const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, validate, ConfigError } = require('../../src/gateway/config/load-config');
const { isReservedProfile } = require('../../src/gateway/guards/profile-names');

const baseProfile = { server: 'db.test', database: 'TestDb', user: 'u', password: 'p' };
const baseConfig = () => ({
    jwt: { secret: 'x'.repeat(32) },
    profiles: { main: { ...baseProfile } }
});

const problemsOf = (raw) => {
    try {
        validate(raw);
    } catch (err) {
        assert.ok(err instanceof ConfigError);
        return err.problems;
    }
    return [];
};

describe('config validation', () => {
    it('accepts a minimal config and fills in the defaults', () => {
        const config = validate(baseConfig());
        assert.equal(config.jwt.hours, 8);
        assert.equal(config.jwt.rememberMeDays, 30);
        assert.equal(config.auth.procedure, 'NGP_GetAuthUsers');
        assert.equal(config.limits.saveMegabytes, 20);
        assert.equal(config.limits.ftpUploadMegabytes, 100);
        assert.deepEqual(config.cors.origins, []);
        assert.deepEqual(config.ftp, { allowedHosts: [], timeoutSeconds: 30 });
        assert.deepEqual(config.profiles.main, {
            ...baseProfile,
            port: 1433,
            encrypt: false,
            trustServerCertificate: true,
            poolMax: 20,
            dataTimeoutSeconds: 300,
            multiTimeoutSeconds: 600
        });
    });

    it('requires jwt.secret of at least 32 characters', () => {
        const raw = baseConfig();
        delete raw.jwt;
        assert.deepEqual(problemsOf(raw), ['jwt.secret is required']);
        raw.jwt = { secret: 'short' };
        assert.deepEqual(problemsOf(raw), ['jwt.secret must be text of at least 32 characters']);
    });

    it('requires at least one profile with server, database, user and password', () => {
        assert.deepEqual(problemsOf({ jwt: baseConfig().jwt }), ['profiles must list at least one database profile']);
        const raw = baseConfig();
        raw.profiles.main = {};
        assert.deepEqual(problemsOf(raw), [
            'profiles.main.server is required',
            'profiles.main.database is required',
            'profiles.main.user is required',
            'profiles.main.password is required'
        ]);
    });

    it('refuses reserved and badly shaped profile names', () => {
        for (const name of ['ftp', 'FTP', 'legacy', 'v2', 'V10']) {
            const raw = baseConfig();
            raw.profiles = { [name]: { ...baseProfile } };
            assert.match(problemsOf(raw).join('\n'), /is reserved/, name);
            assert.ok(isReservedProfile(name), name);
        }
        for (const name of ['1abc', 'has space', 'a/b', 'x'.repeat(33)]) {
            const raw = baseConfig();
            raw.profiles = { [name]: { ...baseProfile } };
            assert.match(problemsOf(raw).join('\n'), /must start with a letter/, name);
        }
        assert.equal(isReservedProfile('dyp'), false);
        assert.equal(isReservedProfile('vendor'), false);
    });

    it('checks numbers, flags, origins, ftp settings and the TLS option', () => {
        const raw = baseConfig();
        raw.jwt.hours = 0;
        raw.cors = { origins: ['http://ok.test:4200', 'http://bad.test/path', 'nonsense'] };
        raw.profiles.main.port = 70000;
        raw.profiles.main.encrypt = 'yes';
        raw.profiles.main.tlsMinVersion = 'SSL3';
        raw.limits = { saveMegabytes: 'big' };
        raw.ftp = { allowedHosts: ['ok.test', ''], timeoutSeconds: 0 };
        assert.deepEqual(problemsOf(raw), [
            'cors.origins[1] must look like http://host:port (no path, no trailing slash)',
            'cors.origins[2] must look like http://host:port (no path, no trailing slash)',
            'jwt.hours must be a whole number from 1 to 720',
            'limits.saveMegabytes must be a whole number from 1 to 500',
            'profiles.main.port must be a whole number from 1 to 65535',
            'profiles.main.encrypt must be true or false',
            'profiles.main.tlsMinVersion must be one of TLSv1, TLSv1.1, TLSv1.2, TLSv1.3',
            'ftp.allowedHosts[1] must be a host name or address',
            'ftp.timeoutSeconds must be a whole number from 1 to 600'
        ]);
    });

    it('names unknown settings (typos) but ignores keys that start with an underscore', () => {
        const raw = baseConfig();
        raw._readme = 'a note';
        raw.profile = {};
        raw.profiles.main.poolmax = 5;
        assert.deepEqual(problemsOf(raw), [
            'config: unknown setting "profile"',
            'profiles.main: unknown setting "poolmax"'
        ]);
    });

    it('never puts a configured value into an error message', () => {
        const raw = baseConfig();
        raw.jwt.secret = 'SENTINEL_SECRET'; // too short on purpose
        raw.cors = { origins: ['SENTINEL_ORIGIN/path'] };
        raw.profiles.main.password = 12345; // wrong type on purpose
        raw.profiles.main.user = 'SENTINEL_USER';
        raw.profiles.main.port = 'SENTINEL_PORT';
        raw.ftp = { allowedHosts: [''], timeoutSeconds: 'SENTINEL_TIMEOUT' };
        const text = problemsOf(raw).join('\n');
        assert.ok(text.length > 0);
        assert.doesNotMatch(text, /SENTINEL|12345/);
    });

    it('config.example.json uses only settings the loader knows', () => {
        const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.example.json'), 'utf8'));
        assert.equal(problemsOf(example).filter((p) => p.includes('unknown setting')).length, 0);
        // The placeholders are not valid on purpose: the example must be edited before use.
        assert.ok(problemsOf(example).length > 0);
    });
});

describe('config file loading', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imapps-cfg-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const write = (name, content) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content);
        return file;
    };

    it('a missing default file means "not found" (the new API stays off)', () => {
        const defaultPath = path.join(dir, 'missing.json');
        assert.deepEqual(loadConfig({ env: {}, defaultPath }), { found: false, path: defaultPath });
    });

    it('a missing file named by IMAPPS_API_CONFIG is an error', () => {
        const env = { IMAPPS_API_CONFIG: path.join(dir, 'missing.json') };
        assert.throws(() => loadConfig({ env, defaultPath: 'unused' }), /named by IMAPPS_API_CONFIG can not be read \(ENOENT\)/);
    });

    it('loads the default file and the file named by IMAPPS_API_CONFIG (with a BOM)', () => {
        const good = JSON.stringify(baseConfig());
        const defaultPath = write('default.json', good);
        assert.equal(loadConfig({ env: {}, defaultPath }).found, true);
        const other = write('other.json', '﻿' + good);
        const loaded = loadConfig({ env: { IMAPPS_API_CONFIG: other }, defaultPath });
        assert.equal(loaded.path, other);
        assert.equal(loaded.config.profiles.main.database, 'TestDb');
    });

    it('invalid JSON gives a generic message that shows none of the file', () => {
        const file = write('bad.json', '{ "jwt": { "secret": "SENTINEL_SECRET_VALUE" ,, } }');
        assert.throws(
            () => loadConfig({ env: {}, defaultPath: file }),
            (err) => err instanceof ConfigError && /not valid JSON/.test(err.message) && !err.message.includes('SENTINEL')
        );
    });

    it('a file that is valid JSON but wrong throws a ConfigError listing the problems', () => {
        const file = write('wrong.json', '{ "profiles": {} }');
        assert.throws(() => loadConfig({ env: {}, defaultPath: file }), /jwt\.secret is required[\s\S]*at least one database profile/);
    });
});
