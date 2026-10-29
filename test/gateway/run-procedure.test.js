const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runProcedure } = require('../../src/gateway/db/run-procedure');
const { createFakeDatabase } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const when = new Date(Date.UTC(2026, 9, 23, 8, 0, 0));

describe('run-procedure', () => {
    it('single: answers the first result set as rows, dates as local text', async () => {
        const db = createFakeDatabase({
            prdone: { recordsets: [recordset([{ Id: 1, Start: when }], { Start: 'datetime' }), recordset([{ Ignored: true }])], messages: [], returnValue: 0 }
        });
        const out = await runProcedure(db, 'main', 'prdOne', { A: 1 });
        assert.deepEqual(out.rows, [{ Id: 1, Start: '2026-10-23T08:00:00' }]);
        assert.equal('resultSets' in out, false);
        assert.deepEqual(db.calls[0], { profile: 'main', name: 'prdOne', params: { A: 1 }, options: { multi: false } });
    });

    it('single: a procedure that returns nothing answers an empty list', async () => {
        const db = createFakeDatabase({ prdnone: { recordsets: [], messages: [], returnValue: 0 } });
        assert.deepEqual((await runProcedure(db, 'main', 'prdNone', {})).rows, []);
    });

    it('multi: answers every result set, in order, without a number to supply', async () => {
        const db = createFakeDatabase({
            prdmany: { recordsets: [recordset([{ A: 1 }]), recordset([{ B: 2 }, { B: 3 }]), recordset([])], messages: [], returnValue: 0 }
        });
        const out = await runProcedure(db, 'main', 'prdMany', {}, { multi: true });
        assert.deepEqual(out.resultSets, [[{ A: 1 }], [{ B: 2 }, { B: 3 }], []]);
        assert.equal('rows' in out, false);
        assert.deepEqual(db.calls[0].options, { multi: true });
    });

    it('passes on what the procedure printed and its return value', async () => {
        const db = createFakeDatabase({ prdmsg: { recordsets: [recordset([{ ERROR_FLAG: 1 }])], messages: ['Unexpected error occurred!'], returnValue: 5 } });
        const out = await runProcedure(db, 'main', 'prdMsg', {});
        assert.deepEqual(out.messages, ['Unexpected error occurred!']);
        assert.equal(out.returnValue, 5);
    });

    it('checks the name before asking the database', async () => {
        const db = createFakeDatabase({});
        await assert.rejects(runProcedure(db, 'main', 'db.dbo.x', {}), (e) => e.status === 400);
        await assert.rejects(runProcedure(db, 'main', 'prdGetBOBulkCopyConnectString', {}), (e) => e.status === 403);
        assert.equal(db.calls.length, 0);
    });

    it('lets database errors through unchanged', async () => {
        const db = createFakeDatabase({});
        await assert.rejects(runProcedure(db, 'main', 'prdMissing', {}), (e) => e.status === 404 && e.code === 'not_found');
    });

    it('produces JSON-safe output even for big integers, GUIDs and binary', async () => {
        const db = createFakeDatabase({
            prdtypes: { recordsets: [recordset([{ Big: 12345678901234567890n, G: 'ABCDEF01-0000-0000-0000-000000000000', Bin: Buffer.from([1, 2]) }], { G: 'uniqueidentifier' })], messages: [] }
        });
        const out = await runProcedure(db, 'main', 'prdTypes', {});
        assert.doesNotThrow(() => JSON.stringify(out));
        assert.deepEqual(out.rows[0], { Big: '12345678901234567890', G: 'abcdef01-0000-0000-0000-000000000000', Bin: 'AQI=' });
    });
});
