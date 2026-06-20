'use strict';
const C = require('./const');

// Build a HeaterCooler + mode switches for one GE AC, bound to the SmartHQ client.
// Capability-aware: temperature range comes from the unit (0x7B06), and Heat is exposed only
// when the unit reports a heating setpoint ERD (0x7002). A cooling-only unit (e.g. AHTT06BC,
// which reports neither heat nor a non-[64,86] range) behaves exactly as the cooling-only build.
class ACAccessory {
  constructor(platform, accessory, client, mac) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.client = client;
    this.mac = mac;
    this.hap = platform.api.hap;
    this.S = this.hap.Service;
    this.Ch = this.hap.Characteristic;
    const name = accessory.displayName;

    // ---- capability detection (state is already populated when we get here) ----
    // heatCapable enables an EXPERIMENTAL, UNTESTED heat path: no heat-capable unit was available to
    // verify it, and 0x7002's encoding is assumed identical to the (verified) 0x7003 cool setpoint.
    this.heatCapable = client.getState(mac, C.ERD.HEAT_TARGET_TEMP) != null;
    this.range = C.decodeRange(client.getState(mac, C.ERD.TEMP_RANGE)); // {minF, maxF}, fallback {64,86}
    this.minC = C.fToC(this.range.minF);
    this.maxC = C.fToC(this.range.maxF);
    this.log.info(`[${name}] ${this.heatCapable ? 'heat+cool' : 'cooling-only'}, range ${this.range.minF}-${this.range.maxF}F`);

    accessory.getService(this.S.AccessoryInformation)
      .setCharacteristic(this.Ch.Manufacturer, 'GE Appliances')
      .setCharacteristic(this.Ch.Model, this.heatCapable ? 'Smart AC (heat/cool)' : 'Smart Window AC')
      .setCharacteristic(this.Ch.SerialNumber, mac);

    // ---- HeaterCooler ----
    const hc = accessory.getService(this.S.HeaterCooler) || accessory.addService(this.S.HeaterCooler, name, 'GEAC_HC');
    this.hc = hc;
    this._configuredName(hc, name);
    const CHCS = this.Ch.CurrentHeaterCoolerState;
    const THCS = this.Ch.TargetHeaterCoolerState;

