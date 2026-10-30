const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runSave } = require('../../src/plan/services/run-save');
const { ApiError } = require('../../src/api/errors');
const { createFakeDatabase, fakeTable } = require('../helpers/fake-database');
const { recordset } = require('../helpers/fake-sql');

const limits = { saveSteps: 20, saveRowsPerTable: 5 };

// Two staging tables like the Planning Board's (every column text, as the procedures expect) and one with awkward columns.
const staging = (name, extra = []) => fakeTable({
    name,
    columns: [
        ['TransId', 'varchar', { maxLength: 50 }], ['MONo', 'varchar', { maxLength: 50 }], ['BONo', 'varchar', { maxLength: 50 }],
        ['PlanQty', 'varchar', { maxLength: 50 }], ['PlanStart', 'varchar', { maxLength: 50 }], ...extra
    ]
});
const tables = {
    bohdrbulkcopy: staging('BOHdrBulkCopy'),
    bodeletebulkcopy: staging('BODeleteBulkCopy'),
    odd: fakeTable({
        name: 'Odd',
        columns: [['Id', 'int', { identity: true }], ['Name', 'nvarchar', { maxLength: 40 }], ['Total', 'decimal', { computed: true }],
            ['RowVer', 'timestamp'], ['Shape', 'geography', { maxLength: -1 }], ['Qty', 'int'], ['When', 'datetime']]
    }),
    aview: fakeTable({ name: 'aView', isView: true, columns: [['A', 'int']] })
};

const flag = (value, extra = {}) => ({ recordsets: [recordset([{ ERROR_FLAG: value }])], messages: [], returnValue: 0, ...extra });
const okHandlers = () => ({
    prdsavebulkbohstrysp: { recordsets: [], messages: [], returnValue: 0 },
    prdbulkcopyinsertsp: flag(0),
    prdsavebulksp: flag(0)
});

// The recipe the DYP Planning Board would send.
const dypRecipe = (overrides = {}) => ({
    steps: [
        { call: 'prdSaveBulkBoHstrySP', params: {} },
        {
            transaction: [
                { bulk: 'BOHdrBulkCopy', columns: ['TransId', 'MONo', 'BONo', 'PlanQty'], rows: [['T1', 'MO1', 'B1', 10], ['T1', 'MO1', 'B2', '20']] },
                { bulk: 'BODeleteBulkCopy', columns: ['TransId', 'MONo', 'BONo'], rows: [['T1', 'MO9', 'B9']] }
            ]
        },
        {
            repeat: [
                { call: 'prdBulkCopyInsertSP', params: { TransId: 'T1' }, okWhenFirstCellIs: 0 },
                { call: 'prdSaveBulkSP', params: { TransId: 'T1' }, okWhenFirstCellIs: 0 }
            ],
            attempts: 3
        }
    ],
    ...overrides
});

const make = (handlers = okHandlers(), options = {}) => createFakeDatabase(handlers, { tables, ...options });
const failsWith = async (promise, status, code, pattern, extra) => {
    await assert.rejects(promise, (e) => {
        assert.ok(e instanceof ApiError, `an ApiError, got ${e && e.stack}`);
        assert.equal(e.status, status);
        assert.equal(e.code, code);
        assert.match(e.message, pattern);
        if (extra) for (const [key, value] of Object.entries(extra)) assert.deepEqual(e.extra[key], value, `extra.${key}`);
        assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /SENTINEL/);
        return true;
    });
};

