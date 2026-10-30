const { ApiError } = require('../../api/errors');

// A procedure is `name` or `schema.name`: plain letters, digits and underscores only.
// Never a database prefix, never quotes or spaces. (Names can not be SQL parameters,
// so this check is what keeps text from a request out of SQL.)
const OBJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\.[A-Za-z_][A-Za-z0-9_]{0,127})?$/;

// Refused whatever the schema prefix or letter case. It hands out database login values.
const BLOCKED_PROCEDURES = new Set(['prdgetbobulkcopyconnectstring']);

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
    if (BLOCKED_PROCEDURES.has(name.split('.').pop().toLowerCase())) {
        throw new ApiError(403, 'forbidden', 'This procedure is not available through the API.');
    }
    return name;
};
