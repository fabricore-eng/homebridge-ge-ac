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
    this.acMac = null;
    this.acName = null;
    this.client = new SmartHQClient(log, this.username, this.password);
    // Pick the AC from the appliance list, but defer building until its full state arrives
    // ('ready') so we can read capabilities (heat support, temp range) up front.
    this.client.on('appliances', (items) => this._pickAc(items));
    this.client.on('ready', (mac) => { if (mac === this.acMac) this._buildAc(mac); });

    this.api.on('didFinishLaunching', () => {
      this.log.info('Starting GE SmartHQ client…');
      this.client.start();
    });
    this.api.on('shutdown', () => { if (this.client) this.client.stop(); });
  }

  configureAccessory(accessory) { this.accessories.push(accessory); }

  _pickAc(items) {
    if (this.acMac) return; // already chosen
    const wanted = (this.config.macAddress || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    let ac;
    if (wanted) ac = items.find((i) => i.applianceId.toUpperCase().includes(wanted));
    if (!ac) ac = items.find((i) => /air|cond|\bac\b/i.test(`${i.type} ${i.nickname}`));
    if (!ac) ac = items[0];
    if (!ac) { this.log.warn('No appliances found on SmartHQ account.'); return; }
    this.acMac = ac.applianceId;
    this.acName = this.config.name || ac.nickname || 'Air Conditioner';
  }

  _buildAc(mac) {
    if (this.configured.has(mac)) return;
    this.configured.add(mac);
    const name = this.acName || 'Air Conditioner';
    const uuid = this.api.hap.uuid.generate(`${C.PLUGIN_NAME}:${mac}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (accessory) {
      this.log.info(`Restoring AC "${name}" (${mac}) from cache`);
      accessory.context.mac = mac;
      new ACAccessory(this, accessory, this.client, mac);
      this.api.updatePlatformAccessories([accessory]); // persist service changes (e.g. added Fan, removed stale chars)
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
