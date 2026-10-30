const { ApiError } = require('../../api/errors');
const { convertValue } = require('../../gateway/db/parameter-types');

// The Planning Board routes use a few tables by fixed name (BOLocking, BOTimestamp). This loads
// one from the database catalog and checks it has the columns the route needs, so a database that
// differs gives a clear error instead of a SQL error.
exports.loadPlanTable = async (database, profileName, tableName, requiredColumns) => {
    const table = await database.describeTable(profileName, tableName);
    if (!table) throw new ApiError(404, 'not_found', `The table ${tableName} was not found in this database.`);
    const missing = requiredColumns.filter((name) => !table.byLower.has(name.toLowerCase()));
    if (missing.length > 0) {
        throw new ApiError(500, 'internal', `The table ${tableName} has no column ${missing.join(', ')}, which this route needs.`);
    }
    return table;
};

exports.column = (table, name) => table.byLower.get(name.toLowerCase());

const bad = (message) => new ApiError(400, 'bad_request', message);

// Reads a JSON body that may hold only the named fields. `required` fields must be non-empty text;
// `optional` fields may be text or null. Returns the fields that were given.
exports.readFields = (body, { required = [], optional = [] }) => {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw bad(`The request body must be a JSON object with ${required.join(', ')}.`);
    }
    const allowed = [...required, ...optional];
    const unknown = Object.keys(body).find((key) => !allowed.includes(key));
    if (unknown !== undefined) throw bad(`Unknown field "${unknown.slice(0, 64)}". Allowed: ${allowed.join(', ')}.`);
    for (const name of required) {
        if (typeof body[name] !== 'string' || body[name] === '') throw bad(`${name} is required and must be text.`);
    }
    for (const name of optional) {
        if (body[name] !== undefined && body[name] !== null && typeof body[name] !== 'string') throw bad(`${name} must be text or null.`);
    }
    return Object.fromEntries(allowed.filter((name) => body[name] !== undefined).map((name) => [name, body[name]]));
};

// Reads query-string fields: only the named ones, each given once and not empty.
exports.readQuery = (query, names) => {
    const unknown = Object.keys(query).find((key) => !names.includes(key));
    if (unknown !== undefined) throw bad(`Unknown query field "${unknown.slice(0, 64)}". Allowed: ${names.join(', ')}.`);
    return Object.fromEntries(names.map((name) => {
        if (typeof query[name] !== 'string' || query[name] === '') throw bad(`${name} is required in the query string.`);
        return [name, query[name]];
    }));
};

// A value converted for its column (length and type checked; the message names the column, not the value).
exports.valueFor = (table, name, value) => convertValue(exports.column(table, name), value);
