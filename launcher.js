// "npm start" yahi chalata hai. Ye server.js ko chalata hai aur:
//  - frontend ka "Server Restart" button (exit code 42) par server dobara chalata hai
//  - server crash ho jaye to 3 second baad khud dobara chalata hai
const { spawn } = require('child_process');
const path = require('path');
require('./patch-wa')(); // whatsapp-web.js ka photo-send bug theek (har start par)

let child = null;
let stopping = false;
let crashes = [];

function run() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, LAUNCHED_BY: 'launcher' },
  });
  child.on('exit', (code) => {
    child = null;
    if (stopping || code === 0) process.exit(0);
    if (code === 42) {
      console.log('\n[launcher] Server restart ho raha hai...\n');
      return setTimeout(run, 500);
    }
    if (code === 43) process.exit(1); // port/config masla, dobara try bekaar
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60000);
    crashes.push(now);
    if (crashes.length > 5) {
      console.log('[launcher] Server baar baar crash ho raha hai, ruk gaya. Upar ka error dekho.');
      process.exit(1);
    }
    console.log(`[launcher] Server crash hua (code ${code}). 3 second mein dobara chalega...`);
    setTimeout(run, 3000);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) process.exit(0);
  setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 20000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run();