// whatsapp-web.js 1.34.7 + naya WhatsApp Web: photo bhejte waqt error aata hai
// "Data passed to getter must include an id property". Library ke ek file mein 1 line
// jodni parti hai. Ye script wo line khud jod deta hai (launcher.js har start par chalata hai).
// Dobara chalane se kuch nahi bigarta, aur "npm install" ke baad bhi khud dobara lag jati hai.
const fs = require('fs');
const path = require('path');

function patch() {
  const file = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
  try {
    if (!fs.existsSync(file)) return console.log('[patch] whatsapp-web.js ki Utils.js nahi mili, patch skip');
    const original = fs.readFileSync(file, 'utf8');
    if (original.includes('delete message.__x_id')) return; // pehle se patched (ya library ne khud theek kar diya)

    const start = original.indexOf('const message = {');
    if (start === -1) return console.log('[patch] pattern nahi mila (library badal gayi hogi), patch skip');
    const lineStart = original.lastIndexOf('\n', start) + 1;
    const indent = original.slice(lineStart, start);
    if (/\S/.test(indent)) return console.log('[patch] file ka format alag hai, patch skip');

    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const closing = eol + indent + '};';
    const end = original.indexOf(closing, start);
    if (end === -1) return console.log('[patch] object ka end nahi mila, patch skip');

    const at = end + closing.length;
    const patched = original.slice(0, at) + eol + indent + 'delete message.__x_id;' + original.slice(at);
    if (!fs.existsSync(file + '.bak')) fs.writeFileSync(file + '.bak', original);
    fs.writeFileSync(file, patched);
    console.log('[patch] whatsapp-web.js photo-send fix laga diya');
  } catch (e) {
    console.log('[patch] fail hua (' + e.message + '), tool phir bhi chalega');
  }
}

module.exports = patch;
if (require.main === module) patch();
