const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { readRows, insertRow, updateRows, deleteRows } = require('../../src/gateway/db/table-service');
const { createFakeDatabase, fakeTable } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const limits = { tableRows: 1000 };

// BOLocking and BOTimestamp as sp_help showed them.
const locking = fakeTable({
    name: 'BOLocking',
    columns: [
        ['Recid', 'uniqueidentifier', { nullable: false }],
        ['MfgLoc', 'varchar', { maxLength: 50, nullable: false }],
        ['LockedDt', 'datetime', { maxLength: 8, nullable: false }],
        ['LockedBy', 'nvarchar', { maxLength: 200, nullable: false }],
        ['Session', 'nvarchar', { maxLength: 200 }],
        ['Remarks', 'nvarchar', { maxLength: 200 }]
    ]
});
// A table that has every awkward kind of column.
const items = fakeTable({
    name: 'Items',
    columns: [
        ['Id', 'int', { identity: true, nullable: false }],
        ['Name', 'nvarchar', { maxLength: 40 }],
        ['Total', 'decimal', { precision: 18, scale: 2, computed: true }],
        ['RowVer', 'timestamp'],
        ['Notes', 'text', { maxLength: 16 }],
        ['Data', 'xml', { maxLength: -1 }],
        ['Shape', 'geography', { maxLength: -1 }],
        ['we]ird', 'int']
    ]
});
const withTriggers = fakeTable({ name: 'Audited', hasTriggers: true, columns: [['A', 'int'], ['B', 'varchar', { maxLength: 10 }]] });
const aView = fakeTable({ name: 'vwThing', isView: true, columns: [['A', 'int']] });

const tables = { bolocking: locking, items, audited: withTriggers, vwthing: aView };
const make = (onQuery) => createFakeDatabase({}, { tables, onQuery });
const refuses = (promise, status, pattern) => assert.rejects(promise, (e) =>
    e.status === status && pattern.test(e.message) && !/SENTINEL/.test(e.message), String(pattern));

