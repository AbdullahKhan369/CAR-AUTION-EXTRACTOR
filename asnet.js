// ASNET (www.asnet.jp) se photos: listing number (lot) + mileage match karke gari ki photos.
// Flow: results row par click -> pehla bada modal (#detail_view) -> uski photos + auction sheet.
// Debug: nakaam hone par debug/ folder mein html/png save hoti hain.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  enqueue, friendly, OUT_DIR, getSitePage, loginAllowed, loginFailed, loginOk, touch, sessionFresh, politeDelay, sleep: pause,
} = require('./scraper');

const BASE = 'https://www.asnet.jp/asnet/';
const DEBUG_DIR = path.join(__dirname, 'debug');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dump(name, html) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, name), html);
  } catch (e) { /* ignore */ }
}

const isLoggedIn = (page) =>
  page.evaluate(() => !!document.querySelector('a[href*="/authentication/logout"]') && !document.getElementById('MemberAccount'));

async function ensureLoggedIn(page, force) {
  // pehle se login aur taza session: koi nayi request nahi
  if (!force && page.url().startsWith(BASE) && sessionFresh('asnet') && (await isLoggedIn(page).catch(() => false))) {
    touch('asnet');
    return;
  }
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  if (await isLoggedIn(page)) { touch('asnet'); return; }

  loginAllowed('asnet'); // pichla login fail hua ho to 10 minute ruko
  console.log('[asnet] login ho raha hai...');
  const user = process.env.ASNET_USER;
  const pass = process.env.ASNET_PASS;
  if (!user || !pass) throw new Error('.env mein ASNET_USER (member number) aur ASNET_PASS likho');
  if (!(await page.$('#MemberAccount'))) throw new Error('ASNET ka login page nahi khula');

  await page.type('#MemberAccount', user, { delay: 20 });
  await page.type('#Password', pass, { delay: 20 });
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }),
      page.click('.loginSubmit button'),
    ]);
  } catch (e) { /* neeche check hoga */ }

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  if (!(await isLoggedIn(page))) {
    loginFailed('asnet');
    throw new Error('ASNET login nahi hua. Member number/password check karo (password 180 din baad badalna parta hai)');
  }
  loginOk('asnet');
}

// "6.7万km" / "67,000km" / "67千km" -> numbers (km)
function parseKms(text) {
  const t = String(text).replace(/[\s\u00a0]/g, '');
  const out = [];
  let m;
  const r1 = /([\d.]+)万km/gi;
  while ((m = r1.exec(t))) out.push(Math.round(parseFloat(m[1]) * 10000));
  const r2 = /([\d.]+)千km/gi;
  while ((m = r2.exec(t))) out.push(Math.round(parseFloat(m[1]) * 1000));
  const r3 = /(\d[\d,]*)km/gi;
  while ((m = r3.exec(t))) out.push(parseInt(m[1].replace(/,/g, ''), 10));
  return out.filter((n) => Number.isFinite(n));
}

async function searchLot(page, lot) {
  // "Search by listing number" modal kholo (home aur results dono page par ye link hota hai)
  const openLink = () => page.evaluate(() => {
    const a = document.querySelector('a.searchExhibitionNumberDisplay');
    if (!a) return false;
    a.click();
    return true;
  });
  let opened = await openLink();
  if (!opened) {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
    opened = await openLink();
  }
  if (!opened) throw new Error('ASNET: "Search by listing number" link nahi mila');

  const sel = '#modalSearchExhibitionNumber input[name="AAExhibitionNumbers[0]"]';
  await page.waitForSelector(sel, { visible: true, timeout: 15000 });
  await page.evaluate(() => {
    document.querySelectorAll('#modalSearchExhibitionNumber input[type=text]').forEach((i) => (i.value = ''));
  });
  await page.type(sel, lot, { delay: 30 });

  const nav = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
  await page.click('#modalSearchExhibitionNumberClose');
  await nav;

  try {
    await page.waitForFunction(
      (l) => Array.from(document.querySelectorAll('tr')).some(
        (tr) => !tr.querySelector('tr') && !tr.closest('#detail_view') && /km/i.test(tr.innerText) &&
          Array.from(tr.children).some((td) => td.innerText.trim() === l)),
      { timeout: 30000 },
      lot
    );
  } catch (e) {
    dump('asnet-results.html', await page.content());
    try { await page.screenshot({ path: path.join(DEBUG_DIR, 'asnet-results.png'), fullPage: true }); } catch (x) { /* ignore */ }
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    })).catch(() => ({}));
    return info;
  }
  await sleep(1000);
  return true;
}

