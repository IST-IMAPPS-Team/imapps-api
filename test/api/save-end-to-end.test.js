const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const real = require('mssql');

const { validate } = require('../../src/gateway/config/load-config');
const { createApiRouter } = require('../../src/api/router');
const mountRoutes = require('../../src/api/routes');
const { createDatabase } = require('../../src/gateway/db/database');
const { issueToken } = require('../../src/gateway/auth/token');
const { createFakeSql, parameterRows, recordset } = require('../helpers/fake-sql');

// Save through HTTP, the router, the token check, the recipe checks, the runner and the real
// database layer, with only the SQL driver faked.
const config = validate({
    jwt: { secret: 'save-e2e-secret-save-e2e-secret-1234567' },
    profiles: { main: { server: 'db.test', database: 'D', user: 'u', password: 'p', dataTimeoutSeconds: 30, multiTimeoutSeconds: 90 } }
});

const PROCEDURES = {
    prdsavebulkbohstrysp: [['TransId', 'varchar', 50], ['MfgLoc', 'varchar', 50], ['UserID', 'nvarchar', 100]],
    prdbulkcopyinsertsp: [['TransId', 'varchar', 50], ['UserID', 'nvarchar', 100]],
    prdsavebulksp: [['TransId', 'varchar', 50], ['UserID', 'nvarchar', 100]]
};
const stagingColumn = (table, name, type, maxLength) => ({
    schema_name: 'dbo', table_name: table, object_type: 'U ', has_triggers: 0, column_name: name, type_name: type,
    max_length: maxLength, precision: 0, scale: 0, is_nullable: 1, is_identity: 0, is_computed: 0
});
const staging = (table) => [
    stagingColumn(table, 'TransId', 'varchar', 50), stagingColumn(table, 'MONo', 'varchar', 50),
    stagingColumn(table, 'BONo', 'varchar', 50), stagingColumn(table, 'PlanQty', 'varchar', 50)
];
const TABLES = { bohdrbulkcopy: staging('BOHdrBulkCopy'), bodeletebulkcopy: staging('BODeleteBulkCopy') };

const recipe = () => ({
    steps: [
        { call: 'prdSaveBulkBoHstrySP', params: { TransId: 'T1', MfgLoc: 'DYP', UserID: 'ray' } },
        { transaction: [
            { bulk: 'BOHdrBulkCopy', columns: ['TransId', 'MONo', 'BONo', 'PlanQty'], rows: [['T1', 'MO1', 'B1', 10], ['T1', 'MO1', 'B2', 20]] },
            { bulk: 'BODeleteBulkCopy', columns: ['TransId', 'MONo', 'BONo'], rows: [['T1', 'MO9', 'B9']] }
        ] },
        { repeat: [
            { call: 'prdBulkCopyInsertSP', params: { TransId: 'T1', UserID: 'ray' }, okWhenFirstCellIs: 0 },
            { call: 'prdSaveBulkSP', params: { TransId: 'T1', UserID: 'ray' }, okWhenFirstCellIs: 0 }
        ], attempts: 3 }
    ]
});

