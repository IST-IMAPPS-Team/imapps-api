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

// BOLocking as sp_help showed it, in the shape the catalog query returns.
const lockingColumn = (name, type, maxLength, nullable) => ({
    schema_name: 'dbo', table_name: 'BOLocking', object_type: 'U ', has_triggers: 0, column_name: name, type_name: type,
    max_length: maxLength, precision: 0, scale: 0, is_nullable: nullable, is_identity: 0, is_computed: 0
});
const LOCKING_COLUMNS = [
    lockingColumn('Recid', 'uniqueidentifier', 16, 0),
    lockingColumn('MfgLoc', 'varchar', 50, 0),
    lockingColumn('LockedDt', 'datetime', 8, 0),
    lockingColumn('LockedBy', 'nvarchar', 200, 0),
    lockingColumn('Session', 'nvarchar', 200, 1),
    lockingColumn('Remarks', 'nvarchar', 200, 1)
];
const stampColumn = (name, type, maxLength) => ({ ...lockingColumn(name, type, maxLength, 1), table_name: 'BOTimestamp' });
const TIMESTAMP_COLUMNS = [
    stampColumn('MfgLoc', 'varchar', 50),
    stampColumn('Process', 'varchar', 100),
    stampColumn('UserId', 'varchar', 50),
    stampColumn('Timestamp', 'datetime', 8)
];
const STORED_ROW ={ Recid: '6F9619FF-8B86-D011-B42D-00C04FC964FF', MfgLoc: 'DYP', LockedDt: new Date(Date.UTC(2026, 9, 23, 9, 30, 0)), LockedBy: 'ray' };

