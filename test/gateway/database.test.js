const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const real = require('mssql');

const { createDatabase } = require('../../src/gateway/db/database');
const { ApiError } = require('../../src/api/errors');
const { validate } = require('../../src/gateway/config/load-config');
const { createFakeSql, parameterRows, recordset } = require('../helpers/fake-sql');

const config = validate({
    jwt: { secret: 'x'.repeat(32) },
    profiles: {
        main: { server: 'db.test', port: 1444, database: 'TestDb', user: 'u', password: 'SENTINEL_PASSWORD', poolMax: 7, dataTimeoutSeconds: 30, multiTimeoutSeconds: 90, tlsMinVersion: 'TLSv1' },
        other: { server: 'db2.test', database: 'Other', user: 'u2', password: 'p2' }
    }
});

const quietLog = () => ({ lines: [], errors: [], info(l) { this.lines.push(l); }, error(l) { this.errors.push(l); } });

// One procedure: prdTest(@MfgLoc varchar(20), @Count int, @Flag bit, @When datetime)
const PROC_PARAMS = [['MfgLoc', 'varchar', 20], ['Count', 'int', 4], ['Flag', 'bit', 1], ['When', 'datetime', 8]];

function setup(extra = {}) {
    const calls = { describe: 0 };
    const fake = createFakeSql({
        messages: extra.messages,
        connectError: extra.connectError,
        onQuery(text, request) {
            if (text.includes('sys.parameters')) {
                calls.describe += 1;
                const name = request.inputs.find((i) => i.name === 'name').value.toLowerCase().replace(/^dbo\./, '');
                if (name === 'prdtest') return { recordset: parameterRows(PROC_PARAMS) };
                if (name === 'prdnoparams') return { recordset: parameterRows([]) };
                return { recordset: [] };
            }
            return { recordset: [{ ok: 1 }] };
        },
        onExecute: extra.onExecute || (() => ({
            recordsets: [recordset([{ A: 1 }], { A: 'int' }), recordset([{ B: 2 }], { B: 'int' })],
            returnValue: 0
        }))
    });
    const log = quietLog();
    let clock = 1000;
    const db = createDatabase({ profiles: config.profiles, sql: fake.sql, log, catalogTtlMs: 60000 });
    return { db, fake, log, calls, tick: (ms) => { clock += ms; return clock; } };
}

