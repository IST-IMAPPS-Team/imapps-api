const { ApiError } = require('../../api/errors');
const { checkProcedureName, checkTableName } = require('../../gateway/guards/names');
const { convertValue } = require('../../gateway/db/parameter-types');
const { WRITABLE_TYPES } = require('../../gateway/db/table-service');

// Checks a Save recipe and prepares it, before anything runs, so a bad recipe changes nothing:
//   - only known step types and fields, within the limits (steps, rows per bulk step),
//   - procedure names pass the name check (the blocked one is refused), parameters are checked
//     against the procedure's own list,
//   - every table and column of a bulk step is looked up in the catalog and every value is
//     converted to its column's real type.
// Every problem names the step ("3" or "3.2" for a step inside a group) and, for a value, the row and column.
const KINDS = {
    call: ['call', 'params', 'okWhenFirstCellIs', 'resultSet'],
    bulk: ['bulk', 'columns', 'rows'],
    transaction: ['transaction'],
    repeat: ['repeat', 'attempts']
};
const MAX_COLUMNS = 200;
const MAX_ATTEMPTS = 5;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (text) => String(text).slice(0, 64);
const stepError = (id, message, extra = {}) => new ApiError(400, 'bad_request', `Step ${id}: ${message}`, { step: id, ...extra });

// Puts the step into an error from a check that knows nothing about steps.
const inStep = (id, err) => (err instanceof ApiError
    ? new ApiError(err.status, err.code, `Step ${id}: ${err.message}`, { ...err.extra, step: id }, err.headers)
    : err);

function kindOf(step, id) {
    if (!isObject(step)) throw stepError(id, 'a step must be an object.');
    const kinds = Object.keys(KINDS).filter((kind) => Object.hasOwn(step, kind));
    if (kinds.length !== 1) throw stepError(id, `a step must have exactly one of: ${Object.keys(KINDS).join(', ')}.`);
    const unknown = Object.keys(step).find((key) => !KINDS[kinds[0]].includes(key));
    if (unknown !== undefined) throw stepError(id, `unknown field "${short(unknown)}" for a ${kinds[0]} step.`);
    return kinds[0];
}

// All steps, including those inside groups, counted against limits.saveSteps.
const countSteps = (steps) => steps.reduce((sum, step) => {
    const inner = isObject(step) ? step.transaction ?? step.repeat : undefined;
    return sum + 1 + (Array.isArray(inner) ? inner.length : 0);
}, 0);

async function prepareCall(ctx, step, id) {
    let procedure;
    try {
        procedure = checkProcedureName(step.call);
    } catch (err) {
        throw inStep(id, err);
    }
    const params = step.params === undefined ? {} : step.params;
    if (!isObject(params)) throw stepError(id, 'params must be an object of parameter names and values.');
    try {
        await ctx.database.checkCall(ctx.profileName, procedure, params);
    } catch (err) {
        throw inStep(id, err);
    }

    const { resultSet } = step;
    if (resultSet !== undefined && resultSet !== 'last' && !(Number.isInteger(resultSet) && resultSet >= 1)) {
        throw stepError(id, 'resultSet must be a whole number from 1, or "last".');
    }
    let check = null;
    if (Object.hasOwn(step, 'okWhenFirstCellIs')) {
        const expected = step.okWhenFirstCellIs;
        if (expected !== null && !['number', 'string', 'boolean'].includes(typeof expected)) {
            throw stepError(id, 'okWhenFirstCellIs must be a number, text, true/false or null.');
        }
        check = { expected };
    }
    return { id, kind: 'call', procedure, params, resultSet: resultSet === undefined ? 1 : resultSet, check };
}

async function loadTable(ctx, name, id) {
    let tableName;
    try {
        tableName = checkTableName(name);
    } catch (err) {
        throw inStep(id, err);
    }
    const key = tableName.toLowerCase();
    if (!ctx.tables.has(key)) {
        let table;
        try {
            table = await ctx.database.describeTable(ctx.profileName, tableName);
        } catch (err) {
            throw inStep(id, err);
        }
        ctx.tables.set(key, table);
    }
    const table = ctx.tables.get(key);
    if (!table) throw new ApiError(404, 'not_found', `Step ${id}: No such table.`, { step: id });
    if (table.isView) throw stepError(id, 'a bulk step can not write to a view.');
    return table;
}

