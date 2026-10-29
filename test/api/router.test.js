const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { validate } = require('../../src/gateway/config/load-config');
const { createApiRouter } = require('../../src/api/router');
const { ApiError } = require('../../src/api/errors');
const mountApi = require('../../src/api/mount');

const config = validate(require('../fixtures/config.valid.json'));

// A small app like the real one: the new router first, then a "rest of the app" marker.
function buildApp(mountRoutes, log) {
    const app = express();
    app.use('/api', createApiRouter(config, { log, mountRoutes }));
    app.use((req, res) => res.status(418).send('rest of the app'));
    return app;
}

const silentLog = () => ({ lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } });

describe('new API router', () => {
    const log = silentLog();
    let server;
    let base;

    before(async () => {
        const app = buildApp((router) => {
            router.get('/:profile/health', (req, res) => res.json({ ok: true, profile: req.apiProfileName }));
            router.post('/:profile/procedures/echo', (req, res) => res.json({ got: req.body }));
            router.get('/:profile/procedures/boom', () => { throw new Error('SENTINEL_INTERNAL_DETAIL'); });
            router.get('/:profile/procedures/conflict', () => {
                throw new ApiError(409, 'conflict', 'Already locked.', { step: 3 });
            });
            router.get('/:profile/procedures/async-boom', async () => { throw new ApiError(400, 'bad_request', 'Nope.'); });
        }, log);
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.close();
        server.closeAllConnections();
    });

    const get = (p, headers) => fetch(base + p, { headers });
    const post = (p, body, headers = {}) => fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });

    it('answers a known route with a request id and safe headers', async () => {
        const res = await get('/api/main/health');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, profile: 'main' });
        assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-powered-by'), null);
    });

    it('gives every request its own id', async () => {
        const a = (await get('/api/main/health')).headers.get('x-request-id');
        const b = (await get('/api/main/health')).headers.get('x-request-id');
        assert.notEqual(a, b);
    });

    it('passes paths it does not own on to the rest of the app', async () => {
        const paths = [
            '/api/legacy/downloadftp',
            '/api/legacy/health',    // "legacy" is reserved, so it is never read as a profile
            '/api/ftp/health',       // "ftp" too
            '/api/v2/main/health',   // a future version prefix
            '/api/uploadftp',        // an old root address
            '/api/main',             // a profile with no area
            '/api/main/unknown-area/x'
        ];
        for (const p of paths) {
            const res = await post(p, {});
            assert.equal(res.status, 418, p);
            assert.equal(res.headers.get('x-request-id'), null, p);
            assert.equal(await res.text(), 'rest of the app', p);
        }
    });

    it('answers 404 not_found in the error shape for an unknown profile', async () => {
        const res = await get('/api/nope/health');
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'Unknown profile.' } });
        assert.ok(res.headers.get('x-request-id'));
    });

    it('treats names like __proto__ and constructor as unknown profiles', async () => {
        for (const name of ['__proto__', 'constructor', 'toString']) {
            const res = await get(`/api/${name}/health`);
            assert.equal(res.status, 404, name);
            assert.equal((await res.json()).error.code, 'not_found', name);
        }
    });

    it('answers 404 not_found for a route inside a known area that does not exist', async () => {
        const res = await get('/api/main/procedures/missing');
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'No such route.' } });
    });

    it('maps an ApiError (also from async code) to its status, code, message and step', async () => {
        const conflict = await get('/api/main/procedures/conflict');
        assert.equal(conflict.status, 409);
        assert.deepEqual(await conflict.json(), { error: { code: 'conflict', message: 'Already locked.', step: 3 } });
        const bad = await get('/api/main/procedures/async-boom');
        assert.equal(bad.status, 400);
        assert.deepEqual(await bad.json(), { error: { code: 'bad_request', message: 'Nope.' } });
    });

    it('answers an unexpected error with a generic 500 and logs it by request id', async () => {
        const res = await get('/api/main/procedures/boom');
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.deepEqual(body, { error: { code: 'internal', message: 'An unexpected error occurred.' } });
        assert.doesNotMatch(JSON.stringify(body), /SENTINEL/);
        const id = res.headers.get('x-request-id');
        assert.ok(log.errors.some((line) => line.includes(id) && line.includes('SENTINEL_INTERNAL_DETAIL')));
    });

    it('reads a JSON body, refuses bad JSON (400) and a body over the limit (413)', async () => {
        const ok = await post('/api/main/procedures/echo', { a: 1 });
        assert.deepEqual(await ok.json(), { got: { a: 1 } });

        const bad = await post('/api/main/procedures/echo', '{ not json');
        assert.equal(bad.status, 400);
        assert.deepEqual(await bad.json(), { error: { code: 'bad_request', message: 'The request body is not valid JSON.' } });

        const big = await post('/api/main/procedures/echo', JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }));
        assert.equal(big.status, 413);
        assert.equal((await big.json()).error.code, 'too_large');
    });

    it('allows a listed browser origin and answers its preflight', async () => {
        const origin = 'http://webapp.test:4200';
        const res = await get('/api/main/health', { origin });
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        assert.match(res.headers.get('access-control-expose-headers'), /X-Request-Id/);

        const pre = await fetch(base + '/api/main/procedures/echo', {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }
        });
        assert.equal(pre.status, 204);
        assert.equal(pre.headers.get('access-control-allow-origin'), origin);
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/i);
    });

    it('gives an origin that is not listed no CORS headers', async () => {
        const res = await get('/api/main/health', { origin: 'http://evil.test' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    it('writes one access line per request without the query string or the body', async () => {
        log.lines.length = 0;
        const res = await post('/api/main/procedures/echo?where.Col=SENTINEL_QUERY', { secret: 'SENTINEL_BODY' });
        await res.text();
        const id = res.headers.get('x-request-id');
        await new Promise((resolve) => setImmediate(resolve));
        const line = log.lines.find((l) => l.includes(id));
        assert.ok(line, 'access line written');
        assert.match(line, /POST \/api\/main\/procedures\/echo 200 \d+ms$/);
        assert.doesNotMatch(log.lines.join('\n'), /SENTINEL/);
    });
});

describe('mounting the new API in the app', () => {
    it('stays off, and says so, when there is no config file', () => {
        const messages = [];
        const app = express();
        const saved = process.env.IMAPPS_API_CONFIG;
        delete process.env.IMAPPS_API_CONFIG;
        try {
            const mounted = mountApi(app, {
                defaultPath: path.join(__dirname, 'no-such-config.json'),
                log: { info: (m) => messages.push(m), error() {} }
            });
            assert.equal(mounted, false);
            assert.match(messages[0], /the new API is off, the legacy routes are unchanged/);
            assert.equal(app.router.stack.length, 0);
        } finally {
            if (saved !== undefined) process.env.IMAPPS_API_CONFIG = saved;
        }
    });

    it('mounts the router when given a config', () => {
        const app = express();
        assert.equal(mountApi(app, { config, log: silentLog() }), true);
    });

    it('stops the start when IMAPPS_API_CONFIG points at a missing file', () => {
        const saved = process.env.IMAPPS_API_CONFIG;
        process.env.IMAPPS_API_CONFIG = path.join(__dirname, 'does-not-exist.json');
        try {
            assert.throws(() => mountApi(express(), { log: silentLog() }), /named by IMAPPS_API_CONFIG can not be read/);
        } finally {
            if (saved === undefined) delete process.env.IMAPPS_API_CONFIG;
            else process.env.IMAPPS_API_CONFIG = saved;
        }
    });
});
