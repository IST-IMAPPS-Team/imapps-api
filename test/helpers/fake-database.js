const { ApiError } = require('../../src/api/errors');

// A stand-in for src/gateway/db/database.js with the same methods. It records every call.
//
// Procedures: answers from a table of canned results keyed by lower-case procedure name:
//   handlers = { prdgetsomething: { recordsets: [[{ A: 1 }]], messages: [], returnValue: 0 } }
//   A handler may also be a function (params, options) -> result, or throw.
//
// Tables (second argument): { tables: { bolocking: tableMeta }, onQuery(text, inputs) -> { recordsets } }
//   tableMeta as table-catalog.js returns it; use fakeTable() below to build one.
exports.createFakeDatabase = (handlers = {}, { tables = {}, onQuery } = {}) => {
    const calls = [];
    const queries = [];
    return {
        calls,
        queries,
        async callProcedure(profile, name, params, options = {}) {
            calls.push({ profile, name, params, options });
            const handler = handlers[name.toLowerCase().replace(/^[^.]+\./, '')]; // schema.name finds name
            if (!handler) throw new ApiError(404, 'not_found', 'No such procedure.');
            return typeof handler === 'function' ? handler(params, options) : handler;
        },
        async describeTable(profile, name) {
            return tables[name.toLowerCase().replace(/^[^.]+\./, '')] || null;
        },
        async query(profile, text, inputs = [], options = {}) {
            queries.push({ profile, text, inputs, options });
            return onQuery ? onQuery(text, inputs) : { recordsets: [] };
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