describe('Save: running a recipe', () => {
    it('runs the history call, the staging group in one transaction, then the retried calls outside any transaction', async () => {
        const db = make();
        const out = await runSave(db, 'main', dypRecipe(), limits);

        assert.deepEqual(db.events, [
            'call:prdSaveBulkBoHstrySP',
            'tx:begin', 'bulk:BOHdrBulkCopy', 'bulk:BODeleteBulkCopy', 'tx:commit',
            'call:prdBulkCopyInsertSP', 'call:prdSaveBulkSP'
        ]);
        assert.deepEqual(db.transactions, [['commit']]);
        assert.ok(db.bulks.every((b) => b.inTransaction), 'the staging inserts ran inside the group');
        assert.ok(db.calls.every((c) => !c.inTransaction), 'the procedure calls were not wrapped');
        assert.ok(db.calls.every((c) => c.options.multi === true), 'calls use the long Save timeout');

        assert.deepEqual(out, {
            success: true,
            steps: [
                { step: '1', kind: 'call', procedure: 'prdSaveBulkBoHstrySP' },
                { step: '2', kind: 'transaction', steps: [
                    { step: '2.1', kind: 'bulk', table: 'BOHdrBulkCopy', rows: 2 },
                    { step: '2.2', kind: 'bulk', table: 'BODeleteBulkCopy', rows: 1 }
                ] },
                { step: '3', kind: 'repeat', attempts: 1, calls: [
                    { step: '3.1', kind: 'call', procedure: 'prdBulkCopyInsertSP', firstCell: 0 },
                    { step: '3.2', kind: 'call', procedure: 'prdSaveBulkSP', firstCell: 0 }
                ] }
            ]
        });
    });

    it('converts every value to its column\'s type before inserting (text columns take numbers as text)', async () => {
        const db = make();
        await runSave(db, 'main', dypRecipe(), limits);
        assert.deepEqual(db.bulks[0].columns, ['TransId', 'MONo', 'BONo', 'PlanQty']);
        assert.deepEqual(db.bulks[0].rows, [['T1', 'MO1', 'B1', '10'], ['T1', 'MO1', 'B2', '20']]);
        assert.deepEqual(db.bulks[0].schema, 'dbo');
    });

    it('runs the whole repeat list again while a check fails, and says how many attempts it took', async () => {
        let saves = 0;
        const handlers = { ...okHandlers(), prdsavebulksp: () => flag(++saves < 3 ? 1 : 0) };
        const db = make(handlers);
        const out = await runSave(db, 'main', dypRecipe(), limits);

        assert.deepEqual(db.events.slice(-6), ['call:prdBulkCopyInsertSP', 'call:prdSaveBulkSP', 'call:prdBulkCopyInsertSP', 'call:prdSaveBulkSP', 'call:prdBulkCopyInsertSP', 'call:prdSaveBulkSP']);
        assert.equal(out.steps[2].attempts, 3);
    });

    it('after the last attempt it stops with 422 step_failed naming the call, the attempts and what the procedure printed; the staging rows stay', async () => {
        const handlers = { ...okHandlers(), prdsavebulksp: { recordsets: [recordset([{ ERROR_FLAG: 1 }])], messages: ['Unexpected error occurred!', 'Violation of PRIMARY KEY'], returnValue: 0 } };
        const db = make(handlers);
        await failsWith(runSave(db, 'main', dypRecipe(), limits), 422, 'step_failed', /prdSaveBulkSP gave 1 in the first cell of result set 1, not 0, after 3 attempts/, {
            step: '3.2', attempts: 3, messages: ['Unexpected error occurred!', 'Violation of PRIMARY KEY', 'Unexpected error occurred!', 'Violation of PRIMARY KEY', 'Unexpected error occurred!', 'Violation of PRIMARY KEY']
        });
        assert.equal(db.events.filter((e) => e === 'call:prdSaveBulkSP').length, 3);
        assert.ok(db.events.includes('tx:commit'), 'the staging group had committed and is not undone');
    });

    it('a failed check outside a repeat stops at once (one attempt)', async () => {
        const db = make({ ...okHandlers(), prdbulkcopyinsertsp: flag(1, { messages: ['boom'] }) });
        const recipe = { steps: [{ call: 'prdBulkCopyInsertSP', params: { TransId: 'T' }, okWhenFirstCellIs: 0 }, { call: 'prdSaveBulkSP', params: {} }] };
        await failsWith(runSave(db, 'main', recipe, limits), 422, 'step_failed', /gave 1 .* not 0\.$/, { step: '1', attempts: 1, messages: ['boom'] });
        assert.deepEqual(db.events, ['call:prdBulkCopyInsertSP'], 'nothing after the failed step ran');
    });

    it('a call with no check never fails on its answer', async () => {
        const db = make({ ...okHandlers(), prdsavebulksp: flag(7) });
        assert.equal((await runSave(db, 'main', { steps: [{ call: 'prdSaveBulkSP', params: {} }] }, limits)).success, true);
    });

    it('checks the result set chosen by resultSet (a number or "last") and the first column of its first row', async () => {
        const two = { recordsets: [recordset([{ A: 'x' }]), recordset([{ ERROR_FLAG: 0, Other: 5 }])], messages: [] };
        const db = make({ prdtwosets: two });
        const ok = await runSave(db, 'main', { steps: [
            { call: 'prdTwoSets', okWhenFirstCellIs: 0, resultSet: 2 },
            { call: 'prdTwoSets', okWhenFirstCellIs: 0, resultSet: 'last' },
            { call: 'prdTwoSets', okWhenFirstCellIs: 'x' }
        ] }, limits);
        assert.deepEqual(ok.steps.map((s) => s.firstCell), [0, 0, 'x']);
        await failsWith(runSave(db, 'main', { steps: [{ call: 'prdTwoSets', okWhenFirstCellIs: 0 }] }, limits), 422, 'step_failed', /gave "x" in the first cell of result set 1/);
    });

    it('compares numbers and their text alike, and a bit as 0 or 1', async () => {
        const db = make({ prdone: { recordsets: [recordset([{ F: '0' }])], messages: [] }, prdbit: { recordsets: [recordset([{ F: false }])], messages: [] } });
        await runSave(db, 'main', { steps: [{ call: 'prdOne', okWhenFirstCellIs: 0 }, { call: 'prdBit', okWhenFirstCellIs: 0 }] }, limits);
        await failsWith(runSave(db, 'main', { steps: [{ call: 'prdBit', okWhenFirstCellIs: 1 }] }, limits), 422, 'step_failed', /not 1/);
    });

    it('a check on a result set that has no rows fails', async () => {
        const db = make({ prdempty: { recordsets: [recordset([])], messages: [] } });
        await failsWith(runSave(db, 'main', { steps: [{ call: 'prdEmpty', okWhenFirstCellIs: 0 }] }, limits), 422, 'step_failed', /gave no row/);
    });

    it('a staging insert that fails undoes the group and the procedures are never called', async () => {
        let bulkCount = 0;
        const db = make(okHandlers(), { onBulk: () => { if (++bulkCount === 2) throw new ApiError(409, 'conflict', 'A row with the same key already exists.'); } });
        await failsWith(runSave(db, 'main', dypRecipe(), limits), 409, 'conflict', /same key/, { step: '2.2' });

        assert.deepEqual(db.events, ['call:prdSaveBulkBoHstrySP', 'tx:begin', 'bulk:BOHdrBulkCopy', 'bulk:BODeleteBulkCopy', 'tx:rollback']);
        assert.deepEqual(db.transactions, [['rollback']]);
    });

    it('a procedure that ends the group\'s transaction fails the group (422) and names the step', async () => {
        const ended = () => { throw new ApiError(422, 'step_failed', 'A procedure ended the transaction it was called in, so its changes were undone.'); };
        const db = make({ ...okHandlers(), prdsavebulksp: ended });
        const recipe = { steps: [{ transaction: [
            { bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [['T1']] },
            { call: 'prdSaveBulkSP', params: {} }
        ] }] };
        await failsWith(runSave(db, 'main', recipe, limits), 422, 'step_failed', /ended the transaction/, { step: '1.2' });
        assert.deepEqual(db.transactions, [['rollback']]);
    });

    it('a call inside a group runs on the group\'s transaction and its failed check undoes the group', async () => {
        const db = make({ ...okHandlers(), prdsavebulksp: flag(1) });
        const recipe = { steps: [{ transaction: [
            { bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [['T1']] },
            { call: 'prdSaveBulkSP', params: {}, okWhenFirstCellIs: 0 }
        ] }] };
        await failsWith(runSave(db, 'main', recipe, limits), 422, 'step_failed', /prdSaveBulkSP gave 1/, { step: '1.2' });
        assert.ok(db.calls[0].inTransaction);
        assert.deepEqual(db.transactions, [['rollback']]);
    });

    it('a SQL error from a procedure keeps its status and gets the step and what it printed', async () => {
        const sqlError = Object.assign(new ApiError(400, 'sql_error', 'Batch 12 is locked.'), { messages: ['printed line'] });
        const db = make({ ...okHandlers(), prdsavebulkbohstrysp: () => { throw sqlError; } });
        await failsWith(runSave(db, 'main', dypRecipe(), limits), 400, 'sql_error', /Batch 12 is locked/, { step: '1', messages: ['printed line'] });
        assert.deepEqual(db.events, ['call:prdSaveBulkBoHstrySP'], 'nothing after it ran');
    });

    it('a bulk step with no rows is allowed and inserts nothing', async () => {
        const db = make();
        const out = await runSave(db, 'main', { steps: [{ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [] }] }, limits);
        assert.deepEqual(out.steps, [{ step: '1', kind: 'bulk', table: 'BOHdrBulkCopy', rows: 0 }]);
        assert.deepEqual(db.bulks, []);
    });

    it('a bulk step outside a group inserts on its own, not in a transaction', async () => {
        const db = make();
        await runSave(db, 'main', { steps: [{ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [['T1']] }] }, limits);
        assert.deepEqual(db.events, ['bulk:BOHdrBulkCopy']);
        assert.equal(db.bulks[0].inTransaction, undefined);
    });
});