// results table ki rows: jis row mein listing number (lot) wala cell aur "km" ho
function collectCandidates(page, lot) {
  return page.evaluate((l) => {
    const out = [];
    const rows = Array.from(document.querySelectorAll('tr')).filter(
      (tr) => !tr.querySelector('tr') && !tr.closest('#detail_view') && /km/i.test(tr.innerText) &&
        Array.from(tr.children).some((td) => td.innerText.trim() === l));
    rows.forEach((tr, i) => {
      const first = tr.children[0]; // A/B/C/D favorite checkboxes yahan hote hain, inhe click nahi karna
      const notFirst = (el) => !first || !first.contains(el);
      const list = [];
      const add = (el) => { if (el && notFirst(el) && !list.includes(el)) list.push(el); };
      // asli link: gari ke naam wala <a class="showDetail"> (HTML se confirm)
      tr.querySelectorAll('a.showDetail').forEach(add);
      tr.querySelectorAll('td.carPhoto img').forEach(add);
      tr.querySelectorAll('a[data-target="detail_view"]').forEach(add);
      tr.querySelectorAll('a.openModal').forEach(add);
      list.forEach((el, k) => el.setAttribute('data-cq', i + '_' + k));

      const kms = [];
      Array.from(tr.children).forEach((td) => {
        const re = /(\d[\d,.]*)[ \t]*(万|千)?[ \t]*km/gi;
        let m;
        while ((m = re.exec(td.innerText))) {
          const n = parseFloat(m[1].replace(/,/g, ''));
          if (!isFinite(n)) continue;
          kms.push(Math.round(m[2] === '万' ? n * 10000 : m[2] === '千' ? n * 1000 : n));
        }
      });
      out.push({ idx: i, targets: list.length, kms, html: tr.outerHTML, text: (tr.innerText || '').replace(/\s+/g, ' ').trim() });
    });
    return out;
  }, lot);
}

const DETAIL = '#detail_view';

// photo ki pehchan: URL ka v1 parameter (size badalne par bhi wahi rehta hai)
const photoKey = (u) => {
  try { return new URL(u).searchParams.get('v1') || u; } catch (e) { return u; }
};

const clickSel = (page, sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.click();
    return true;
  }, sel);