describe('database: calling a procedure', () => {
    it('types and converts every parameter from the procedure\'s own metadata and executes by name', async () => {
        const { db, fake } = setup();
        const result = await db.callProcedure('main', 'dbo.prdTest', { MfgLoc: 'DYP', '@count': '5', FLAG: 'true', when: '2026-10-23T08:00:00' });
        assert.equal(result.recordsets.length, 2);
        assert.equal(result.returnValue, 0);

        const request = fake.state.requests.find((r) => r.procedure);
        assert.equal(request.procedure, 'dbo.prdTest');
        const byName = Object.fromEntries(request.inputs.map((i) => [i.name, i]));
        assert.deepEqual(Object.keys(byName).sort(), ['Count', 'Flag', 'MfgLoc', 'When']); // declared spelling
        assert.equal(byName.MfgLoc.type.type.declaration, 'varchar');
        assert.equal(byName.MfgLoc.type.length, 20);
        assert.equal(byName.MfgLoc.value, 'DYP');
        assert.equal(byName.Count.type, real.Int);
        assert.equal(byName.Count.value, 5);
        assert.equal(byName.Flag.value, true);
        assert.equal(byName.When.type, real.DateTime);
        assert.equal(byName.When.value.toISOString(), '2026-10-23T08:00:00.000Z');
    });

    it('calls a procedure that has no parameters', async () => {
        const { db, fake } = setup();
        await db.callProcedure('main', 'prdNoParams', {});
        assert.deepEqual(fake.state.requests.find((r) => r.procedure).inputs, []);
    });

    it('refuses a parameter the procedure does not have, a duplicate, and a bad value, without echoing values', async () => {
        const { db, fake } = setup();
        await assert.rejects(db.callProcedure('main', 'prdTest', { Nope: 1 }), (e) => e.status === 400 && /no parameter @Nope/.test(e.message));
        await assert.rejects(db.callProcedure('main', 'prdTest', { Count: 1, '@COUNT': 2 }), (e) => e.status === 400 && /given twice/.test(e.message));
        await assert.rejects(db.callProcedure('main', 'prdTest', { MfgLoc: 'SENTINEL'.repeat(10) }), (e) => e.status === 400 && /longer than the 20/.test(e.message) && !/SENTINEL/.test(e.message));
        await assert.rejects(db.callProcedure('main', 'prdTest', [1, 2]), (e) => e.status === 400 && /params must be an object/.test(e.message));
        assert.equal(fake.state.requests.filter((r) => r.procedure).length, 0, 'nothing was executed');
    });

    it('answers 404 not_found for a procedure the catalog does not list, and does not cache that', async () => {
        const { db, calls } = setup();
        await assert.rejects(db.callProcedure('main', 'prdMissing', {}), (e) => e.status === 404 && e.code === 'not_found');
        await assert.rejects(db.callProcedure('main', 'prdMissing', {}), (e) => e.status === 404);
        assert.equal(calls.describe, 2);
    });

    it('reads a procedure\'s metadata once and then from the cache', async () => {
        const { db, calls } = setup();
        await db.callProcedure('main', 'prdTest', {});
        await db.callProcedure('main', 'PRDTEST', {});
        await db.callProcedure('main', 'prdTest', { Count: 1 });
        assert.equal(calls.describe, 1);
    });

    it('re-reads the metadata after the cache time', async () => {
        let reads = 0;
        const fake = createFakeSql({ onQuery: () => { reads += 1; return { recordset: parameterRows([['A', 'int', 4]]) }; } });
        let now = 0;
        const { createProcedureCatalog } = require('../../src/gateway/db/proc-catalog');
        const catalog = createProcedureCatalog({ ttlMs: 1000, now: () => now });
        const pool = new fake.sql.ConnectionPool({});
        await catalog.describe(pool, fake.sql, 'main', 'p');
        now = 999;
        await catalog.describe(pool, fake.sql, 'main', 'p');
        assert.equal(reads, 1, 'still cached');
        now = 1001;
        await catalog.describe(pool, fake.sql, 'main', 'p');
        assert.equal(reads, 2, 'read again after the cache time');
        catalog.clear();
        await catalog.describe(pool, fake.sql, 'main', 'p');
        assert.equal(reads, 3, 'read again after clear()');
    });

    it('collects what the procedure PRINTs', async () => {
        const { db } = setup({ messages: ['Unexpected error occurred!', 'Violation of PRIMARY KEY'] });
        const result = await db.callProcedure('main', 'prdTest', {});
        assert.deepEqual(result.messages, ['Unexpected error occurred!', 'Violation of PRIMARY KEY']);
    });

    it('uses the profile\'s single timeout for one result set and the multi timeout for several', async () => {
        const { db, fake } = setup();
        await db.callProcedure('main', 'prdTest', {});
        await db.callProcedure('main', 'prdTest', {}, { multi: true });
        const executed = fake.state.requests.filter((r) => r.procedure);
        assert.deepEqual(executed.map((r) => r.overrides.requestTimeout), [30000, 90000]);
    });

    it('maps SQL Server errors to API errors and keeps unexpected ones out of the answer', async () => {
        const dup = new real.RequestError(Object.assign(new Error('Violation of PRIMARY KEY'), { info: { number: 2627, class: 14 } }), 'EREQUEST');
        const { db } = setup({ onExecute: () => { throw dup; } });
        await assert.rejects(db.callProcedure('main', 'prdTest', {}), (e) => e.status === 409 && e.code === 'conflict');

        const slow = new real.RequestError('Timeout: Request failed to complete in 30000ms', 'ETIMEOUT');
        const second = setup({ onExecute: () => { throw slow; } });
        await assert.rejects(second.db.callProcedure('main', 'prdTest', {}), (e) => e.status === 504);
    });

    it('answers 404 for a profile that is not configured', async () => {
        const { db } = setup();
        await assert.rejects(db.callProcedure('nope', 'prdTest', {}), (e) => e.status === 404 && /Unknown profile/.test(e.message));
        await assert.rejects(db.callProcedure('__proto__', 'prdTest', {}), (e) => e.status === 404);
    });
});