describe('table service: reading rows', () => {
    it('reads every readable column of a table with a quoted catalog name and a typed @top', async () => {
        const db = make(() => ({ recordsets: [recordset([{ MfgLoc: 'DYP', LockedDt: new Date(Date.UTC(2026, 9, 23, 8, 0, 0)) }], { LockedDt: 'datetime' })] }));
        const out = await readRows(db, 'main', 'BOLocking', {}, limits);

        assert.deepEqual(out, { rows: [{ MfgLoc: 'DYP', LockedDt: '2026-10-23T08:00:00' }], truncated: false });
        const q = db.queries[0];
        assert.equal(q.text, 'SELECT TOP (@top) [Recid], [MfgLoc], [LockedDt], [LockedBy], [Session], [Remarks] FROM [dbo].[BOLocking]');
        assert.deepEqual(q.inputs.map((i) => [i.name, i.meta.typeName, i.value]), [['top', 'int', 1001]]);
    });

    it('applies columns, where (equality, AND), orderBy and top; names come out in the catalog\'s spelling', async () => {
        const db = make(() => ({ recordsets: [recordset([])] }));
        await readRows(db, 'main', 'dbo.bolocking', {
            columns: 'mfgloc, LockedBy', orderBy: '-lockeddt,MFGLOC', top: '5', 'where.MFGLOC': 'DYP', 'where.lockedby': 'ray mart'
        }, limits);

        const q = db.queries[0];
        assert.equal(q.text, 'SELECT TOP (@top) [MfgLoc], [LockedBy] FROM [dbo].[BOLocking] WHERE [MfgLoc] = @w0 AND [LockedBy] = @w1 ORDER BY [LockedDt] DESC, [MfgLoc] ASC');
        assert.deepEqual(q.inputs.map((i) => [i.name, i.meta.name, i.value]), [['top', undefined, 6], ['w0', 'MfgLoc', 'DYP'], ['w1', 'LockedBy', 'ray mart']]);
    });

    it('says when the answer was cut off at top', async () => {
        const db = make(() => ({ recordsets: [recordset([{ A: 1 }, { A: 2 }, { A: 3 }])] }));
        assert.deepEqual(await readRows(db, 'main', 'BOLocking', { top: '2' }, limits), { rows: [{ A: 1 }, { A: 2 }], truncated: true });
        assert.deepEqual((await readRows(db, 'main', 'BOLocking', { top: '3' }, limits)).truncated, false);
    });

    it('caps top at limits.tableRows, which is also the default', async () => {
        const db = make(() => ({ recordsets: [recordset([])] }));
        await readRows(db, 'main', 'BOLocking', {}, { tableRows: 10 });
        assert.equal(db.queries[0].inputs[0].value, 11);
        for (const top of ['0', '11', 'abc', '-1', '1.5', '']) {
            await refuses(readRows(db, 'main', 'BOLocking', { top }, { tableRows: 10 }), 400, /top must be a whole number from 1 to 10/);
        }
    });

    it('leaves out columns SQL Server can not return, and refuses to ask for them', async () => {
        const db = make(() => ({ recordsets: [recordset([])] }));
        await readRows(db, 'main', 'Items', {}, limits);
        assert.equal(db.queries[0].text, 'SELECT TOP (@top) [Id], [Name], [Total], [RowVer], [Notes], [Data], [we]]ird] FROM [dbo].[Items]');
        await refuses(readRows(db, 'main', 'Items', { columns: 'Shape' }, limits), 400, /can not be read/);
    });

    it('404 for a table the catalog does not list, 400 for a bad table name; the database is not queried', async () => {
        const db = make();
        await refuses(readRows(db, 'main', 'Nope', {}, limits), 404, /No such table/);
        for (const name of ['a b', 'db.dbo.t', 'a;b', "x'y", '1a', 'a]b']) {
            await refuses(readRows(db, 'main', name, {}, limits), 400, /table name is not valid/);
        }
        assert.equal(db.queries.length, 0);
    });

    it('400 for unknown columns, unknown query fields, repeated fields and values that do not fit', async () => {
        const db = make();
        await refuses(readRows(db, 'main', 'BOLocking', { columns: 'Nope' }, limits), 400, /no column "Nope" \(columns\)/);
        await refuses(readRows(db, 'main', 'BOLocking', { orderBy: 'Nope' }, limits), 400, /no column "Nope" \(orderBy\)/);
        await refuses(readRows(db, 'main', 'BOLocking', { 'where.Nope': '1' }, limits), 400, /no column "Nope" \(where\)/);
        await refuses(readRows(db, 'main', 'BOLocking', { sort: 'x' }, limits), 400, /Unknown query field "sort"/);
        await refuses(readRows(db, 'main', 'BOLocking', { 'where.MfgLoc': ['a', 'b'] }, limits), 400, /must be given once/);
        await refuses(readRows(db, 'main', 'BOLocking', { columns: ['a', 'b'] }, limits), 400, /must be given once/);
        await refuses(readRows(db, 'main', 'BOLocking', { columns: 'MfgLoc,mfgloc' }, limits), 400, /twice/);
        await refuses(readRows(db, 'main', 'BOLocking', { columns: 'MfgLoc,,' }, limits), 400, /comma-separated/);
        await refuses(readRows(db, 'main', 'BOLocking', { 'where.MfgLoc': 'a', 'where.mfgloc': 'b' }, limits), 400, /in where twice/);
        await refuses(readRows(db, 'main', 'Items', { 'where.Id': 'SENTINEL' }, limits), 400, /Column Id: expected a whole number/);
        await refuses(readRows(db, 'main', 'BOLocking', { 'where.LockedDt': '2026-10-23T08:00:00Z' }, limits), 400, /no time zone/);
        assert.equal(db.queries.length, 0);
    });

    it('does not allow text, ntext, image or xml in where or orderBy', async () => {
        const db = make();
        await refuses(readRows(db, 'main', 'Items', { 'where.Notes': 'x' }, limits), 400, /can not be used in where/);
        await refuses(readRows(db, 'main', 'Items', { 'where.Data': 'x' }, limits), 400, /can not be used in where/);
        await refuses(readRows(db, 'main', 'Items', { orderBy: 'Notes' }, limits), 400, /can not be used in orderBy/);
    });

    it('never puts request text into the SQL: hostile names fail the catalog lookup, hostile values travel as parameters', async () => {
        const db = make(() => ({ recordsets: [recordset([])] }));
        await refuses(readRows(db, 'main', 'BOLocking', { columns: 'MfgLoc]; DROP TABLE BOLocking;--' }, limits), 400, /no column/);
        await refuses(readRows(db, 'main', 'BOLocking', { 'where.MfgLoc] = 1; --': 'x' }, limits), 400, /no column/);
        assert.equal(db.queries.length, 0);

        const hostile = "x'; DROP TABLE BOLocking; --";
        await readRows(db, 'main', 'BOLocking', { 'where.MfgLoc': hostile }, limits);
        const q = db.queries[0];
        assert.doesNotMatch(q.text, /DROP|x'/);
        assert.equal(q.inputs[1].value, hostile);
    });
});

describe('table service: inserting a row', () => {
    const stored = { Recid: 'ABCDEF01-0000-0000-0000-000000000000', MfgLoc: 'DYP', LockedDt: new Date(Date.UTC(2026, 9, 23, 9, 30, 0)), LockedBy: 'ray', Session: null, Remarks: null };
    const stores = () => make(() => ({ recordsets: [recordset([stored], { Recid: 'uniqueidentifier', LockedDt: 'datetime' })] }));

    it('inserts the given columns and answers the stored row, including what the database filled in', async () => {
        const db = stores();
        const out = await insertRow(db, 'main', 'BOLocking', { values: { MfgLoc: 'DYP', lockedby: 'ray' } });

        assert.equal(db.queries[0].text, 'INSERT INTO [dbo].[BOLocking] ([MfgLoc], [LockedBy]) OUTPUT INSERTED.[Recid], INSERTED.[MfgLoc], INSERTED.[LockedDt], INSERTED.[LockedBy], INSERTED.[Session], INSERTED.[Remarks] VALUES (@v0, @v1)');
        assert.deepEqual(db.queries[0].inputs.map((i) => [i.name, i.meta.name, i.value]), [['v0', 'MfgLoc', 'DYP'], ['v1', 'LockedBy', 'ray']]);
        assert.deepEqual(out, {
            inserted: 1,
            row: { Recid: 'abcdef01-0000-0000-0000-000000000000', MfgLoc: 'DYP', LockedDt: '2026-10-23T09:30:00', LockedBy: 'ray', Session: null, Remarks: null }
        });
    });

    it('sends null as a value and other types converted from the column', async () => {
        const db = stores();
        await insertRow(db, 'main', 'BOLocking', { values: { MfgLoc: 'A', LockedBy: 'b', Session: null, LockedDt: '2026-10-23T08:00:00' } });
        const inputs = Object.fromEntries(db.queries[0].inputs.map((i) => [i.meta.name, i.value]));
        assert.equal(inputs.Session, null);
        assert.equal(inputs.LockedDt.toISOString(), '2026-10-23T08:00:00.000Z');
    });

    it('a table with enabled triggers is inserted without OUTPUT and answers row: null', async () => {
        const db = make(() => ({ recordsets: [] }));
        const out = await insertRow(db, 'main', 'Audited', { values: { A: 1 } });
        assert.equal(db.queries[0].text, 'INSERT INTO [dbo].[Audited] ([A]) VALUES (@v0)');
        assert.deepEqual(out, { inserted: 1, row: null });
    });

    it('leaves text, ntext, image, rowversion and unreadable (geography) columns out of OUTPUT', async () => {
        const db = make(() => ({ recordsets: [recordset([{ Id: 1 }])] }));
        await insertRow(db, 'main', 'Items', { values: { Name: 'x' } });
        assert.match(db.queries[0].text, /OUTPUT INSERTED\.\[Id\], INSERTED\.\[Name\], INSERTED\.\[Total\], INSERTED\.\[Data\], INSERTED\.\[we\]\]ird\] VALUES/);
        assert.doesNotMatch(db.queries[0].text, /INSERTED\.\[(Notes|RowVer|Shape)\]/);
    });

    it('refuses generated columns (identity, computed, rowversion), unknown columns and repeated columns', async () => {
        const db = stores();
        for (const column of ['Id', 'Total', 'RowVer']) {
            await refuses(insertRow(db, 'main', 'Items', { values: { [column]: 1 } }), 400, /generated by the database/);
        }
        await refuses(insertRow(db, 'main', 'BOLocking', { values: { Nope: 1 } }), 400, /no column "Nope" \(values\)/);
        await refuses(insertRow(db, 'main', 'BOLocking', { values: { MfgLoc: 'a', mfgloc: 'b' } }), 400, /in values twice/);
        assert.equal(db.queries.length, 0);
    });

    it('checks the body: values only, a non-empty object, and values that fit their column', async () => {
        const db = stores();
        for (const body of [undefined, null, [], 'x', {}, { value: { A: 1 } }, { values: {} }, { values: [] }, { values: null }, { values: 'x' }, { values: { MfgLoc: 'a' }, where: {} }]) {
            await refuses(insertRow(db, 'main', 'BOLocking', body), 400, /request body|Unknown field|values must be/);
        }
        await refuses(insertRow(db, 'main', 'BOLocking', { values: { LockedBy: 'SENTINEL'.repeat(20) } }), 400, /Column LockedBy: longer than the 100 characters/);
        await refuses(insertRow(db, 'main', 'Items', { values: { 'we]ird': 'abc' } }), 400, /Column we\]ird: expected a whole number/);
        assert.equal(db.queries.length, 0);
    });

    it('takes no query string and refuses a view', async () => {
        const db = stores();
        await refuses(insertRow(db, 'main', 'BOLocking', { values: { MfgLoc: 'a' } }, { 'where.MfgLoc': 'a' }), 400, /no query string/);
        await refuses(insertRow(db, 'main', 'vwThing', { values: { A: 1 } }), 400, /only tables can be changed/);
        assert.equal(db.queries.length, 0);
    });
});

