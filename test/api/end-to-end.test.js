const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const real = require('mssql');

const { validate } = require('../../src/gateway/config/load-config');
const { createApiRouter } = require('../../src/api/router');
const mountRoutes = require('../../src/api/routes');
const { createDatabase } = require('../../src/gateway/db/database');
const { createFakeSql, parameterRows, recordset } = require('../helpers/fake-sql');

// The whole path with only the SQL Server faked: HTTP -> router -> token check -> routes ->
// run-procedure -> database.js (typing from the catalog) -> fake driver.
const config = validate({
    jwt: { secret: 'e2e-test-secret-e2e-test-secret-1234567' },
    profiles: { main: { server: 'db.test', database: 'D', user: 'u', password: 'SENTINEL_DB_PASSWORD', dataTimeoutSeconds: 30, multiTimeoutSeconds: 90 } }
});

const PROCEDURES = {
    ngp_getauthusers: [['userid', 'nvarchar', 100], ['password', 'nvarchar', 100]],
    prdboard: [['MfgLoc', 'varchar', 20], ['AsOf', 'datetime', 8], ['Flag', 'bit', 1]],
    prdlock: [['MfgLoc', 'varchar', 20]]
};

describe('end to end with only SQL Server faked', () => {
    let server;
    let base;
    let fake;
    let token;
    const log = { lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } };

    before(async () => {
        fake = createFakeSql({
            onQuery(text, request) {
                if (!text.includes('sys.parameters')) return { recordset: [{ ok: 1 }] };
                const name = request.inputs.find((i) => i.name === 'name').value.toLowerCase().replace(/^dbo\./, '');
                return { recordset: PROCEDURES[name] ? parameterRows(PROCEDURES[name]) : [] };
            },
            onExecute(name, request) {
                const proc = name.toLowerCase().replace(/^dbo\./, '');
                const input = Object.fromEntries(request.inputs.map((i) => [i.name, i.value]));
                if (proc === 'ngp_getauthusers') {
                    const rows = input.userid === 'raymart'
                        ? [{ UserID: 'raymart', Password: input.password, RememberMe: 0, IsActive: true, UserName: 'Ray Mart', Startup: null, Lang: 'en' }]
                        : [];
                    return { recordsets: [recordset(rows)], returnValue: 0 };
                }
                if (proc === 'prdlock') {
                    throw new real.RequestError(Object.assign(new Error('Violation of PRIMARY KEY'), { info: { number: 2627, class: 14 } }), 'EREQUEST');
                }
                return {
                    recordsets: [
                        recordset([{ MfgLoc: input.MfgLoc, AsOf: input.AsOf, Flag: input.Flag, Big: 9007199254740993n }], { AsOf: 'datetime' }),
                        recordset([{ Second: 2 }])
                    ],
                    returnValue: 0
                };
            }
        });
        const database = createDatabase({ profiles: config.profiles, sql: fake.sql, log });
        const app = express();
        app.use('/api', createApiRouter(config, { database, log, mountRoutes }));
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.close();
        server.closeAllConnections();
    });

    const post = (path, body, authToken = token) => fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify(body)
    });

    it('signs in through the real database layer, then calls a procedure with the token', async () => {
        const res = await post('/api/main/auth/login', { userid: 'raymart', password: 'secret-pw' });
        assert.equal(res.status, 200);
        token = (await res.json()).token;
        assert.ok(token);

        const call = await post('/api/main/procedures/prdBoard', { params: { MfgLoc: 'DYP', AsOf: '2026-10-23T08:00:00', Flag: '1' } });
        assert.equal(call.status, 200);
        assert.deepEqual(await call.json(), { rows: [{ MfgLoc: 'DYP', AsOf: '2026-10-23T08:00:00', Flag: true, Big: '9007199254740993' }] });
    });

    it('typed the parameters from the catalog and used the profile\'s single timeout', async () => {
        const request = fake.state.requests.filter((r) => r.procedure === 'prdBoard').at(-1);
        const byName = Object.fromEntries(request.inputs.map((i) => [i.name, i]));
        assert.equal(byName.MfgLoc.type.type.declaration, 'varchar');
        assert.equal(byName.AsOf.type, real.DateTime);
        assert.equal(byName.AsOf.value.toISOString(), '2026-10-23T08:00:00.000Z');
        assert.equal(byName.Flag.value, true);
        assert.equal(request.overrides.requestTimeout, 30000);
    });

    it('/multi returns both result sets and uses the multi timeout', async () => {
        const res = await post('/api/main/procedures/prdBoard/multi', { params: { MfgLoc: 'A' } });
        const body = await res.json();
        assert.equal(body.resultSets.length, 2);
        assert.deepEqual(body.resultSets[1], [{ Second: 2 }]);
        assert.equal(fake.state.requests.filter((r) => r.procedure === 'prdBoard').at(-1).overrides.requestTimeout, 90000);
    });

    it('refuses a parameter the procedure does not have, an over-long value and a bad date, before executing', async () => {
        const before = fake.state.requests.filter((r) => r.procedure).length;
        const unknown = await post('/api/main/procedures/prdBoard', { params: { Nope: 1 } });
        assert.equal(unknown.status, 400);
        assert.match((await unknown.json()).error.message, /no parameter @Nope/);

        const long = await post('/api/main/procedures/prdBoard', { params: { MfgLoc: 'SENTINEL_LONG_VALUE_THAT_IS_TOO_LONG' } });
        assert.equal(long.status, 400);
        assert.doesNotMatch(JSON.stringify(await long.json()), /SENTINEL/);

        const date = await post('/api/main/procedures/prdBoard', { params: { AsOf: '2026-10-23T08:00:00Z' } });
        assert.equal(date.status, 400);
        assert.equal(fake.state.requests.filter((r) => r.procedure).length, before, 'nothing was executed');
    });

    it('answers 404 for a procedure that is not in the catalog', async () => {
        const res = await post('/api/main/procedures/prdMissing', {});
        assert.equal(res.status, 404);
        assert.equal((await res.json()).error.code, 'not_found');
    });

    it('maps a SQL Server duplicate-key error to 409 without the SQL text', async () => {
        const res = await post('/api/main/procedures/prdLock', { params: { MfgLoc: 'DYP' } });
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.error.code, 'conflict');
        assert.doesNotMatch(JSON.stringify(body), /PRIMARY KEY/);
    });

    it('a password longer than the procedure parameter is a wrong login (401), not a 400', async () => {
        const res = await post('/api/main/auth/login', { userid: 'raymart', password: 'x'.repeat(200) }, null);
        assert.equal(res.status, 401);
        assert.equal((await res.json()).error.code, 'invalid_credentials');
    });

    it('never puts the database or user password into a log line', () => {
        assert.doesNotMatch(log.lines.join('\n') + log.errors.join('\n'), /SENTINEL|secret-pw/);
    });
});