describe('database: transactions', () => {
    const requestError = (number, severity, message) =>
        new real.RequestError(Object.assign(new Error(message), { info: { number, class: severity } }), 'EREQUEST');

    it('runs the work on one transaction and commits when it returns', async () => {
        const { db, fake } = setup();
        const out = await db.transaction('main', async (tx) => {
            await tx.query('SELECT 1 AS a', []);
            const second = await tx.query('SELECT @x AS x', [{ name: 'x', meta: { typeName: 'int' }, value: 5 }]);
            assert.deepEqual(second.recordsets.length, 1);
            return 'done';
        });
        assert.equal(out, 'done');

        const tx = fake.state.transactions[0];
        assert.deepEqual(tx.events, ['begin', 'commit']);
        const inTx = fake.state.requests.filter((r) => r.pool === tx);
        assert.equal(inTx.length, 2, 'every statement ran on the transaction');
        assert.equal(inTx[1].inputs[0].type, real.Int);
        assert.equal(inTx[1].overrides.requestTimeout, 30000);
    });

    it('rolls back when the work throws, and passes an API error on unchanged', async () => {
        const { db, fake } = setup();
        const conflict = new ApiError(409, 'conflict', 'held');
        await assert.rejects(db.transaction('main', async () => { throw conflict; }), (e) => e === conflict);
        assert.deepEqual(fake.state.transactions[0].events, ['begin', 'rollback']);
    });

    it('rolls back and maps a SQL Server error (duplicate key is 409)', async () => {
        const { db, fake } = setup();
        await assert.rejects(
            db.transaction('main', async () => { throw requestError(2627, 14, 'Violation of PRIMARY KEY'); }),
            (e) => e.status === 409 && e.code === 'conflict'
        );
        assert.deepEqual(fake.state.transactions[0].events, ['begin', 'rollback']);
    });

    it('a failing commit is reported; a failing rollback does not hide the first error', async () => {
        const commitFails = setup();
        commitFails.fake.script.commitError = requestError(1205, 13, 'deadlock victim');
        await assert.rejects(commitFails.db.transaction('main', async () => 1), (e) => e.status === 409);

        const rollbackFails = setup();
        rollbackFails.fake.script.rollbackError = new real.TransactionError('Transaction has not begun.', 'ENOTBEGUN');
        const original = new ApiError(400, 'bad_request', 'the first error');
        await assert.rejects(rollbackFails.db.transaction('main', async () => { throw original; }), (e) => e === original);
    });

    it('answers 503 when the transaction can not begin, and 404 for an unknown profile', async () => {
        const { db, fake } = setup();
        fake.script.beginError = new real.ConnectionError('Connection is closed.', 'ECONNCLOSED');
        await assert.rejects(db.transaction('main', async () => 1), (e) => e.status === 503 && e.code === 'db_unavailable');
        await assert.rejects(setup().db.transaction('nope', async () => 1), (e) => e.status === 404);
    });
});

