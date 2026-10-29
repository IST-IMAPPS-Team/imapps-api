const { ApiError } = require('../../api/errors');

// One connection pool per profile, created on the first call. Nothing connects at start-up.
exports.createPoolRegistry = ({ profiles, sql, log = console }) => {
    const pools = new Map(); // profile name -> Promise of a connected pool

    const configFor = (p) => {
        const config = {
            server: p.server,
            port: p.port,
            database: p.database,
            user: p.user,
            password: p.password,
            connectionTimeout: 15000,
            // The longest per-call timeout; each call sets its own (single or multi) on top of this.
            requestTimeout: Math.max(p.dataTimeoutSeconds, p.multiTimeoutSeconds) * 1000,
            pool: { max: p.poolMax, min: 0, idleTimeoutMillis: 30000 },
            options: { encrypt: p.encrypt, trustServerCertificate: p.trustServerCertificate, appName: 'imapps-api' }
        };
        if (p.tlsMinVersion) config.options.cryptoCredentialsDetails = { minVersion: p.tlsMinVersion };
        return config;
    };

    const get = (profileName) => {
        if (!Object.hasOwn(profiles, profileName)) {
            return Promise.reject(new ApiError(404, 'not_found', 'Unknown profile.'));
        }
        let entry = pools.get(profileName);
        if (!entry) {
            const pool = new sql.ConnectionPool(configFor(profiles[profileName]));
            // An unhandled 'error' event would stop the process.
            pool.on('error', (err) => log.error(`[db] pool "${profileName}" error: ${err.message}`));
            entry = pool.connect().then(() => pool, (err) => {
                pools.delete(profileName); // the next call tries again
                pool.close().catch(() => {});
                throw err;
            });
            pools.set(profileName, entry);
        }
        return entry;
    };

    const closeAll = async () => {
        const entries = [...pools.values()];
        pools.clear();
        await Promise.allSettled(entries.map(async (entry) => (await entry).close()));
    };

    return { get, closeAll };
};
