'use strict';
const { PLUGIN_NAME, PLATFORM_NAME } = require('./lib/const');
const { GEACPlatform } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GEACPlatform);
};
