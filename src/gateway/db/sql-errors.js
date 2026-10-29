const { ApiError } = require('../../api/errors');

// Network or login problems: the database can not be used right now.
const UNAVAILABLE_CODES = new Set(['ELOGIN', 'ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ENOTOPEN', 'ENOTFOUND', 'ECONNREFUSED']);
const DUPLICATE_KEY = new Set([2627, 2601]);
const PERMISSION_DENIED = new Set([229, 230, 262, 297, 300]);

const isMssqlError = (err) => err && (err.name === 'RequestError' || err.name === 'ConnectionError' || err.name === 'MSSQLError');

// Maps an error from the SQL Server driver to an ApiError. Anything else comes back unchanged.
// SQL user errors (class 11 to 16) keep SQL Server's own message, because the web app shows it.
// Connection and unexpected errors answer generic text; the detail goes to the log.
exports.mapSqlError = (err, log = console) => {
    if (err instanceof ApiError || !isMssqlError(err)) return err;

    if (err.name === 'ConnectionError' || UNAVAILABLE_CODES.has(err.code)) {
        log.error(`[db] database unavailable (${err.code || err.name}): ${err.message}`);
        return new ApiError(503, 'db_unavailable', 'The database can not be reached.');
    }
    if (err.code === 'ETIMEOUT') {
        return new ApiError(504, 'timeout', 'The database took too long to answer.');
    }
    if (err.code === 'EPARAM') {
        return new ApiError(400, 'bad_request', 'A parameter value is not valid for its type.');
    }

    const number = Number(err.number);
    if (DUPLICATE_KEY.has(number)) return new ApiError(409, 'conflict', 'A row with the same key already exists.');
    if (number === 547) return new ApiError(409, 'conflict', 'The change conflicts with a database constraint.');
    if (number === 1205) return new ApiError(409, 'conflict', 'The database rolled the request back (deadlock). Try again.');
    if (number === 1222) return new ApiError(504, 'timeout', 'The database could not get a lock in time.');
    if (number === 2812) return new ApiError(404, 'not_found', 'No such procedure.');
    if (PERMISSION_DENIED.has(number)) return new ApiError(403, 'forbidden', err.message);

    const severity = Number(err.class);
    if (severity >= 11 && severity <= 16) return new ApiError(400, 'sql_error', err.message);

    log.error(`[db] unexpected database error (number ${err.number}, class ${err.class}): ${err.message}`);
    return new ApiError(500, 'internal', 'An unexpected error occurred.');
};
