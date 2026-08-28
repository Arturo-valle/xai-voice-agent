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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'xai-voice-agent' }));

// TwiML with PCM format (no mulaw conversion needed)
app.post('/twiml', (req, res) => {
  const ctx = req.query.ctx ? JSON.parse(decodeURIComponent(req.query.ctx)) : {};
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" contentType="audio/L16;rate=8000;encoding=base64">
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

async function handleMediaStream(twilioWs, url) {
  console.log('Twilio Media Stream connected');

  let xaiWs = null;
  let streamSid = null;
  let context = {};

  const ctxParam = url.searchParams.get('ctx');
  if (ctxParam) {
    try { context = JSON.parse(decodeURIComponent(ctxParam)); } catch {}
  }

  // Connect to xAI
  xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: { 'Authorization': `Bearer ${XAI_API_KEY}` }
  });

  xaiWs.on('open', () => {
    console.log('Connected to xAI');
    
    const contextMsg = context.nombre 
      ? `Estás llamando a ${context.nombre} de ${context.empresa || 'una empresa'}. Servicio de interés: ${context.servicio || 'marketing digital'}. Preséntate como agente de CreativeMk.`
      : '';

    xaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: 'eve',
        instructions: `Eres un agente de ventas de CreativeMk en Nicaragua. SIEMPRE habla en español. Sé amable y profesional. ${contextMsg}`,
        turn_detection: { type: 'server_vad' },
        input_audio_format: "pcm_8000",
        output_audio_format: "pcm_8000",
      }
    }));

    xaiWs.send(JSON.stringify({ type: 'response.create' }));
    console.log('Session configured, response.create sent');
  });

  xaiWs.on('message', (data) => {
    const event = JSON.parse(data.toString());
    
    if (event.type !== 'session.updated' && event.type !== 'ping') {
      console.log(`xAI: ${event.type}`);
    }
    
    // Forward audio from xAI to Twilio (PCM passthrough)
    if (event.type === 'response.output_audio.delta' && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: event.delta }
      }));
    }

    if (event.type === 'error') {
      console.error('xAI error:', JSON.stringify(event));
    }
  });

  xaiWs.on('error', (err) => console.error('xAI WS error:', err.message));
  xaiWs.on('close', () => console.log('xAI WS closed'));

  // Handle Twilio events
  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('Twilio stream connected');
        break;
      case 'start':
        streamSid = msg.start.streamSid;
        console.log(`Stream started: ${streamSid}`);
        break;
      case 'media':
        // Forward audio from Twilio to xAI (PCM passthrough)
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
