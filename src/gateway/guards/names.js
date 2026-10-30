const { ApiError } = require('../../api/errors');

// A procedure is `name` or `schema.name`: plain letters, digits and underscores only.
// Never a database prefix, never quotes or spaces. (Names can not be SQL parameters,
// so this check is what keeps text from a request out of SQL.)
const OBJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\.[A-Za-z_][A-Za-z0-9_]{0,127})?$/;

// Refused whatever the schema prefix or letter case. It hands out database login values.
const BLOCKED_PROCEDURES = new Set(['prdgetbobulkcopyconnectstring']);

// System procedures: names that start with sp_ or xp_, and anything in the sys or
// INFORMATION_SCHEMA schemas. Any SQL login may run some of them (sp_executesql runs any SQL text), so
// reaching them through the API would give a caller more than "the procedures of the application".
// The Planning Board's own procedures are prd..., pln... and NGP_...
const SYSTEM_PREFIXES = ['sp_', 'xp_'];
const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema']);

const parts = (name) => name.toLowerCase().split('.');

exports.isBlockedProcedure = (name) => BLOCKED_PROCEDURES.has(parts(name).pop());

exports.isSystemProcedure = (name) => {
    const names = parts(name);
    const bare = names.pop();
    return SYSTEM_PREFIXES.some((prefix) => bare.startsWith(prefix)) || (names.length > 0 && SYSTEM_SCHEMAS.has(names[0]));
};

// A table (or view) is `name` or `schema.name` too. The exact table and its columns are then
// looked up in the database catalog; the names used in SQL come from there, never from the request.
exports.checkTableName = (name) => {
    if (typeof name !== 'string' || !OBJECT_NAME.test(name)) {
        throw new ApiError(400, 'bad_request', 'The table name is not valid. Use name or schema.name.');
    }
    return name;
};

exports.checkProcedureName = (name) => {
    if (typeof name !== 'string' || !OBJECT_NAME.test(name)) {
        throw new ApiError(400, 'bad_request', 'The procedure name is not valid. Use name or schema.name.');
    }
    if (exports.isBlockedProcedure(name)) {
        throw new ApiError(403, 'forbidden', 'This procedure is not available through the API.');
    }
    if (exports.isSystemProcedure(name)) {
        throw new ApiError(403, 'forbidden', 'System procedures (names starting with sp_ or xp_, or in the sys schema) are not available through the API.');
    }
    return name;
};
