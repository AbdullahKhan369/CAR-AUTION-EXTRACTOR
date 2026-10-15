const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DIR = path.join(__dirname, 'wa-session');

// status: starting | qr | ready | error
const state = { status: 'starting', qr: null, error: null, detail: '' };

let client = null;
let gen = 0; // har naye client ka number; purane client ke events ignore ho jate hain
let retryTimer = null;
let watchdog = null;
let healthTimer = null;
let attempts = 0;
let sending = false;
let stopped = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms))]);

// Client ka number .env se (CLIENT_NUMBER), sirf digits
function target() {
  const d = String(process.env.CLIENT_NUMBER || '').replace(/\D/g, '');
  return d.length >= 8 ? d : '';
}

function clearTimers() {
  clearTimeout(watchdog);
  clearInterval(healthTimer);
}

async function killClient() {
  const old = client;
  client = null;
  if (old) {
    try { await withTimeout(old.destroy(), 15000, 'destroy'); } catch (e) { /* ignore */ }
  }
}

async function wipeSession() {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch (e) {
      await sleep(1000); // Windows par Chrome ke band hone tak file lock rehti hai
    }
  }
}

// kuch der baad apne aap dobara connect (session yaad hai, QR nahi lagta)
function scheduleRetry(wipe) {
  if (stopped) return;
  clearTimers();
  attempts++;
  const wait = Math.min(5000 * attempts, 30000);
  const myGen = gen;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (myGen !== gen) return; // beech mein kisi ne manual reconnect kar diya
    if (wipe) { await killClient(); await wipeSession(); }
    start();
  }, wait);
}

function armWatchdog(myGen) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (myGen === gen && state.status === 'starting') {
      state.status = 'error';
      state.error = 'WhatsApp load nahi ho raha (net slow ya VPN?). Dobara koshish ho rahi hai...';
      scheduleRetry();
    }
  }, 240000);
}

// ready hone ke baad har 45 second connection check; 3 baar fail to dobara connect
function startHealth(myGen) {
  clearInterval(healthTimer);
  let bad = 0;
  healthTimer = setInterval(async () => {
    if (myGen !== gen || state.status !== 'ready' || sending || !client) return;
    try {
      const s = await withTimeout(client.getState(), 20000, 'getState');
      if (s === 'CONNECTED') { bad = 0; return; }
      bad++;
    } catch (e) { bad++; }
    if (bad >= 3 && myGen === gen) {
      state.status = 'error';
      state.error = 'WhatsApp ka connection toot gaya. Dobara connect ho raha hai...';
      scheduleRetry();
    }
  }, 45000);
}

async function start() {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearTimers();
  const myGen = ++gen;
  await killClient();
  if (myGen !== gen) return; // beech mein dusri start() chal gayi

  state.status = 'starting';
  state.qr = null;
  state.error = null;
  state.detail = 'WhatsApp start ho raha hai...';

  let c;
  try {
    c = new Client({
      authStrategy: new LocalAuth({ dataPath: SESSION_DIR }), // QR sirf pehli baar
      puppeteer: {
        headless: process.env.WA_SHOW === '1' ? false : true,
        args: ['--no-sandbox'],
        protocolTimeout: 200000,
      },
    });
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    scheduleRetry();
    return;
  }
  client = c;
  const live = () => myGen === gen;

  c.on('qr', async (qr) => {
    if (!live()) return;
    clearTimeout(watchdog); // QR scan hone tak intezar, watchdog nahi
    state.status = 'qr';
    state.detail = 'QR scan karo';
    try { state.qr = await QRCode.toDataURL(qr); } catch (e) { /* ignore */ }
  });
  c.on('authenticated', () => {
    if (!live()) return;
    state.status = 'starting';
    state.qr = null;
    state.detail = 'Login ho gaya, load ho raha hai...';
    armWatchdog(myGen);
  });
  c.on('loading_screen', (percent) => {
    if (!live()) return;
    state.detail = 'Load ho raha hai ' + percent + '%';
  });
  c.on('ready', () => {
    if (!live()) return;
    clearTimeout(watchdog);
    attempts = 0;
    state.status = 'ready';
    state.qr = null;
    state.error = null;
    state.detail = '';
    console.log('WhatsApp ready');
    startHealth(myGen);
  });
  c.on('auth_failure', (m) => {
    if (!live()) return;
    state.status = 'error';
    state.error = 'WhatsApp login fail (' + m + '). Naya QR aayega...';
    scheduleRetry(true);
  });
  c.on('disconnected', (reason) => {
    if (!live()) return;
    state.status = 'error';
    state.error = 'WhatsApp disconnect hua (' + reason + '). Dobara connect ho raha hai...';
    scheduleRetry(String(reason).toUpperCase() === 'LOGOUT');
  });

  armWatchdog(myGen);
  c.initialize().catch((e) => {
    if (!live()) return;
    console.error('WhatsApp initialize error:', e.message);
    state.status = 'error';
    state.error = e.message;
    scheduleRetry();
  });
}

