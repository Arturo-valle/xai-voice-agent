import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

const XAI_API_KEY = process.env.XAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || '+175****6876';
const PORT = process.env.PORT || 3000;
const GAIN = parseFloat(process.env.AUDIO_GAIN) || 2.0;

// Pre-warmed xAI connections keyed by CallSid
const prewarmedXai = new Map();

// µ-law decode table (256 entries)
const ULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let val = ~i;
  let sign = val & 0x80;
  let exponent = (val >> 4) & 0x07;
  let mantissa = val & 0x0F;
  let sample = ((mantissa << 1) + 33) << (exponent + 2);
  sample -= 0x84;
  ULAW_TO_PCM[i] = sign ? -sample : sample;
}

function pcm16ToUlaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0; exponent--, expMask >>= 1) {
    if (sample & expMask) break;
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function amplifyUlawBase64(payload, gain) {
  const buf = Buffer.from(payload, 'base64');
  const out = Buffer.alloc(buf.length);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const abs = Math.abs(ULAW_TO_PCM[buf[i]]);
    if (abs > peak) peak = abs;
  }
  const normGain = peak > 100 ? (29000 / peak) : gain;
  const effectiveGain = Math.max(gain, normGain);
  for (let i = 0; i < buf.length; i++) {
    let pcm = ULAW_TO_PCM[buf[i]];
    pcm = Math.max(-32768, Math.min(32767, Math.round(pcm * effectiveGain)));
    out[i] = pcm16ToUlaw(pcm);
  }
  return out.toString('base64');
}

// Configure xAI session and send greeting
function configureXaiSession(xaiWs, ctx) {
  const contextMsg = ctx.nombre
    ? `Estás llamando a ${ctx.nombre} de ${ctx.empresa || 'una empresa'}. Servicio de interés: ${ctx.servicio || 'marketing digital'}. Preséntate como agente de CreativeMk.`
    : '';

  xaiWs.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: 'eve',
      instructions: `Eres un agente de ventas de CreativeMk en Nicaragua. SIEMPRE habla en español. Sé amable y profesional. ${contextMsg}`,
      turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: 500 },
      audio: {
        input: { format: { type: 'audio/pcmu' }, transport: 'binary' },
        output: { format: { type: 'audio/pcmu' }, transport: 'binary', speed: 1.05 }
      }
    }
  }));

  xaiWs.send(JSON.stringify({ type: 'response.create' }));
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'xai-voice-agent' }));

// TwiML — also pre-connects xAI
app.post('/twiml', (req, res) => {
  const ctx = req.query.ctx ? JSON.parse(decodeURIComponent(req.query.ctx)) : {};
  const callSid = req.body.CallSid || null;

  if (callSid) {
    const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { 'Authorization': `Bearer ${XAI_API_KEY}` }
    });

    xaiWs._ctx = ctx;
    xaiWs._ready = false;

    xaiWs.on('open', () => {
      configureXaiSession(xaiWs, ctx);
      // Send response.create immediately — audio will buffer until stream is ready
      xaiWs.send(JSON.stringify({ type: 'response.create' }));
      xaiWs._ready = true;
      console.log(`xAI pre-warmed for CallSid=${callSid}`);
    });

    xaiWs.on('error', (err) => {
      console.error('xAI pre-warm error:', err.message);
      prewarmedXai.delete(callSid);
    });

    prewarmedXai.set(callSid, xaiWs);
    setTimeout(() => {
      if (prewarmedXai.has(callSid)) {
        prewarmedXai.delete(callSid);
        xaiWs.close();
      }
    }, 60000);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="context" value="${encodeURIComponent(JSON.stringify(ctx))}" />
    </Stream>
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// Outbound call API
app.post('/call', async (req, res) => {
  const { to, nombre, empresa, servicio } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to"' });

  const ctx = encodeURIComponent(JSON.stringify({ to, nombre, empresa, servicio }));
  const webhookUrl = `https://${req.headers.host}/twiml?ctx=${ctx}`;

  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', TWILIO_NUMBER);
  params.append('Url', webhookUrl);
  params.append('Method', 'POST');

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );

  const data = await resp.json();
  if (data.sid) {
    res.json({ success: true, call_sid: data.sid, to, nombre, status: data.status });
  } else {
    res.status(400).json({ error: data.message || 'Call failed' });
  }
});

