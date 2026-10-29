const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const real = require('mssql');

const { createDatabase } = require('../../src/gateway/db/database');
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
