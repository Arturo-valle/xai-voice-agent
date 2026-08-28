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
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || '+17543546876';
const PORT = process.env.PORT || 3000;

// Mulaw to PCM conversion table
const MULAW_TO_PCM = new Int16Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xFF;
    let sign = (mu & 0x80) ? -1 : 1;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0F;
    let sample = ((mantissa << 1) + 33) << (exponent + 2);
    sample -= 0x84;
    MULAW_TO_PCM[i] = sign * sample;
  }
})();

// PCM to Mulaw conversion
function pcmToMulaw(pcm) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 0x84;
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  if (pcm > MULAW_MAX) pcm = MULAW_MAX;
  pcm += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0; exponent--, expMask >>= 1) {
    if (pcm & expMask) break;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0F;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulaw;
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'xai-voice-agent' });
});

// Twilio webhook for outbound calls
app.post('/twiml', (req, res) => {
  const ctx = req.query.ctx ? JSON.parse(decodeURIComponent(req.query.ctx)) : {};
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" contentType="audio/x-mulaw;rate=8000;encoding=base64">
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

// WebSocket handler for Twilio Media Streams
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/media-stream') {
    handleMediaStream(ws, url);
  }
});

async function handleMediaStream(twilioWs, url) {
  console.log('Twilio Media Stream connected');

  let xaiWs = null;
  let streamSid = null;
  let callSid = null;
  let context = {};

  const ctxParam = url.searchParams.get('ctx');
  if (ctxParam) {
    try { context = JSON.parse(decodeURIComponent(ctxParam)); } catch {}
  }

  // Connect to xAI Realtime API
  xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: { 'Authorization': `Bearer ${XAI_API_KEY}` }
  });

  xaiWs.on('open', () => {
    console.log('Connected to xAI');
    
    const contextMsg = context.nombre 
      ? `Estás llamando a ${context.nombre} de ${context.empresa || 'una empresa'}. Servicio de interés: ${context.servicio || 'marketing digital'}. Preséntate como agente de CreativeMk y pregunta si tienen un momento para platicar.`
      : '';

    // Configure session with mulaw format to match Twilio
    xaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: 'eve',
        instructions: `Eres un agente de ventas de CreativeMk, una agencia de marketing digital en Nicaragua. SIEMPRE habla en español. Sé amable, profesional y conciso. ${contextMsg} Si no entienden algo, explícalo de forma simple. Si no están interesados, agradece y despídete.`,
        turn_detection: { type: 'server_vad' },
        input_audio_format: { type: 'audio/pcm', rate: 8000 },
        output_audio_format: { type: 'audio/pcm', rate: 8000 },
      }
    }));
  });

  xaiWs.on('message', (data) => {
    const event = JSON.parse(data.toString());
    
    // Forward audio from xAI to Twilio (convert PCM to mulaw)
    if (event.type === 'response.audio.delta' && twilioWs.readyState === WebSocket.OPEN) {
      // xAI sends base64-encoded PCM, Twilio expects base64-encoded mulaw
      const pcmBuffer = Buffer.from(event.delta, 'base64');
      const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
      
      for (let i = 0; i < mulawBuffer.length; i++) {
        const pcmSample = pcmBuffer.readInt16LE(i * 2);
        mulawBuffer[i] = pcmToMulaw(pcmSample);
      }
      
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: mulawBuffer.toString('base64') }
      }));
    }

    if (event.type === 'error') {
      console.error('xAI error:', event);
    }
  });

  xaiWs.on('error', (err) => console.error('xAI WS error:', err.message));
  xaiWs.on('close', () => console.log('xAI WS closed'));

  // Handle Twilio Media Stream events
  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('Twilio stream connected');
        break;
      
      case 'start':
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        console.log(`Stream started: ${streamSid}, Call: ${callSid}`);
        break;
      
      case 'media':
        // Convert mulaw to PCM and forward to xAI
        if (xaiWs?.readyState === WebSocket.OPEN) {
          const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
          const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);
          
          for (let i = 0; i < mulawBuffer.length; i++) {
            const pcmSample = MULAW_TO_PCM[mulawBuffer[i]];
            pcmBuffer.writeInt16LE(pcmSample, i * 2);
          }
          
          xaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pcmBuffer.toString('base64')
          }));
        }
        break;
      
      case 'stop':
        console.log('Stream stopped');
        if (xaiWs?.readyState === WebSocket.OPEN) xaiWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio stream disconnected');
    if (xaiWs?.readyState === WebSocket.OPEN) xaiWs.close();
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error:', err.message));
}

server.listen(PORT, () => {
  console.log(`Voice Agent running on port ${PORT}`);
});
