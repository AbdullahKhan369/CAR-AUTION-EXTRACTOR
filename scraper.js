require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { extractRows } = require('./extract');

const BASE = 'https://pioneercarauc.ajes.com';
const ROW_SEL = 'tr[id^="aj_view"]:not(#aj_view00)';
const OUT_DIR = path.join(__dirname, 'public', 'cars');

let browserPromise = null;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// unke server par halka bojh: requests ke beech thora random waqfa
const politeDelay = (min = 1000, max = 2000) => sleep(min + Math.random() * (max - min));

// purane gari-photos ke folder (7 din se purane) startup par saaf, taake disk na bhare
(function cleanOldCars() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const limit = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(OUT_DIR)) {
      const full = path.join(OUT_DIR, name);
      if (fs.statSync(full).mtimeMs < limit) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch (e) { /* ignore */ }
})();

// ek waqt mein sirf ek lot search ho (warna browser page aapas mein takra jata hai)
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

/* ---------- Session / login control (Pioneer + ASNET dono) ---------- */
// Har site ka ek hi page chalta rehta hai, aur login ki yaad memory mein rehti hai.
// Login sirf tab hota hai jab sach mein logout ho; fail ho to 10 minute tak dobara koshish nahi
// (taake galat password se baar baar try karke ID lock/ban na ho).
const sessions = {};
const S = (name) => (sessions[name] = sessions[name] || { page: null, loggedAt: 0, failedAt: 0 });
const LOGIN_COOLDOWN = 10 * 60 * 1000;
const SESSION_TRUST = 20 * 60 * 1000;

async function getSitePage(name) {
  const s = S(name);
  let alive = false;
  try { alive = !!s.page && !s.page.isClosed() && s.page.browser().isConnected(); } catch (e) { alive = false; }
  if (alive) return s.page;
  s.page = null;
  s.loggedAt = 0; // naya page: cookies browser mein hain, bas ek baar check hoga
  const browser = await getBrowser();
  s.page = await browser.newPage();
  return s.page;
}
function loginAllowed(name) {
  const s = S(name);
  if (s.failedAt && Date.now() - s.failedAt < LOGIN_COOLDOWN) {
    const m = Math.ceil((LOGIN_COOLDOWN - (Date.now() - s.failedAt)) / 60000);
    throw new Error(name + ' ka login pehle fail hua tha. ID lock se bachne ke liye ' + m + ' minute ruko, aur .env mein user/password check karo.');
  }
}
const loginFailed = (name) => { const s = S(name); s.failedAt = Date.now(); s.loggedAt = 0; };
const loginOk = (name) => { const s = S(name); s.failedAt = 0; s.loggedAt = Date.now(); };
const touch = (name) => { S(name).loggedAt = Date.now(); };
const sessionFresh = (name) => Date.now() - S(name).loggedAt < SESSION_TRUST;
const forgetSessions = () => { Object.keys(sessions).forEach((k) => delete sessions[k]); };

function getBrowser() {
  if (!browserPromise) {
    const p = puppeteer.launch({
      headless: process.env.SHOW_BROWSER !== '1',
      userDataDir: path.join(__dirname, 'chrome-profile'), // login yahan yaad rehta hai
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox'],
      protocolTimeout: 200000,
    });
    browserPromise = p;
    // window band ho jaye ya launch fail ho to agli search naya browser kholay
    p.then((b) => b.on('disconnected', () => { if (browserPromise === p) { browserPromise = null; forgetSessions(); } }))
      .catch(() => { if (browserPromise === p) browserPromise = null; });
  }
  return browserPromise;
}

async function closeBrowser() {
  const p = browserPromise;
  browserPromise = null;
  forgetSessions();
  if (p) {
    try { const b = await p; await b.close(); } catch (e) { /* ignore */ }
  }
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK_CHANGED|ERR_PROXY|ERR_TIMED_OUT/.test(m)) {
    return new Error('Internet ya VPN ka masla: website khul nahi rahi. Net check karo aur dobara try karo.');
  }
  if (/timeout|timed out/i.test(m)) {
    return new Error('Website bohat slow hai (timeout). Thori der baad dobara try karo.');
  }
  return e;
}

