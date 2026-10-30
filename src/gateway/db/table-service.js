const { ApiError } = require('../../api/errors');
const { checkTableName } = require('../guards/names');
const { convertValue } = require('./parameter-types');
const { serialiseRecordsets } = require('./serialise');

// Reads and changes rows of one table. The caller sends plain names and values; this module
//   - looks the table and every column up in the database catalog (unknown names are 400/404),
//   - builds SQL text from the catalog's names only, each quoted as [name],
//   - sends every value as a typed parameter (@w0, @v0, ...), never inside the text.
// Updates and deletes need a `where`, and change at most limits.tableRows rows or nothing at all.

const MAX_PARTS = 200;

// Types a column can be written as (the types parameter-types.js can convert) ...
const WRITABLE = new Set(['bit', 'tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney',
    'float', 'real', 'char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext', 'date', 'datetime', 'smalldatetime',
    'datetime2', 'datetimeoffset', 'time', 'uniqueidentifier', 'binary', 'varbinary', 'image', 'xml']);
// ... and read as (a rowversion comes out as base64 text). geography, hierarchyid, sql_variant and
// user types are left out of reads.
const READABLE = new Set([...WRITABLE, 'timestamp']);
// SQL Server can not compare or sort these, and can not put text, ntext or image in an OUTPUT clause
// (a rowversion is also left out of the answer to an insert, to stay on the safe side).
const NO_COMPARE = new Set(['text', 'ntext', 'image', 'xml']);
const NO_OUTPUT = new Set(['text', 'ntext', 'image', 'timestamp']);

const bad = (message) => new ApiError(400, 'bad_request', message);
const short = (text) => String(text).slice(0, 64);
const quote = (name) => `[${String(name).replace(/]/g, ']]')}]`;
const qualified = (table) => `${quote(table.schema)}.${quote(table.name)}`;
const intMeta = { typeName: 'int' };
const isGenerated = (c) => c.identity || c.computed || c.typeName === 'timestamp';

async function loadTable(database, profileName, rawName, { forWrite = false } = {}) {
    const table = await database.describeTable(profileName, checkTableName(rawName));
    if (!table) throw new ApiError(404, 'not_found', 'No such table.');
    if (forWrite && table.isView) throw bad('This is a view; only tables can be changed.');
    return table;
}

function column(table, given, where) {
    const found = table.byLower.get(String(given).toLowerCase());
    if (!found) throw bad(`The table has no column "${short(given)}"${where ? ` (${where})` : ''}.`);
    return found;
}

const checkQueryFields = (query, allowed) => {
    for (const key of Object.keys(query)) {
        if (!allowed.includes(key) && !key.startsWith('where.')) throw bad(`Unknown query field "${short(key)}".`);
    }
};

const queryText = (query, key) => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw bad(`${key} must be given once.`);
    return value;
};

// where.Column=value pairs, all equality, joined with AND.
function buildWhere(table, query) {
    const entries = Object.entries(query).filter(([key]) => key.startsWith('where.'));
    if (entries.length > MAX_PARTS) throw bad(`At most ${MAX_PARTS} where conditions are allowed.`);

    const seen = new Set();
    const inputs = [];
    const parts = [];
    entries.forEach(([key, raw], i) => {
        const given = key.slice('where.'.length);
        const col = column(table, given, 'where');
        if (seen.has(col.name)) throw bad(`Column ${col.name} is in where twice.`);
        seen.add(col.name);
        if (typeof raw !== 'string') throw bad(`where.${short(given)} must be given once.`);
        if (NO_COMPARE.has(col.typeName)) throw bad(`Column ${col.name} (${col.typeName}) can not be used in where.`);
        inputs.push({ name: `w${i}`, meta: col, value: convertValue(col, raw) });
        parts.push(`${quote(col.name)} = @w${i}`);
    });
    return { text: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', inputs, count: parts.length };
}

function requireWhere(where) {
    if (where.count === 0) throw bad('where is required: give at least one where.Column=value.');
}

// The body of POST and PATCH: { "values": { "Column": value, ... } } and nothing else.
function readValues(table, body) {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw bad('The request body must be a JSON object like { "values": { ... } }.');
    }
    const unknown = Object.keys(body).find((key) => key !== 'values');
    if (unknown !== undefined) throw bad(`Unknown field "${short(unknown)}". Only "values" is allowed.`);

    const { values } = body;
    if (values === null || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length === 0) {
        throw bad('values must be an object with at least one column.');
    }
    if (Object.keys(values).length > MAX_PARTS) throw bad(`At most ${MAX_PARTS} columns can be written at once.`);

    const seen = new Set();
    return Object.entries(values).map(([given, value], i) => {
        const col = column(table, given, 'values');
        if (seen.has(col.name)) throw bad(`Column ${col.name} is in values twice.`);
        seen.add(col.name);
        if (isGenerated(col)) throw bad(`Column ${col.name} is generated by the database and can not be written.`);
        return { col, input: { name: `v${i}`, meta: col, value: convertValue(col, value) } };
    });
}

// Runs a change in one transaction and undoes it when it would touch more than `maxRows` rows.
function cappedChange(statement) {
    return [
        'SET XACT_ABORT ON;',
        'SET NOCOUNT ON;',
        'BEGIN TRANSACTION;',
        `${statement};`,
        'DECLARE @affected int = @@ROWCOUNT;',
        'IF @affected > @maxRows',
        'BEGIN',
        '    ROLLBACK TRANSACTION;',
        'END',
        'ELSE',
        'BEGIN',
        '    COMMIT TRANSACTION;',
        'END',
        'SELECT @affected AS affected, CASE WHEN @affected > @maxRows THEN 1 ELSE 0 END AS rolledBack;'
    ].join('\n');
}

