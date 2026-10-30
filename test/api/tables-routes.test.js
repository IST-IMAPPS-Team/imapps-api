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
    jwt: { secret: 'tables-test-secret-tables-test-secret-12' },
    limits: { tableRows: 50 },
    profiles: { main: { server: 'db.test', database: 'D', user: 'u', password: 'p' } }
});

const locking = fakeTable({
    name: 'BOLocking',
    columns: [
        ['Recid', 'uniqueidentifier', { nullable: false }],
        ['MfgLoc', 'varchar', { maxLength: 50, nullable: false }],
        ['LockedDt', 'datetime'],
        ['LockedBy', 'nvarchar', { maxLength: 200, nullable: false }]
    ]
});

describe('table routes', () => {
    let server;
    let base;
    let database;
    let reply = { recordsets: [] };
    const token = issueToken({ userId: 'tester', secret: config.jwt.secret, lifetimeSeconds: 3600 }).token;

    before(async () => {
        database = createFakeDatabase({}, { tables: { bolocking: locking }, onQuery: () => reply });
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
    const lastQuery = () => database.queries.at(-1);

    it('GET reads rows; dotted where keys, encoded values, columns, orderBy and top arrive as written', async () => {
        reply = { recordsets: [recordset([{ MfgLoc: 'DYP', LockedBy: 'Ray Mart' }])] };
        const res = await call('GET', '/api/main/tables/dbo.BOLocking/rows?columns=MfgLoc,LockedBy&orderBy=-LockedDt&top=5&where.MfgLoc=DYP&where.LockedBy=Ray%20Mart');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { rows: [{ MfgLoc: 'DYP', LockedBy: 'Ray Mart' }], truncated: false });
        assert.equal(lastQuery().text, 'SELECT TOP (@top) [MfgLoc], [LockedBy] FROM [dbo].[BOLocking] WHERE [MfgLoc] = @w0 AND [LockedBy] = @w1 ORDER BY [LockedDt] DESC');
        assert.deepEqual(lastQuery().inputs.map((i) => i.value), [6, 'DYP', 'Ray Mart']);
    });

    it('GET uses the profile\'s tableRows limit (50 here) as the default and the maximum', async () => {
        reply = { recordsets: [recordset([])] };
        await call('GET', '/api/main/tables/BOLocking/rows');
        assert.equal(lastQuery().inputs[0].value, 51);
        const res = await call('GET', '/api/main/tables/BOLocking/rows?top=51');
        assert.equal(res.status, 400);
        assert.match((await errorOf(res)).message, /from 1 to 50/);
    });

    it('POST inserts and answers 201 with the stored row', async () => {
        reply = { recordsets: [recordset([{ Recid: 'x', MfgLoc: 'DYP' }])] };
        const res = await call('POST', '/api/main/tables/BOLocking/rows', { body: { values: { MfgLoc: 'DYP', LockedBy: 'ray' } } });
        assert.equal(res.status, 201);
        assert.deepEqual(await res.json(), { inserted: 1, row: { Recid: 'x', MfgLoc: 'DYP' } });
    });

    it('PATCH updates and DELETE deletes the rows given by the query-string filters', async () => {
        reply = { recordsets: [recordset([{ affected: 1, rolledBack: 0 }])] };
        const patch = await call('PATCH', '/api/main/tables/BOLocking/rows?where.MfgLoc=DYP', { body: { values: { LockedBy: 'x' } } });
        assert.deepEqual([patch.status, await patch.json()], [200, { updated: 1 }]);
        const del = await call('DELETE', '/api/main/tables/BOLocking/rows?where.MfgLoc=DYP&where.LockedBy=ray');
        assert.deepEqual([del.status, await del.json()], [200, { deleted: 1 }]);
    });

    it('PATCH and DELETE without a where are 400 and run nothing', async () => {
        const before = database.queries.length;
        const patch = await call('PATCH', '/api/main/tables/BOLocking/rows', { body: { values: { LockedBy: 'x' } } });
        assert.deepEqual([patch.status, (await errorOf(patch)).code], [400, 'bad_request']);
        const del = await call('DELETE', '/api/main/tables/BOLocking/rows');
        assert.equal(del.status, 400);
        assert.match((await errorOf(del)).message, /where is required/);
        assert.equal(database.queries.length, before);
    });

    it('a repeated filter, an unknown table, a bad table name and bad bodies are errors in the error shape', async () => {
        const twice = await call('GET', '/api/main/tables/BOLocking/rows?where.MfgLoc=a&where.MfgLoc=b');
        assert.deepEqual([twice.status, (await errorOf(twice)).code], [400, 'bad_request']);

        const unknown = await call('GET', '/api/main/tables/Nope/rows');
        assert.deepEqual([unknown.status, (await errorOf(unknown)).code], [404, 'not_found']);

        const badName = await call('GET', '/api/main/tables/a%20b/rows');
        assert.equal(badName.status, 400);

        const badJson = await call('POST', '/api/main/tables/BOLocking/rows', { body: '{ nope' });
        assert.equal(badJson.status, 400);
        const noValues = await call('POST', '/api/main/tables/BOLocking/rows', { body: { MfgLoc: 'x' } });
        assert.match((await errorOf(noValues)).message, /Unknown field "MfgLoc"/);
    });

    it('every table route needs a token, and only these four methods exist', async () => {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
            assert.equal((await call(method, '/api/main/tables/BOLocking/rows', { auth: false })).status, 401, method);
        }
        const put = await call('PUT', '/api/main/tables/BOLocking/rows', { body: {} });
        assert.deepEqual([put.status, (await errorOf(put)).code], [404, 'not_found']);
    });

    it('turns a database conflict into 409', async () => {
        const { ApiError } = require('../../src/api/errors');
        reply = null;
        const original = database.query;
        database.query = async () => { throw new ApiError(409, 'conflict', 'A row with the same key already exists.'); };
        try {
            const res = await call('POST', '/api/main/tables/BOLocking/rows', { body: { values: { MfgLoc: 'DYP', LockedBy: 'ray' } } });
            assert.deepEqual([res.status, (await errorOf(res)).code], [409, 'conflict']);
        } finally {
            database.query = original;
        }
    });
});
