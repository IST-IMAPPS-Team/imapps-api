const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { validate } = require('../../src/gateway/config/load-config');
const { createApiRouter } = require('../../src/api/router');
const { ApiError } = require('../../src/api/errors');
const { issueToken } = require('../../src/gateway/auth/token');
const mountRoutes = require('../../src/api/routes');
const { createFakeDatabase } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const config = validate({
    jwt: { secret: 'proc-test-secret-proc-test-secret-12345' },
    profiles: { main: { server: 'db.test', database: 'D', user: 'u', password: 'p' } }
});

const when = new Date(Date.UTC(2026, 9, 23, 8, 0, 0));

describe('procedure routes', () => {
    let server;
    let base;
    let database;
    const log = { lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } };
    const token = issueToken({ userId: 'tester', secret: config.jwt.secret, lifetimeSeconds: 3600 }).token;

    before(async () => {
        database = createFakeDatabase({
            prdone: { recordsets: [recordset([{ COLORDESC: 'Red', BALQTY: 5, Start: when }], { Start: 'datetime' }), recordset([{ Other: 1 }])], messages: [], returnValue: 0 },
            prdmany: { recordsets: [recordset([{ A: 1 }]), recordset([{ B: 2 }, { B: 3 }]), recordset([])], messages: [], returnValue: 0 },
            prdnoresult: { recordsets: [], messages: [], returnValue: 0 },
            prdconflict: () => { throw new ApiError(409, 'conflict', 'A row with the same key already exists.'); },
            prdboom: () => { throw new Error('SENTINEL_INTERNAL_DETAIL'); },
            multi: { recordsets: [recordset([{ Named: 'multi' }])], messages: [] }
        });
        const app = express();
        app.use('/api', createApiRouter(config, { database, log, mountRoutes }));
        app.use((req, res) => res.status(418).send('rest of the app'));
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.close();
        server.closeAllConnections();
    });

    const call = (method, path, { body, auth = true } = {}) => fetch(base + path, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(auth ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const post = (path, body, opts) => call('POST', path, { body, ...opts });
    const errorOf = async (res) => (await res.json()).error;

    it('POST /procedures/{name} answers { rows } (the first result set) with dates as local text', async () => {
        database.calls.length = 0;
        const res = await post('/api/main/procedures/prdOne', { params: { MfgLoc: 'DYP', Count: 3 } });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { rows: [{ COLORDESC: 'Red', BALQTY: 5, Start: '2026-10-23T08:00:00' }] });
        assert.deepEqual(database.calls[0], { profile: 'main', name: 'prdOne', params: { MfgLoc: 'DYP', Count: 3 }, options: { multi: false } });
    });

    it('POST /procedures/{name}/multi answers { resultSets } with every set, no number to give', async () => {
        database.calls.length = 0;
        const res = await post('/api/main/procedures/prdMany/multi', { params: {} });
        assert.deepEqual(await res.json(), { resultSets: [[{ A: 1 }], [{ B: 2 }, { B: 3 }], []] });
        assert.deepEqual(database.calls[0].options, { multi: true });
    });

    it('a procedure that returns no result set answers an empty list', async () => {
        const res = await post('/api/main/procedures/prdNoResult', {});
        assert.deepEqual(await res.json(), { rows: [] });
    });

    it('params is optional: no body, {} and { params: {} } all call with no parameters', async () => {
        database.calls.length = 0;
        for (const body of [undefined, {}, { params: {} }]) {
            const res = await post('/api/main/procedures/prdNoResult', body);
            assert.equal(res.status, 200, JSON.stringify(body));
        }
        assert.deepEqual(database.calls.map((c) => c.params), [{}, {}, {}]);
    });

    it('accepts schema.name, and a procedure called "multi" is still a plain procedure name', async () => {
        assert.equal((await post('/api/main/procedures/dbo.prdOne', {})).status, 200);
        assert.deepEqual(await (await post('/api/main/procedures/multi', {})).json(), { rows: [{ Named: 'multi' }] });
    });

    it('refuses a bad procedure name (400) and the blocked procedure (403) without calling the database', async () => {
        database.calls.length = 0;
        for (const name of ['db.dbo.prdOne', 'a%20b', 'a%2Fb', '1abc', 'a;drop', "x'y"]) {
            const res = await post(`/api/main/procedures/${name}`, {});
            assert.equal(res.status, 400, name);
            assert.equal((await errorOf(res)).code, 'bad_request', name);
        }
        for (const name of ['prdGetBOBulkCopyConnectString', 'dbo.PRDGETBOBULKCOPYCONNECTSTRING']) {
            const res = await post(`/api/main/procedures/${name}`, {});
            assert.equal(res.status, 403, name);
            assert.equal((await errorOf(res)).code, 'forbidden', name);
        }
        assert.equal(database.calls.length, 0);
    });

    it('refuses system procedures (sp_, xp_, sys schema) with 403 on both procedure routes, without calling the database', async () => {
        database.calls.length = 0;
        for (const name of ['sp_executesql', 'xp_cmdshell', 'dbo.sp_who', 'sys.sp_helptext']) {
            for (const suffix of ['', '/multi']) {
                const res = await post(`/api/main/procedures/${name}${suffix}`, { params: { stmt: 'SELECT 1' } });
                assert.equal(res.status, 403, name + suffix);
                const error = await errorOf(res);
                assert.equal(error.code, 'forbidden');
                assert.match(error.message, /System procedures/);
            }
        }
        assert.equal(database.calls.length, 0);
    });

    it('refuses a body that is not { params: {...} }: other fields, arrays, params that are not an object', async () => {
        database.calls.length = 0;
        const bad = [
            { param: { A: 1 } },                // a misspelt "params" must not become a call with defaults
            { params: {}, extra: 1 },
            [],
            [{ params: {} }],
            { params: [1, 2] },
            { params: null },
            { params: 'text' }
        ];
        for (const body of bad) {
            const res = await post('/api/main/procedures/prdOne', body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.equal((await errorOf(res)).code, 'bad_request', JSON.stringify(body));
        }
        assert.equal((await post('/api/main/procedures/prdOne', '"text"')).status, 400);
        assert.equal((await post('/api/main/procedures/prdOne', '{ nope')).status, 400);
    });

    it('answers a procedure the database does not know with 404, a conflict with 409, anything unexpected with a generic 500', async () => {
        const missing = await post('/api/main/procedures/prdMissing', {});
        assert.deepEqual([missing.status, (await errorOf(missing)).code], [404, 'not_found']);

        const conflict = await post('/api/main/procedures/prdConflict', {});
        assert.deepEqual([conflict.status, (await errorOf(conflict)).code], [409, 'conflict']);

        const boom = await post('/api/main/procedures/prdBoom', {});
        assert.equal(boom.status, 500);
        const body = await boom.json();
        assert.deepEqual(body, { error: { code: 'internal', message: 'An unexpected error occurred.' } });
        assert.doesNotMatch(JSON.stringify(body), /SENTINEL/);
    });

    it('needs a token, and only POST is a procedure route', async () => {
        assert.equal((await post('/api/main/procedures/prdOne', {}, { auth: false })).status, 401);
        assert.equal((await post('/api/main/procedures/prdOne/multi', {}, { auth: false })).status, 401);
        const get = await call('GET', '/api/main/procedures/prdOne');
        assert.deepEqual([get.status, (await errorOf(get)).code], [404, 'not_found']);
    });

    it('answers many calls at the same time (the board load makes about 23)', async () => {
        const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
            post(`/api/main/procedures/${i % 2 ? 'prdOne' : 'prdMany/multi'}`, { params: {} })));
        assert.ok(results.every((r) => r.status === 200));
    });

    it('does not write parameter values into the log', async () => {
        log.lines.length = 0;
        const res = await post('/api/main/procedures/prdOne?x=SENTINEL_QUERY', { params: { Secret: 'SENTINEL_VALUE' } });
        await res.text();
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(log.lines.some((l) => l.includes('/api/main/procedures/prdOne ')));
        assert.doesNotMatch(log.lines.join('\n'), /SENTINEL/);
    });

    it('GET /health needs a token and answers { ok, profile } when the database answers', async () => {
        assert.equal((await call('GET', '/api/main/health', { auth: false })).status, 401);
        const res = await call('GET', '/api/main/health');
        assert.deepEqual(await res.json(), { ok: true, profile: 'main' });
    });

    it('GET /health answers 503 when the database can not be reached', async () => {
        const original = database.ping;
        database.ping = async () => { throw new ApiError(503, 'db_unavailable', 'The database can not be reached.'); };
        try {
            const res = await call('GET', '/api/main/health');
            assert.deepEqual([res.status, (await errorOf(res)).code], [503, 'db_unavailable']);
        } finally {
            database.ping = original;
        }
    });
});
