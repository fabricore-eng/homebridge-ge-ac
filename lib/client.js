'use strict';
const EventEmitter = require('events');
const axios = require('axios');
const WebSocket = require('ws');
const C = require('./const');
const auth = require('./auth');

// SmartHQClient: owns auth + the realtime websocket. Emits:
//   'appliances' (items[])           — appliance list received
//   'erd' (mac, erdNorm, value)      — an ERD value updated (live)
//   'status' (text)                  — connection status for logging
class SmartHQClient extends EventEmitter {
  constructor(log, username, password) {
    super();
    this.log = log;
    this.username = username;
    this.password = password;
    this.token = null;
    this.refreshToken = null;
    this.userId = null;
    this.endpoint = null;
    this.ws = null;
    this.state = new Map(); // mac -> { erdNorm: value }
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.reconnectDelay = C.RECONNECT_BASE_MS;
    this.stopped = false;
    this.connecting = false;
    this._timers = { keepalive: null, relist: null, refresh: null, reconnect: null };
  }

  start() { this._connect(false); }

  stop() {
    this.stopped = true;
    for (const k of Object.keys(this._timers)) if (this._timers[k]) clearTimeout(this._timers[k]) || clearInterval(this._timers[k]);
    if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ }
  }

  getState(mac, erd) {
    const m = this.state.get(mac);
    return m ? m[C.normErd(erd)] : undefined;
  }

  async _connect(viaRefresh) {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    if (this._timers.reconnect) { clearTimeout(this._timers.reconnect); this._timers.reconnect = null; }
    try {
      // 1. token
      if (viaRefresh && this.refreshToken) {
        this.log.debug('refreshing token');
        try { this._setToken(await auth.refresh(this.refreshToken)); }
        catch (e) { if (e.invalidGrant) { this.log.info('refresh token expired, full re-login'); this._setToken(await auth.login(this.username, this.password)); } else throw e; }
      } else {
        this.log.debug('logging in to SmartHQ');
        this._setToken(await auth.login(this.username, this.password));
      }
      // 2. websocket credentials
      const creds = (await axios.get(`${C.API_URL}/v1/websocket`, { headers: { authorization: `Bearer ${this.token}` }, timeout: 30000, validateStatus: () => true }));
      if (creds.status >= 400 || !creds.data || !creds.data.endpoint) {
        if (creds.status === 401 || creds.status === 403) { this.token = null; this.refreshToken = null; }
        throw new Error(`GET /v1/websocket -> ${creds.status}`);
      }
      this.endpoint = creds.data.endpoint;
      this.userId = creds.data.userId;
      // 3. connect
      this._openSocket();
    } catch (e) {
      this.connecting = false;
      this.log.warn(`connect failed: ${e.message}`);
      this._scheduleReconnect();
    }
  }

  _setToken(tok) {
    this.token = tok.access_token;
    if (tok.refresh_token) this.refreshToken = tok.refresh_token;
    const ms = ((tok.expires_in || 3600) * 1000) - C.REFRESH_SKEW_MS;
    if (this._timers.refresh) clearTimeout(this._timers.refresh);
    this._timers.refresh = setTimeout(() => { this.log.debug('token refresh timer'); this._reconnect(true); }, Math.max(ms, 60000));
  }

  _openSocket() {
    const ws = new WebSocket(this.endpoint);
    this.ws = ws;
    ws.on('open', () => {
      this.connecting = false;
      this.reconnectDelay = C.RECONNECT_BASE_MS;
      this.log.info('SmartHQ websocket connected');
      this.emit('status', 'connected');
      this._send({ kind: 'websocket#subscribe', action: 'subscribe', resources: ['/appliance/*/erd/*'] });
      this._send(this._api('GET', '/v1/appliance', 'List-appliances'));
      if (this._timers.keepalive) clearInterval(this._timers.keepalive);
      this._timers.keepalive = setInterval(() => this._send({ kind: 'websocket#ping', id: 'keepalive-ping', action: 'ping' }), C.KEEPALIVE_MS);
      if (this._timers.relist) clearInterval(this._timers.relist);
      this._timers.relist = setInterval(() => this._send(this._api('GET', '/v1/appliance', 'List-appliances')), C.RELIST_MS);
    });
    ws.on('message', (raw) => { try { this._process(JSON.parse(raw.toString())); } catch (e) { this.log.debug(`msg parse: ${e.message}`); } });
    ws.on('error', (e) => this.log.debug(`ws error: ${e.message}`));
    ws.on('close', () => {
      this.connecting = false;
      if (this._timers.keepalive) { clearInterval(this._timers.keepalive); this._timers.keepalive = null; }
      if (this._timers.relist) { clearInterval(this._timers.relist); this._timers.relist = null; }
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) { this.emit('status', 'disconnected'); this.log.warn('SmartHQ websocket closed; reconnecting'); this._scheduleReconnect(); }
    });
  }

  _reconnect(viaRefresh) {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this._viaRefresh = viaRefresh;
    if (!this.connecting) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || this._timers.reconnect) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, C.RECONNECT_MAX_MS);
    this._timers.reconnect = setTimeout(() => { this._timers.reconnect = null; this._connect(this._viaRefresh !== false); }, delay);
  }

  _api(method, path, id, body) {
    const m = { kind: 'websocket#api', action: 'api', host: C.API_HOST, method, path, id };
    if (body) m.body = body;
    return m;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { this.log.debug(`send failed: ${e.message}`); return false; }
  }

  _process(m) {
    if ((m.code === 401 || m.code === 403) || m.reason === 'Access token expired') { this.log.info('socket auth expired; refreshing'); this.token = null; this._reconnect(true); return; }
    const kind = m.kind;
    if (kind === 'websocket#api' && m.body && m.body.kind === 'appliance#applianceList') {
      const items = m.body.items || [];
      this.emit('appliances', items);
      for (const it of items) this._send(this._api('GET', `/v1/appliance/${it.applianceId}/erd`, `${it.applianceId}-allErd`));
      return;
    }
    if (kind === 'websocket#api' && m.body && m.body.kind === 'appliance#erdList') {
      // id is "{mac}-allErd"
      const mac = (m.id || '').replace(/-allErd$/, '');
      for (const it of (m.body.items || [])) this._apply(mac, it.erd, it.value);
      this.emit('ready', mac); // full state for this appliance is now in this.state
      return;
    }
    if (kind === 'publish#erd' && m.item) {
      this._apply(m.item.applianceId, m.item.erd, m.item.value);
      return;
    }
    if (kind === 'websocket#api' && typeof m.id === 'string' && m.id.includes('-setErd-')) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        const ok = (m.success === undefined || m.success === true) && (m.code === undefined || m.code === 200);
        if (ok) p.resolve(); else p.reject(new Error(`setErd rejected: code=${m.code} success=${m.success}`));
      }
      return;
    }
  }

  _apply(mac, erd, value) {
    if (!mac) return;
    const e = C.normErd(erd);
    let s = this.state.get(mac);
    if (!s) { s = {}; this.state.set(mac, s); }
    if (s[e] === value) return;
    s[e] = value;
    this.emit('erd', mac, e, value);
  }

  // setErd over the websocket; resolves on backend ack. Optimistically applies locally for snappy UI.
  setErd(mac, erd, value) {
    const e = C.normErd(erd);
    const id = `${mac}-setErd-${e}`;
    const body = { kind: 'appliance#erdListEntry', userId: this.userId, applianceId: mac, erd: e, value, ackTimeout: 10, delay: 0 };
    const sent = this._send(this._api('POST', `/v1/appliance/${mac}/erd/${e}`, id, body));
    if (!sent) return Promise.reject(new Error('websocket not connected'));
    this._apply(mac, e, value); // optimistic; publish#erd will confirm/correct
    return new Promise((resolve, reject) => {
      const old = this.pending.get(id);
      if (old) { clearTimeout(old.timer); old.reject(new Error('superseded')); }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('setErd ack timeout')); }, C.SETERD_ACK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

module.exports = { SmartHQClient };