describe('database: building blocks for Save', () => {
    const requestError = (number, severity, message) =>
        new real.RequestError(Object.assign(new Error(message), { info: { number, class: severity } }), 'EREQUEST');
    const prepared = {
        schema: 'dbo',
        name: 'BOHdrBulkCopy',
        columns: [
            { kind: 'column', name: 'TransId', typeName: 'varchar', maxLength: 50, precision: 0, scale: 0, nullable: true },
            { kind: 'column', name: 'Qty', typeName: 'int', maxLength: 4, precision: 10, scale: 0, nullable: false },
            { kind: 'column', name: 'When', typeName: 'datetime', maxLength: 8, precision: 23, scale: 3, nullable: true }
        ],
        rows: [['T1', 1, new Date(Date.UTC(2026, 9, 23, 8))], ['T1', 2, null]]
    };

    it('bulkInsert loads the rows into the table with each column typed from the catalog, using the long timeout', async () => {
        const { db, fake } = setup();
        assert.deepEqual(await db.bulkInsert('main', prepared), { rows: 2 });

        const request = fake.state.requests.find((r) => r.bulkTable);
        const table = request.bulkTable;
        assert.equal(table.path, '[dbo].[BOHdrBulkCopy]');
        assert.equal(table.create, false);
        assert.deepEqual(table.columns.map((c) => [c.name, c.type.declaration, c.nullable]), [['TransId', 'varchar', true], ['Qty', 'int', false], ['When', 'datetime', true]]);
        assert.equal(table.columns[0].length, 50);
        assert.deepEqual(table.rows.map((r) => r.length), [3, 3]);
        assert.equal(table.rows[0][2].toISOString(), '2026-10-23T08:00:00.000Z');
        assert.equal(request.overrides.requestTimeout, 90000);
    });

    it('bulkInsert inside a transaction runs on that transaction and maps errors', async () => {
        const { db, fake } = setup({});
        await db.transaction('main', (tx) => tx.bulkInsert(prepared));
        assert.equal(fake.state.requests.find((r) => r.bulkTable).pool, fake.state.transactions[0]);

        fake.script.onBulk = () => { throw requestError(2627, 14, 'Violation of PRIMARY KEY'); };
        await assert.rejects(db.bulkInsert('main', prepared), (e) => e.status === 409 && e.code === 'conflict');
        await assert.rejects(db.transaction('main', (tx) => tx.bulkInsert(prepared)), (e) => e.status === 409);
        assert.deepEqual(fake.state.transactions[1].events, ['begin', 'rollback']);
    });

    it('tx.callProcedure runs on the transaction with typed parameters and what it printed', async () => {
        const { db, fake } = setup({ messages: ['Saving'] });
        const result = await db.transaction('main', (tx) => tx.callProcedure('prdTest', { MfgLoc: 'DYP', Count: 2 }, { multi: true }));
        assert.deepEqual(result.messages, ['Saving']);
        const request = fake.state.requests.find((r) => r.procedure === 'prdTest');
        assert.equal(request.pool, fake.state.transactions[0]);
        assert.equal(request.overrides.requestTimeout, 90000);
        assert.equal(request.inputs.find((i) => i.name === 'Count').type, real.Int);
    });

    it('keeps what a procedure printed on the error, also after the error is mapped, and its step', async () => {
        const failing = () => { throw requestError(50000, 16, 'Batch 12 is locked.'); };
        const outside = setup({ messages: ['printed before the error'], onExecute: failing });
        await assert.rejects(outside.db.callProcedure('main', 'prdTest', {}), (e) => e.status === 400 && e.code === 'sql_error' && e.messages[0] === 'printed before the error');

        const inside = setup({ messages: ['printed in tx'], onExecute: failing });
        await assert.rejects(
            inside.db.transaction('main', async (tx) => {
                try { await tx.callProcedure('prdTest', {}); } catch (err) { err.stepId = '2.1'; throw err; }
            }),
            (e) => e.status === 400 && e.messages[0] === 'printed in tx' && e.stepId === '2.1'
        );
    });

    it('a procedure that ends the transaction it was called in (SQL Server error 266) is 422 step_failed', async () => {
        for (const number of [266, 3902, 3903]) {
            const { db } = setup({ onExecute: () => { throw requestError(number, 16, 'Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements.'); } });
            await assert.rejects(
                db.transaction('main', (tx) => tx.callProcedure('prdTest', {})),
                (e) => e.status === 422 && e.code === 'step_failed' && /ended the transaction/.test(e.message),
                String(number)
            );
        }
    });

    it('checkCall finds the procedure and checks the parameters without running anything', async () => {
        const { db, fake } = setup();
        assert.equal(await db.checkCall('main', 'prdTest', { MfgLoc: 'DYP', Count: '3' }), true);
        await assert.rejects(db.checkCall('main', 'prdTest', { Nope: 1 }), (e) => e.status === 400 && /no parameter @Nope/.test(e.message));
        await assert.rejects(db.checkCall('main', 'prdTest', { MfgLoc: 'x'.repeat(30) }), (e) => e.status === 400 && /longer than the 20/.test(e.message));
        await assert.rejects(db.checkCall('main', 'prdMissing', {}), (e) => e.status === 404);
        assert.equal(fake.state.requests.filter((r) => r.procedure).length, 0);
    });
});

