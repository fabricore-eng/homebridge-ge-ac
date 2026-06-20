'use strict';
const C = require('./const');

// Build a HeaterCooler + 4 mode switches for one GE AC, bound to the SmartHQ client.
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

    accessory.getService(this.S.AccessoryInformation)
      .setCharacteristic(this.Ch.Manufacturer, 'GE Appliances')
      .setCharacteristic(this.Ch.Model, 'Smart Window AC')
      .setCharacteristic(this.Ch.SerialNumber, mac);

    // ---- HeaterCooler ----
    const hc = accessory.getService(this.S.HeaterCooler) || accessory.addService(this.S.HeaterCooler, name, 'GEAC_HC');
    this.hc = hc;
    this._configuredName(hc, name);

    hc.getCharacteristic(this.Ch.Active)
      .onGet(() => this._power() ? this.Ch.Active.ACTIVE : this.Ch.Active.INACTIVE)
      .onSet(this._wrap(async (v) => {
        if (v === this.Ch.Active.ACTIVE) {
          if (!this._power()) { await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.ON); await this.client.setErd(this.mac, C.ERD.OPERATION_MODE, this._mode() || C.MODE.COOL); }
        } else if (this._power()) { await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.OFF); }
      }));

    hc.getCharacteristic(this.Ch.CurrentHeaterCoolerState)
      .setProps({ validValues: [this.Ch.CurrentHeaterCoolerState.INACTIVE, this.Ch.CurrentHeaterCoolerState.IDLE, this.Ch.CurrentHeaterCoolerState.COOLING] })
      .onGet(() => this._currentState());

    hc.getCharacteristic(this.Ch.TargetHeaterCoolerState)
      .setProps({ validValues: [this.Ch.TargetHeaterCoolerState.COOL] })
      .onGet(() => this.Ch.TargetHeaterCoolerState.COOL)
      .onSet(this._wrap(async () => {
        if (!this._power()) await this.client.setErd(this.mac, C.ERD.POWER, C.POWER.ON);
        await this.client.setErd(this.mac, C.ERD.OPERATION_MODE, C.MODE.COOL);
      }));

    hc.getCharacteristic(this.Ch.CurrentTemperature)
      .onGet(() => C.fToC(this._ambientF()));

    hc.getCharacteristic(this.Ch.CoolingThresholdTemperature)
      .setProps({ minValue: 17.7, maxValue: 30, minStep: 0.5 }) // 17.7C ~= 64F floor; below fToC(64)=17.7777 to avoid boundary rejection
      .onGet(() => this._coolThreshC())
      .onSet(this._wrap(async (v) => {
        let f = Math.round(C.cToF(v));
        f = Math.max(64, Math.min(86, f));
        await this.client.setErd(this.mac, C.ERD.TARGET_TEMP, C.encodeTempF(f));
      }));

    hc.getCharacteristic(this.Ch.RotationSpeed)
      .onGet(() => this._fanPct())
      .onSet(this._wrap(async (pct) => { await this.client.setErd(this.mac, C.ERD.FAN, this._fanFromPct(pct)); }));

    hc.getCharacteristic(this.Ch.TemperatureDisplayUnits)
      .onGet(() => (this.client.getState(this.mac, C.ERD.TEMP_UNIT) === '01') ? this.Ch.TemperatureDisplayUnits.CELSIUS : this.Ch.TemperatureDisplayUnits.FAHRENHEIT);

    // ---- mode switches (no HEAT; cooling-only unit) ----
    this.switches = [
      ['Cool', 'GEAC_COOL', C.MODE.COOL],
      ['Fan Only', 'GEAC_FAN', C.MODE.FAN_ONLY],
      ['Energy Saver', 'GEAC_ECO', C.MODE.ENERGY_SAVER],
      ['Dry', 'GEAC_DRY', C.MODE.DRY],
    ].map(([label, subtype, modeHex]) => {
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

    // remove a stale HEAT switch if a previous version created one
    const stale = accessory.getService('GEAC_HEAT');
    if (stale) accessory.removeService(stale);

    // live updates
    this._onErd = (mac) => { if (mac === this.mac) this._pushAll(); };
    client.on('erd', this._onErd);
  }

  _configuredName(svc, name) {
    svc.setCharacteristic(this.Ch.Name, name);
    if (!svc.testCharacteristic(this.Ch.ConfiguredName)) svc.addCharacteristic(this.Ch.ConfiguredName);
    svc.getCharacteristic(this.Ch.ConfiguredName).onGet(() => name).updateValue(name);
  }

  _power() { return this.client.getState(this.mac, C.ERD.POWER) === C.POWER.ON; }
  _mode() { return this.client.getState(this.mac, C.ERD.OPERATION_MODE); }
  _targetF() { const v = C.decodeInt(this.client.getState(this.mac, C.ERD.TARGET_TEMP)); return (v != null && v >= 60 && v <= 90) ? v : 72; }
  // cooling-threshold in Celsius, clamped to the characteristic's valid band so a boundary
  // float (e.g. fToC(64)=17.7777 vs a 17.7778 min) can never be rejected by HAP
  _coolThreshC() { return Math.max(17.7, Math.min(30, C.fToC(this._targetF()))); }
  _ambientF() { const v = C.decodeInt(this.client.getState(this.mac, C.ERD.AMBIENT_TEMP)); return (v != null && v >= 32 && v <= 120) ? v : this._targetF(); }
  _currentState() {
    if (!this._power()) return this.Ch.CurrentHeaterCoolerState.INACTIVE;
    return (this._ambientF() > this._targetF()) ? this.Ch.CurrentHeaterCoolerState.COOLING : this.Ch.CurrentHeaterCoolerState.IDLE;
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
    u(this.Ch.CurrentHeaterCoolerState, this._currentState());
    u(this.Ch.CurrentTemperature, C.fToC(this._ambientF()));
    u(this.Ch.CoolingThresholdTemperature, this._coolThreshC());
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
