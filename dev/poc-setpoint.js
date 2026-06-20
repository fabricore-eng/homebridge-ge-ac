#!/usr/bin/env node
/*
 * GE SmartHQ AC setpoint PoC — proves WebSocket setErd writes are honored.
 * Flow (all reverse-engineered from simbaja/gehome):
 *   1. OAuth2 auth-code login (form scrape) -> access_token
 *   2. GET /v1/websocket (bearer) -> { endpoint, userId }
 *   3. WS connect -> subscribe -> List-appliances -> pick AC -> allErd
 *   4. setErd 0x7003 = target temp -> await ack + publish#erd round-trip
 * Exit 0 on confirmed setpoint change; non-zero with the failing step otherwise.
 */
'use strict';
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const WebSocket = require('ws');

// ---- constants (gehome const.py) ----
const LOGIN_URL = 'https://accounts.brillion.geappliances.com';
const API_URL = 'https://api.brillion.geappliances.com';
const API_HOST = 'api.brillion.geappliances.com';
const CLIENT_ID = '564c31616c4f7474434b307435412b4d2f6e7672';
const CLIENT_SECRET = '6476512b5246446d452f697154444941387052645938466e5671746e5847593d';
const REDIRECT_URI = 'brillion.4e617a766474657344444e562b5935566e51324a://oauth/redirect';
const REGION_COOKIE = 'us-east-1';

const POC_TEMP = parseInt(process.env.POC_TEMP || '72', 10); // distinct from current
const POC_MAC = process.env.POC_MAC || '';
const CONFIG = process.env.HB_CONFIG || '/var/lib/homebridge/config.json';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (step, msg) => { console.error(`\n[POC-FAIL @ ${step}] ${msg}`); process.exit(1); };

// ---- manual cookie jar ----
const jar = { abgea_region: REGION_COOKIE };
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return;
  for (const line of sc) {
    const pair = line.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function req(cfg) {
  cfg.headers = Object.assign({ Cookie: cookieHeader() }, cfg.headers || {});
  cfg.maxRedirects = 0;
  cfg.validateStatus = () => true;
  const res = await axios(cfg);
  absorb(res);
  return res;
}

// ---- 1. OAuth login ----
function formInputs(html, formId) {
  const $ = cheerio.load(html);
  const form = $(`form#${formId}`);
  const out = {};
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (name) out[name] = $(el).attr('value') || '';
  });
  return out;
}
function codeFromLocation(loc) {
  if (!loc) return null;
  try { return new URL(loc, LOGIN_URL).searchParams.get('code'); } catch { return null; }
}

async function handleResponse(res, depth = 0) {
  if (depth > 10) fail('login', 'too many redirects');
  const status = res.status;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location || '';
    const code = codeFromLocation(loc);
    if (code) return code;
    const next = new URL(loc, LOGIN_URL).toString();
    log('  follow redirect ->', next.replace(/\?.*/, '?…'));
    return handleResponse(await req({ method: 'GET', url: next }), depth + 1);
  }
  if (status === 200) {
    const html = res.data;
    // MFA enrollment
    if (/addMfaForm|Multi-Factor Authentication|\/account\/active\/security\/add\/mfamethod/.test(html)) {
      log('  interstitial: MFA enrollment -> declining');
      const f = formInputs(html, 'addMfaForm');
      if (!Object.keys(f).length) { fs.writeFileSync('/tmp/poc-mfa.html', html); fail('login', 'MFA enrollment required but no addMfaForm; saved /tmp/poc-mfa.html. Configure/disable MFA in SmartHQ and retry.'); }
      return handleResponse(await req({ method: 'POST', url: `${LOGIN_URL}/account/active/redirect`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(f).toString() }), depth + 1);
    }
    // Terms acceptance
    if (/\/oauth2\/terms\/accept/.test(html)) {
      log('  interstitial: terms acceptance -> accepting');
      const $ = cheerio.load(html); const f = {};
      $('form input').each((_, el) => { const n = $(el).attr('name'); if (n) f[n] = $(el).attr('value') || ''; });
      f.developerTerms = 'on'; f.connected_terms = 'on';
      return handleResponse(await req({ method: 'POST', url: `${LOGIN_URL}/oauth2/terms/accept`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(f).toString() }), depth + 1);
    }
    // App authorization
    const f = formInputs(html, 'frmsignin');
    if ('authorized' in f) {
      log('  interstitial: app authorization -> yes');
      f.authorized = 'yes';
      return handleResponse(await req({ method: 'POST', url: `${LOGIN_URL}/oauth2/code`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(f).toString() }), depth + 1);
    }
    const $ = cheerio.load(html);
    const alert = $('#alert_pane').text().trim();
    fs.writeFileSync('/tmp/poc-login.html', html);
    fail('login', alert ? `auth failed: ${alert}` : 'unexpected login HTML (saved /tmp/poc-login.html)');
  }
  fail('login', `unexpected status ${status}`);
}

async function login(username, password) {
  log('1. OAuth login…');
  const params = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', access_type: 'offline', redirect_uri: REDIRECT_URI });
  const page = await req({ method: 'GET', url: `${LOGIN_URL}/oauth2/auth?${params}` });
  if (page.status >= 400) fail('login', `GET /oauth2/auth -> ${page.status}`);
  const post = formInputs(page.data, 'frmsignin');
  if (!Object.keys(post).length) { fs.writeFileSync('/tmp/poc-login.html', page.data); fail('login', 'no #frmsignin form on login page (saved /tmp/poc-login.html)'); }
  post.username = username.trim();
  post.password = password;
  const res = await req({ method: 'POST', url: `${LOGIN_URL}/oauth2/g_authenticate`, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: LOGIN_URL }, data: new URLSearchParams(post).toString() });
  if (res.status >= 400 && res.status < 500) fail('login', `g_authenticate -> ${res.status} (bad credentials?)`);
  const code = await handleResponse(res);
  log('  got auth code');
  // token exchange (body params + Basic auth, per gehome)
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tok = await req({ method: 'POST', url: `${LOGIN_URL}/oauth2/token`, headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }).toString() });
  if (tok.status >= 400 || !tok.data.access_token) fail('login', `token exchange -> ${tok.status}: ${JSON.stringify(tok.data).slice(0,200)}`);
  log(`  token OK (expires_in=${tok.data.expires_in}s)`);
  return tok.data.access_token;
}

