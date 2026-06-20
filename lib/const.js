'use strict';

// Plugin identity
const PLUGIN_NAME = 'homebridge-ge-ac';
const PLATFORM_NAME = 'GEProfileAC';

// GE SmartHQ / Brillion endpoints + OAuth client (from simbaja/gehome const.py)
const LOGIN_URL = 'https://accounts.brillion.geappliances.com';
const API_URL = 'https://api.brillion.geappliances.com';
const API_HOST = 'api.brillion.geappliances.com';
const CLIENT_ID = '564c31616c4f7474434b307435412b4d2f6e7672';
const CLIENT_SECRET = '6476512b5246446d452f697154444941387052645938466e5671746e5847593d';
const REDIRECT_URI = 'brillion.4e617a766474657344444e562b5935566e51324a://oauth/redirect';
const REGION_COOKIE = 'us-east-1';

// Timing
const KEEPALIVE_MS = 30000;
const RELIST_MS = 600000;
const REFRESH_SKEW_MS = 120000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const SETERD_ACK_TIMEOUT_MS = 10000;

// AC ERD codes (gehome canonical, normalized to "0x" + uppercase digits to match the wire)
const ERD = {
  TARGET_TEMP: '0x7003', // R/W 2-byte BE degrees F
  OPERATION_MODE: '0x7A01', // R/W 1-byte enum
  AMBIENT_TEMP: '0x7A02', // R   1-byte degrees F
  POWER: '0x7A0F', // R/W "00"/"01"
  FAN: '0x7A00', // R/W enum
  TEMP_UNIT: '0x0007', // R   "00"=F "01"=C (panel only)
  FILTER: '0x7A04', // R   "00"=ok "01"=change
};

const POWER = { OFF: '00', ON: '01' };
const MODE = { COOL: '00', FAN_ONLY: '01', ENERGY_SAVER: '02', HEAT: '03', DRY: '04' };
const FAN = { AUTO: '01', LOW: '02', MED: '04', HIGH: '08' };

// encode/decode
const decodeInt = (v) => {
  const n = parseInt(v, 16);
  return Number.isNaN(n) ? null : n;
};
const encodeTempF = (f) => Math.round(f).toString(16).padStart(4, '0').toLowerCase(); // 72 -> "0048"
const fToC = (f) => (f - 32) * 5 / 9;
const cToF = (c) => (c * 9 / 5) + 32;

// normalize an erd code to the on-wire form "0x" + UPPER digits ("0x7A01")
const normErd = (code) => code.toUpperCase().replace('0X', '0x');

module.exports = {
  PLUGIN_NAME, PLATFORM_NAME,
  LOGIN_URL, API_URL, API_HOST, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REGION_COOKIE,
  KEEPALIVE_MS, RELIST_MS, REFRESH_SKEW_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS, SETERD_ACK_TIMEOUT_MS,
  ERD, POWER, MODE, FAN,
  decodeInt, encodeTempF, fToC, cToF, normErd,
};
