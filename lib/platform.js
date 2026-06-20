'use strict';
const C = require('./const');
const { SmartHQClient } = require('./client');
const { ACAccessory } = require('./accessory');

class GEACPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = []; // restored from cache
    this.configured = new Set();

    const creds = this.config.credentials || {};
    this.username = this.config.username || creds.username;
    this.password = this.config.password || creds.password;
    if (!this.username || !this.password) {
      this.log.error('Missing SmartHQ username/password in config — plugin disabled.');
      return;
    }
    this.client = new SmartHQClient(log, this.username, this.password);
    this.client.on('appliances', (items) => this._setupAppliances(items));

    this.api.on('didFinishLaunching', () => {
      this.log.info('Starting GE SmartHQ client…');
      this.client.start();
    });
    this.api.on('shutdown', () => { if (this.client) this.client.stop(); });
  }

  configureAccessory(accessory) { this.accessories.push(accessory); }

  _setupAppliances(items) {
    const wanted = (this.config.macAddress || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    let ac;
    if (wanted) ac = items.find((i) => i.applianceId.toUpperCase().includes(wanted));
    if (!ac) ac = items.find((i) => /air|cond|\bac\b/i.test(`${i.type} ${i.nickname}`));
    if (!ac) ac = items[0];
    if (!ac) { this.log.warn('No appliances found on SmartHQ account.'); return; }

    const mac = ac.applianceId;
    if (this.configured.has(mac)) return;
    this.configured.add(mac);

    const name = this.config.name || ac.nickname || 'Air Conditioner';
    const uuid = this.api.hap.uuid.generate(`${C.PLUGIN_NAME}:${mac}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (accessory) {
      this.log.info(`Restoring AC "${name}" (${mac}) from cache`);
      accessory.context.mac = mac;
      new ACAccessory(this, accessory, this.client, mac);
    } else {
      this.log.info(`Adding AC "${name}" (${mac})`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.mac = mac;
      new ACAccessory(this, accessory, this.client, mac);
      this.api.registerPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
  }
}

module.exports = { GEACPlatform };
