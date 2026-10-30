const { ApiError } = require('../../src/api/errors');

// A stand-in for src/gateway/db/database.js with the same methods. It records every call.
//
// Procedures: answers from a table of canned results keyed by lower-case procedure name:
//   handlers = { prdgetsomething: { recordsets: [[{ A: 1 }]], messages: [], returnValue: 0 } }
//   A handler may also be a function (params, options) -> result, or throw.
//
// Options (second argument):
//   tables      { bolocking: tableMeta }  tables as table-catalog.js returns them; build with fakeTable() below
//   onQuery     (text, inputs) -> { recordsets }     answers query() and tx.query()
//   onBulk      (prepared) -> void                   may throw to make a bulk insert fail
//   onCheckCall (name, params) -> void               may throw to make checkCall() refuse a call
//
// `events` lists what ran, in order: 'call:name', 'bulk:Table', 'tx:begin', 'tx:commit', 'tx:rollback'.
exports.createFakeDatabase = (handlers = {}, { tables = {}, onQuery, onBulk, onCheckCall } = {}) => {
    const calls = [];
    const queries = [];
    const bulks = [];
    const transactions = [];
    const events = [];

    const find = (name) => handlers[name.toLowerCase().replace(/^[^.]+\./, '')]; // schema.name finds name

    const run = async (profile, name, params, options = {}, inTransaction = false) => {
        calls.push({ profile, name, params, options, ...(inTransaction ? { inTransaction: true } : {}) });
        events.push(`call:${name}`);
        const handler = find(name);
        if (!handler) throw new ApiError(404, 'not_found', 'No such procedure.');
        return typeof handler === 'function' ? handler(params, options) : handler;
    };

    const bulk = async (profile, prepared, inTransaction = false) => {
        bulks.push({
            profile, table: prepared.name, schema: prepared.schema, columns: prepared.columns.map((c) => c.name),
            rows: prepared.rows, ...(inTransaction ? { inTransaction: true } : {})
        });
        events.push(`bulk:${prepared.name}`);
        if (onBulk) await onBulk(prepared);
        return { rows: prepared.rows.length };
    };

    return {
        calls,
        queries,
        bulks,
        events,
        transactions,
        callProcedure: (profile, name, params, options) => run(profile, name, params, options),
        async checkCall(profile, name, params) {
            if (!find(name)) throw new ApiError(404, 'not_found', 'No such procedure.');
            if (onCheckCall) await onCheckCall(name, params);
            return true;
        },
        async describeTable(profile, name) {
            return tables[name.toLowerCase().replace(/^[^.]+\./, '')] || null;
        },
        async query(profile, text, inputs = [], options = {}) {
            queries.push({ profile, text, inputs, options });
            return onQuery ? onQuery(text, inputs) : { recordsets: [] };
        },
        bulkInsert: (profile, prepared) => bulk(profile, prepared),
        // Runs work(tx) like database.transaction: transactions holds 'commit' or 'rollback' per call.
        async transaction(profile, work) {
            const outcome = [];
            transactions.push(outcome);
            events.push('tx:begin');
            const tx = {
                async query(text, inputs = []) {
                    queries.push({ profile, text, inputs, inTransaction: true });
                    return onQuery ? onQuery(text, inputs) : { recordsets: [] };
                },
                callProcedure: (name, params, options) => run(profile, name, params, options, true),
                bulkInsert: (prepared) => bulk(profile, prepared, true)
            };
            try {
                const result = await work(tx);
                outcome.push('commit');
                events.push('tx:commit');
                return result;
            } catch (err) {
                outcome.push('rollback');
                events.push('tx:rollback');
                throw err;
            }
        },
        async ping() {
            return true;
        },
        async close() {}
    };
};

// A table as the catalog describes it. columns: [name, type, { maxLength, nullable, identity, computed }]
exports.fakeTable = ({ schema = 'dbo', name, columns, hasTriggers = false, isView = false }) => {
    const list = columns.map(([columnName, typeName, extra = {}]) => ({
        kind: 'column', name: columnName, typeName, maxLength: 0, precision: 0, scale: 0,
        nullable: true, identity: false, computed: false, ...extra
    }));
    return { schema, name, isView, hasTriggers, columns: list, byLower: new Map(list.map((c) => [c.name.toLowerCase(), c])) };
};
