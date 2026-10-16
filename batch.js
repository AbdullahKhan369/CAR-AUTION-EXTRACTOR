// Auto batch: Pioneer List A ki AGLI gari khud kholo, photos + message tayyar karo, UI ko do.
// Hifazati qawaid (unke server aur apni ID ke liye):
//  - ek waqt mein sirf ek gari, har gari se pehle 6-12 second ka random waqfa
//  - ek "start" par maximum LIMIT (15) gariyan; server khud rok deta hai, UI par bharosa nahi
//  - photos na aayen to ek retry; phir bhi na aayen to batch ruk jata hai (gari skip mark hoti hai)
//  - Pioneer par 2 ya kam photos, ya price na ho -> sirf usi lot ke liye ASNET bhi
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const S = require('./scraper');
const { findAsnetRun } = require('./asnet');
const { buildMessage } = require('./format');
const { getYenPerEur, marginFor } = require('./pricing');

const LIMIT = 15;
const GAP_MIN = 6000;
const GAP_MAX = 12000;
const KEEP_RECENT = 40;
const FILE = path.join(__dirname, 'batch-done.json');

let doneKeys = new Set();
let recent = []; // sab se nayi pehle; page refresh ke baad cards wapis dikhane ke liye
try {
  const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  doneKeys = new Set(Array.isArray(d.done) ? d.done : []);
  recent = Array.isArray(d.recent) ? d.recent : [];
} catch (e) { /* pehli baar */ }

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify({ done: Array.from(doneKeys), recent })); } catch (e) { /* ignore */ }
}
const keyOf = (r) => [r.lot, r.date, r.auction].join('|');

let count = 0;  // is round mein kitni gariyan
let lastAt = 0; // pichli gari kab khatam hui (waqfa isi se napta hai)

function start() {
  count = 0;
  return { limit: LIMIT, count, doneTotal: doneKeys.size };
}
function reset() {
  doneKeys = new Set();
  recent = [];
  count = 0;
  save();
}
const getRecent = () => recent;

async function nextInner() {
  if (count >= LIMIT) return { done: true, reason: 'limit', count, limit: LIMIT };

  if (lastAt) {
    const wait = lastAt + GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN) - Date.now();
    if (wait > 0) await S.sleep(wait);
  }

  const page = await S.getSitePage('pioneer');
  let cache = S.getListCache();
  if (!cache.rows.length || Date.now() - cache.at > S.LIST_TTL) {
    await S.loadListA(page);
    cache = S.getListCache();
    // jo gariyan ab List A mein nahi, unki "done" yaad hata do
    const live = new Set(cache.rows.map(keyOf));
    doneKeys = new Set(Array.from(doneKeys).filter((k) => live.has(k)));
    save();
  }

  const row = cache.rows.find((r) => !doneKeys.has(keyOf(r)));
  if (!row) return { done: true, reason: 'end', count, limit: LIMIT };

  // 1) Pioneer detail page se photos; na aayen to ek retry
  let images = [];
  for (let attempt = 1; attempt <= 2 && !images.length; attempt++) {
    await S.ensureSession(page);
    let urls = row.images;
    try { urls = await S.getDetailImages(page, row); }
    catch (e) { console.error('[batch] detail page nahi khuli:', e.message); }
    try { images = urls && urls.length ? await S.saveImages(row, urls) : []; }
    catch (e) { images = []; }
    if (!images.length && attempt === 1) await S.politeDelay(2500, 4500);
  }

  // 2) 2 ya kam photos, ya price nahi -> sirf isi lot ke liye ASNET
  let source = 'Pioneer';
  let note = '';
  let stop = false;
  if (images.length <= 2 || marginFor(row.avgYen) === null) {
    try {
      const km = String(row.mileage || '').replace(/\D/g, '');
      const r = await findAsnetRun(row.lot, km, { chassis: row.chassis, year: row.year });
      const best = (r.cars || []).find((c) => c.images && c.images.length);
      if (best && best.images.length > images.length) { images = best.images; source = 'ASNET'; }
      else if (r.note) note = 'ASNET: ' + r.note;
    } catch (e) {
      note = 'ASNET error: ' + e.message;
      if (/login/i.test(e.message)) stop = true; // ID ki hifazat: login masle par aage nahi badhna
    }
  }

  const key = keyOf(row);
  count++;
  lastAt = Date.now();

  // 3) kahin se bhi photos nahi: gari skip mark, batch ruk jaye
  if (!images.length) {
    doneKeys.add(key);
    save();
    throw new Error('Lot ' + row.lot + ' ki photos nahi mili (Pioneer par 2 baar koshish, ASNET bhi). Batch ruk gaya aur ye gari skip ho gayi; isay manual search karo.');
  }

  const rate = await getYenPerEur();
  const car = { ...row, images, source, note, message: buildMessage(row, rate) };
  doneKeys.add(key);
  recent.unshift(car);
  recent.length = Math.min(recent.length, KEEP_RECENT);
  save();

  const remaining = cache.rows.filter((r) => !doneKeys.has(keyOf(r))).length;
  return { car, count, limit: LIMIT, remaining, stop };
}

// queue ke andar chalta hai, to manual searches aur batch aapas mein takrate nahi
function next() {
  return S.enqueue(async () => {
    try { return await nextInner(); }
    catch (e) { throw S.friendly(e); }
  });
}

module.exports = { start, next, reset, getRecent, LIMIT };
