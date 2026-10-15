const { JSDOM } = require('jsdom');
const { extractRows } = require('./extract');
const { buildMessage } = require('./format');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/test-fixture.html', 'utf8');

function run(h) {
  const dom = new JSDOM(h, { runScripts: 'outside-only' });
  return dom.window.eval('(' + extractRows.toString() + ')()');
}

let bad = 0;
const check = (name, got, want) => {
  if (got !== want) { console.log('MISMATCH', name, JSON.stringify(got), '!=', JSON.stringify(want)); bad++; }
};

// 1) asli row (fixture)
const rows = run(html);
const r = rows[0];
console.log(JSON.stringify(r, null, 2));
const expect = { lot: '247', date: '12.10.2026', auction: 'JU Tokyo', model: 'MITSUBISHI CHALLENGER', year: '1996', chassis: 'K96W', grade: '4WD X', cc: '3000', gearbox: 'FA', equipment: 'AC', colour: 'RED', fuel: '', mileage: '408000 km', rating: '3', startYen: 30000, avgYen: 0, avgText: '' };
for (const k in expect) check(k, r[k], expect[k]);
if (r.images.length !== 3) { console.log('MISMATCH images', r.images.length); bad++; }
// avg price Pioneer par nahi -> sirf euro ka nishan
check('message', buildMessage(r), 'MITSUBISHI CHALLENGER 1996 RED\nK96W 4WD X\nFA 3000 cc\n408000 km\nGrade 3\n€');

// 2) fuel detection: row mein HYBRID likha ho
const hy = run(html.replace('FULLTIME4WD,PARTTIME', 'HYBRID'))[0];
check('fuel hybrid', hy.fuel, 'Hybrid');

// 3) avg price maujood ho (hidden div ka 4th hissa)
const av = run(html.replace('yen|30000|0|0', 'yen|30000|0|1250000'))[0];
check('avgYen', av.avgYen, 1250000);
// 1,250,000 + 410,000 = 1,660,000 yen / 177 = 9378 -> 9400 -> 9100€ to 9700€
check('avg message', buildMessage(av, 177).split('\n').pop(), '9100€ to 9700€');
check('avg rate nahi', buildMessage(av, 0).split('\n').pop(), '€ (exchange rate nahi mila)');
check('avg 30 lac se upar', buildMessage({ ...av, avgYen: 3500000 }, 177).split('\n').pop(), 'Price unknown');

// 3b) margin table + user ka example
const { marginFor, eurRange, priceRange } = require('./pricing');
check('margin 310000', 310000 + marginFor(310000), 680000);
check('margin 600000', marginFor(600000), 370000);
check('margin 600001', marginFor(600001), 390000);
check('margin 1000000', marginFor(1000000), 390000);
check('margin 1000001', marginFor(1000001), 410000);
check('margin 3000000', marginFor(3000000), 480000);
check('margin 3000001', marginFor(3000001), null);
const ex = eurRange(710000, 176.7); // 4018 EUR -> 4000 -> 3700 / 4300
check('example eur', ex.eur, 4018);
check('example low', ex.low, 3700);
check('example high', ex.high, 4300);
check('priceRange', priceRange(340000, 177).finalYen, 710000);

// 4) user ke diye hue 2 example (exact format, ab aakhir mein avg line)
check('honda', buildMessage({ model: 'HONDA FIT', year: '2016', colour: 'NAVY BLUE', chassis: 'GP5', grade: 'L PACKAGE', gearbox: 'FA', cc: '1500', fuel: 'Hybrid', mileage: '67000 km', rating: '4.5' }),
  'HONDA FIT 2016 NAVY BLUE\nGP5 L PACKAGE\nFA 1500 cc Hybrid\n67000 km\nGrade 4.5\n€');
check('yaris', buildMessage({ model: 'TOYOTA YARIS', year: '2020', colour: 'grey', chassis: 'MXPH10', grade: 'Hybrid G', gearbox: 'FAT', cc: '1500', fuel: 'Hybrid', mileage: '41000 km', rating: 'R' }),
  'TOYOTA YARIS 2020 grey\nMXPH10 Hybrid G\nFAT 1500 cc Hybrid\n41000 km\nGrade R\n€');

console.log(bad ? 'FAILED' : 'ALL OK');
process.exit(bad ? 1 : 0);