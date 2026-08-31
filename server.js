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

// Timeout configuration (milliseconds)
const CALL_TIMEOUT_MS = parseInt(process.env.CALL_TIMEOUT_MS) || 300000;  // 5min max call duration
const SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS) || 15000;  // 15s silence = hang up

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
  for (let i = 0; i < buf.length; i++) {
    let pcm = ULAW_TO_PCM[buf[i]];
    pcm = Math.max(-32768, Math.min(32767, Math.round(pcm * gain)));
    out[i] = pcm16ToUlaw(pcm);
  }
  return out.toString('base64');
}

// End a call via Twilio API
async function endCall(callSid) {
  if (!callSid) return;
  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'Status=completed',
      }
    );
    const data = await resp.json();
    console.log(`Call ${callSid} ended via Twilio API: ${data.status}`);
  } catch (err) {
    console.error(`Failed to end call ${callSid}:`, err.message);
  }
}

// Configure xAI session and send greeting
function configureXaiSession(xaiWs, ctx) {
  const contextMsg = ctx.nombre
    ? `\n\nCURRENT CALL CONTEXT:\n- Prospect: ${ctx.nombre}\n- Company: ${ctx.empresa || 'Not specified'}\n- Service interest: ${ctx.servicio || 'Not specified'}\n- Phone: ${ctx.to || 'Not available'}`
    : '';

  const tools = [];
  if (process.env.XAI_COLLECTION_ID) {
    tools.push({
      type: 'file_search',
      vector_store_ids: [process.env.XAI_COLLECTION_ID],
      max_num_results: 5,
    });
  }

  xaiWs.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: process.env.XAI_VOICE || 'ara',
      instructions: `${process.env.XAI_INSTRUCTIONS || 'Eres un agente de ventas de CreativeMk.'}${contextMsg}`,
      turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: 500 },
      audio: {
        input: { format: { type: 'audio/pcmu' }, transport: 'binary' },
        output: { format: { type: 'audio/pcmu' }, transport: 'binary', speed: 1.05 }
      },
      ...(tools.length > 0 && { tools })
    }
  }));

  xaiWs.send(JSON.stringify({ type: 'response.create' }));
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'xai-voice-agent' }));