/* ---------- Pioneer login ---------- */
const isLoggedIn = (page) =>
  page.evaluate(() => typeof is_auth !== 'undefined' && String(is_auth) === '1');

const readAuth = (page) =>
  page.evaluate(() => (typeof is_auth !== 'undefined' ? String(is_auth) : '')).catch(() => '');

// page pehle se /japan par hona chahiye
async function doLogin(page) {
  loginAllowed('pioneer');
  const user = process.env.AJES_USER;
  const pass = process.env.AJES_PASS;
  if (!user || !pass) throw new Error('.env file mein AJES_USER aur AJES_PASS likho');

  console.log('[pioneer] login ho raha hai...');
  // page mein 2 login forms hote hain, dono mein value daal do
  await page.evaluate((u, p) => {
    document.querySelectorAll('input[name=username]').forEach((i) => (i.value = u));
    document.querySelectorAll('input[name=password]').forEach((i) => (i.value = p));
  }, user, pass);

  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.evaluate(() => doLoad_login()), // site ka apna login function
    ]);
  } catch (e) {
    loginFailed('pioneer');
    throw new Error('Login nahi hua. Username/password check karo');
  }
  await page.goto(BASE + '/japan', { waitUntil: 'networkidle2', timeout: 60000 });
  if (!(await isLoggedIn(page))) {
    loginFailed('pioneer');
    throw new Error('Login nahi hua. Username/password check karo');
  }
  loginOk('pioneer');
}

// /japan khol kar dekho; login hai to bas, warna login
async function gotoHome(page) {
  await page.goto(BASE + '/japan', { waitUntil: 'networkidle2', timeout: 60000 });
  if (await isLoggedIn(page)) { touch('pioneer'); return; }
  await doLogin(page);
}

// sasta check: koi nayi request nahi, jab tak shak na ho
async function ensureSession(page) {
  if (page.url().startsWith(BASE)) {
    const a = await readAuth(page);
    if (a === '1') { touch('pioneer'); return; }
    if (a === '' && sessionFresh('pioneer')) return;
  } else if (sessionFresh('pioneer')) {
    return;
  }
  await gotoHome(page);
}

// first row ko "tag" karo, phir intezar karo jab tak list reload ho jaye
async function waitListChange(page) {
  await page.waitForFunction(
    (sel) => {
      const first = document.querySelector(sel);
      return first && first !== window.__tag;
    },
    { timeout: 30000 },
    ROW_SEL
  );
}
const tagFirstRow = (page) =>
  page.evaluate((sel) => { window.__tag = document.querySelector(sel); }, ROW_SEL);

async function openListA(page) {
  const clicked = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find((x) => x.textContent.trim() === 'List A');
    if (!a) return false;
    a.click();
    return true;
  });
  if (!clicked) throw new Error('"List A" button nahi mila (login check karo)');

  // jab tak "LIST A" bar na aaye aur rows na aa jayen
  await page.waitForFunction(
    (sel) => {
      const st = document.querySelector('#aj_stats');
      return st && st.textContent.includes('LIST A') && document.querySelector(sel);
    },
    { timeout: 40000 },
    ROW_SEL
  );

  // 50 rows per page karne ki koshish (kam pages = tez). Na ho to koi masla nahi.
  try {
    await tagFirstRow(page);
    const ok = await page.evaluate(() => {
      const b = document.getElementById('list_size_50');
      if (!b || b.style.textDecoration === 'underline') return false;
      b.click();
      return true;
    });
    if (ok) await waitListChange(page);
  } catch (e) { /* ignore */ }
}

async function goNextPage(page, currentPage) {
  await tagFirstRow(page);
  const moved = await page.evaluate((n) => {
    const links = Array.from(document.querySelectorAll('a.navi1'));
    const a = links.find((x) => x.textContent.trim() === String(n));
    if (!a) return false;
    a.click();
    return true;
  }, currentPage + 1);
  if (!moved) return false;
  await waitListChange(page);
  return true;
}