describe('Save: checking the recipe before anything runs', () => {
    const bad = async (recipe, status, code, pattern, extra, options = {}) => {
        const db = make(okHandlers(), options);
        await failsWith(runSave(db, 'main', recipe, limits), status, code, pattern, extra);
        assert.deepEqual(db.events, [], 'a bad recipe runs nothing, not even the steps before the bad one');
    };
    const after = (step) => ({ steps: [{ call: 'prdSaveBulkBoHstrySP', params: {} }, step] });

    it('body: an object with only "steps", a non-empty list', async () => {
        for (const body of [undefined, null, [], 'x', 5]) await bad(body, 400, 'bad_request', /must be a JSON object/);
        await bad({ steps: [{ call: 'prdSaveBulkSP' }], extra: 1 }, 400, 'bad_request', /Unknown field "extra"/);
        for (const steps of [undefined, null, [], 'x', {}]) await bad({ steps }, 400, 'bad_request', /steps must be a non-empty list/);
    });

    it('each step is exactly one known kind with only that kind\'s fields', async () => {
        await bad(after(5), 400, 'bad_request', /Step 2: a step must be an object/, { step: '2' });
        await bad(after({}), 400, 'bad_request', /Step 2: a step must have exactly one of/, { step: '2' });
        await bad(after({ call: 'prdSaveBulkSP', bulk: 'x' }), 400, 'bad_request', /exactly one of/);
        await bad(after({ call: 'prdSaveBulkSP', columns: [] }), 400, 'bad_request', /Step 2: unknown field "columns" for a call step/);
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [], params: {} }), 400, 'bad_request', /unknown field "params" for a bulk step/);
        await bad(after({ run: 'x' }), 400, 'bad_request', /exactly one of/);
    });

    it('a group holds the right steps: no group inside a transaction, only calls in a repeat', async () => {
        await bad({ steps: [{ transaction: [{ transaction: [] }] }] }, 400, 'bad_request', /Step 1\.1: a transaction can hold only bulk and call steps/, { step: '1.1' });
        await bad({ steps: [{ transaction: [{ repeat: [{ call: 'prdSaveBulkSP' }] }] }] }, 400, 'bad_request', /Step 1\.1: a transaction can hold only/);
        await bad({ steps: [{ repeat: [{ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [] }] }] }, 400, 'bad_request', /Step 1\.1: a repeat can hold only call steps/);
        await bad({ steps: [{ repeat: [{ transaction: [] }] }] }, 400, 'bad_request', /a repeat can hold only call steps/);
        await bad({ steps: [{ transaction: [] }] }, 400, 'bad_request', /transaction must be a non-empty list/);
        await bad({ steps: [{ repeat: [] }] }, 400, 'bad_request', /repeat must be a non-empty list/);
    });

    it('attempts is a whole number from 1 to 5', async () => {
        for (const attempts of [0, 6, 1.5, '3', null]) {
            await bad({ steps: [{ repeat: [{ call: 'prdSaveBulkSP' }], attempts }] }, 400, 'bad_request', /attempts must be a whole number from 1 to 5/, { step: '1' });
        }
        const db = make();
        await runSave(db, 'main', { steps: [{ repeat: [{ call: 'prdSaveBulkSP' }], attempts: 5 }] }, limits);
        assert.deepEqual(db.events, ['call:prdSaveBulkSP']);
    });

    it('counts every step, groups included, against limits.saveSteps', async () => {
        const many = { steps: Array.from({ length: 4 }, () => ({ call: 'prdSaveBulkSP' })) };
        const db = make();
        await failsWith(runSave(db, 'main', many, { ...limits, saveSteps: 3 }), 400, 'bad_request', /at most 3 steps/);
        const grouped = { steps: [{ repeat: [{ call: 'prdSaveBulkSP' }, { call: 'prdSaveBulkSP' }] }, { call: 'prdSaveBulkSP' }] };
        await failsWith(runSave(db, 'main', grouped, { ...limits, saveSteps: 3 }), 400, 'bad_request', /at most 3 steps/);
        assert.deepEqual(db.events, []);
    });

    it('call: the name is checked (400), the blocked procedure refused (403), unknown procedures and parameters named by step', async () => {
        await bad(after({ call: 'db.dbo.x' }), 400, 'bad_request', /Step 2: The procedure name is not valid/, { step: '2' });
        await bad(after({ call: 'prdGetBOBulkCopyConnectString' }), 403, 'forbidden', /Step 2: This procedure is not available/, { step: '2' });
        await bad(after({ call: 'sp_executesql', params: { stmt: 'SELECT 1' } }), 403, 'forbidden', /Step 2: System procedures/, { step: '2' });
        await bad({ steps: [{ repeat: [{ call: 'xp_cmdshell' }] }] }, 403, 'forbidden', /Step 1\.1: System procedures/, { step: '1.1' });
        await bad(after({ call: 'prdMissing' }), 404, 'not_found', /Step 2: No such procedure/, { step: '2' });
        await bad(after({ call: 'prdSaveBulkSP', params: [] }), 400, 'bad_request', /Step 2: params must be an object/);
        await bad(after({ call: 'prdSaveBulkSP', params: { Nope: 1 } }), 400, 'bad_request', /Step 2: The procedure has no parameter @Nope/, { step: '2' }, {
            onCheckCall: (name, params) => { if ('Nope' in params) throw new ApiError(400, 'bad_request', 'The procedure has no parameter @Nope.'); }
        });
        await bad(after({ call: 'prdSaveBulkSP', resultSet: 0 }), 400, 'bad_request', /resultSet must be a whole number from 1, or "last"/);
        await bad(after({ call: 'prdSaveBulkSP', resultSet: '2' }), 400, 'bad_request', /resultSet must be/);
        await bad(after({ call: 'prdSaveBulkSP', okWhenFirstCellIs: { a: 1 } }), 400, 'bad_request', /okWhenFirstCellIs must be a number, text, true\/false or null/);
    });

    it('bulk: the table and every column must exist, and be writable', async () => {
        await bad(after({ bulk: 'Nope', columns: ['A'], rows: [] }), 404, 'not_found', /Step 2: No such table/, { step: '2' });
        await bad(after({ bulk: 'a b', columns: ['A'], rows: [] }), 400, 'bad_request', /Step 2: The table name is not valid/);
        await bad(after({ bulk: 'aView', columns: ['A'], rows: [] }), 400, 'bad_request', /can not write to a view/);
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['Nope'], rows: [] }), 400, 'bad_request', /Step 2: the table has no column "Nope"/, { step: '2', column: 'Nope' });
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['MONo', 'mono'], rows: [] }), 400, 'bad_request', /column MONo is listed twice/);
        await bad(after({ bulk: 'Odd', columns: ['Id'], rows: [] }), 400, 'bad_request', /column Id is generated by the database/, { column: 'Id' });
        await bad(after({ bulk: 'Odd', columns: ['Total'], rows: [] }), 400, 'bad_request', /generated by the database/);
        await bad(after({ bulk: 'Odd', columns: ['RowVer'], rows: [] }), 400, 'bad_request', /generated by the database/);
        await bad(after({ bulk: 'Odd', columns: ['Shape'], rows: [] }), 400, 'bad_request', /column Shape has a type \(geography\) this API does not support/);
        for (const columns of [undefined, [], 'A', [''], [5]]) {
            await bad(after({ bulk: 'BOHdrBulkCopy', columns, rows: [] }), 400, 'bad_request', /columns must be a list of 1 to 200 column names/);
        }
    });

    it('bulk: rows are lists of the right length, within limits.saveRowsPerTable', async () => {
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: 'x' }), 400, 'bad_request', /rows must be a list of rows/);
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['TransId', 'MONo'], rows: [['a', 'b'], ['only one']] }), 400, 'bad_request', /Step 2: row 2 must be a list of 2 values/, { step: '2', row: 2 });
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [{ TransId: 'a' }] }), 400, 'bad_request', /row 1 must be a list of 1 values/);
        await bad(after({ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: Array.from({ length: 6 }, () => ['a']) }), 400, 'bad_request', /at most 5 rows are allowed/);
    });

    it('bulk: a value that does not fit says the step, row and column, never the value', async () => {
        await bad(after({ bulk: 'Odd', columns: ['Name', 'Qty'], rows: [['ok', 1], ['SENTINEL'.repeat(10), 2]] }), 400, 'bad_request',
            /Step 2, row 2: Column Name: longer than the 20 characters it can hold/, { step: '2', row: 2, column: 'Name' });
        await bad(after({ bulk: 'Odd', columns: ['Qty'], rows: [['abc']] }), 400, 'bad_request', /Step 2, row 1: Column Qty: expected a whole number/, { row: 1, column: 'Qty' });
        await bad(after({ bulk: 'Odd', columns: ['When'], rows: [['2026-10-23T08:00:00Z']] }), 400, 'bad_request', /Column When: expected date text/);
        await bad({ steps: [{ transaction: [{ bulk: 'Odd', columns: ['Qty'], rows: [[1], ['x']] }] }] }, 400, 'bad_request', /Step 1\.1, row 2: Column Qty/, { step: '1.1', row: 2 });
    });

    it('a bad step 5 runs none of steps 1 to 4', async () => {
        const recipe = { steps: [
            { call: 'prdSaveBulkBoHstrySP' }, { call: 'prdSaveBulkSP' }, { bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [['a']] },
            { call: 'prdSaveBulkSP' }, { bulk: 'BOHdrBulkCopy', columns: ['Nope'], rows: [] }
        ] };
        await bad(recipe, 400, 'bad_request', /Step 5: the table has no column "Nope"/, { step: '5' });
    });

    it('values travel as typed values, never as SQL: this API builds no SQL text for a Save', async () => {
        const db = make();
        await runSave(db, 'main', { steps: [{ bulk: 'BOHdrBulkCopy', columns: ['TransId'], rows: [["x'; DROP TABLE a; --"]] }] }, limits);
        assert.equal(db.queries.length, 0);
        assert.deepEqual(db.bulks[0].rows, [["x'; DROP TABLE a; --"]]);
    });
});
