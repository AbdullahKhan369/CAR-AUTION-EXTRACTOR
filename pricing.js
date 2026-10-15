// Quote price: Pioneer ki average price (yen) + hamara margin -> euro mein convert -> rounding -> -300 / +300.
//   710000 yen -> 4018 EUR -> round 4000 -> "3700€ to 4300€"
const fs = require('fs');
const path = require('path');

// [yen ki upar ki had (inclusive), margin yen mein]
const BRACKETS = [
  [600000, 370000],
  [1000000, 390000],
  [1500000, 410000],
  [2000000, 430000],
  [2500000, 457500],
  [3000000, 480000],
];
const SPREAD_EUR = 300;   // final euro price se itna kam / zyada
const ROUND_TO = 100;     // euro ko nazdeeki 100 par round (4018 -> 4000)

// avg yen -> margin. 30 lac se upar (ya galat value) ho to null = "price unknown"
function marginFor(avgYen) {
  const y = Number(avgYen);
  if (!isFinite(y) || y <= 0) return null;
  for (const [limit, margin] of BRACKETS) if (y <= limit) return margin;
  return null;
}

// margin ke baad wali yen price + rate (1 euro = ? yen) -> { eur, rounded, low, high }
function eurRange(finalYen, yenPerEur) {
  const eur = finalYen / yenPerEur;
  const rounded = Math.round(eur / ROUND_TO) * ROUND_TO;
  return { eur: Math.round(eur), rounded, low: rounded - SPREAD_EUR, high: rounded + SPREAD_EUR };
}

// avg yen -> poora result (null agar price unknown)
function priceRange(avgYen, yenPerEur) {
  const margin = marginFor(avgYen);
  if (margin === null) return null;
  const finalYen = Number(avgYen) + margin;
  return { margin, finalYen, ...eurRange(finalYen, yenPerEur) };
}

/* ---------- live exchange rate (1 EUR = ? JPY) ---------- */
const CACHE_FILE = path.join(__dirname, 'rate-cache.json');
const TTL = 6 * 60 * 60 * 1000; // 6 ghante
let mem = { rate: 0, at: 0 };

try {
  const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (c && c.rate > 0) mem = c;
} catch (e) { /* pehli baar */ }

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchRate() {
  try {
    const d = await getJson('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=JPY'); // ECB rate
    const v = d && d.rates && d.rates.JPY;
    if (v > 50 && v < 500) return v;
  } catch (e) { /* agla source */ }
  try {
    const d = await getJson('https://open.er-api.com/v6/latest/JPY');
    const eurPerYen = d && d.rates && d.rates.EUR;
    if (eurPerYen > 0) {
      const v = 1 / eurPerYen;
      if (v > 50 && v < 500) return v;
    }
  } catch (e) { /* neeche */ }
  return 0;
}

// .env mein EUR_RATE=177 likho to wahi use hoga (internet band ho ya khud fix karna ho)
async function getYenPerEur() {
  const manual = parseFloat(process.env.EUR_RATE);
  if (manual > 0) return manual;
  if (mem.rate > 0 && Date.now() - mem.at < TTL) return mem.rate;
  const fresh = await fetchRate();
  if (fresh > 0) {
    mem = { rate: fresh, at: Date.now() };
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(mem)); } catch (e) { /* ignore */ }
    console.log('[rate] 1 EUR = ' + fresh.toFixed(2) + ' JPY');
    return fresh;
  }
  if (mem.rate > 0) {
    console.error('[rate] naya rate nahi mila, purana use ho raha hai');
    return mem.rate;
  }
  return 0;
}

module.exports = { marginFor, eurRange, priceRange, getYenPerEur, BRACKETS };
