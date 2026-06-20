'use strict';
// Exercises lib/auth.js + lib/client.js end-to-end against the live account.
const fs = require('fs');
const { SmartHQClient } = require('./lib/client');
const C = require('./lib/const');

const log = {
  info: (...a) => console.log('I', ...a),
  warn: (...a) => console.log('W', ...a),
  debug: (...a) => (process.env.DEBUG ? console.log('D', ...a) : null),
  error: (...a) => console.log('E', ...a),
};

const cfg = JSON.parse(fs.readFileSync(process.env.HB_CONFIG || '/var/lib/homebridge/config.json', 'utf8'));
const plat = (cfg.platforms || []).find((p) => p.platform === 'SmartHQ' && p.credentials) || {};
const cred = plat.credentials || {};
if (!cred.username) { console.error('no SmartHQ creds in config'); process.exit(1); }

const TEST_F = parseInt(process.env.TEST_F || '74', 10);
const client = new SmartHQClient(log, cred.username, cred.password);
let mac = null;

const done = (ok, msg) => { console.log(ok ? `\n✅ SMOKE PASS: ${msg}` : `\n❌ SMOKE FAIL: ${msg}`); client.stop(); process.exit(ok ? 0 : 1); };
const timer = setTimeout(() => done(false, 'no setpoint confirmation within 40s'), 40000);

client.on('appliances', (items) => {
  const ac = items.find((i) => /air|cond|\bac\b/i.test(`${i.type} ${i.nickname}`)) || items[0];
  if (ac) { mac = ac.applianceId; log.info(`AC mac=${mac}`); }
});

let sent = false;
client.on('erd', (m, erd, val) => {
  if (m !== mac) return;
  if (erd === C.ERD.TARGET_TEMP) log.info(`target -> ${C.decodeInt(val)}F (raw ${val})`);
  // once we have power+mode+target, fire the test write
  if (!sent && mac && client.getState(mac, C.ERD.TARGET_TEMP) != null) {
    sent = true;
    const want = C.encodeTempF(TEST_F);
    log.info(`setErd target ${TEST_F}F (hex ${want}) via client…`);
    client.setErd(mac, C.ERD.TARGET_TEMP, want)
      .then(() => log.info('setErd ack OK'))
      .catch((e) => done(false, `setErd ack: ${e.message}`));
  }
  // confirm the round-trip
  if (sent && erd === C.ERD.TARGET_TEMP && C.decodeInt(val) === TEST_F) {
    clearTimeout(timer);
    done(true, `client setErd confirmed: target now ${TEST_F}F`);
  }
});

client.start();
