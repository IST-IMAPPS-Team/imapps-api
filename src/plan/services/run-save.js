const { ApiError } = require('../../api/errors');
const { prepareRecipe } = require('./save-recipe');

// Runs a prepared Save recipe, step by step, stopping at the first step that fails.
//   call          runs a procedure (on its own, or inside its group's transaction)
//   bulk          inserts rows straight into a table
//   transaction   its steps succeed or are undone together (bulk and call steps)
//   repeat        runs its calls in order; while a check fails it runs the whole list again, up to `attempts`
// A call outside a transaction group is NOT wrapped by the API: the procedures run their own
// transactions (and roll back and report ERROR_FLAG = 1 on an error), which an outer transaction would break.

const MAX_MESSAGES = 50;

const jsonSafe = (value) => {
    if (typeof value === 'bigint') return String(value);
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (value instanceof Date) return value.toISOString();
    return value === undefined ? null : value;
};

// The first cell of one result set: `which` is a number (1 is the first set) or "last".
function firstCell(recordsets, which) {
    const set = recordsets[which === 'last' ? recordsets.length - 1 : which - 1];
    if (!set || set.length === 0) return { found: false, value: null };
    const row = set[0];
    const columns = set.columns || {};
    const first = Object.keys(columns).find((name) => columns[name].index === 0) ?? Object.keys(row)[0];
    return { found: true, value: jsonSafe(row[first]) };
}

function matches(value, expected) {
    if (value === expected) return true;
    if (value === null || expected === null) return false;
    if (typeof value === 'boolean' && (expected === 0 || expected === 1)) return Number(value) === expected;
    return String(value) === String(expected);
}

// Adds the step (and what the procedures printed) to an API error on its way out.
function annotate(err, id) {
    if (!(err instanceof ApiError)) return err;
    const extra = { ...err.extra };
    if (extra.step === undefined) extra.step = err.stepId ?? id;
    if (extra.messages === undefined && Array.isArray(err.messages) && err.messages.length > 0) extra.messages = err.messages.slice(-MAX_MESSAGES);
    return new ApiError(err.status, err.code, err.message, extra, err.headers);
}

const failedCheck = (item, cell, attempts, messages) => {
    const wanted = JSON.stringify(item.check.expected);
    const got = cell.found ? JSON.stringify(cell.value) : 'no row';
    return new ApiError(422, 'step_failed',
        `Procedure ${item.procedure} gave ${got} in the first cell of result set ${item.resultSet}, not ${wanted}`
        + (attempts > 1 ? `, after ${attempts} attempts.` : '.'),
        { step: item.id, attempts, messages: messages.slice(-MAX_MESSAGES) });
};

// Runs one call. Returns { summary, messages, failedCell } where failedCell is set when its check failed.
async function runCall(item, runner) {
    const result = await runner.callProcedure(item.procedure, item.params, { multi: true });
    const summary = { step: item.id, kind: 'call', procedure: item.procedure };
    const cell = item.check ? firstCell(result.recordsets, item.resultSet) : null;
    if (cell) summary.firstCell = cell.value;
    const failed = item.check && !(cell.found && matches(cell.value, item.check.expected));
    return { summary, messages: result.messages || [], failedCell: failed ? cell : null };
}

async function runLeaf(item, runner) {
    try {
        if (item.kind === 'bulk') {
            // Nothing to insert (for example no deleted batches this time): skip it.
            if (item.rows.length === 0) return { step: item.id, kind: 'bulk', table: item.name, rows: 0 };
            const { rows } = await runner.bulkInsert({ schema: item.schema, name: item.name, columns: item.columns, rows: item.rows });
            return { step: item.id, kind: 'bulk', table: item.name, rows };
        }
        const { summary, messages, failedCell } = await runCall(item, runner);
        if (failedCell) throw failedCheck(item, failedCell, 1, messages);
        return summary;
    } catch (err) {
        // Inside a transaction the database layer maps the error after this; remember which step it was.
        if (!(err instanceof ApiError) && err && typeof err === 'object') err.stepId = item.id;
        throw annotate(err, item.id);
    }
}

async function runRepeat(step, runner) {
    const messages = [];
    let last = null;
    for (let attempt = 1; attempt <= step.attempts; attempt++) {
        const calls = [];
        last = null;
        for (const item of step.items) {
            let outcome;
            try {
                outcome = await runCall(item, runner);
            } catch (err) {
                throw annotate(err, item.id);
            }
            messages.push(...outcome.messages);
            calls.push(outcome.summary);
            if (outcome.failedCell) {
                last = { item, cell: outcome.failedCell };
                break;
            }
        }
        if (!last) return { step: step.id, kind: 'repeat', attempts: attempt, calls };
    }
    throw failedCheck(last.item, last.cell, step.attempts, messages);
}

// body: { steps: [...] }. Answers { success: true, steps: [...] }; any failure is an ApiError that
// names the step, and nothing after the failed step runs.
exports.runSave = async (database, profileName, body, limits) => {
    const steps = await prepareRecipe(database, profileName, body, limits);

    const direct = {
        callProcedure: (name, params, options) => database.callProcedure(profileName, name, params, options),
        bulkInsert: (prepared) => database.bulkInsert(profileName, prepared)
    };

    const results = [];
    for (const step of steps) {
        try {
            if (step.kind === 'transaction') {
                const inner = await database.transaction(profileName, async (tx) => {
                    const done = [];
                    for (const item of step.items) done.push(await runLeaf(item, tx));
                    return done;
                });
                results.push({ step: step.id, kind: 'transaction', steps: inner });
            } else if (step.kind === 'repeat') {
                results.push(await runRepeat(step, direct));
            } else {
                results.push(await runLeaf(step, direct));
            }
        } catch (err) {
            throw annotate(err, step.id);
        }
    }
    return { success: true, steps: results };
};