describe('end to end with only SQL Server faked', () => {
    let server;
    let base;
    let fake;
    let token;
    const log = { lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } };

    before(async () => {
        fake = createFakeSql({
            onQuery(text, request) {
                if (text.includes('sys.columns')) {
                    const asked = request.inputs.find((i) => i.name === 'name').value.toLowerCase().replace(/^dbo\./, '');
                    return { recordset: { bolocking: LOCKING_COLUMNS, botimestamp: TIMESTAMP_COLUMNS }[asked] || [] };
                }
                if (text.includes('sp_getapplock')) return { recordset: [{ result: 0 }] };
                if (text.includes('isMine')) return { recordset: [] };
                if (text.startsWith('SELECT TOP') || text.startsWith('INSERT INTO')) {
                    return { recordsets: [recordset([STORED_ROW], { Recid: 'uniqueidentifier', LockedDt: 'datetime' })] };
                }
                if (text.includes('BEGIN TRANSACTION')) return { recordset: [{ affected: 1, rolledBack: 0 }] };
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

    const lastQuery = (prefix) => fake.state.requests.filter((r) => r.text && r.text.startsWith(prefix)).at(-1);

    it('reads table rows: catalog names in the SQL, values typed from the column, dates and GUIDs as the web app expects', async () => {
        const res = await fetch(base + '/api/main/tables/BOLocking/rows?where.mfgloc=DYP&top=10', { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            rows: [{ Recid: '6f9619ff-8b86-d011-b42d-00c04fc964ff', MfgLoc: 'DYP', LockedDt: '2026-10-23T09:30:00', LockedBy: 'ray' }],
            truncated: false
        });
        const request = lastQuery('SELECT TOP');
        assert.equal(request.text, 'SELECT TOP (@top) [Recid], [MfgLoc], [LockedDt], [LockedBy], [Session], [Remarks] FROM [dbo].[BOLocking] WHERE [MfgLoc] = @w0');
        const byName = Object.fromEntries(request.inputs.map((i) => [i.name, i]));
        assert.equal(byName.top.type, real.Int);
        assert.equal(byName.top.value, 11);
        assert.equal(byName.w0.type.type.declaration, 'varchar');
        assert.equal(byName.w0.type.length, 50);
    });

    it('inserts a table row with typed values and answers 201 with the stored row', async () => {
        const res = await post('/api/main/tables/BOLocking/rows', { values: { MfgLoc: 'DYP', LockedBy: 'ray' } });
        assert.equal(res.status, 201);
        assert.equal((await res.json()).row.LockedBy, 'ray');
        const request = lastQuery('INSERT INTO');
        assert.match(request.text, /^INSERT INTO \[dbo\]\.\[BOLocking\] \(\[MfgLoc\], \[LockedBy\]\) OUTPUT INSERTED\.\[Recid\]/);
        const lockedBy = request.inputs.find((i) => i.meta === undefined && i.name === 'v1');
        assert.equal(lockedBy.type.type.declaration, 'nvarchar');
        assert.equal(lockedBy.type.length, 100);
    });

    it('changes rows inside a capped transaction with typed filters and the row limit as a parameter', async () => {
        const patch = await fetch(base + '/api/main/tables/BOLocking/rows?where.MfgLoc=DYP&where.LockedBy=ray', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ values: { Remarks: 'back' } })
        });
        assert.deepEqual(await patch.json(), { updated: 1 });
        const request = lastQuery('SET XACT_ABORT ON');
        assert.match(request.text, /UPDATE \[dbo\]\.\[BOLocking\] SET \[Remarks\] = @v0 WHERE \[MfgLoc\] = @w0 AND \[LockedBy\] = @w1;/);
        assert.equal(request.inputs.find((i) => i.name === 'maxRows').value, 1000);
        assert.equal(request.inputs.find((i) => i.name === 'maxRows').type, real.Int);

        const del = await fetch(base + '/api/main/tables/BOLocking/rows?where.MfgLoc=DYP', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
        assert.deepEqual(await del.json(), { deleted: 1 });
    });

    it('refuses an unknown table (404) and names that are not in the catalog (400) without sending any data SQL', async () => {
        const dataSql = () => fake.state.requests.filter((r) => r.text && /^(SELECT TOP|INSERT|SET XACT)/.test(r.text)).length;
        const before = dataSql();
        const headers = { authorization: `Bearer ${token}` };
        assert.equal((await fetch(base + '/api/main/tables/Missing/rows', { headers })).status, 404);
        assert.equal((await fetch(base + '/api/main/tables/BOLocking/rows?columns=Nope', { headers })).status, 400);
        assert.equal((await fetch(base + '/api/main/tables/BOLocking/rows?where.Nope=1', { headers })).status, 400);
        assert.equal((await fetch(base + '/api/main/tables/BOLocking/rows?where.LockedDt=2026-10-23T08:00:00Z', { headers })).status, 400);
        assert.equal(dataSql(), before);
    });

    it('takes the edit lock in one transaction: its turn first, then look, insert, read back; commits', async () => {
        const txBefore = fake.state.transactions.length;
        const res = await post('/api/main/plan/lock', { MfgLoc: 'DYP', LockedBy: 'ray', Session: 'tab-1' });
        assert.equal(res.status, 201);
        assert.equal((await res.json()).locked, true);

        const tx = fake.state.transactions[txBefore];
        assert.deepEqual(tx.events, ['begin', 'commit']);
        const inTx = fake.state.requests.filter((r) => r.pool === tx);
        assert.equal(inTx.length, 4);
        assert.match(inTx[0].text, /sp_getapplock/);
        assert.equal(inTx[0].inputs[0].value, 'BOLocking:dyp');
        assert.match(inTx[2].text, /^INSERT INTO \[dbo\]\.\[BOLocking\] \(\[MfgLoc\], \[LockedBy\], \[Session\]\) VALUES \(@mfgLoc, @lockedBy, @session\)$/);
        const byName = Object.fromEntries(inTx[2].inputs.map((i) => [i.name, i]));
        assert.equal(byName.mfgLoc.type.type.declaration, 'varchar');
        assert.equal(byName.mfgLoc.type.length, 50);
        assert.equal(byName.lockedBy.type.type.declaration, 'nvarchar');
        assert.equal(byName.lockedBy.type.length, 100);
    });

    it('writes the load timestamp as the signed-in user, with the database clock', async () => {
        const res = await post('/api/main/plan/timestamp', { Process: 'Generate Planning Board Finish', MfgLoc: 'DYP' });
        assert.equal(res.status, 201);
        const request = lastQuery('INSERT INTO [dbo].[BOTimestamp]');
        assert.match(request.text, /VALUES \(@mfgLoc, @process, @userId, GETDATE\(\)\)$/);
        assert.equal(request.inputs.find((i) => i.name === 'userId').value, 'raymart', 'the user the token was issued to');
        const forged = await post('/api/main/plan/timestamp', { Process: 'x', UserId: 'someone-else' });
        assert.equal(forged.status, 400);
    });

    it('reads the table\'s catalog entry once for all these calls', () => {
        const describes = fake.state.requests.filter((r) => r.text && r.text.includes('sys.columns') && r.inputs[0].value.toLowerCase() === 'bolocking');
        assert.equal(describes.length, 1);
    });

    it('never puts the database or user password into a log line', () => {
        assert.doesNotMatch(log.lines.join('\n') + log.errors.join('\n'), /SENTINEL|secret-pw/);
    });
});