// Dashboard
app.get('/dashboard', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Voice Agent — Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;padding:2rem}
  .container{max-width:720px;margin:0 auto}
  h1{font-size:1.5rem;margin-bottom:.5rem;color:#fff}
  .subtitle{color:#888;margin-bottom:2rem;font-size:.875rem}
  .card{background:#141414;border:1px solid #222;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
  .card h2{font-size:1rem;margin-bottom:1rem;color:#ccc;display:flex;align-items:center;gap:.5rem}
  .status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  .status-dot.ok{background:#22c55e} .status-dot.err{background:#ef4444} .status-dot.loading{background:#eab308}
  label{display:block;font-size:.8rem;color:#888;margin-bottom:.35rem;margin-top:.75rem}
  label:first-child{margin-top:0}
  input,textarea,select{width:100%;padding:.6rem;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#e0e0e0;font-size:.9rem;outline:none}
  input:focus,textarea:focus{border-color:#555}
  textarea{resize:vertical;min-height:60px}
  button{margin-top:1rem;padding:.65rem 1.5rem;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:.9rem;cursor:pointer;font-weight:500}
  button:hover{background:#1d4ed8}
  button:disabled{opacity:.5;cursor:not-allowed}
  .result{margin-top:1rem;padding:1rem;background:#111;border-radius:8px;font-family:monospace;font-size:.8rem;white-space:pre-wrap;max-height:200px;overflow-y:auto;display:none}
  .result.show{display:block}
  .result.ok{border-left:3px solid #22c55e}
  .result.err{border-left:3px solid #ef4444}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
  @media(max-width:500px){.grid{grid-template-columns:1fr}}
  .meta{font-size:.75rem;color:#666;margin-top:.5rem}
</style>
</head>
<body>
<div class="container">
  <h1>🎙️ Voice Agent</h1>
  <p class="subtitle">xAI + Twilio · CreativeMk</p>

  <div class="card">
    <h2><span class="status-dot loading" id="statusDot"></span> Estado del Servicio</h2>
    <div id="statusInfo" style="font-size:.85rem;color:#888">Verificando...</div>
  </div>

  <div class="card">
    <h2>📞 Hacer Llamada de Prueba</h2>
    <div class="grid">
      <div>
        <label>Teléfono (con código país)</label>
        <input id="to" type="tel" placeholder="+50583598517">
      </div>
      <div>
        <label>Nombre del prospecto</label>
        <input id="nombre" type="text" placeholder="Juan Pérez">
      </div>
      <div>
        <label>Empresa</label>
        <input id="empresa" type="text" placeholder="Acme Corp">
      </div>
      <div>
        <label>Servicio de interés</label>
        <input id="servicio" type="text" placeholder="Marketing digital">
      </div>
    </div>
    <button id="callBtn" onclick="makeCall()">Llamar</button>
    <div id="callResult" class="result"></div>
  </div>

  <div class="card">
    <h2>📋 Info Técnica</h2>
    <div id="techInfo" style="font-size:.8rem;color:#666">Cargando...</div>
  </div>

  <p class="meta">Voice Agent v1.0 · Puerto ${PORT}</p>
</div>
<script>
async function checkStatus(){
  const dot=document.getElementById('statusDot');
  const info=document.getElementById('statusInfo');
  try{
    const r=await fetch('/');
    const d=await r.json();
    dot.className='status-dot ok';
    info.innerHTML='<span style="color:#22c55e">● Online</span> — '+d.service;
  }catch(e){
    dot.className='status-dot err';
    info.innerHTML='<span style="color:#ef4444">● Offline</span> — '+e.message;
  }
}

async function loadTech(){
  const el=document.getElementById('techInfo');
  try{
    const r=await fetch('/');
    const d=await r.json();
    el.innerHTML='Servicio: '+d.service+'<br>Endpoint: /<br>Métodos: POST /call, POST /call-batch, POST /twiml<br>WebSocket: /media-stream';
  }catch(e){el.textContent='Error: '+e.message}
}

async function makeCall(){
  const btn=document.getElementById('callBtn');
  const res=document.getElementById('callResult');
  const to=document.getElementById('to').value.trim();
  if(!to){res.className='result err show';res.textContent='Falta número de teléfono';return}
  btn.disabled=true;btn.textContent='Llamando...';
  res.className='result show';res.textContent='Enviando solicitud...';
  try{
    const r=await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      to,
      nombre:document.getElementById('nombre').value.trim(),
      empresa:document.getElementById('empresa').value.trim(),
      servicio:document.getElementById('servicio').value.trim()
    })});
    const d=await r.json();
    res.className='result '+(d.success?'ok':'err')+' show';
    res.textContent=JSON.stringify(d,null,2);
  }catch(e){
    res.className='result err show';res.textContent='Error: '+e.message;
  }
  btn.disabled=false;btn.textContent='Llamar';
}

checkStatus();loadTech();
setInterval(checkStatus,30000);
</script>
</body>
</html>`);
});

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
  params.append('Timeout', '55');  // Max ring time before answer

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
    params.append('Timeout', '55');

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

// Save lead to external API
app.post('/save-lead', async (req, res) => {
  const { nombre, telefono, empresa, servicio, notas } = req.body;
  
  try {
    const resp = await fetch('https://xai-leads-api.el-molino.workers.dev/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: nombre || 'Sin nombre',
        telefono: telefono || 'Desconocido',
        empresa: empresa || '',
        servicio: servicio || '',
        notas: notas || '',
        origen: 'voice-agent'
      })
    });
    
    const data = await resp.json();
    res.json({ success: true, lead: data });
  } catch (err) {
    console.error('Error saving lead:', err.message);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

// Leads dashboard
app.get('/leads', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Leads Dashboard — Arturo Ordóñez</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;padding:2rem}
  .container{max-width:900px;margin:0 auto}
  h1{font-size:1.5rem;margin-bottom:.5rem;color:#fff}
  .subtitle{color:#888;margin-bottom:2rem;font-size:.875rem}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:2rem}
  .stat{background:#141414;border:1px solid #222;border-radius:12px;padding:1rem;text-align:center}
  .stat .num{font-size:2rem;font-weight:700;color:#fff}
  .stat .label{font-size:.75rem;color:#888;margin-top:.25rem}
  .stat.hot .num{color:#22c55e} .stat.warm .num{color:#eab308} .stat.cold .num{color:#ef4444}
  table{width:100%;border-collapse:collapse;background:#141414;border-radius:12px;overflow:hidden}
  th{background:#1a1a1a;padding:.75rem 1rem;text-align:left;font-size:.8rem;color:#888;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.75rem 1rem;border-top:1px solid #222;font-size:.85rem}
  tr:hover td{background:#1a1a1a}
  .badge{display:inline-block;padding:.15rem .5rem;border-radius:6px;font-size:.7rem;font-weight:600}
  .badge.hot{background:#166534;color:#86efac} .badge.warm{background:#854d0e;color:#fde047} .badge.cold{background:#991b1b;color:#fca5a5}
  .empty{text-align:center;padding:3rem;color:#555}
  .refresh{margin-bottom:1rem}
  .refresh button{padding:.5rem 1rem;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:.85rem}
  .refresh button:hover{background:#1d4ed8}
  .notes{max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media(max-width:600px){.stats{grid-template-columns:1fr 1fr}td,th{padding:.5rem;font-size:.75rem}}
</style>
</head>
<body>
<div class="container">
  <h1>📋 Leads Dashboard</h1>
  <p class="subtitle">Arturo Ordóñez — Voice Agent Leads</p>
  <div class="refresh"><button onclick="loadLeads()">↻ Refresh</button></div>
  <div class="stats" id="stats"></div>
  <table>
    <thead><tr><th>Name</th><th>Phone</th><th>Company</th><th>Service</th><th>Level</th><th>Date</th><th>Notes</th></tr></thead>
    <tbody id="leads"><tr><td colspan="7" class="empty">Loading...</td></tr></tbody>
  </table>
</div>
<script>
function classify(notes){
  const t=(notes||'').toLowerCase();
  if(t.includes('high')||t.includes('schedule')||t.includes('meeting')||t.includes('interested'))return 'hot';
  if(t.includes('medium')||t.includes('follow')||t.includes('think'))return 'warm';
  return 'cold';
}
function shortDate(d){try{return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch(e){return d}}
async function loadLeads(){
  try{
    const r=await fetch('https://xai-leads-api.el-molino.workers.dev/leads');
    const d=await r.json();
    const leads=(d.leads||[]).sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));
    const hot=leads.filter(l=>classify(l.notas)==='hot').length;
    const warm=leads.filter(l=>classify(l.notas)==='warm').length;
    const cold=leads.filter(l=>classify(l.notas)==='cold').length;
    document.getElementById('stats').innerHTML=
      '<div class="stat"><div class="num">'+leads.length+'</div><div class="label">Total</div></div>'+
      '<div class="stat hot"><div class="num">'+hot+'</div><div class="label">Hot</div></div>'+
      '<div class="stat warm"><div class="num">'+warm+'</div><div class="label">Warm</div></div>'+
      '<div class="stat cold"><div class="num">'+cold+'</div><div class="label">Cold</div></div>';
    if(!leads.length){document.getElementById('leads').innerHTML='<tr><td colspan="7" class="empty">No leads yet</td></tr>';return}
    document.getElementById('leads').innerHTML=leads.map(l=>{
      const level=classify(l.notas);
      return '<tr><td><strong>'+(l.nombre||'-')+'</strong></td><td>'+(l.telefono||'-')+'</td><td>'+(l.empresa||'-')+'</td><td>'+(l.servicio||'-')+'</td><td><span class="badge '+level+'">'+level+'</span></td><td>'+shortDate(l.fecha)+'</td><td class="notes" title="'+(l.notas||'').replace(/"/g,'&quot;')+'">'+(l.notas||'-')+'</td></tr>'
    }).join('');
  }catch(e){document.getElementById('leads').innerHTML='<tr><td colspan="7" class="empty">Error loading leads</td></tr>'}
}
loadLeads();
</script>
</body>
</html>`);
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
      state.lastAudioTime = Date.now();  // Reset silence timer
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
      state.highEnergyChunks = 0;
      // Explicitly request new response after user stops speaking
      if (xaiWs.readyState === WebSocket.OPEN) {
        xaiWs.send(JSON.stringify({ type: 'response.create' }));
        console.log('speech_stopped → response.create');
      }
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
  let callSid = null;
  let context = {};
  const state = { 
    streamSid: null, 
    userSpeaking: false, 
    firstAudioSent: false, 
    responseActive: false, 
    highEnergyChunks: 0, 
    lastBargeIn: 0,
    lastAudioTime: Date.now(),  // Track last audio for silence detection
    callTimeout: null,
    silenceTimeout: null
  };

  // Function to clean up and end call
  function cleanup(reason) {
    console.log(`Call cleanup: ${reason} (CallSid=${callSid})`);
    if (state.callTimeout) clearTimeout(state.callTimeout);
    if (state.silenceTimeout) clearTimeout(state.silenceTimeout);
    if (xaiWs?.readyState === WebSocket.OPEN) xaiWs.close();
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    if (callSid) endCall(callSid);
  }

  // Set call timeout (max duration)
  state.callTimeout = setTimeout(() => {
    cleanup(`Call timeout (${CALL_TIMEOUT_MS}ms)`);
  }, CALL_TIMEOUT_MS);

  // Function to reset silence timeout
  function resetSilenceTimeout() {
    if (state.silenceTimeout) clearTimeout(state.silenceTimeout);
    state.silenceTimeout = setTimeout(() => {
      cleanup(`Silence timeout (${SILENCE_TIMEOUT_MS}ms)`);
    }, SILENCE_TIMEOUT_MS);
  }

  // Start silence monitoring
  resetSilenceTimeout();

  twilioWs.on('message', async (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('Twilio stream connected');
        break;

      case 'start':
        state.streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
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

          // Reset silence timeout on any audio
          state.lastAudioTime = Date.now();
          resetSilenceTimeout();

          // Server-side VAD: clear Twilio immediately, but don't cancel xAI yet
          if (state.responseActive && !state.userSpeaking) {
            let energy = 0;
            for (let i = 0; i < audioBuf.length; i++) {
              const pcm = ULAW_TO_PCM[audioBuf[i]];
              energy += pcm * pcm;
            }
            const rms = Math.sqrt(energy / audioBuf.length);
            const SPEECH_THRESHOLD = 1500;
            const CHUNKS_NEEDED = 5;

            if (rms > SPEECH_THRESHOLD) {
              state.highEnergyChunks++;
              if (state.highEnergyChunks >= CHUNKS_NEEDED) {
                state.userSpeaking = true;
                // Clear Twilio buffer — user hears silence immediately
                if (twilioWs.readyState === WebSocket.OPEN && state.streamSid) {
                  twilioWs.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
                }
                console.log(`Barge-in: clear Twilio (rms=${Math.round(rms)}) [+${Date.now() - t0}ms]`);
              }
            } else {
              state.highEnergyChunks = 0;
            }
          }
        }
        break;

      case 'stop':
        console.log('Stream stopped');
        cleanup('Stream stopped by Twilio');
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    cleanup('Twilio WebSocket closed');
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error:', err.message);
    cleanup('Twilio WebSocket error');
  });
}

server.listen(PORT, () => console.log(`Voice Agent running on port ${PORT}`));
