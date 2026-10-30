const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { writeTimestamp } = require('../../src/plan/services/timestamp');
const { createFakeDatabase, fakeTable } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

// BOTimestamp as sp_help showed it: four optional columns, no key, no defaults.
const stamp = (extra = {}) => fakeTable({
    name: 'BOTimestamp',
    columns: [
        ['MfgLoc', 'varchar', { maxLength: 50 }],
        ['Process', 'varchar', { maxLength: 100 }],
        ['UserId', 'varchar', { maxLength: 50 }],
        ['Timestamp', 'datetime']
    ],
    ...extra
});

const stored = { MfgLoc: 'DYP', Process: 'Generate Planning Board Finish', UserId: 'ray', Timestamp: new Date(Date.UTC(2026, 9, 23, 9, 30, 15)) };
const make = (table = stamp()) => createFakeDatabase({}, {
    tables: { botimestamp: table },
    onQuery: () => ({ recordsets: [recordset([stored], { Timestamp: 'datetime' })] })
});
const refuses = (promise, status, pattern) => assert.rejects(promise, (e) =>
    e.status === status && pattern.test(e.message) && !/SENTINEL/.test(e.message), String(pattern));

describe('timestamp: the load audit row', () => {
    it('inserts one row with the database clock and the signed-in user, and answers it', async () => {
        const db = make();
        const out = await writeTimestamp(db, 'main', { Process: 'Generate Planning Board Finish', MfgLoc: 'DYP' }, 'ray');

        assert.deepEqual(out, { inserted: 1, row: { MfgLoc: 'DYP', Process: 'Generate Planning Board Finish', UserId: 'ray', Timestamp: '2026-10-23T09:30:15' } });
        const q = db.queries[0];
        assert.equal(q.text, 'INSERT INTO [dbo].[BOTimestamp] ([MfgLoc], [Process], [UserId], [Timestamp]) OUTPUT INSERTED.[MfgLoc], INSERTED.[Process], INSERTED.[UserId], INSERTED.[Timestamp] VALUES (@mfgLoc, @process, @userId, GETDATE())');
        assert.deepEqual(q.inputs.map((i) => [i.name, i.value]), [['mfgLoc', 'DYP'], ['process', 'Generate Planning Board Finish'], ['userId', 'ray']]);
    });

    it('MfgLoc is optional and goes in as null', async () => {
        const db = make();
        await writeTimestamp(db, 'main', { Process: 'Something' }, 'ray');
        assert.equal(db.queries[0].inputs[0].value, null);
        await writeTimestamp(db, 'main', { Process: 'Something', MfgLoc: null }, 'ray');
        assert.equal(db.queries[1].inputs[0].value, null);
    });

    it('takes the user only from the caller (the token), never from the body', async () => {
        const db = make();
        await refuses(writeTimestamp(db, 'main', { Process: 'x', UserId: 'someone-else' }, 'ray'), 400, /Unknown field "UserId"/);
        await refuses(writeTimestamp(db, 'main', { Process: 'x', Timestamp: '2020-01-01T00:00:00' }, 'ray'), 400, /Unknown field "Timestamp"/);
        assert.equal(db.queries.length, 0);
    });

    it('checks the body and the column lengths', async () => {
        const db = make();
        for (const body of [undefined, null, [], {}, { Process: '' }, { Process: 5 }, { MfgLoc: 'a' }, { Process: 'x', MfgLoc: 5 }]) {
            await assert.rejects(writeTimestamp(db, 'main', body, 'ray'), (e) => e.status === 400, JSON.stringify(body));
        }
        await refuses(writeTimestamp(db, 'main', { Process: 'SENTINEL'.repeat(20) }, 'ray'), 400, /Column Process: longer than the 100 characters/);
        await refuses(writeTimestamp(db, 'main', { Process: 'x', MfgLoc: 'SENTINEL'.repeat(10) }, 'ray'), 400, /Column MfgLoc: longer than the 50 characters/);
        await refuses(writeTimestamp(db, 'main', { Process: 'x' }, 'u'.repeat(51)), 400, /Column UserId: longer than the 50 characters/);
        assert.equal(db.queries.length, 0);
    });

    it('a table with enabled triggers is written without OUTPUT and answers row: null', async () => {
        const db = make(stamp({ hasTriggers: true }));
        const out = await writeTimestamp(db, 'main', { Process: 'x' }, 'ray');
        assert.equal(db.queries[0].text, 'INSERT INTO [dbo].[BOTimestamp] ([MfgLoc], [Process], [UserId], [Timestamp]) VALUES (@mfgLoc, @process, @userId, GETDATE())');
        assert.deepEqual(out, { inserted: 1, row: null });
    });

    it('404 when the table is missing; 500 naming a missing column', async () => {
        await refuses(writeTimestamp(createFakeDatabase({}, { tables: {} }), 'main', { Process: 'x' }, 'ray'), 404, /table BOTimestamp was not found/);
        const odd = fakeTable({ name: 'BOTimestamp', columns: [['Process', 'varchar', { maxLength: 100 }]] });
        await refuses(writeTimestamp(make(odd), 'main', { Process: 'x' }, 'ray'), 500, /has no column MfgLoc, UserId, Timestamp/);
    });
});