async function prepareBulk(ctx, step, id) {
    const table = await loadTable(ctx, step.bulk, id);

    if (!Array.isArray(step.columns) || step.columns.length === 0 || step.columns.length > MAX_COLUMNS
        || step.columns.some((name) => typeof name !== 'string' || name === '')) {
        throw stepError(id, `columns must be a list of 1 to ${MAX_COLUMNS} column names.`);
    }
    const seen = new Set();
    const columns = step.columns.map((given) => {
        const column = table.byLower.get(given.toLowerCase());
        if (!column) throw stepError(id, `the table has no column "${short(given)}".`, { column: short(given) });
        if (seen.has(column.name)) throw stepError(id, `column ${column.name} is listed twice.`, { column: column.name });
        seen.add(column.name);
        if (column.identity || column.computed || column.typeName === 'timestamp') {
            throw stepError(id, `column ${column.name} is generated by the database and can not be written.`, { column: column.name });
        }
        if (!WRITABLE_TYPES.has(column.typeName)) {
            throw stepError(id, `column ${column.name} has a type (${column.typeName || 'unknown'}) this API does not support.`, { column: column.name });
        }
        return column;
    });

    if (!Array.isArray(step.rows)) throw stepError(id, 'rows must be a list of rows, each a list of values in the order of columns.');
    if (step.rows.length > ctx.limits.saveRowsPerTable) {
        throw stepError(id, `at most ${ctx.limits.saveRowsPerTable} rows are allowed in one bulk step.`);
    }
    const rows = step.rows.map((row, r) => {
        if (!Array.isArray(row) || row.length !== columns.length) {
            throw stepError(id, `row ${r + 1} must be a list of ${columns.length} values.`, { row: r + 1 });
        }
        return row.map((cell, c) => {
            try {
                return convertValue(columns[c], cell);
            } catch (err) {
                throw new ApiError(400, 'bad_request', `Step ${id}, row ${r + 1}: ${err.message}`, { step: id, row: r + 1, column: columns[c].name });
            }
        });
    });

    return { id, kind: 'bulk', schema: table.schema, name: table.name, columns, rows };
}

const groupItems = (step, kind, id) => {
    const items = step[kind];
    if (!Array.isArray(items) || items.length === 0) throw stepError(id, `${kind} must be a non-empty list of steps.`);
    return items;
};

async function prepareStep(ctx, step, id) {
    const kind = kindOf(step, id);
    if (kind === 'call') return prepareCall(ctx, step, id);
    if (kind === 'bulk') return prepareBulk(ctx, step, id);

    if (kind === 'transaction') {
        const items = [];
        for (const [j, item] of groupItems(step, 'transaction', id).entries()) {
            const itemId = `${id}.${j + 1}`;
            const itemKind = kindOf(item, itemId);
            if (itemKind !== 'call' && itemKind !== 'bulk') throw stepError(itemId, 'a transaction can hold only bulk and call steps.');
            items.push(await prepareStep(ctx, item, itemId));
        }
        return { id, kind: 'transaction', items };
    }

    // repeat: calls only, run again as a whole while a check fails, up to `attempts` times
    const { attempts = 1 } = step;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
        throw stepError(id, `attempts must be a whole number from 1 to ${MAX_ATTEMPTS}.`);
    }
    const items = [];
    for (const [j, item] of groupItems(step, 'repeat', id).entries()) {
        const itemId = `${id}.${j + 1}`;
        if (kindOf(item, itemId) !== 'call') throw stepError(itemId, 'a repeat can hold only call steps.');
        items.push(await prepareCall(ctx, item, itemId));
    }
    return { id, kind: 'repeat', attempts, items };
}

// body: { "steps": [ ... ] }. Returns the prepared steps.
exports.prepareRecipe = async (database, profileName, body, limits) => {
    if (!isObject(body)) throw new ApiError(400, 'bad_request', 'The request body must be a JSON object like { "steps": [ ... ] }.');
    const unknown = Object.keys(body).find((key) => key !== 'steps');
    if (unknown !== undefined) throw new ApiError(400, 'bad_request', `Unknown field "${short(unknown)}". Only "steps" is allowed.`);
    if (!Array.isArray(body.steps) || body.steps.length === 0) throw new ApiError(400, 'bad_request', 'steps must be a non-empty list.');
    if (countSteps(body.steps) > limits.saveSteps) {
        throw new ApiError(400, 'bad_request', `A Save may have at most ${limits.saveSteps} steps (steps inside a group count too).`);
    }

    const ctx = { database, profileName, limits, tables: new Map() };
    const prepared = [];
    for (const [i, step] of body.steps.entries()) prepared.push(await prepareStep(ctx, step, String(i + 1)));
    return prepared;
};
