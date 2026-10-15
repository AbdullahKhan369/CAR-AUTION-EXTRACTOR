// Ye function browser ke andar chalta hai (List A ki har row se data nikalta hai).
// Koi bahar ka variable use nahi hona chahiye, warna puppeteer mein nahi chalega.
function extractRows() {
  const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = document.querySelectorAll('tr[id^="aj_view"]:not(#aj_view00)');
  const out = [];
  rows.forEach((row) => {
    const bidA = row.querySelector('td.ffix_bid a.my_bids');
    if (!bidA) return;
    const lot = clean(bidA.textContent);
    const href = bidA.getAttribute('href');

    // auction date + name (sirf screen par pehchan ke liye, message mein nahi jata)
    const timeTd = row.querySelector('td.ffix_time');
    const dateNode = timeTd && timeTd.querySelector('nobr') && timeTd.querySelector('nobr').childNodes[0];
    const date = clean(dateNode && dateNode.textContent);
    const aucNobr = timeTd && timeTd.querySelector('span[style*="word-break"] nobr');
    const auction = clean(aucNobr && aucNobr.textContent);

    const cells = row.children;
    // model / year / chassis / grade
    const c3 = cells[3];
    const model = clean(c3 && c3.querySelector('span[style*="6db3eb"]') && c3.querySelector('span[style*="6db3eb"]').textContent);
    const yc = c3 && c3.querySelector('span[style*="a93f15"]');
    const year = clean(yc && yc.childNodes[0] && yc.childNodes[0].textContent);
    const chassis = clean(yc && yc.querySelector('font') && yc.querySelector('font').textContent);
    const grade = clean(c3 && c3.querySelector('.grade_hide') && c3.querySelector('.grade_hide').textContent);

    // engine / gearbox / equipment / colour
    const c4 = cells[4];
    const c4text = clean(c4 && c4.textContent);
    const ccMatch = c4text.match(/(\d{3,5})\s*cc/i);
    const cc = ccMatch ? ccMatch[1] : '';
    const gearbox = clean(c4 && c4.querySelector('span font') && c4.querySelector('span font').textContent);
    const equipment = clean(c4 && c4.querySelector('.aj_equip') && c4.querySelector('.aj_equip').textContent);
    const small = c4 ? Array.from(c4.querySelectorAll('span[style*="#aaa"]')).map((s) => clean(s.textContent)) : [];
    const colourRaw = small[0] || '';
    const colour = colourRaw.replace(/\s+\d+$/, ''); // "RED 2" -> "RED"

    // fuel: model/grade/engine wale hisse mein lafz dhoondo (Hybrid, Diesel ...)
    const hay = clean((c3 ? c3.textContent : '') + ' ' + (c4 ? c4.textContent : ''));
    let fuel = '';
    if (/hybrid/i.test(hay)) fuel = 'Hybrid';
    else if (/diesel/i.test(hay)) fuel = 'Diesel';
    else if (/\belectric\b|\bEV\b/i.test(hay)) fuel = 'Electric';
    else if (/\bLPG\b/i.test(hay)) fuel = 'LPG';

    // mileage / condition
    const c5 = cells[5];
    const mileageRaw = clean(c5 && c5.querySelector('nobr') && c5.querySelector('nobr').textContent);
    const mileage = mileageRaw.replace(/(\d)\s+(?=\d)/g, '$1'); // "67 000 km" -> "67000 km"
    const rating = clean(c5 && c5.querySelector('.mileage_fix2 b') && c5.querySelector('.mileage_fix2 b').textContent);

    // price: hidden div "yen|start|sold|avg"
    const pr = row.querySelector('div[id^="Fcurr0"]');
    const parts = pr ? pr.textContent.split('|') : [];
    const startYen = parseInt(parts[1], 10) || 0;
    const soldYen = parseInt(parts[2], 10) || 0;
    const avgYen = parseInt(parts[3], 10) || 0;

    // average price: site ne jo screen par likha ho wo (hidden div ke baghair)
    const avgTd = row.querySelector('td.ffix_average');
    let avgText = '';
    if (avgTd) {
      const cl = avgTd.cloneNode(true);
      cl.querySelectorAll('[id^="Fcurr0"], [style*="display:none"], [style*="display: none"]').forEach((n) => n.remove());
      avgText = clean(cl.textContent);
    }

    // photos in the row (usually 2 photos + auction sheet as 3rd)
    const images = Array.from(row.querySelectorAll('td.ffix_photo a.aj_resize'))
      .map((a) => a.getAttribute('href'))
      .filter(Boolean);

    out.push({ lot, href, date, auction, model, year, chassis, grade, cc, gearbox, equipment, colour, colourRaw, fuel, mileage, rating, startYen, soldYen, avgYen, avgText, images });
  });
  return out;
}
module.exports = { extractRows };