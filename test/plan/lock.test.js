const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { takeLock, readLock, releaseLock } = require('../../src/plan/services/lock');
const { createFakeDatabase, fakeTable } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

// BOLocking as sp_help showed it.
const locking = fakeTable({
    name: 'BOLocking',
    columns: [
        ['Recid', 'uniqueidentifier', { nullable: false }],
        ['MfgLoc', 'varchar', { maxLength: 50, nullable: false }],
        ['LockedDt', 'datetime', { nullable: false }],
        ['LockedBy', 'nvarchar', { maxLength: 200, nullable: false }],
        ['Session', 'nvarchar', { maxLength: 200 }],
        ['Remarks', 'nvarchar', { maxLength: 200 }]
    ]
});

const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 23, h, m, 0));
const lockRow = (extra = {}) => ({ MfgLoc: 'DYP', LockedBy: 'ray', LockedDt: at(9), Session: 'tab-1', Remarks: null, ...extra });
const types = { LockedDt: 'datetime' };

// A scripted database: `scenario.holders` are the rows already in BOLocking for the location,
// `scenario.applock` is what sp_getapplock answers, `scenario.deleted` how many rows a DELETE removes.
function setup(scenario = {}, { table = locking } = {}) {
    const state = { holders: [], applock: 0, deleted: 1, stored: lockRow(), ...scenario };
    const db = createFakeDatabase({}, {
        tables: { bolocking: table },
        onQuery(text) {
            if (text.includes('sp_getapplock')) return { recordsets: [recordset([{ result: state.applock }])] };
            if (text.includes('isMine')) return { recordsets: [recordset(state.holders, types)] };
            if (text.startsWith('SELECT TOP (1)')) return { recordsets: [recordset(state.stored ? [state.stored] : [], types)] };
            if (text.includes('DELETE FROM')) return { recordsets: [recordset([{ released: state.deleted }])] };
            return { recordsets: [] };
        }
    });
    const statements = () => db.queries.map((q) => q.text.split(/\s/)[0] === 'DECLARE' ? 'APPLOCK' : q.text.split(/\s/)[0]);
    return { db, statements, state };
}

const refuses = (promise, status, pattern) => assert.rejects(promise, (e) =>
    e.status === status && pattern.test(e.message) && !/SENTINEL/.test(e.message), String(pattern));