const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

/* ---------- List A cache: har lot par poori list dobara nahi khangalni ---------- */
let listCache = { at: 0, rows: [] };
const LIST_TTL = 10 * 60 * 1000;        // itni der cache chalega
const LIST_REFRESH_MIN = 30 * 1000;     // lot na mile to bhi 30 second se pehle dobara list nahi kholni

async function loadListA(page) {
  await gotoHome(page);
  await openListA(page);
  const rows = [];
  let pageNo = 1;
  while (pageNo <= 40) {
    rows.push(...(await page.evaluate(extractRows)));
    await politeDelay(800, 1500);
    const more = await goNextPage(page, pageNo);
    if (!more) break;
    pageNo++;
  }
  listCache = { at: Date.now(), rows };
  console.log('[pioneer] List A load hui: ' + rows.length + ' gariyan');
  return rows;
}
const hitsFor = (lot) => listCache.rows.filter((r) => norm(r.lot) === norm(lot));

async function getDetailImages(page, row) {
  await page.goto(new URL(row.href, BASE + '/').href, { waitUntil: 'networkidle2', timeout: 60000 });
  if ((await readAuth(page)) === '0') {
    S('pioneer').loggedAt = 0; // agli baar login check hoga
    throw new Error('session khatam');
  }
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[id^="thumb"]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => h.includes('ajes.com/imgs/'))
  );
  const unique = Array.from(new Set(hrefs));
  return unique.length ? unique : row.images;
}

async function download(url, file) {
  const r = await fetch(url, { headers: { Referer: BASE + '/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = r.headers.get('content-type') || '';
  const ext = type.includes('png') ? 'png' : 'jpg';
  const full = file + '.' + ext;
  fs.writeFileSync(full, Buffer.from(await r.arrayBuffer()));
  return path.basename(full);
}

async function saveImages(row, urls) {
  const safeDate = (row.date || 'nodate').replace(/[^\d]/g, '-');
  const folder = `${row.lot}_${safeDate}`.replace(/[^\w-]/g, '_');
  const dir = path.join(OUT_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const sheetUrl = row.images[2]; // list mein 3rd photo = auction sheet
  const result = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const name = String(i + 1).padStart(2, '0');
    let src = url; // download fail ho to direct link dikha do
    try { src = `/cars/${folder}/${await download(url, path.join(dir, name))}`; } catch (e) { /* remote */ }
    result.push({ url: src, sheet: url === sheetUrl });
    await sleep(200);
  }
  return result;
}

function findLot(lot) {
  return enqueue(async () => {
    try {
      const page = await getSitePage('pioneer');

      const age = Date.now() - listCache.at;
      let hits = listCache.rows.length && age < LIST_TTL ? hitsFor(lot) : [];
      if (!hits.length && (!listCache.at || age > LIST_REFRESH_MIN)) {
        await loadListA(page);
        hits = hitsFor(lot);
      }
      if (!hits.length) return [];

      await ensureSession(page);
      // har car ka detail page kholo (saari photos ke liye)
      const cars = [];
      for (const row of hits) {
        let urls = row.images;
        try {
          urls = await getDetailImages(page, row);
        } catch (e) { console.error('Detail page photos nahi mili, list wali use hongi:', e.message); }
        const images = await saveImages(row, urls);
        cars.push({ ...row, images });
        await politeDelay(500, 1000);
      }
      return cars;
    } catch (e) {
      throw friendly(e);
    }
  });
}

module.exports = {
  findLot, closeBrowser, getBrowser, enqueue, friendly, OUT_DIR,
  getSitePage, loginAllowed, loginFailed, loginOk, touch, sessionFresh, politeDelay, sleep,
  // batch.js ke liye
  ensureSession, loadListA, getDetailImages, saveImages, LIST_TTL, getListCache: () => listCache,
};