describe('database: connections', () => {
    it('makes no connection until the first call, then one pool per profile, built from the profile', async () => {
        const { db, fake } = setup();
        assert.equal(fake.state.pools.length, 0);
        await db.callProcedure('main', 'prdTest', {});
        await db.callProcedure('main', 'prdTest', {});
        await db.callProcedure('other', 'prdTest', {});
        assert.equal(fake.state.pools.length, 2);

        const main = fake.state.pools[0].config;
        assert.equal(main.server, 'db.test');
        assert.equal(main.port, 1444);
        assert.equal(main.database, 'TestDb');
        assert.equal(main.pool.max, 7);
        assert.equal(main.pool.acquireTimeoutMillis, 60000);
        assert.equal(main.options.encrypt, false);
        assert.equal(main.options.trustServerCertificate, true);
        assert.deepEqual(main.options.cryptoCredentialsDetails, { minVersion: 'TLSv1' });
        assert.equal(main.requestTimeout, 90000);
        assert.equal(fake.state.pools[1].config.port, 1433);
        assert.equal(fake.state.pools[1].config.options.cryptoCredentialsDetails, undefined);
    });

    it('shares one pool between calls that start at the same moment', async () => {
        const { db, fake } = setup();
        await Promise.all([db.callProcedure('main', 'prdTest', {}), db.callProcedure('main', 'prdTest', {}), db.ping('main')]);
        assert.equal(fake.state.pools.length, 1);
        assert.equal(fake.state.connectCalls, 1);
    });

    it('a failed connection is 503, logged without the password, and tried again on the next call', async () => {
        const { db, fake, log } = setup({ connectError: new real.ConnectionError("Login failed for user 'u'.", 'ELOGIN') });
        await assert.rejects(db.callProcedure('main', 'prdTest', {}), (e) => e.status === 503 && e.code === 'db_unavailable');
        await assert.rejects(db.ping('main'), (e) => e.status === 503);
        assert.equal(fake.state.connectCalls, 2);
        assert.ok(fake.state.pools.every((p) => p.closed), 'failed pools are closed');
        assert.doesNotMatch(log.errors.join('\n'), /SENTINEL_PASSWORD/);

        fake.script.connectError = null;
        assert.equal(await db.ping('main'), true);
    });

    it('logs a pool error instead of crashing', async () => {
        const { db, fake, log } = setup();
        await db.ping('main');
        assert.doesNotThrow(() => fake.state.pools[0].emit('error', new Error('connection reset')));
        assert.match(log.errors[0], /pool "main" error: connection reset/);
    });

    it('ping runs a trivial query with a short timeout', async () => {
        const { db, fake } = setup();
        assert.equal(await db.ping('main'), true);
        const request = fake.state.requests[0];
        assert.equal(request.text, 'SELECT 1 AS ok');
        assert.equal(request.overrides.requestTimeout, 10000);
    });

    it('close() closes every pool', async () => {
        const { db, fake } = setup();
        await db.ping('main');
        await db.ping('other');
        await db.close();
        assert.ok(fake.state.pools.every((p) => p.closed));
    });
});