// Pehle bade modal ki photos + auction sheet. Return: [{url, alt, sheet}]
async function openModalPhotos(page, cand) {
  dump('asnet-row.html', cand.html);

  // purana modal band karo (agar khula ho), phir andar ka purana content saaf
  await clickSel(page, DETAIL + ' .floatingHeader .close a');
  await sleep(300);
  await page.evaluate((sel) => {
    const m = document.querySelector(sel);
    const w = m && m.querySelector('.wrap__floating');
    if (w) w.innerHTML = '';
  }, DETAIL);

  let opened = false;
  for (let k = 0; k < cand.targets && !opened; k++) {
    await page.evaluate((tag) => {
      const el = document.querySelector('[data-cq="' + tag + '"]');
      if (el) el.click();
    }, cand.idx + '_' + k);
    try {
      await page.waitForFunction(
        (sel) => document.querySelectorAll(sel + ' .carImage .image img').length > 0,
        { timeout: 8000 },
        DETAIL
      );
      opened = true;
    } catch (e) { /* agla target */ }
  }
  if (!opened) {
    try { await page.screenshot({ path: path.join(DEBUG_DIR, 'asnet-nomodal.png'), fullPage: true }); } catch (x) { /* ignore */ }
    dump('asnet-results.html', await page.content());
    throw new Error('ASNET: gari ki detail window nahi khuli (debug/asnet-row.html aur asnet-nomodal.png dekho)');
  }
  await sleep(1500);
  dump('asnet-detail.html', await page.evaluate((sel) => document.querySelector(sel).outerHTML, DETAIL));

  // 1) bade modal ki photos (medium size) + sheet thumbnail
  const base = await page.evaluate((sel) => {
    const m = document.querySelector(sel);
    const src = (i) => i.currentSrc || i.src;
    return {
      photos: Array.from(m.querySelectorAll('.carImage .image li img')).map(src),
      sheet: (m.querySelector('.carImage .sheet img') ? src(m.querySelector('.carImage .sheet img')) : ''),
    };
  }, DETAIL);

  const seen = new Set();
  const photos = [];
  for (const u of base.photos) {
    const k = photoKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    photos.push({ url: u, alt: u, sheet: false, key: k });
  }

  // 2) photo par click -> "Vehicle image" modal mein bade size ki photos (nakaam ho to medium chalegi)
  try {
    await page.evaluate(() => {
      const w = document.querySelector('#image_view .wrap__floating');
      if (w) w.innerHTML = '';
    });
    if (await clickSel(page, DETAIL + ' .carImage .image a.openImageModal')) {
      await page.waitForFunction(
        () => document.querySelectorAll('#image_view #thumbnail img').length > 0,
        { timeout: 8000 }
      );
      await sleep(800);
      const big = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#image_view #thumbnail img')).map((i) => i.currentSrc || i.src));
      const bigMap = new Map(big.map((u) => [photoKey(u), u]));
      photos.forEach((p) => { if (bigMap.has(p.key)) p.url = bigMap.get(p.key); });
      await clickSel(page, '#image_view .floatingHeader .close a');
      await sleep(400);
    }
  } catch (e) {
    dump('asnet-imagemodal.html', await page.evaluate(() => (document.querySelector('#image_view') || { outerHTML: '' }).outerHTML).catch(() => ''));
    await clickSel(page, '#image_view .floatingHeader .close a');
  }

  // 3) auction sheet: click karke bada version, na mile to thumbnail
  const result = photos.map((p) => ({ url: p.url, alt: p.alt, sheet: false }));
  if (base.sheet) {
    let sheetBig = '';
    try {
      await page.evaluate(() => {
        const w = document.querySelector('#sheet_view .wrap__floating');
        if (w) w.innerHTML = '';
      });
      if (await clickSel(page, DETAIL + ' .carImage .sheet a.openSheetModal')) {
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('#sheet_view img')).some((i) => /ImgGet/.test(i.currentSrc || i.src)),
          { timeout: 8000 }
        );
        await sleep(800);
        dump('asnet-sheetmodal.html', await page.evaluate(() => document.querySelector('#sheet_view').outerHTML));
        sheetBig = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('#sheet_view img'))
            .map((i) => ({ u: i.currentSrc || i.src, w: i.naturalWidth || 0 }))
            .filter((x) => /ImgGet/.test(x.u))
            .sort((a, b) => b.w - a.w);
          return imgs.length ? imgs[0].u : '';
        });
        await clickSel(page, '#sheet_view .floatingHeader .close a');
        await sleep(400);
      }
    } catch (e) {
      await clickSel(page, '#sheet_view .floatingHeader .close a');
    }
    result.push({ url: sheetBig || base.sheet, alt: base.sheet, sheet: true });
  }
  return result;
}

async function download(page, item, fileBase) {
  const tries = Array.from(new Set([item.url, item.alt].filter(Boolean)));
  for (const u of tries) {
    try {
      const cookies = (await page.cookies(u)).map((c) => c.name + '=' + c.value).join('; ');
      const r = await fetch(u, { headers: { Referer: BASE, Cookie: cookies } });
      if (!r.ok) continue;
      const type = r.headers.get('content-type') || '';
      if (!type.startsWith('image/')) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 4000) continue; // icon/placeholder
      const name = fileBase + '.' + (type.includes('png') ? 'png' : 'jpg');
      fs.writeFileSync(name, buf);
      return path.basename(name);
    } catch (e) { /* agla */ }
  }
  return null;
}

// 2016 -> H28, 2020 -> R2
function eraOf(y) {
  y = parseInt(y, 10);
  if (!y) return '';
  if (y >= 2019) return 'R' + (y - 2018);
  if (y >= 1989) return 'H' + (y - 1988);
  return 'S' + (y - 1925);
}

