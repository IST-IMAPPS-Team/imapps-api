const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createTableCatalog } = require('../../src/gateway/db/table-catalog');
const { createFakeSql } = require('../helpers/fake-sql');

// Rows as the catalog query returns them: one per column.
const row = (column, type, extra = {}) => ({
    schema_name: 'dbo', table_name: 'BOLocking', object_type: 'U ', has_triggers: 0,
    column_name: column, type_name: type, max_length: 0, precision: 0, scale: 0,
    is_nullable: 1, is_identity: 0, is_computed: 0, ...extra
});

describe('table catalog', () => {
    it('describes a table from its catalog rows', async () => {
        const fake = createFakeSql({
            onQuery: () => ({
                recordset: [
                    row('Recid', 'uniqueidentifier', { is_nullable: 0 }),
                    row('MfgLoc', 'VARCHAR', { max_length: 50, is_nullable: 0 }),
                    row('RowVer', 'timestamp'),
                    row('Id', 'int', { is_identity: 1 }),
                    row('Total', 'decimal', { precision: 18, scale: 2, is_computed: 1 }),
                    row('Odd', null)
                ]
            })
        });
        const catalog = createTableCatalog();
        const pool = new fake.sql.ConnectionPool({});
        const table = await catalog.describe(pool, fake.sql, 'main', 'dbo.BOLocking');

        assert.deepEqual([table.schema, table.name, table.isView, table.hasTriggers], ['dbo', 'BOLocking', false, false]);
        assert.deepEqual(table.columns.map((c) => c.name), ['Recid', 'MfgLoc', 'RowVer', 'Id', 'Total', 'Odd']);
        const byName = Object.fromEntries(table.columns.map((c) => [c.name, c]));
        assert.deepEqual(
            [byName.MfgLoc.typeName, byName.MfgLoc.maxLength, byName.MfgLoc.nullable, byName.MfgLoc.kind],
            ['varchar', 50, false, 'column']
        );
        assert.equal(byName.Id.identity, true);
        assert.equal(byName.Total.computed, true);
        assert.equal(byName.Odd.typeName, null);
        assert.equal(table.byLower.get('mfgloc'), byName.MfgLoc);
    });

    it('asks the catalog for the name given, with the name as a parameter, and leaves system objects out', async () => {
        const fake = createFakeSql({ onQuery: () => ({ recordset: [row('A', 'int')] }) });
        const catalog = createTableCatalog();
        await catalog.describe(new fake.sql.ConnectionPool({}), fake.sql, 'main', 'BOLocking');
        const request = fake.state.requests[0];
        assert.deepEqual(request.inputs.map((i) => [i.name, i.value]), [['name', 'BOLocking']]);
        assert.match(request.text, /OBJECT_ID\(@name\)/);
        assert.match(request.text, /is_ms_shipped = 0/);
        assert.match(request.text, /o\.type IN \('U', 'V'\)/);
    });

    it('flags views and tables with enabled triggers', async () => {
        const fake = createFakeSql({ onQuery: () => ({ recordset: [row('A', 'int', { object_type: 'V ', has_triggers: 1 })] }) });
        const table = await createTableCatalog().describe(new fake.sql.ConnectionPool({}), fake.sql, 'main', 'vw');
        assert.deepEqual([table.isView, table.hasTriggers], [true, true]);
    });

    it('returns null for a table the catalog does not list, and does not cache that', async () => {
        let reads = 0;
        const fake = createFakeSql({ onQuery: () => { reads += 1; return { recordset: [] }; } });
        const catalog = createTableCatalog();
        const pool = new fake.sql.ConnectionPool({});
        assert.equal(await catalog.describe(pool, fake.sql, 'main', 'Nope'), null);
        assert.equal(await catalog.describe(pool, fake.sql, 'main', 'Nope'), null);
        assert.equal(reads, 2);
    });

    it('keeps a table for the cache time, per profile, then reads it again', async () => {
        let reads = 0;
        const fake = createFakeSql({ onQuery: () => { reads += 1; return { recordset: [row('A', 'int')] }; } });
        let now = 0;
        const catalog = createTableCatalog({ ttlMs: 1000, now: () => now });
        const pool = new fake.sql.ConnectionPool({});
        await catalog.describe(pool, fake.sql, 'main', 'T');
        await catalog.describe(pool, fake.sql, 'main', 't');
        assert.equal(reads, 1, 'same table in any letter case is one entry');
        await catalog.describe(pool, fake.sql, 'other', 'T');
        assert.equal(reads, 2, 'another profile is another entry');
        now = 1001;
        await catalog.describe(pool, fake.sql, 'main', 'T');
        assert.equal(reads, 3);
        catalog.clear();
        await catalog.describe(pool, fake.sql, 'main', 'T');
        assert.equal(reads, 4);
    });
});
