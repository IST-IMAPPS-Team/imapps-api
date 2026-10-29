const path = require('node:path');

const { loadConfig } = require('../gateway/config/load-config');
const { createApiRouter } = require('./router');

// config.json lives in the project folder (next to package.json), whatever folder PM2 starts in.
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

// Mounts the new API under /api. Without a config file the new API stays off and
// the legacy routes keep working; a config file that is wrong stops the start.
module.exports = (app, options = {}) => {
    const log = options.log || console;
    const loaded = options.config
        ? { found: true, config: options.config }
        : loadConfig({ env: process.env, defaultPath: options.defaultPath || DEFAULT_CONFIG_PATH });

    if (!loaded.found) {
        log.info(`[api] no config file at ${loaded.path}: the new API is off, the legacy routes are unchanged`);
        return false;
    }

    app.use('/api', createApiRouter(loaded.config, options));
    return true;
};
