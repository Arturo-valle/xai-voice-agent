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

// ponytail: pre-warmed xAI connections keyed by call attempt ID
const pendingXai = new Map();

app.get('/', (req, res) => res.json({ status: 'ok', service: 'xai-voice-agent' }));

// TwiML — also pre-connects xAI to shave ~300ms
app.post('/twiml', (req, res) => {
  const ctx = req.query.ctx ? JSON.parse(decodeURIComponent(req.query.ctx)) : {};
  const callId = req.query.callId || Date.now().toString(36);

  // Pre-warm xAI connection now (Twilio will WS-connect ~200ms after this)
  const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: { 'Authorization': `Bearer ${XAI_API_KEY}` }
  });
  xaiWs._ctx = ctx;
  xaiWs._ready = false;

  xaiWs.on('open', () => {
    const contextMsg = ctx.nombre
      ? `Estás llamando a ${ctx.nombre} de ${ctx.empresa || 'una empresa'}. Servicio de interés: ${ctx.servicio || 'marketing digital'}. Preséntate como agente de CreativeMk.`
      : '';

    xaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: 'eve',
        instructions: `Eres un agente de ventas de CreativeMk en Nicaragua. SIEMPRE habla en español. Sé amable y profesional. ${contextMsg}`,
        turn_detection: { type: 'server_vad', threshold: 0.4, prefix_padding_ms: 100, silence_duration_ms: 200 },
        audio: {
          input: { format: { type: 'audio/pcmu' } },
          output: { format: { type: 'audio/pcmu' } }
        }
      }
    }));

    xaiWs._ready = true;
    console.log(`xAI pre-warmed for callId=${callId}`);
  });

  xaiWs.on('error', (err) => {
    console.error('xAI pre-warm error:', err.message);
    pendingXai.delete(callId);
  });

  pendingXai.set(callId, xaiWs);

  // Cleanup stale entries after 60s
  setTimeout(() => { pendingXai.delete(callId); xaiWs.close(); }, 60000);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="context" value="${encodeURIComponent(JSON.stringify(ctx))}" />
      <Parameter name="callId" value="${callId}" />
    </Stream>
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// Outbound call API
app.post('/call', async (req, res) => {
  const { to, nombre, empresa, servicio } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to"' });

  const callId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ctx = encodeURIComponent(JSON.stringify({ to, nombre, empresa, servicio }));
  const webhookUrl = `https://${req.headers.host}/twiml?ctx=${ctx}&callId=${callId}`;

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

    const callId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ctx = encodeURIComponent(JSON.stringify(lead));
    const webhookUrl = `https://${req.headers.host}/twiml?ctx=${ctx}&callId=${callId}`;

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

function setupXaiHandlers(xaiWs, twilioWs, t0) {
  xaiWs.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type !== 'session.updated' && event.type !== 'ping') {
      console.log(`xAI: ${event.type}`);
    }
    if (event.type === 'response.output_audio.delta' && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: twilioWs._streamSid,
        media: { payload: event.delta }
      }));
    }
    if (event.type === 'error') {
      console.error('xAI error:', JSON.stringify(event));
    }
  });
  xaiWs.on('error', (err) => console.error('xAI WS error:', err.message));
  xaiWs.on('close', () => console.log('xAI WS closed'));
}

async function connectXaiFresh(context, twilioWs, t0) {
  const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: { 'Authorization': `Bearer ${XAI_API_KEY}` }
  });
  await new Promise((resolve, reject) => {
    xaiWs.on('open', resolve);
    xaiWs.on('error', reject);
  });

  const contextMsg = context.nombre
    ? `Estás llamando a ${context.nombre} de ${context.empresa || 'una empresa'}. Servicio de interés: ${context.servicio || 'marketing digital'}. Preséntate como agente de CreativeMk.`
    : '';

  xaiWs.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: 'eve',
      instructions: `Eres un agente de ventas de CreativeMk en Nicaragua. SIEMPRE habla en español. Sé amable y profesional. ${contextMsg}`,
      turn_detection: { type: 'server_vad', threshold: 0.4, prefix_padding_ms: 100, silence_duration_ms: 200 },
      audio: {
        input: { format: { type: 'audio/pcmu' } },
        output: { format: { type: 'audio/pcmu' } }
      }
    }
  }));

  setupXaiHandlers(xaiWs, twilioWs, t0);
  xaiWs.send(JSON.stringify({ type: 'response.create' }));
  console.log(`xAI fresh connect + response.create (${Date.now() - t0}ms)`);
  return xaiWs;
}

async function handleMediaStream(twilioWs, url) {
  const t0 = Date.now();
  console.log('Twilio Media Stream connected');

  let xaiWs = null;
  let context = {};

  // Handle Twilio events
  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('Twilio stream connected');
        break;
      case 'start':
        twilioWs._streamSid = msg.start.streamSid;
        const params = msg.start.customParameters || {};
        if (params.context) {
          try { context = JSON.parse(decodeURIComponent(params.context)); } catch {}
        }
        const callId = params.callId || null;
        console.log(`Stream started: ${msg.start.streamSid} (${Date.now() - t0}ms)`);

        // Try to reuse pre-warmed xAI connection
        if (callId && pendingXai.has(callId)) {
          xaiWs = pendingXai.get(callId);
          pendingXai.delete(callId);
          console.log(`Reusing pre-warmed xAI (${Date.now() - t0}ms)`);
          setupXaiHandlers(xaiWs, twilioWs, t0);
          if (xaiWs.readyState === WebSocket.OPEN) {
            xaiWs.send(JSON.stringify({ type: 'response.create' }));
            console.log(`response.create sent (${Date.now() - t0}ms)`);
          } else {
            xaiWs.on('open', () => {
              xaiWs.send(JSON.stringify({ type: 'response.create' }));
              console.log(`response.create sent (delayed, ${Date.now() - t0}ms)`);
            });
          }
        } else {
          connectXaiFresh(context, twilioWs, t0).then(ws => { xaiWs = ws; });
        }
        break;
      case 'media':
        if (xaiWs?.readyState === WebSocket.OPEN) {
          xaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
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
    console.log('Twilio disconnected');
    if (xaiWs?.readyState === WebSocket.OPEN) xaiWs.close();
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error:', err.message));
}

server.listen(PORT, () => console.log(`Voice Agent running on port ${PORT}`));
