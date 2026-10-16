require('dotenv').config();
const express = require('express');
const path = require('path');
const { findLot, closeBrowser } = require('./scraper');
const { buildMessage } = require('./format');
const { getYenPerEur } = require('./pricing');
const wa = require('./wa');
const { findAsnet } = require('./asnet');
const batch = require('./batch');

// WhatsApp/Chrome ke andar ke unhandled errors se poora server na girey
process.on('unhandledRejection', (e) => console.error('Unhandled:', e && e.message ? e.message : e));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, pid: process.pid }));

app.get('/api/lot/:lot', async (req, res) => {
  try {
    const cars = await findLot(req.params.lot.trim());
    const rate = cars.length ? await getYenPerEur() : 0; // 1 EUR = ? JPY (6 ghante cache)
    res.json({ ok: true, cars: cars.map((c) => ({ ...c, message: buildMessage(c, rate) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/asnet/:lot', async (req, res) => {
  try {
    const r = await findAsnet(req.params.lot.trim(), req.query.km, req.query);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Auto batch (Pioneer List A): UI ek ek gari maangta hai, server 15 par khud rok deta hai
app.post('/api/batch/start', (req, res) => res.json({ ok: true, ...batch.start() }));
app.post('/api/batch/next', async (req, res) => {
  try { res.json({ ok: true, ...(await batch.next()) }); }
  catch (e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/batch/recent', (req, res) => res.json({ ok: true, cars: batch.getRecent() }));
app.post('/api/batch/reset', (req, res) => { batch.reset(); res.json({ ok: true }); });

app.get('/api/wa/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t = wa.target();
  res.json({
    status: wa.state.status,
    qr: wa.state.qr,
    error: wa.state.error,
    detail: wa.state.detail,
    to: t ? '+' + t : '',
  });
});

app.post('/api/wa/send', async (req, res) => {
  try {
    const { text, images } = req.body || {};
    const list = Array.isArray(images) ? images.filter((x) => typeof x === 'string') : [];
    const sent = await wa.sendCar(String(text || ''), list);
    res.json({ ok: true, sent });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/wa/reconnect', async (req, res) => {
  try { await wa.reconnect(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/wa/reset', async (req, res) => {
  try { await wa.reset(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

let quitting = false;
async function quit(code) {
  if (quitting) return;
  quitting = true;
  const hard = setTimeout(() => process.exit(code), 15000); // atak jaye to bhi 15 second mein band
  try { await Promise.all([wa.shutdown().catch(() => {}), closeBrowser().catch(() => {})]); } catch (e) { /* ignore */ }
  clearTimeout(hard);
  process.exit(code);
}

// code 42 = launcher.js ko bolta hai "dobara chalao"
app.post('/api/restart', (req, res) => {
  if (process.env.LAUNCHED_BY !== 'launcher') {
    return res.status(400).json({ ok: false, error: 'Server "npm start" se nahi chala, isliye restart nahi ho sakta. Terminal band karke npm start chalao.' });
  }
  res.json({ ok: true });
  setTimeout(() => quit(42), 300);
});

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`Tool chal raha hai: http://localhost:${port}`);
  wa.start();
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port} pehle se use ho raha hai. Purana tool band karo (ya .env mein PORT badlo).`);
    process.exit(43); // 43 = launcher dobara try na kare
  }
  console.error(e);
  process.exit(1);
});
