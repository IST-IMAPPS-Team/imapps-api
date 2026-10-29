const { ApiError } = require('../../src/api/errors');

// A stand-in for src/gateway/db/database.js with the same methods. It records every call and
// answers from a table of canned results keyed by lower-case procedure name:
//   handlers = { prdgetsomething: { recordsets: [[{ A: 1 }]], messages: [], returnValue: 0 } }
// A handler may also be a function (params, options) -> result, or throw.
exports.createFakeDatabase = (handlers = {}) => {
    const calls = [];
    return {
        calls,
        async callProcedure(profile, name, params, options = {}) {
            calls.push({ profile, name, params, options });
            const handler = handlers[name.toLowerCase()];
            if (!handler) throw new ApiError(404, 'not_found', 'No such procedure.');
            return typeof handler === 'function' ? handler(params, options) : handler;
        },
        async ping() {
            return true;
        },
        async close() {}
    };
};