describe('lock: taking it', () => {
    it('a free location: waits its turn, looks, inserts, reads the row back, all in one transaction', async () => {
        const { db, statements } = setup({ holders: [] });
        const out = await takeLock(db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' });

        assert.deepEqual(out, { locked: true, alreadyHeld: false, lock: { MfgLoc: 'DYP', LockedBy: 'ray', LockedDt: '2026-10-23T09:00:00', Session: 'tab-1', Remarks: null } });
        assert.deepEqual(statements(), ['APPLOCK', 'SELECT', 'INSERT', 'SELECT']);
        assert.deepEqual(db.transactions, [['commit']]);
        assert.ok(db.queries.every((q) => q.inTransaction));
    });

    it('serialises takes for one location with an application lock named after it', async () => {
        const { db } = setup();
        await takeLock(db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' });
        const [applock] = db.queries;
        assert.match(applock.text, /EXEC @result = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;/);
        assert.equal(applock.inputs[0].value, 'BOLocking:dyp');
        assert.equal(applock.inputs[0].meta.typeName, 'nvarchar');
    });

    it('inserts only MfgLoc and LockedBy, so the database fills Recid and LockedDt; Session and Remarks when given', async () => {
        const plain = setup();
        await takeLock(plain.db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' });
        const insert = plain.db.queries.find((q) => q.text.startsWith('INSERT'));
        assert.equal(insert.text, 'INSERT INTO [dbo].[BOLocking] ([MfgLoc], [LockedBy]) VALUES (@mfgLoc, @lockedBy)');

        const full = setup();
        await takeLock(full.db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray', Session: 'tab-9', Remarks: null });
        const insertFull = full.db.queries.find((q) => q.text.startsWith('INSERT'));
        assert.equal(insertFull.text, 'INSERT INTO [dbo].[BOLocking] ([MfgLoc], [LockedBy], [Session], [Remarks]) VALUES (@mfgLoc, @lockedBy, @session, @remarks)');
        assert.deepEqual(insertFull.inputs.map((i) => [i.name, i.value]), [['mfgLoc', 'DYP'], ['lockedBy', 'ray'], ['session', 'tab-9'], ['remarks', null]]);
    });

    it('the same user taking it again refreshes LockedDt and answers 200-style alreadyHeld, without inserting', async () => {
        const { db, statements } = setup({ holders: [{ ...lockRow(), isMine: 1 }] });
        const out = await takeLock(db, 'main', { MfgLoc: 'DYP', LockedBy: 'RAY', Session: 'tab-2' });

        assert.equal(out.alreadyHeld, true);
        assert.deepEqual(statements(), ['APPLOCK', 'SELECT', 'UPDATE', 'SELECT']);
        const update = db.queries.find((q) => q.text.startsWith('UPDATE'));
        assert.equal(update.text, 'UPDATE [dbo].[BOLocking] SET [LockedDt] = GETDATE(), [Session] = @session WHERE [MfgLoc] = @mfgLoc AND [LockedBy] = @lockedBy');
        assert.deepEqual(db.transactions, [['commit']]);
    });

    it('another user holding it is 409 conflict naming the holder; nothing is written and the transaction is undone', async () => {
        const { db, statements } = setup({ holders: [{ ...lockRow({ LockedBy: 'someone', Session: 'tab-7' }), isMine: 0 }] });
        await assert.rejects(takeLock(db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' }), (e) => {
            assert.equal(e.status, 409);
            assert.equal(e.code, 'conflict');
            assert.equal(e.message, 'This location is locked by another user.');
            assert.deepEqual(e.extra, { holder: { LockedBy: 'someone', LockedDt: '2026-10-23T09:00:00', Session: 'tab-7' } });
            return true;
        });
        assert.deepEqual(statements(), ['APPLOCK', 'SELECT']);
        assert.deepEqual(db.transactions, [['rollback']]);
    });

    it('when an old race left rows for two users, the one who holds a row may refresh; others see the earliest holder', async () => {
        const rows = [{ ...lockRow({ LockedBy: 'early' }), isMine: 0 }, { ...lockRow({ LockedBy: 'ray', LockedDt: at(10) }), isMine: 1 }];
        const mine = setup({ holders: rows });
        assert.equal((await takeLock(mine.db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' })).alreadyHeld, true);

        const other = setup({ holders: rows.map((r) => ({ ...r, isMine: 0 })) });
        await assert.rejects(takeLock(other.db, 'main', { MfgLoc: 'DYP', LockedBy: 'third' }), (e) => e.extra.holder.LockedBy === 'early');
    });

    it('answers 409 "try again" when it can not get its turn, and writes nothing', async () => {
        const { db, statements } = setup({ applock: -1 });
        await refuses(takeLock(db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' }), 409, /Another request is changing this lock/);
        assert.deepEqual(statements(), ['APPLOCK']);
        assert.deepEqual(db.transactions, [['rollback']]);
    });

    it('checks the body before opening a transaction: required text, only known fields, lengths from the table', async () => {
        const { db } = setup();
        for (const body of [undefined, null, [], 'x', {}, { MfgLoc: 'a' }, { LockedBy: 'a' }, { MfgLoc: '', LockedBy: 'a' }, { MfgLoc: 5, LockedBy: 'a' },
            { MfgLoc: 'a', LockedBy: 'b', Extra: 1 }, { MfgLoc: 'a', LockedBy: 'b', Session: 5 }, { MfgLoc: 'a', LockedBy: 'b', mfgloc: 'x' }]) {
            await assert.rejects(takeLock(db, 'main', body), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(body));
        }
        await refuses(takeLock(db, 'main', { MfgLoc: 'SENTINEL'.repeat(10), LockedBy: 'a' }), 400, /Column MfgLoc: longer than the 50 characters/);
        await refuses(takeLock(db, 'main', { MfgLoc: 'a', LockedBy: 'SENTINEL'.repeat(20) }), 400, /Column LockedBy: longer than the 100 characters/);
        assert.equal(db.transactions.length, 0);
        assert.equal(db.queries.length, 0);
    });

    it('values travel as typed parameters, never inside the SQL text', async () => {
        const { db } = setup();
        const hostile = "x'; DROP TABLE BOLocking; --";
        await takeLock(db, 'main', { MfgLoc: hostile, LockedBy: 'ray' });
        assert.ok(db.queries.every((q) => !q.text.includes('DROP') && !q.text.includes(hostile)));
        assert.ok(db.queries.some((q) => q.inputs.some((i) => i.value === hostile)));
    });

    it('404 when the lock table is not in the database; 500 naming a missing column', async () => {
        const none = createFakeDatabase({}, { tables: {} });
        await refuses(takeLock(none, 'main', { MfgLoc: 'a', LockedBy: 'b' }), 404, /table BOLocking was not found/);
        const odd = fakeTable({ name: 'BOLocking', columns: [['MfgLoc', 'varchar', { maxLength: 50 }], ['LockedBy', 'nvarchar', { maxLength: 200 }]] });
        const { db } = setup({}, { table: odd });
        await refuses(takeLock(db, 'main', { MfgLoc: 'a', LockedBy: 'b' }), 500, /has no column Recid, LockedDt, Session, Remarks/);
        assert.equal(db.transactions.length, 0);
    });
});

describe('lock: reading and releasing it', () => {
    it('reads who holds a location, or that nobody does', async () => {
        const held = setup({ stored: lockRow() });
        assert.deepEqual(await readLock(held.db, 'main', { MfgLoc: 'DYP' }), {
            locked: true, lock: { MfgLoc: 'DYP', LockedBy: 'ray', LockedDt: '2026-10-23T09:00:00', Session: 'tab-1', Remarks: null }
        });
        assert.equal(held.db.queries[0].text, 'SELECT TOP (1) [MfgLoc], [LockedBy], [LockedDt], [Session], [Remarks] FROM [dbo].[BOLocking] WHERE [MfgLoc] = @mfgLoc ORDER BY [LockedDt], [Recid]');

        const free = setup({ stored: null });
        assert.deepEqual(await readLock(free.db, 'main', { MfgLoc: 'DYP' }), { locked: false });
    });

    it('releases only the row that matches both MfgLoc and LockedBy; nothing to release is not an error', async () => {
        const some = setup({ deleted: 1 });
        assert.deepEqual(await releaseLock(some.db, 'main', { MfgLoc: 'DYP', LockedBy: 'ray' }), { released: true });
        assert.equal(some.db.queries[0].text, 'SET NOCOUNT ON; DELETE FROM [dbo].[BOLocking] WHERE [MfgLoc] = @mfgLoc AND [LockedBy] = @lockedBy; SELECT @@ROWCOUNT AS released;');
        assert.deepEqual(some.db.queries[0].inputs.map((i) => [i.name, i.value]), [['mfgLoc', 'DYP'], ['lockedBy', 'ray']]);

        const none = setup({ deleted: 0 });
        assert.deepEqual(await releaseLock(none.db, 'main', { MfgLoc: 'DYP', LockedBy: 'someone-else' }), { released: false });
    });

    it('needs MfgLoc (and LockedBy to release) once each, and no other query field', async () => {
        const { db } = setup();
        for (const query of [{}, { MfgLoc: '' }, { MfgLoc: ['a', 'b'] }, { MfgLoc: 'a', x: '1' }, { mfgloc: 'a' }]) {
            await assert.rejects(readLock(db, 'main', query), (e) => e.status === 400, JSON.stringify(query));
        }
        for (const query of [{ MfgLoc: 'a' }, { LockedBy: 'b' }, { MfgLoc: 'a', LockedBy: ['b', 'c'] }, { MfgLoc: 'a', LockedBy: 'b', top: '1' }]) {
            await assert.rejects(releaseLock(db, 'main', query), (e) => e.status === 400, JSON.stringify(query));
        }
        assert.equal(db.queries.length, 0);
    });
});