describe('Save end to end with only SQL Server faked', () => {
    let server;
    let base;
    let fake;
    // What the faked procedures answer; each test sets what it needs.
    let flags;
    let printed;
    const log = { lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } };
    const token = issueToken({ userId: 'ray', secret: config.jwt.secret, lifetimeSeconds: 3600 }).token;

    before(async () => {
        fake = createFakeSql({
            onQuery(text, request) {
                const asked = request.inputs.find((i) => i.name === 'name')?.value.toLowerCase().replace(/^dbo\./, '');
                if (text.includes('sys.parameters')) return { recordset: PROCEDURES[asked] ? parameterRows(PROCEDURES[asked]) : [] };
                if (text.includes('sys.columns')) return { recordset: TABLES[asked] || [] };
                return { recordset: [{ ok: 1 }] };
            },
            onExecute(name, request) {
                fake.script.messages = printed[name.toLowerCase()] || [];
                const next = (flags[name.toLowerCase()] || [0]);
                const value = next.length > 1 ? next.shift() : next[0];
                if (value === 'ended') {
                    throw new real.RequestError(Object.assign(new Error('Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements.'), { info: { number: 266, class: 16 } }), 'EREQUEST');
                }
                return { recordsets: [recordset(name.toLowerCase() === 'prdsavebulkbohstrysp' ? [] : [{ ERROR_FLAG: value }])], returnValue: 0 };
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

    const save = (body, auth = true) => fetch(base + '/api/main/plan/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    const executed = () => fake.state.requests.filter((r) => r.procedure).map((r) => r.procedure);
    const reset = () => { flags = {}; printed = {}; fake.script.onBulk = undefined; };

    it('saves: history call, then the staging group in one transaction, then the two calls outside any transaction', async () => {
        reset();
        const txBefore = fake.state.transactions.length;
        const requestsBefore = fake.state.requests.length;
        const res = await save(recipe());
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.deepEqual(body.steps.map((s) => [s.step, s.kind]), [['1', 'call'], ['2', 'transaction'], ['3', 'repeat']]);
        assert.deepEqual(body.steps[1].steps.map((s) => s.rows), [2, 1]);

        const tx = fake.state.transactions[txBefore];
        assert.deepEqual(tx.events, ['begin', 'commit']);
        assert.equal(fake.state.transactions.length, txBefore + 1, 'exactly one transaction, for the group');

        const mine = fake.state.requests.slice(requestsBefore).filter((r) => r.procedure || r.bulkTable);
        assert.deepEqual(mine.map((r) => r.procedure || r.bulkTable.path), ['prdSaveBulkBoHstrySP', '[dbo].[BOHdrBulkCopy]', '[dbo].[BODeleteBulkCopy]', 'prdBulkCopyInsertSP', 'prdSaveBulkSP']);
        assert.deepEqual(mine.map((r) => r.pool === tx), [false, true, true, false, false], 'only the two staging inserts ran inside the transaction');
        assert.ok(mine.every((r) => r.overrides.requestTimeout === 90000), 'the long timeout');
    });

    it('sends the staging rows as typed values and the procedure parameters typed from the catalog', async () => {
        reset();
        await save(recipe());
        const hdr = fake.state.requests.filter((r) => r.bulkTable && r.bulkTable.path === '[dbo].[BOHdrBulkCopy]').at(-1).bulkTable;
        assert.deepEqual(hdr.columns.map((c) => [c.name, c.type.declaration]), [['TransId', 'varchar'], ['MONo', 'varchar'], ['BONo', 'varchar'], ['PlanQty', 'varchar']]);
        assert.deepEqual(hdr.rows, [['T1', 'MO1', 'B1', '10'], ['T1', 'MO1', 'B2', '20']]);

        const history = fake.state.requests.filter((r) => r.procedure === 'prdSaveBulkBoHstrySP').at(-1);
        const byName = Object.fromEntries(history.inputs.map((i) => [i.name, i]));
        assert.equal(byName.UserID.type.length, 50);
        assert.equal(byName.TransId.type.type.declaration, 'varchar');
    });

    it('runs the two calls again while a check fails and reports the attempts', async () => {
        reset();
        flags = { prdsavebulksp: [1, 1, 0] };
        const body = await (await save(recipe())).json();
        assert.equal(body.steps[2].attempts, 3);
        assert.equal(executed().filter((n) => n === 'prdSaveBulkSP').length >= 3, true);
    });

    it('after the last attempt: 422 step_failed with the step, the attempts and what the procedure printed', async () => {
        reset();
        flags = { prdsavebulksp: [1] };
        printed = { prdsavebulksp: ['Unexpected error occurred!', 'Violation of PRIMARY KEY constraint'] };
        const res = await save(recipe());
        assert.equal(res.status, 422);
        const { error } = await res.json();
        assert.equal(error.code, 'step_failed');
        assert.equal(error.step, '3.2');
        assert.equal(error.attempts, 3);
        assert.match(error.message, /prdSaveBulkSP gave 1 in the first cell of result set 1, not 0, after 3 attempts/);
        assert.ok(error.messages.includes('Violation of PRIMARY KEY constraint'));
    });

    it('a staging insert that fails undoes the group and the two calls never run', async () => {
        reset();
        let count = 0;
        fake.script.onBulk = () => {
            if (++count === 2) throw new real.RequestError(Object.assign(new Error('Violation of PRIMARY KEY'), { info: { number: 2627, class: 14 } }), 'EREQUEST');
        };
        const txBefore = fake.state.transactions.length;
        const before = executed().length;
        const res = await save(recipe());
        assert.equal(res.status, 409);
        const { error } = await res.json();
        assert.deepEqual([error.code, error.step], ['conflict', '2.2']);
        assert.deepEqual(fake.state.transactions[txBefore].events, ['begin', 'rollback']);
        assert.deepEqual(executed().slice(before), ['prdSaveBulkBoHstrySP'], 'only the history call ran, as in the legacy');
    });

    it('a procedure that ends the group\'s transaction is 422 and undoes the group', async () => {
        reset();
        flags = { prdsavebulksp: ['ended'] };
        const body = { steps: [{ transaction: [
            { bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [['T1']] },
            { call: 'prdSaveBulkSP', params: { TransId: 'T1', UserID: 'ray' } }
        ] }] };
        const txBefore = fake.state.transactions.length;
        const res = await save(body);
        assert.equal(res.status, 422);
        const { error } = await res.json();
        assert.deepEqual([error.code, error.step], ['step_failed', '1.2']);
        assert.match(error.message, /ended the transaction/);
        assert.deepEqual(fake.state.transactions[txBefore].events, ['begin', 'rollback']);
    });

    it('a bad recipe runs nothing: step 3 names a parameter the procedure does not have', async () => {
        reset();
        const bad = recipe();
        bad.steps[2].repeat[1].params = { Nope: 1 };
        const before = { calls: executed().length, tx: fake.state.transactions.length, bulks: fake.state.requests.filter((r) => r.bulkTable).length };
        const res = await save(bad);
        assert.equal(res.status, 400);
        const { error } = await res.json();
        assert.deepEqual([error.code, error.step], ['bad_request', '3.2']);
        assert.match(error.message, /Step 3\.2: The procedure has no parameter @Nope/);
        assert.deepEqual({ calls: executed().length, tx: fake.state.transactions.length, bulks: fake.state.requests.filter((r) => r.bulkTable).length }, before);
    });

    it('a value that does not fit names the step, row and column and does not echo the value', async () => {
        reset();
        const bad = recipe();
        bad.steps[1].transaction[0].rows[1][0] = 'SENTINEL'.repeat(10);
        const res = await save(bad);
        assert.equal(res.status, 400);
        const { error } = await res.json();
        assert.deepEqual([error.step, error.row, error.column], ['2.1', 2, 'TransId']);
        assert.doesNotMatch(JSON.stringify(error), /SENTINEL/);
    });

    it('refuses the blocked procedure with 403 and the step', async () => {
        reset();
        const res = await save({ steps: [{ call: 'prdGetBOBulkCopyConnectString' }] });
        assert.equal(res.status, 403);
        assert.deepEqual([(await res.json()).error.step], ['1']);
    });

    it('needs a token; bad JSON and a body that is not a recipe are 400', async () => {
        assert.equal((await save(recipe(), false)).status, 401);
        assert.equal((await save('{ nope')).status, 400);
        const res = await save({ nothing: true });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error.message, /Unknown field "nothing"/);
    });

    it('accepts a large Save body (over 2 MB, the limit is 20 MB) while other routes keep the 1 MB limit', async () => {
        reset();
        const rows = Array.from({ length: 30000 }, (_, i) => [`T${i}`, `MO${i}`, `B${i}`, 'x'.repeat(50)]);
        const big = { steps: [{ bulk: 'BOHdrBulkCopy', columns: ['TransId', 'MONo', 'BONo', 'PlanQty'], rows }] };
        const text = JSON.stringify(big);
        assert.ok(text.length > 2 * 1024 * 1024, `body is ${text.length} bytes`);

        const res = await save(text);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).steps[0].rows, 30000);

        const other = await fetch(base + '/api/main/procedures/prdSaveBulkSP', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: text
        });
        assert.equal(other.status, 413);
    });

    it('refuses more rows than limits.saveRowsPerTable (50000) with the step', async () => {
        reset();
        const rows = Array.from({ length: 50001 }, () => ['T']);
        const res = await save({ steps: [{ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows }] });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error.message, /at most 50000 rows/);
    });

    it('never writes the staging values or the database password into a log line', () => {
        assert.doesNotMatch(log.lines.join('\n') + log.errors.join('\n'), /SENTINEL|MO1|B1/);
    });
});
