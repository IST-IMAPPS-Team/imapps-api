const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { login } = require('../../src/gateway/auth/login');
const { validate } = require('../../src/gateway/config/load-config');
const { ApiError } = require('../../src/api/errors');
const { createFakeDatabase } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const config = validate({
    jwt: { secret: 'login-test-secret-login-test-secret-12' },
    profiles: { main: { server: 'db.test', database: 'D', user: 'u', password: 'p' } }
});
const NOW_MS = 1_800_000_000_000;

const row = (extra = {}) => ({ UserID: 'raymart', Password: 'SENTINEL_PW', RememberMe: 0, IsActive: true, UserName: 'Ray Mart', Startup: 'PLAN', Lang: 'en', ...extra });
const dbWith = (rows) => createFakeDatabase({ ngp_getauthusers: { recordsets: [recordset(rows)], messages: [] } });
const run = (db, body, cfg = config) => login({ database: db, config: cfg, now: () => NOW_MS }, 'main', body);
const body = (extra = {}) => ({ userid: 'raymart', password: 'SENTINEL_PW', ...extra });

const invalid = (e) => e instanceof ApiError && e.status === 401 && e.code === 'invalid_credentials' && e.message === 'Username or password is incorrect.';

describe('login', () => {
    it('signs a user in and answers a token and the user, calling the configured procedure with @userid and @password', async () => {
        const db = dbWith([row()]);
        const result = await run(db, body());

        assert.deepEqual(db.calls[0], { profile: 'main', name: 'NGP_GetAuthUsers', params: { userid: 'raymart', password: 'SENTINEL_PW' }, options: { multi: false } });
        assert.deepEqual(result.user, { id: 'raymart', name: 'Ray Mart', startup: 'PLAN', lang: 'en' });

        const payload = jwt.verify(result.token, config.jwt.secret, { algorithms: ['HS256'], clockTimestamp: NOW_MS / 1000 });
        assert.equal(payload.unique_name, 'raymart');
        assert.equal(payload.exp - payload.iat, 8 * 3600);
        assert.equal(result.expiresAt, new Date((NOW_MS / 1000 + 8 * 3600) * 1000).toISOString());
    });

    it('never returns the password the procedure sends back', async () => {
        const result = await run(dbWith([row()]), body());
        assert.doesNotMatch(JSON.stringify(result), /SENTINEL_PW|password/i);
    });

    it('uses the "remember me" lifetime when asked, and ignores the RememberMe column', async () => {
        const remembered = await run(dbWith([row({ RememberMe: 0 })]), body({ rememberme: true }));
        const p1 = jwt.decode(remembered.token);
        assert.equal(p1.exp - p1.iat, 30 * 86400);

        const notRemembered = await run(dbWith([row({ RememberMe: 1 })]), body({ rememberme: false }));
        const p2 = jwt.decode(notRemembered.token);
        assert.equal(p2.exp - p2.iat, 8 * 3600);
    });

    it('takes both lifetimes from the config', async () => {
        const cfg = validate({ jwt: { secret: config.jwt.secret, hours: 2, rememberMeDays: 3 }, profiles: config.profiles });
        const normal = jwt.decode((await run(dbWith([row()]), body(), cfg)).token);
        const remembered = jwt.decode((await run(dbWith([row()]), body({ rememberme: true }), cfg)).token);
        assert.equal(normal.exp - normal.iat, 2 * 3600);
        assert.equal(remembered.exp - remembered.iat, 3 * 86400);
    });

    it('a wrong password, an unknown user and a different letter case all give the same 401', async () => {
        for (const [rows, request] of [
            [[row()], body({ password: 'wrong' })],
            [[row()], body({ password: 'sentinel_pw' })],
            [[], body()],
            [[row()], body({ userid: 'RAYMART' })],
            [[row({ UserID: 'someone-else' })], body()]
        ]) {
            await assert.rejects(run(dbWith(rows), request), invalid);
        }
    });

    it('refuses an inactive user like a wrong password (only IsActive = 1 passes)', async () => {
        for (const active of [false, null, 0, undefined, 'yes']) {
            await assert.rejects(run(dbWith([row({ IsActive: active })]), body()), invalid, String(active));
        }
        await assert.doesNotReject(run(dbWith([row({ IsActive: 1 })]), body()));
    });

    it('finds the matching user among several rows and reads column names in any letter case', async () => {
        const rows = [row({ UserID: 'other', Password: 'x' }), { userid: 'raymart', PASSWORD: 'SENTINEL_PW', isactive: true, username: 'Ray' }];
        const result = await run(dbWith(rows), body());
        assert.deepEqual(result.user, { id: 'raymart', name: 'Ray', startup: null, lang: null });
    });

    it('answers null for the optional columns the procedure leaves empty', async () => {
        const result = await run(dbWith([row({ UserName: null, Startup: null, Lang: null })]), body());
        assert.deepEqual(result.user, { id: 'raymart', name: null, startup: null, lang: null });
    });

    it('uses the login procedure named in the config, never one from the request', async () => {
        const cfg = validate({ jwt: { secret: config.jwt.secret }, auth: { procedure: 'MyLogin' }, profiles: config.profiles });
        const db = createFakeDatabase({ mylogin: { recordsets: [recordset([row()])], messages: [] } });
        await run(db, { ...body(), procedure: 'prdEvil', cmd: 'prdEvil' }, cfg);
        assert.equal(db.calls[0].name, 'MyLogin');
    });

    it('checks the request body (400) before asking the database', async () => {
        const db = dbWith([row()]);
        for (const bad of [undefined, null, 'text', {}, { userid: 'a' }, { password: 'b' }, { userid: '', password: 'b' }, { userid: 5, password: 'b' }, { userid: 'a', password: ['x'] }, body({ rememberme: 'yes' })]) {
            await assert.rejects(run(db, bad), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(bad));
        }
        assert.equal(db.calls.length, 0);
    });

    it('treats an over-long user or password as a wrong login without asking the database', async () => {
        const db = dbWith([row()]);
        await assert.rejects(run(db, body({ password: 'x'.repeat(257) })), invalid);
        await assert.rejects(run(db, body({ userid: 'x'.repeat(257) })), invalid);
        assert.equal(db.calls.length, 0);
    });

    it('a value the procedure parameter can not hold is a wrong login, but other 400s stay 400', async () => {
        const tooLong = Object.assign(new ApiError(400, 'bad_request', 'Parameter @password: longer than the 50 characters it can hold.'), { reason: 'parameter_value' });
        await assert.rejects(run(createFakeDatabase({ ngp_getauthusers: () => { throw tooLong; } }), body()), invalid);

        const noParam = new ApiError(400, 'bad_request', 'The procedure has no parameter @userid.');
        await assert.rejects(run(createFakeDatabase({ ngp_getauthusers: () => { throw noParam; } }), body()), (e) => e === noParam);
    });

    it('lets database problems through (503) instead of calling them a wrong login', async () => {
        const down = new ApiError(503, 'db_unavailable', 'The database can not be reached.');
        await assert.rejects(run(createFakeDatabase({ ngp_getauthusers: () => { throw down; } }), body()), (e) => e === down);
    });
});