async function runCappedChange(database, profileName, statement, inputs, limits) {
    const result = await database.query(profileName, cappedChange(statement), [
        ...inputs,
        { name: 'maxRows', meta: intMeta, value: limits.tableRows }
    ]);
    const row = (result.recordsets[0] || [])[0] || { affected: 0, rolledBack: 0 };
    if (row.rolledBack) {
        throw bad(`The change would affect ${row.affected} rows, more than the limit of ${limits.tableRows}. Nothing was changed.`);
    }
    return row.affected;
}

// GET: { rows, truncated }. Query: columns=a,b  orderBy=a,-b  top=N  where.Column=value
exports.readRows = async (database, profileName, tableName, query, limits) => {
    const table = await loadTable(database, profileName, tableName);
    checkQueryFields(query, ['columns', 'orderBy', 'top']);

    // top: how many rows to answer (at most limits.tableRows, which is also the default).
    let top = limits.tableRows;
    const rawTop = queryText(query, 'top');
    if (rawTop !== undefined) {
        top = /^\d+$/.test(rawTop) ? Number(rawTop) : 0;
        if (top < 1 || top > limits.tableRows) throw bad(`top must be a whole number from 1 to ${limits.tableRows}.`);
    }

    const rawColumns = queryText(query, 'columns');
    let selected;
    if (rawColumns === undefined) {
        selected = table.columns.filter((c) => READABLE.has(c.typeName));
    } else {
        const names = rawColumns.split(',').map((n) => n.trim());
        if (names.length > MAX_PARTS || names.some((n) => n === '')) throw bad('columns must be a comma-separated list of column names.');
        const seen = new Set();
        selected = names.map((given) => {
            const col = column(table, given, 'columns');
            if (!READABLE.has(col.typeName)) throw bad(`Column ${col.name} (${col.typeName || 'unknown type'}) can not be read through this API.`);
            if (seen.has(col.name)) throw bad(`Column ${col.name} is in columns twice.`);
            seen.add(col.name);
            return col;
        });
    }
    if (selected.length === 0) throw bad('The table has no column this API can read.');

    let order = '';
    const rawOrder = queryText(query, 'orderBy');
    if (rawOrder !== undefined) {
        const seen = new Set();
        const items = rawOrder.split(',').map((item) => item.trim()).map((item) => {
            const descending = item.startsWith('-');
            const col = column(table, descending ? item.slice(1) : item, 'orderBy');
            if (!READABLE.has(col.typeName) || NO_COMPARE.has(col.typeName)) throw bad(`Column ${col.name} can not be used in orderBy.`);
            if (seen.has(col.name)) throw bad(`Column ${col.name} is in orderBy twice.`);
            seen.add(col.name);
            return `${quote(col.name)} ${descending ? 'DESC' : 'ASC'}`;
        });
        order = `ORDER BY ${items.join(', ')}`;
    }

    const where = buildWhere(table, query);
    // One row more than asked for tells whether the answer was cut off.
    const text = [`SELECT TOP (@top) ${selected.map((c) => quote(c.name)).join(', ')}`, `FROM ${qualified(table)}`, where.text, order]
        .filter(Boolean).join(' ');
    const result = await database.query(profileName, text, [{ name: 'top', meta: intMeta, value: top + 1 }, ...where.inputs]);

    let rows = serialiseRecordsets(result.recordsets)[0] || [];
    const truncated = rows.length > top;
    if (truncated) rows = rows.slice(0, top);
    return { rows, truncated };
};

// POST: { inserted: 1, row } where row is the stored row (with values the database filled in),
// or null for a table with enabled triggers (SQL Server can not return the row there).
exports.insertRow = async (database, profileName, tableName, body, query = {}) => {
    const table = await loadTable(database, profileName, tableName, { forWrite: true });
    if (Object.keys(query).length > 0) throw bad('Insert takes no query string; send { "values": { ... } } in the body.');
    const items = readValues(table, body);

    const names = items.map(({ col }) => quote(col.name)).join(', ');
    const placeholders = items.map(({ input }) => `@${input.name}`).join(', ');
    const returnable = table.columns.filter((c) => READABLE.has(c.typeName) && !NO_OUTPUT.has(c.typeName));
    const output = table.hasTriggers || returnable.length === 0
        ? ''
        : ` OUTPUT ${returnable.map((c) => `INSERTED.${quote(c.name)}`).join(', ')}`;

    const text = `INSERT INTO ${qualified(table)} (${names})${output} VALUES (${placeholders})`;
    const result = await database.query(profileName, text, items.map(({ input }) => input));
    const row = output ? (serialiseRecordsets(result.recordsets)[0] || [])[0] || null : null;
    return { inserted: 1, row };
};

// PATCH: { updated: n }. where is required.
exports.updateRows = async (database, profileName, tableName, query, body, limits) => {
    const table = await loadTable(database, profileName, tableName, { forWrite: true });
    checkQueryFields(query, []);
    const items = readValues(table, body);
    const where = buildWhere(table, query);
    requireWhere(where);

    const sets = items.map(({ col, input }) => `${quote(col.name)} = @${input.name}`).join(', ');
    const statement = `UPDATE ${qualified(table)} SET ${sets} ${where.text}`;
    const updated = await runCappedChange(database, profileName, statement, [...items.map(({ input }) => input), ...where.inputs], limits);
    return { updated };
};

// DELETE: { deleted: n }. where is required.
exports.deleteRows = async (database, profileName, tableName, query, limits) => {
    const table = await loadTable(database, profileName, tableName, { forWrite: true });
    checkQueryFields(query, []);
    const where = buildWhere(table, query);
    requireWhere(where);

    const deleted = await runCappedChange(database, profileName, `DELETE FROM ${qualified(table)} ${where.text}`, where.inputs, limits);
    return { deleted };
};
