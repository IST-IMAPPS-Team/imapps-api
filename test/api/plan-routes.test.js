const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { validate } = require('../../src/gateway/config/load-config');
const { createApiRouter } = require('../../src/api/router');
const { issueToken } = require('../../src/gateway/auth/token');
const mountRoutes = require('../../src/api/routes');
const { createFakeDatabase, fakeTable } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const config = validate({
    jwt: { secret: 'plan-test-secret-plan-test-secret-1234567' },
    profiles: { main: { server: 'db.test', database: 'D', user: 'u', password: 'p' } }
});

const locking = fakeTable({
    name: 'BOLocking',
    columns: [
        ['Recid', 'uniqueidentifier'], ['MfgLoc', 'varchar', { maxLength: 50 }], ['LockedDt', 'datetime'],
        ['LockedBy', 'nvarchar', { maxLength: 200 }], ['Session', 'nvarchar', { maxLength: 200 }], ['Remarks', 'nvarchar', { maxLength: 200 }]
    ]
});
const stamps = fakeTable({
    name: 'BOTimestamp',
    columns: [['MfgLoc', 'varchar', { maxLength: 50 }], ['Process', 'varchar', { maxLength: 100 }], ['UserId', 'varchar', { maxLength: 50 }], ['Timestamp', 'datetime']]
});

describe('plan routes: lock and timestamp', () => {
    let server;
    let base;
    let database;
    let holders = [];
    const token = issueToken({ userId: 'tester', secret: config.jwt.secret, lifetimeSeconds: 3600 }).token;
    const stored = { MfgLoc: 'DYP', LockedBy: 'ray', LockedDt: new Date(Date.UTC(2026, 9, 23, 9, 0, 0)), Session: null, Remarks: null };

    before(async () => {
        database = createFakeDatabase({}, {
            tables: { bolocking: locking, botimestamp: stamps },
            onQuery(text) {
                if (text.includes('sp_getapplock')) return { recordsets: [recordset([{ result: 0 }])] };
                if (text.includes('isMine')) return { recordsets: [recordset(holders, { LockedDt: 'datetime' })] };
                if (text.includes('DELETE FROM')) return { recordsets: [recordset([{ released: 1 }])] };
                if (text.includes('OUTPUT')) return { recordsets: [recordset([{ MfgLoc: null, Process: 'P', UserId: 'tester', Timestamp: stored.LockedDt }], { Timestamp: 'datetime' })] };
                if (text.startsWith('SELECT TOP (1)')) return { recordsets: [recordset([stored], { LockedDt: 'datetime' })] };
                return { recordsets: [] };
            }
        });
        const app = express();
        app.use('/api', createApiRouter(config, { database, log: { info() {}, error() {} }, mountRoutes }));
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
    const errorOf = async (res) => (await res.json()).error;

    it('POST /plan/lock takes a free location: 201 with the lock', async () => {
        holders = [];
        const res = await call('POST', '/api/main/plan/lock', { body: { MfgLoc: 'DYP', LockedBy: 'ray' } });
        assert.equal(res.status, 201);
        assert.deepEqual(await res.json(), { locked: true, alreadyHeld: false, lock: { MfgLoc: 'DYP', LockedBy: 'ray', LockedDt: '2026-10-23T09:00:00', Session: null, Remarks: null } });
    });

    it('POST /plan/lock by the user who holds it is 200 alreadyHeld', async () => {
        holders = [{ ...stored, isMine: 1 }];
        const res = await call('POST', '/api/main/plan/lock', { body: { MfgLoc: 'DYP', LockedBy: 'ray' } });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).alreadyHeld, true);
    });

    it('POST /plan/lock for a location another user holds is 409 with the holder in the error', async () => {
        holders = [{ ...stored, LockedBy: 'someone', Session: 'tab-3', isMine: 0 }];
        const res = await call('POST', '/api/main/plan/lock', { body: { MfgLoc: 'DYP', LockedBy: 'ray' } });
        assert.equal(res.status, 409);
        assert.deepEqual(await errorOf(res), {
            code: 'conflict',
            message: 'This location is locked by another user.',
            holder: { LockedBy: 'someone', LockedDt: '2026-10-23T09:00:00', Session: 'tab-3' }
        });
    });

    it('GET /plan/lock says who holds it, and DELETE releases your own', async () => {
        const read = await call('GET', '/api/main/plan/lock?MfgLoc=DYP');
        assert.deepEqual(await read.json(), { locked: true, lock: { MfgLoc: 'DYP', LockedBy: 'ray', LockedDt: '2026-10-23T09:00:00', Session: null, Remarks: null } });
        const del = await call('DELETE', '/api/main/plan/lock?MfgLoc=DYP&LockedBy=ray');
        assert.deepEqual([del.status, await del.json()], [200, { released: true }]);
    });

    it('lock input errors are 400 in the error shape', async () => {
        for (const [method, path, body] of [
            ['POST', '/api/main/plan/lock', {}],
            ['POST', '/api/main/plan/lock', '{ nope'],
            ['GET', '/api/main/plan/lock', undefined],
            ['DELETE', '/api/main/plan/lock?MfgLoc=DYP', undefined]
        ]) {
            const res = await call(method, path, { body });
            assert.equal(res.status, 400, `${method} ${path}`);
            assert.equal((await errorOf(res)).code, 'bad_request');
        }
    });

    it('POST /plan/timestamp writes the row as the signed-in user and answers 201', async () => {
        database.queries.length = 0;
        const res = await call('POST', '/api/main/plan/timestamp', { body: { Process: 'Generate Planning Board Finish' } });
        assert.equal(res.status, 201);
        assert.equal((await res.json()).inserted, 1);
        const insert = database.queries.at(-1);
        assert.match(insert.text, /VALUES \(@mfgLoc, @process, @userId, GETDATE\(\)\)$/);
        assert.equal(insert.inputs.find((i) => i.name === 'userId').value, 'tester', 'the user comes from the token');
    });

    it('POST /plan/timestamp refuses a UserId or Timestamp from the request', async () => {
        for (const body of [{ Process: 'x', UserId: 'someone-else' }, { Process: 'x', Timestamp: '2020-01-01T00:00:00' }, {}]) {
            const res = await call('POST', '/api/main/plan/timestamp', { body });
            assert.equal(res.status, 400, JSON.stringify(body));
        }
    });

    it('every plan route needs a token', async () => {
        for (const [method, path] of [['POST', '/api/main/plan/lock'], ['GET', '/api/main/plan/lock?MfgLoc=a'], ['DELETE', '/api/main/plan/lock?MfgLoc=a&LockedBy=b'], ['POST', '/api/main/plan/timestamp']]) {
            assert.equal((await call(method, path, { body: method === 'POST' ? {} : undefined, auth: false })).status, 401, `${method} ${path}`);
        }
    });
});