    hc.getCharacteristic(this.Ch.Active)
      .onGet(() => this._power() ? this.Ch.Active.ACTIVE : this.Ch.Active.INACTIVE)
      .onSet(this._wrap(async (v) => {
        if (v === this.Ch.Active.ACTIVE) {
          if (!this._power()) { await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.ON); await this.client.setErd(this.mac, C.ERD.OPERATION_MODE, this._mode() || C.MODE.COOL); }
        } else if (this._power()) { await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.OFF); }
      }));

    hc.getCharacteristic(CHCS)
      .setProps({ validValues: this.heatCapable ? [CHCS.INACTIVE, CHCS.IDLE, CHCS.HEATING, CHCS.COOLING] : [CHCS.INACTIVE, CHCS.IDLE, CHCS.COOLING] })
      .onGet(() => this._currentState());

    hc.getCharacteristic(THCS)
      .setProps({ validValues: this.heatCapable ? [THCS.HEAT, THCS.COOL] : [THCS.COOL] })
      .onGet(() => this._targetState())
      .onSet(this._wrap(async (v) => {
        if (!this._power()) await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.ON);
        await this.client.setErd(this.mac, C.ERD.OPERATION_MODE, (this.heatCapable && v === THCS.HEAT) ? C.MODE.HEAT : C.MODE.COOL);
      }));

    hc.getCharacteristic(this.Ch.CurrentTemperature)
      .onGet(() => C.fToC(this._ambientF()));

    // Step = exactly 1 degF (5/9 degC), anchored at the unit's min, so the HomeKit grid lands on
    // whole Fahrenheit degrees. minValue/maxValue are COMPUTED so a pushed boundary value equals
    // the prop exactly and HAP never rejects it (the 64F float-boundary lesson).
    const tempProps = { minValue: this.minC, maxValue: this.maxC, minStep: 5 / 9 };
    hc.getCharacteristic(this.Ch.CoolingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this._threshC(C.ERD.TARGET_TEMP))
      .onSet(this._wrap(async (v) => { await this.client.setErd(this.mac, C.ERD.TARGET_TEMP, C.encodeTempF(this._clampF(v))); }));

    if (this.heatCapable) {
      hc.getCharacteristic(this.Ch.HeatingThresholdTemperature)
        .setProps(tempProps)
        .onGet(() => this._threshC(C.ERD.HEAT_TARGET_TEMP))
        .onSet(this._wrap(async (v) => { await this.client.setErd(this.mac, C.ERD.HEAT_TARGET_TEMP, C.encodeTempF(this._clampF(v))); }));
    }

    hc.getCharacteristic(this.Ch.RotationSpeed)
      .onGet(() => this._fanPct())
      .onSet(this._wrap(async (pct) => { await this.client.setErd(this.mac, C.ERD.FAN, this._fanFromPct(pct)); }));

    hc.getCharacteristic(this.Ch.TemperatureDisplayUnits)
      .onGet(() => (this.client.getState(this.mac, C.ERD.TEMP_UNIT) === '01') ? this.Ch.TemperatureDisplayUnits.CELSIUS : this.Ch.TemperatureDisplayUnits.FAHRENHEIT);

    // ---- mode switches ----
    const defs = [
      ['Cool', 'GEAC_COOL', C.MODE.COOL],
      ['Fan Only', 'GEAC_FAN', C.MODE.FAN_ONLY],
      ['Energy Saver', 'GEAC_ECO', C.MODE.ENERGY_SAVER],
      ['Dry', 'GEAC_DRY', C.MODE.DRY],
    ];
    if (this.heatCapable) defs.push(['Heat', 'GEAC_HEAT', C.MODE.HEAT]);
    else { const stale = accessory.getService('GEAC_HEAT'); if (stale) accessory.removeService(stale); } // drop a stale Heat switch on cooling-only units

    this.switches = defs.map(([label, subtype, modeHex]) => {
      const sw = accessory.getService(subtype) || accessory.addService(this.S.Switch, label, subtype);
      this._configuredName(sw, label);
      sw.getCharacteristic(this.Ch.On)
        .onGet(() => this._power() && this._mode() === modeHex)
        .onSet(this._wrap(async (on) => {
          if (on) { if (!this._power()) await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.ON); await this.client.setErd(this.mac, C.ERD.OPERATION_MODE, modeHex); }
          else if (this._power() && this._mode() === modeHex) { await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.OFF); }
        }));
      return { sw, modeHex };
    });

    // live updates
    this._onErd = (m) => { if (m === this.mac) this._pushAll(); };
    client.on('erd', this._onErd);
    this._pushAll(); // seed valid initial values to avoid HAP init warnings
  }

  _configuredName(svc, name) {
    svc.setCharacteristic(this.Ch.Name, name);
    if (!svc.testCharacteristic(this.Ch.ConfiguredName)) svc.addCharacteristic(this.Ch.ConfiguredName);
    svc.getCharacteristic(this.Ch.ConfiguredName).onGet(() => name).updateValue(name);
  }

  // ---- state helpers ----
  _power() { return this.client.getState(this.mac, C.ERD.POWER) === C.POWER.ON; }
  _mode() { return this.client.getState(this.mac, C.ERD.OPERATION_MODE); }
  _isHeatMode() { return this.heatCapable && this._mode() === C.MODE.HEAT; }
  _setpointF(erd) { const v = C.decodeInt(this.client.getState(this.mac, erd)); return (v != null && v >= 45 && v <= 100) ? v : Math.round((this.range.minF + this.range.maxF) / 2); }
  _threshC(erd) { return Math.max(this.minC, Math.min(this.maxC, C.fToC(this._setpointF(erd)))); }
  _clampF(c) { return Math.max(this.range.minF, Math.min(this.range.maxF, Math.round(C.cToF(c)))); }
  _ambientF() { const v = C.decodeInt(this.client.getState(this.mac, C.ERD.AMBIENT_TEMP)); return (v != null && v >= 32 && v <= 120) ? v : this._setpointF(C.ERD.TARGET_TEMP); }
  _targetState() { return this._isHeatMode() ? this.Ch.TargetHeaterCoolerState.HEAT : this.Ch.TargetHeaterCoolerState.COOL; }
  _currentState() {
    const CHCS = this.Ch.CurrentHeaterCoolerState;
    if (!this._power()) return CHCS.INACTIVE;
    if (this._isHeatMode()) return (this._ambientF() < this._setpointF(C.ERD.HEAT_TARGET_TEMP)) ? CHCS.HEATING : CHCS.IDLE;
    return (this._ambientF() > this._setpointF(C.ERD.TARGET_TEMP)) ? CHCS.COOLING : CHCS.IDLE;
  }
  _fanPct() {
    const n = C.decodeInt(this.client.getState(this.mac, C.ERD.FAN));
    if (n == null) return 0;
    if (n >= 8) return 100; if (n >= 4) return 66; if (n >= 2) return 33; return 0; // 0/1 => AUTO
  }
  _fanFromPct(p) { if (p <= 0) return C.FAN.AUTO; if (p <= 33) return C.FAN.LOW; if (p <= 66) return C.FAN.MED; return C.FAN.HIGH; }

  _pushAll() {
    const u = (c, v) => { try { this.hc.updateCharacteristic(c, v); } catch (e) { /* ignore */ } };
    u(this.Ch.Active, this._power() ? this.Ch.Active.ACTIVE : this.Ch.Active.INACTIVE);
    u(this.Ch.TargetHeaterCoolerState, this._targetState());
    u(this.Ch.CurrentHeaterCoolerState, this._currentState());
    u(this.Ch.CurrentTemperature, C.fToC(this._ambientF()));
    u(this.Ch.CoolingThresholdTemperature, this._threshC(C.ERD.TARGET_TEMP));
    if (this.heatCapable) u(this.Ch.HeatingThresholdTemperature, this._threshC(C.ERD.HEAT_TARGET_TEMP));
    u(this.Ch.RotationSpeed, this._fanPct());
    for (const { sw, modeHex } of this.switches) {
      try { sw.updateCharacteristic(this.Ch.On, this._power() && this._mode() === modeHex); } catch (e) { /* ignore */ }
    }
  }

  _wrap(fn) {
    return async (v) => {
      try { await fn(v); }
      catch (e) {
        this.log.warn(`[${this.accessory.displayName}] set failed: ${e.message}`);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    };
  }
}

module.exports = { ACAccessory };
