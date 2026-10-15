// Gari ka chhota message (sirf zaroori info). Server aur test dono yahi use karte hain.
//   HONDA FIT 2016 NAVY BLUE
//   GP5 L PACKAGE
//   FA 1500 cc Hybrid
//   67000 km
//   Grade 4.5
//   3700€ to 4300€     <- avg price + margin, euro mein, +-300
const { marginFor, priceRange } = require('./pricing');

// avg nahi -> sirf "€"; 30 lac se upar -> "Price unknown"; rate na mile -> saaf nishani (bhejne se pehle dikhe)
function priceLine(c, yenPerEur) {
  const avg = Number(c.avgYen) || 0;
  if (avg <= 0) return '€';
  if (marginFor(avg) === null) return 'Price unknown';
  if (!(yenPerEur > 0)) return '€ (exchange rate nahi mila)';
  const r = priceRange(avg, yenPerEur);
  return r.low + '€ to ' + r.high + '€';
}

function buildMessage(c, yenPerEur) {
  const line1 = [c.model, c.year, c.colour].filter(Boolean).join(' ');
  const line2 = [c.chassis, c.grade].filter(Boolean).join(' ');
  const line3 = [c.gearbox, c.cc ? c.cc + ' cc' : '', c.fuel].filter(Boolean).join(' ');
  const line4 = c.mileage || '';
  const line5 = c.rating ? 'Grade ' + c.rating : '';
  return [line1, line2, line3, line4, line5, priceLine(c, yenPerEur)].filter(Boolean).join('\n');
}
module.exports = { buildMessage };