// ---- encode ----
const encTemp = f => Math.round(f).toString(16).padStart(4, '0').toLowerCase();
const decInt = v => parseInt(v, 16);

// ---- main ----
(async () => {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const plat = (cfg.platforms || []).find(p => p.platform === 'SmartHQ' && p.credentials);
  if (!plat) fail('config', 'no SmartHQ platform with credentials in config.json');
  const { username, password } = plat.credentials;
  log(`config: user=${username.replace(/(.).*(@.*)/, '$1***$2')}`);

  const token = await login(username, password);

  log('2. GET /v1/websocket…');
  const ws1 = await req({ method: 'GET', url: `${API_URL}/v1/websocket`, headers: { authorization: `Bearer ${token}` } });
  if (ws1.status >= 400 || !ws1.data.endpoint) fail('websocket-creds', `GET /v1/websocket -> ${ws1.status}: ${JSON.stringify(ws1.data).slice(0,200)}`);
  const endpoint = ws1.data.endpoint;
  const userId = ws1.data.userId;
  log(`  endpoint host=${new URL(endpoint).host} userId=${userId}`);

  log('3. WS connect…');
  const ws = new WebSocket(endpoint);
  const send = o => { log('  -> ' + (o.id || o.action || o.kind)); ws.send(JSON.stringify(o)); };
  const api = (method, path, id, body) => ({ kind: 'websocket#api', action: 'api', host: API_HOST, method, path, id, ...(body ? { body } : {}) });

  let mac = POC_MAC, sentSet = false, gotAck = false;
  const setId = () => `${mac}-setErd-0x7003`;
  const wantHex = encTemp(POC_TEMP);
  const timeout = setTimeout(() => fail('confirm', `no publish#erd round-trip within 25s (gotAck=${gotAck}). WS write likely NOT honored for this unit.`), 25000);

  ws.on('open', () => {
    log('  WS open');
    send({ kind: 'websocket#subscribe', action: 'subscribe', resources: ['/appliance/*/erd/*'] });
    send(api('GET', '/v1/appliance', 'List-appliances'));
  });
  ws.on('error', e => fail('ws', `socket error: ${e.message}`));
  ws.on('close', (c) => log(`  WS closed (${c})`));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.code && [401, 403].includes(m.code)) fail('ws', `auth rejected on socket: code ${m.code} ${m.reason || ''}`);

    if (m.kind === 'websocket#api' && m.body && m.body.kind === 'appliance#applianceList') {
      const items = m.body.items || [];
      log(`  appliances: ${items.map(i => `${i.applianceId}(${i.type ?? '?'}${i.nickname ? ',' + i.nickname : ''},${i.online || i.connected || '?'})`).join(' | ')}`);
      if (!mac) {
        const acm = items.find(i => /air|cond|\bac\b/i.test(`${i.type} ${i.nickname}`)) || items[0];
        if (!acm) fail('discover', 'no appliances on account');
        mac = acm.applianceId;
      }
      log(`  using AC mac=${mac}`);
      send(api('GET', `/v1/appliance/${mac}/erd`, `${mac}-allErd`));
      return;
    }
    if (m.kind === 'websocket#api' && m.body && m.body.kind === 'appliance#erdList') {
      const map = {}; for (const it of (m.body.items || [])) map[it.erd] = it.value;
      const cur = map['0x7003'] ?? map['0x7003'.toUpperCase()];
      log(`  current: target=0x7003 raw=${cur} (${cur != null ? decInt(cur) + 'F' : '?'}) power=${map['0x7A0F']} mode=${map['0x7A01']} ambient=${map['0x7A02'] != null ? decInt(map['0x7A02']) + 'F' : '?'}`);
      if (!sentSet) {
        sentSet = true;
        log(`4. setErd 0x7003 -> ${POC_TEMP}F (hex ${wantHex})`);
        send(api('POST', `/v1/appliance/${mac}/erd/0x7003`, setId(),
          { kind: 'appliance#erdListEntry', userId, applianceId: mac, erd: '0x7003', value: wantHex, ackTimeout: 10, delay: 0 }));
      }
      return;
    }
    if (m.kind === 'websocket#api' && m.id === setId()) {
      gotAck = true;
      const ok = (m.success === undefined || m.success === true) && (m.code === undefined || m.code === 200);
      log(`  setErd ACK: success=${m.success} code=${m.code} -> ${ok ? 'accepted' : 'REJECTED'}`);
      if (!ok) fail('write', `setErd rejected by backend: ${JSON.stringify(m).slice(0,300)}`);
      return;
    }
    if (m.kind === 'publish#erd' && m.item && /\/erd\/0x7003$/i.test(m.resource || '')) {
      const v = m.item.value;
      log(`  publish#erd 0x7003 -> raw=${v} (${decInt(v)}F)`);
      if (decInt(v) === Math.round(POC_TEMP)) {
        clearTimeout(timeout);
        log(`\n✅ CONFIRMED: AC target temp is now ${decInt(v)}F (raw ${v}). WebSocket setErd writes ARE honored.`);
        ws.close(); process.exit(0);
      }
    }
  });
})().catch(e => fail('exception', e.stack || e.message));