describe('table service: updating and deleting rows', () => {
    const affects = (affected, rolledBack = 0) => make(() => ({ recordsets: [recordset([{ affected, rolledBack }])] }));

    it('updates the rows where the equality conditions match, in one capped transaction', async () => {
        const db = affects(1);
        const out = await updateRows(db, 'main', 'BOLocking', { 'where.MfgLoc': 'DYP', 'where.LockedBy': 'ray' }, { values: { Remarks: 'back', Session: null } }, limits);

        assert.deepEqual(out, { updated: 1 });
        const q = db.queries[0];
        assert.match(q.text, /^SET XACT_ABORT ON;\nSET NOCOUNT ON;\nBEGIN TRANSACTION;\nUPDATE \[dbo\]\.\[BOLocking\] SET \[Remarks\] = @v0, \[Session\] = @v1 WHERE \[MfgLoc\] = @w0 AND \[LockedBy\] = @w1;\nDECLARE @affected int = @@ROWCOUNT;\nIF @affected > @maxRows/);
        assert.match(q.text, /ROLLBACK TRANSACTION;[\s\S]*COMMIT TRANSACTION;[\s\S]*SELECT @affected AS affected, CASE WHEN @affected > @maxRows THEN 1 ELSE 0 END AS rolledBack;$/);
        assert.deepEqual(q.inputs.map((i) => [i.name, i.value]), [['v0', 'back'], ['v1', null], ['w0', 'DYP'], ['w1', 'ray'], ['maxRows', 1000]]);
    });

    it('deletes the rows where the conditions match', async () => {
        const db = affects(2);
        const out = await deleteRows(db, 'main', 'BOLocking', { 'where.MfgLoc': 'DYP', 'where.LockedBy': 'ray' }, limits);
        assert.deepEqual(out, { deleted: 2 });
        assert.match(db.queries[0].text, /\nDELETE FROM \[dbo\]\.\[BOLocking\] WHERE \[MfgLoc\] = @w0 AND \[LockedBy\] = @w1;\n/);
    });

    it('needs a where: no update or delete of a whole table', async () => {
        const db = affects(0);
        await refuses(updateRows(db, 'main', 'BOLocking', {}, { values: { Remarks: 'x' } }, limits), 400, /where is required/);
        await refuses(deleteRows(db, 'main', 'BOLocking', {}, limits), 400, /where is required/);
        await refuses(deleteRows(db, 'main', 'BOLocking', { top: '5' }, limits), 400, /Unknown query field "top"/);
        assert.equal(db.queries.length, 0);
    });

    it('undoes a change that would touch more rows than limits.tableRows, and says nothing was changed', async () => {
        const db = affects(15, 1);
        await refuses(deleteRows(db, 'main', 'BOLocking', { 'where.MfgLoc': 'DYP' }, { tableRows: 10 }), 400, /would affect 15 rows, more than the limit of 10\. Nothing was changed/);
        assert.equal(db.queries[0].inputs.at(-1).value, 10);
    });

    it('checks the body of an update and refuses generated columns and views', async () => {
        const db = affects(1);
        const where = { 'where.MfgLoc': 'DYP' };
        for (const body of [undefined, {}, { values: {} }, { value: {} }, { values: { Remarks: 'x' }, extra: 1 }]) {
            await refuses(updateRows(db, 'main', 'BOLocking', where, body, limits), 400, /request body|Unknown field|values must be/);
        }
        await refuses(updateRows(db, 'main', 'Items', { 'where.Name': 'a' }, { values: { Id: 5 } }, limits), 400, /generated by the database/);
        await refuses(updateRows(db, 'main', 'vwThing', { 'where.A': '1' }, { values: { A: 2 } }, limits), 400, /only tables can be changed/);
        await refuses(deleteRows(db, 'main', 'vwThing', { 'where.A': '1' }, limits), 400, /only tables can be changed/);
        await refuses(updateRows(db, 'main', 'BOLocking', { ...where, columns: 'x' }, { values: { Remarks: 'x' } }, limits), 400, /Unknown query field/);
        assert.equal(db.queries.length, 0);
    });

    it('404 for an unknown table', async () => {
        await refuses(updateRows(affects(0), 'main', 'Nope', { 'where.A': '1' }, { values: { A: 1 } }, limits), 404, /No such table/);
        await refuses(deleteRows(affects(0), 'main', 'Nope', { 'where.A': '1' }, limits), 404, /No such table/);
    });
});