// "Reconnect" button: session wahi rehta hai, QR dobara nahi lagta
async function reconnect() {
  attempts = 0;
  await start();
}

// "Reset" button: purana link hata kar naya QR
async function reset() {
  attempts = 0;
  gen++;
  clearTimers();
  clearTimeout(retryTimer);
  if (client && state.status === 'ready') {
    try { await withTimeout(client.logout(), 10000, 'logout'); } catch (e) { /* ignore */ }
  }
  await killClient();
  await wipeSession();
  await start();
}

async function shutdown() {
  stopped = true;
  clearTimers();
  clearTimeout(retryTimer);
  gen++;
  await killClient();
}

// "/cars/247_12-10-2026/01.jpg" -> asli file path (folder se bahar jaane se rokta hai)
async function toMedia(url) {
  if (url.startsWith('/cars/')) {
    const full = path.resolve(PUBLIC_DIR, '.' + url);
    if (!full.startsWith(path.join(PUBLIC_DIR, 'cars') + path.sep) || !fs.existsSync(full)) {
      throw new Error('Image file nahi mili: ' + url);
    }
    return MessageMedia.fromFilePath(full);
  }
  // download fail wali photos ke liye: sirf ajes.com ke links
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { /* ignore */ }
  if (!/(^|\.)ajes\.com$/i.test(host)) throw new Error('Ye image link allowed nahi hai');
  return MessageMedia.fromUrl(url);
}

// Message + saari photos .env wale CLIENT_NUMBER par. Photos lazmi hain.
async function sendCar(text, imageUrls) {
  if (state.status !== 'ready') {
    throw new Error('WhatsApp connected nahi hai. Upar status dekho, aur Troubleshoot mein "WhatsApp Reconnect" dabao.');
  }
  const digits = target();
  if (!digits) throw new Error('.env mein CLIENT_NUMBER likho (jese 923001234567), phir Server Restart karo.');
  if (!imageUrls.length) throw new Error('Is gari ki photos nahi mili, isliye kuch nahi bheja.');
  if (sending) throw new Error('Pehli send abhi chal rahi hai, intezar karo.');

  sending = true;
  const c = client;
  try {
    // pehle saari photos tayyar; koi na mile to kuch bhi nahi jata (adhoora na jaye)
    const medias = [];
    for (const u of imageUrls) medias.push(await toMedia(u));

    const id = await c.getNumberId(digits);
    if (!id) throw new Error('CLIENT_NUMBER (' + digits + ') par WhatsApp nahi hai.');

    for (let i = 0; i < medias.length; i++) {
      try {
        const opts = { sendSeen: false };
        if (i === 0 && text) opts.caption = text; // pehli photo ke sath message
        await c.sendMessage(id._serialized, medias[i], opts);
      } catch (e) {
        throw new Error(i + ' photos ja chuki thin, phir error aaya: ' + e.message + '. Dobara bhejne se pehle client se check kar lo.');
      }
      await sleep(1200);
    }
    return medias.length;
  } finally {
    sending = false;
  }
}

module.exports = { state, start, reconnect, reset, shutdown, sendCar, target };