function findAsnet(lotRaw, kmRaw, extra) {
  extra = extra || {};
  return enqueue(async () => {
    const lot = String(parseInt(String(lotRaw).replace(/\D/g, ''), 10));
    if (lot === 'NaN') throw new Error('Lot number sirf digits hona chahiye');
    if (lot.length > 5) throw new Error('ASNET AA listing number 5 digit tak hota hai');
    const km = parseInt(String(kmRaw || '').replace(/\D/g, ''), 10) || 0;

    let page;
    try {
      page = await getSitePage('asnet'); // ek hi page chalta rehta hai, baar baar naya nahi
      await ensureLoggedIn(page);
      await politeDelay(800, 1600);
      let sr = await searchLot(page, lot);
      // session beech mein khatam ho gaya ho to ek baar login karke dobara
      if (sr !== true && !(await isLoggedIn(page).catch(() => false))) {
        await ensureLoggedIn(page, true);
        sr = await searchLot(page, lot);
      }
      if (sr !== true) {
        return { cars: [], note: 'ASNET results nahi dikhe. Page: ' + (sr.title || '?') + ' | ' + (sr.url || '') + ' | Text: ' + (sr.text || '') + ' (debug/asnet-results.png aur .html dekho)' };
      }

      const cands = await collectCandidates(page, lot);
      if (!cands.length) return { cars: [], note: 'Results mein is lot ki gari nahi mili.' };

      // match: mileage (±1000 km) YA chassis + saal
      const chassis = String(extra.chassis || '').toUpperCase().replace(/[\s-]/g, '');
      const era = eraOf(extra.year);
      let chosen;
      if (km || chassis || era) {
        const scored = cands.map((c) => {
          const txt = c.text.toUpperCase();
          const kmDiff = c.kms.length && km ? Math.min(...c.kms.map((k) => Math.abs(k - km))) : Infinity;
          const kmOk = kmDiff <= 1000;
          const chOk = !!chassis && txt.replace(/[\s-]/g, '').includes(chassis);
          const yrOk = !!era && new RegExp('(^|\\s)' + era + '(\\s|$)').test(txt);
          return { ...c, kmDiff, score: (kmOk ? 2 : 0) + (chOk ? 2 : 0) + (yrOk ? 1 : 0), ok: kmOk || (chOk && yrOk) };
        }).sort((a, b) => b.score - a.score || a.kmDiff - b.kmDiff);
        chosen = scored.filter((c) => c.ok).slice(0, 3);
        if (!chosen.length) {
          return {
            cars: [],
            note: cands.length + ' gariyan mili par koi match nahi hui (km ' + (km || '-') + ', chassis ' + (chassis || '-') + ', saal ' + (era || '-') + '). Mileages: ' +
              cands.map((c) => (c.kms[0] != null ? c.kms[0] : '?')).join(', '),
          };
        }
      } else {
        chosen = cands.slice(0, 3);
      }

      const cars = [];
      for (const c of chosen) {
        const items = await openModalPhotos(page, c);
        const dir = 'asnet_' + lot + '_' + (c.kms[0] || 'x') + '_' + Date.now();
        const full = path.join(OUT_DIR, dir);
        fs.mkdirSync(full, { recursive: true });
        const images = [];
        for (let i = 0; i < items.length; i++) {
          const f = await download(page, items[i], path.join(full, String(i + 1).padStart(2, '0')));
          if (f) images.push({ url: '/cars/' + dir + '/' + f, sheet: !!items[i].sheet });
          await pause(300);
        }
        cars.push({ lot, km: c.kms[0] || 0, info: c.text.slice(0, 140), images });
        await politeDelay(600, 1200);
      }
      touch('asnet');
      const empty = cars.every((c) => !c.images.length);
      return { cars, note: empty ? 'Gari mili par photos download nahi hui (debug/asnet-detail.html dekho).' : '' };
    } catch (e) {
      if (page) { try { dump('asnet-error.html', await page.content()); } catch (x) { /* ignore */ } }
      throw friendly(e);
    }
  });
}

module.exports = { findAsnet, parseKms };