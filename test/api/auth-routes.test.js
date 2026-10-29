const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { validate } = require('../../src/gateway/config/load-config');
const { createApiRouter } = require('../../src/api/router');
const mountRoutes = require('../../src/api/routes');
const { createFakeDatabase } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const config = validate({
    cors: { origins: ['http://webapp.test:4200'] },
    jwt: { secret: 'routes-test-secret-routes-test-secret-1' },
    profiles: {
        main: { server: 'db.test', database: 'D', user: 'u', password: 'p' },
        other: { server: 'db2.test', database: 'D2', user: 'u', password: 'p' }
    }
});

const USERS = [
    { UserID: 'raymart', Password: 'SENTINEL_PW', RememberMe: 0, IsActive: true, UserName: 'Ray Mart', Startup: null, Lang: 'en' },
    { UserID: 'gone', Password: 'SENTINEL_PW', RememberMe: 0, IsActive: false, UserName: 'Gone', Startup: null, Lang: null }
];

describe('auth routes', () => {
    let server;
    let base;
    let clock = 1_800_000_000_000;
    const log = { lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } };

    before(async () => {
        const database = createFakeDatabase({
            ngp_getauthusers: (params) => ({
                recordsets: [recordset(USERS.filter((u) => u.UserID.toLowerCase() === String(params.userid).toLowerCase()))],
                messages: []
            })
        });
        const app = express();
        app.use('/api', createApiRouter(config, { database, log, mountRoutes, now: () => clock }));
        app.use((req, res) => res.status(418).send('rest of the app'));
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.close();
        server.closeAllConnections();
    });

    const call = (method, path, { body, token, headers } = {}) => fetch(base + path, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const signIn = (userid = 'raymart', password = 'SENTINEL_PW', extra = {}, profile = 'main') =>
        call('POST', `/api/${profile}/auth/login`, { body: { userid, password, ...extra } });
    const errorOf = async (res) => (await res.json()).error;

    it('POST login answers a token and the user; the token opens /me on this and on another profile', async () => {
        const res = await signIn();
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = await res.json();
        assert.deepEqual(body.user, { id: 'raymart', name: 'Ray Mart', startup: null, lang: 'en' });
        assert.equal(body.expiresAt, new Date(clock + 8 * 3600 * 1000).toISOString());
        assert.doesNotMatch(JSON.stringify(body), /SENTINEL_PW/);

        const me = await call('GET', '/api/main/auth/me', { token: body.token });
        assert.deepEqual(await me.json(), { id: 'raymart', expiresAt: body.expiresAt });
        const meOther = await call('GET', '/api/other/auth/me', { token: body.token });
        assert.equal(meOther.status, 200, 'the token has no profile claim');
    });

    it('a wrong login is 401 invalid_credentials in the error shape; an inactive user is the same', async () => {
        for (const res of [await signIn('raymart', 'wrong'), await signIn('nobody', 'x'), await signIn('gone')]) {
            assert.equal(res.status, 401);
            assert.deepEqual(await errorOf(res), { code: 'invalid_credentials', message: 'Username or password is incorrect.' });
        }
    });

    it('login needs a JSON body with userid and password (400)', async () => {
        const bad = await call('POST', '/api/main/auth/login', { body: '{ not json' });
        assert.equal(bad.status, 400);
        assert.equal((await errorOf(bad)).code, 'bad_request');
        const missing = await call('POST', '/api/main/auth/login', { body: { userid: 'raymart' } });
        assert.equal(missing.status, 400);
    });

    it('every other route needs a token: none, malformed, wrong key, tampered or expired is 401 unauthorized', async () => {
        const { token } = await (await signIn()).json();
        const cases = [
            [undefined, /Sign in required/],
            ['not-a-token', /not valid/],
            [token.slice(0, -2) + 'xx', /not valid/]
        ];
        for (const [value, pattern] of cases) {
            const res = await call('GET', '/api/main/auth/me', { token: value });
            assert.equal(res.status, 401);
            assert.equal(res.headers.get('www-authenticate'), 'Bearer');
            const error = await errorOf(res);
            assert.equal(error.code, 'unauthorized');
            assert.match(error.message, pattern);
        }
        const basic = await call('GET', '/api/main/auth/me', { headers: { authorization: 'Basic abc' } });
        assert.equal(basic.status, 401);

        clock += 8 * 3600 * 1000 + 1000;
        const expired = await call('GET', '/api/main/auth/me', { token });
        assert.equal(expired.status, 401);
        assert.match((await errorOf(expired)).message, /expired/);
        clock -= 8 * 3600 * 1000 + 1000;
    });

    it('login is the only open route: GET login and an unknown route without a token are 401, not 404', async () => {
        assert.equal((await call('GET', '/api/main/auth/login')).status, 401);
        assert.equal((await call('POST', '/api/main/auth/me', { body: {} })).status, 401);
        assert.equal((await call('GET', '/api/main/procedures/anything')).status, 401);
    });

    it('answers the browser preflight for login without a token', async () => {
        const origin = 'http://webapp.test:4200';
        const res = await fetch(base + '/api/main/auth/login', {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
    });

    it('never writes a password into the log', async () => {
        await signIn('raymart', 'SENTINEL_PW');
        await signIn('raymart', 'SENTINEL_WRONG_PW');
        assert.ok(log.lines.length > 0);
        assert.doesNotMatch(log.lines.join('\n') + log.errors.join('\n'), /SENTINEL/);
    });

    it('slows down guessing: 10 wrong logins for one user, then 429 with Retry-After, even for the right password', async () => {
        const user = 'victim';
        for (let i = 0; i < 10; i++) assert.equal((await signIn(user, 'bad')).status, 401);
        const blocked = await signIn(user, 'bad');
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get('retry-after'), '60');
        const error = await errorOf(blocked);
        assert.equal(error.code, 'rate_limited');
        assert.equal(error.retryAfterSeconds, 60);

        assert.equal((await signIn('raymart')).status, 200, 'another user is not blocked');

        clock += 61000;
        assert.equal((await signIn(user, 'bad')).status, 401, 'allowed again after the window');
    });

    it('a successful login clears that user\'s failures', async () => {
        for (let i = 0; i < 9; i++) await signIn('raymart', 'bad');
        assert.equal((await signIn('raymart')).status, 200);
        for (let i = 0; i < 9; i++) assert.equal((await signIn('raymart', 'bad')).status, 401);
    });

    it('also limits one address that tries many users (50 a minute)', async () => {
        clock += 120000;
        for (let i = 0; i < 50; i++) await signIn(`guess${i}`, 'bad');
        const blocked = await signIn('guess-new', 'bad');
        assert.equal(blocked.status, 429);
        clock += 61000;
    });
});