// Batch call API
app.post('/call-batch', async (req, res) => {
  const { leads, delay_seconds = 60 } = req.body;
  if (!leads?.length) return res.status(400).json({ error: 'Empty leads list' });

  const results = [];
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    if (!lead.to) { results.push({ error: 'Missing number' }); continue; }

    const ctx = encodeURIComponent(JSON.stringify(lead));
    const webhookUrl = `https://${req.headers.host}/twiml?ctx=${ctx}`;

    const params = new URLSearchParams();
    params.append('To', lead.to);
    params.append('From', TWILIO_NUMBER);
    params.append('Url', webhookUrl);
    params.append('Method', 'POST');

    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );

    const data = await resp.json();
    results.push(data.sid ? { success: true, call_sid: data.sid, to: lead.to } : { error: data.message, to: lead.to });

    if (i < leads.length - 1) await new Promise(r => setTimeout(r, delay_seconds * 1000));
  }

  res.json({ total: leads.length, successful: results.filter(r => r.success).length, results });
});

// WebSocket handler
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/media-stream') handleMediaStream(ws, url);
});

function setupXaiHandlers(xaiWs, twilioWs, t0, state) {
  xaiWs.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!state.userSpeaking && twilioWs.readyState === WebSocket.OPEN && state.streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: state.streamSid,
          media: { payload: amplifyUlawBase64(data.toString('base64'), GAIN) }
        }));
      }
      return;
    }

    const event = JSON.parse(data.toString());

    if (event.type !== 'session.updated' && event.type !== 'ping') {
      console.log(`xAI: ${event.type} (+${Date.now() - t0}ms)`);
    }

    if (event.type === 'response.created') {
      state.responseActive = true;
      state.firstAudioSent = false;
      console.log(`LATENCY: xAI started generating at +${Date.now() - t0}ms`);
    }
    if (event.type === 'response.done') {
      state.responseActive = false;
    }
    if (event.type === 'response.output_audio.delta' && !state.firstAudioSent) {
      state.firstAudioSent = true;
      console.log(`LATENCY: first audio chunk at +${Date.now() - t0}ms`);
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      state.userSpeaking = true;
      if (state.responseActive && xaiWs.readyState === WebSocket.OPEN) {
        xaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        state.responseActive = false;
      }
      if (twilioWs.readyState === WebSocket.OPEN && state.streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
      }
      console.log('Barge-in: cancel + clear');
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      state.userSpeaking = false;
    }

    if (event.type === 'response.output_audio.delta' && !state.userSpeaking && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: state.streamSid,
        media: { payload: amplifyUlawBase64(event.delta, GAIN) }
      }));
    }

    if (event.type === 'error') {
      console.error('xAI error:', JSON.stringify(event));
    }
  });

  xaiWs.on('error', (err) => console.error('xAI WS error:', err.message));
  xaiWs.on('close', () => console.log('xAI WS closed'));
}

function connectXaiFresh(ctx) {
  return new Promise((resolve, reject) => {
    const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { 'Authorization': `Bearer ${XAI_API_KEY}` }
    });
    xaiWs.on('open', () => {
      configureXaiSession(xaiWs, ctx);
      resolve(xaiWs);
    });
    xaiWs.on('error', reject);
  });
}

async function handleMediaStream(twilioWs, url) {
  const t0 = Date.now();
  console.log('Twilio Media Stream connected');

  let xaiWs = null;
  let context = {};
  const state = { streamSid: null, userSpeaking: false, firstAudioSent: false, responseActive: false };

  twilioWs.on('message', async (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('Twilio stream connected');
        break;

      case 'start':
        state.streamSid = msg.start.streamSid;
        const callSid = msg.start.callSid;
        console.log(`Stream started: ${state.streamSid} (CallSid=${callSid}) [+${Date.now() - t0}ms]`);

        // Try pre-warmed xAI connection
        if (callSid && prewarmedXai.has(callSid)) {
          xaiWs = prewarmedXai.get(callSid);
          prewarmedXai.delete(callSid);
          console.log(`Using pre-warmed xAI [+${Date.now() - t0}ms]`);
          setupXaiHandlers(xaiWs, twilioWs, t0, state);
        } else {
          // Fallback: fresh connection
          console.log(`No pre-warmed xAI, connecting fresh [+${Date.now() - t0}ms]`);
          const ctxParam = url.searchParams.get('ctx');
          if (ctxParam) {
            try { context = JSON.parse(decodeURIComponent(ctxParam)); } catch {}
          }
          xaiWs = await connectXaiFresh(context);
          setupXaiHandlers(xaiWs, twilioWs, t0, state);
          console.log(`xAI connected fresh [+${Date.now() - t0}ms]`);
        }
        break;

      case 'media':
        if (msg.media.track === 'inbound' && xaiWs?.readyState === WebSocket.OPEN) {
          const audioBuf = Buffer.from(msg.media.payload, 'base64');
          xaiWs.send(audioBuf);
        }
        break;

      case 'stop':
        console.log('Stream stopped');
        if (xaiWs?.readyState === WebSocket.OPEN) xaiWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    if (xaiWs?.readyState === WebSocket.OPEN) xaiWs.close();
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error:', err.message));
}

server.listen(PORT, () => console.log(`Voice Agent running on port ${PORT}`));
