'use strict';
// GE SmartHQ OAuth2 authorization-code login (form scrape) + refresh.
// Ported verbatim from the proven PoC / simbaja gehome async_login_flows.py.
const axios = require('axios');
const cheerio = require('cheerio');
const C = require('./const');

function makeJar() {
  const jar = { abgea_region: C.REGION_COOKIE };
  const header = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    for (const line of sc) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  };
  const req = async (cfg) => {
    cfg.headers = Object.assign({ Cookie: header() }, cfg.headers || {});
    cfg.maxRedirects = 0;
    cfg.validateStatus = () => true;
    cfg.timeout = 30000;
    const res = await axios(cfg);
    absorb(res);
    return res;
  };
  return { req };
}

function formInputs(html, formId) {
  const $ = cheerio.load(html);
  const out = {};
  $(`form#${formId}`).find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (name) out[name] = $(el).attr('value') || '';
  });
  return out;
}
function codeFromLocation(loc) {
  if (!loc) return null;
  try { return new URL(loc, C.LOGIN_URL).searchParams.get('code'); } catch { return null; }
}

async function handleResponse(req, res, depth = 0) {
  if (depth > 10) throw new Error('login: too many redirects');
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.location || '';
    const code = codeFromLocation(loc);
    if (code) return code;
    const next = new URL(loc, C.LOGIN_URL).toString();
    return handleResponse(req, await req({ method: 'GET', url: next }), depth + 1);
  }
  if (res.status === 200) {
    const html = res.data;
    if (/addMfaForm|Multi-Factor Authentication|\/account\/active\/security\/add\/mfamethod/.test(html)) {
      const f = formInputs(html, 'addMfaForm');
      if (!Object.keys(f).length) throw new Error('MFA enrollment required — configure/disable MFA in the SmartHQ app, then restart Homebridge');
      return handleResponse(req, await req({ method: 'POST', url: `${C.LOGIN_URL}/account/active/redirect`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(f).toString() }), depth + 1);
    }
    if (/\/oauth2\/terms\/accept/.test(html)) {
      const $ = cheerio.load(html); const f = {};
      $('form input').each((_, el) => { const n = $(el).attr('name'); if (n) f[n] = $(el).attr('value') || ''; });
      f.developerTerms = 'on'; f.connected_terms = 'on';
      return handleResponse(req, await req({ method: 'POST', url: `${C.LOGIN_URL}/oauth2/terms/accept`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(f).toString() }), depth + 1);
    }
    const f = formInputs(html, 'frmsignin');
    if ('authorized' in f) {
      f.authorized = 'yes';
      return handleResponse(req, await req({ method: 'POST', url: `${C.LOGIN_URL}/oauth2/code`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(f).toString() }), depth + 1);
    }
    const $ = cheerio.load(html);
    const alert = $('#alert_pane').text().trim();
    throw new Error(alert ? `auth failed: ${alert}` : 'auth failed: unexpected login page');
  }
  throw new Error(`login: unexpected status ${res.status}`);
}

async function login(username, password) {
  const { req } = makeJar();
  const params = new URLSearchParams({ client_id: C.CLIENT_ID, response_type: 'code', access_type: 'offline', redirect_uri: C.REDIRECT_URI });
  const page = await req({ method: 'GET', url: `${C.LOGIN_URL}/oauth2/auth?${params}` });
  if (page.status >= 400) throw new Error(`GET /oauth2/auth -> ${page.status}`);
  const post = formInputs(page.data, 'frmsignin');
  if (!Object.keys(post).length) throw new Error('login page had no #frmsignin form');
  post.username = String(username).trim();
  post.password = password;
  const res = await req({ method: 'POST', url: `${C.LOGIN_URL}/oauth2/g_authenticate`, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: C.LOGIN_URL }, data: new URLSearchParams(post).toString() });
  if (res.status >= 400 && res.status < 500) throw new Error(`g_authenticate -> ${res.status} (check username/password)`);
  const code = await handleResponse(req, res);
  return exchange(req, new URLSearchParams({ code, client_id: C.CLIENT_ID, client_secret: C.CLIENT_SECRET, redirect_uri: C.REDIRECT_URI, grant_type: 'authorization_code' }));
}

async function refresh(refreshToken) {
  const { req } = makeJar();
  return exchange(req, new URLSearchParams({ refresh_token: refreshToken, client_id: C.CLIENT_ID, client_secret: C.CLIENT_SECRET, redirect_uri: C.REDIRECT_URI, grant_type: 'refresh_token' }));
}

async function exchange(req, body) {
  const basic = Buffer.from(`${C.CLIENT_ID}:${C.CLIENT_SECRET}`).toString('base64');
  const tok = await req({ method: 'POST', url: `${C.LOGIN_URL}/oauth2/token`, headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, data: body.toString() });
  if (tok.status >= 400 || !tok.data || !tok.data.access_token) {
    const err = new Error(`token endpoint -> ${tok.status}: ${JSON.stringify(tok.data).slice(0, 160)}`);
    err.invalidGrant = tok.data && tok.data.error === 'invalid_grant';
    throw err;
  }
  return tok.data; // { access_token, refresh_token, expires_in, ... }
}

module.exports = { login, refresh };
