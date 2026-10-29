const { ApiError } = require('../../api/errors');

// Turns the JSON value for one procedure parameter into what the driver sends, using the
// parameter's real SQL type (read from the database catalog), never a guess from the value.
// Error messages name the parameter and the rule, never the value.

const INTEGER_RANGES = { tinyint: [0, 255], smallint: [-32768, 32767], int: [-2147483648, 2147483647] };
const INTEGER_TEXT = /^-?\d+$/;
const NUMBER_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?$/;
const OFFSET_TEXT = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?)(Z|[+-]\d{2}:\d{2})$/i;
const TIME_TEXT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const YEAR_RANGES = { datetime: [1753, 9999], smalldatetime: [1900, 2079], date: [1, 9999], datetime2: [1, 9999] };

// `reason` is not sent to the caller; it lets the login tell "this value does not fit the
// parameter" (a wrong login) from other 400s such as a misspelt parameter name.
const bad = (meta, message) => {
    const error = new ApiError(400, 'bad_request', `Parameter @${meta.name}: ${message}`);
    error.reason = 'parameter_value';
    return error;
};

// Length of a text or binary parameter, in characters (or bytes). null means "max".
const declaredLength = (meta) => {
    if (meta.maxLength === -1) return null;
    return ['nchar', 'nvarchar', 'ntext'].includes(meta.typeName) ? meta.maxLength / 2 : meta.maxLength;
};

const toNumber = (meta, value, kind) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const pattern = kind === 'integer' ? INTEGER_TEXT : NUMBER_TEXT;
    if (typeof value === 'string' && pattern.test(value)) return Number(value);
    throw bad(meta, `expected ${kind === 'integer' ? 'a whole number' : 'a number'}.`);
};

// Reads "YYYY-MM-DD[ T]hh:mm[:ss[.fff]]" as the database's own clock value (held as UTC).
const toClockDate = (meta, value) => {
    const m = typeof value === 'string' ? DATE_TEXT.exec(value) : null;
    if (!m) throw bad(meta, 'expected date text like 2026-10-23 or 2026-10-23T08:00:00 (no time zone).');
    // Parts that are missing (a date with no time) stay undefined so the defaults apply.
    const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((part) => (part === undefined ? undefined : Number(part)));
    const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
    const valid = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60 && s < 60;
    if (!valid) throw bad(meta, 'not a real date or time.');
    const range = YEAR_RANGES[meta.typeName];
    if (range && (y < range[0] || y > range[1])) throw bad(meta, `the year must be from ${range[0]} to ${range[1]}.`);
    return date;
};

const toClockTime = (meta, value) => {
    const m = typeof value === 'string' ? TIME_TEXT.exec(value) : null;
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] || 0) > 59) {
        throw bad(meta, 'expected time text like 08:00 or 08:00:00.123.');
    }
    const ms = m[4] ? Number((m[4] + '000').slice(0, 3)) : 0;
    return new Date(Date.UTC(1970, 0, 1, Number(m[1]), Number(m[2]), Number(m[3] || 0), ms));
};

const toText = (meta, value) => {
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (typeof value !== 'string') throw bad(meta, 'expected text.');
    const length = declaredLength(meta);
    if (length !== null && value.length > length) throw bad(meta, `longer than the ${length} characters it can hold.`);
    return value;
};

// The mssql type object for a parameter (`sql` is the mssql module, passed in so tests can fake it).
exports.typeFor = (sql, meta) => {
    const length = declaredLength(meta);
    switch (meta.typeName) {
        case 'bit': return sql.Bit;
        case 'tinyint': return sql.TinyInt;
        case 'smallint': return sql.SmallInt;
        case 'int': return sql.Int;
        case 'bigint': return sql.BigInt;
        case 'decimal': return sql.Decimal(meta.precision, meta.scale);
        case 'numeric': return sql.Numeric(meta.precision, meta.scale);
        case 'money': return sql.Money;
        case 'smallmoney': return sql.SmallMoney;
        case 'float': return sql.Float;
        case 'real': return sql.Real;
        case 'char': case 'varchar': case 'text': return sql.VarChar(length === null ? sql.MAX : length);
        case 'nchar': case 'nvarchar': case 'ntext': return sql.NVarChar(length === null ? sql.MAX : length);
        case 'date': return sql.Date;
        case 'datetime': return sql.DateTime;
        case 'smalldatetime': return sql.SmallDateTime;
        case 'datetime2': return sql.DateTime2(meta.scale);
        case 'datetimeoffset': return sql.DateTimeOffset(meta.scale);
        case 'time': return sql.Time(meta.scale);
        case 'uniqueidentifier': return sql.UniqueIdentifier;
        case 'binary': case 'varbinary': case 'image': return sql.VarBinary(length === null ? sql.MAX : length);
        case 'xml': return sql.Xml;
        default:
            throw bad(meta, `its type (${meta.typeName || 'unknown'}) is not supported by this API.`);
    }
};

// The value to send. `null` is always allowed (the procedure decides what it means).
exports.convertValue = (meta, value) => {
    if (value === null) return null;
    switch (meta.typeName) {
        case 'bit': {
            if (typeof value === 'boolean') return value;
            if (value === 1 || value === '1' || /^true$/i.test(value)) return true;
            if (value === 0 || value === '0' || /^false$/i.test(value)) return false;
            throw bad(meta, 'expected true or false.');
        }
        case 'tinyint': case 'smallint': case 'int': {
            const n = toNumber(meta, value, 'integer');
            const [min, max] = INTEGER_RANGES[meta.typeName];
            if (!Number.isInteger(n) || n < min || n > max) throw bad(meta, `expected a whole number from ${min} to ${max}.`);
            return n;
        }
        case 'bigint': {
            const n = toNumber(meta, value, 'integer');
            if (!Number.isSafeInteger(n)) throw bad(meta, 'expected a whole number within +/- 9007199254740991.');
            return BigInt(n);
        }
        case 'decimal': case 'numeric': case 'money': case 'smallmoney': case 'float': case 'real':
            return toNumber(meta, value, 'number');
        case 'char': case 'varchar': case 'text': case 'nchar': case 'nvarchar': case 'ntext': case 'xml':
            return toText(meta, value);
        case 'date': case 'datetime': case 'smalldatetime': case 'datetime2':
            return toClockDate(meta, value);
        case 'time':
            return toClockTime(meta, value);
        case 'datetimeoffset': {
            const m = typeof value === 'string' ? OFFSET_TEXT.exec(value) : null;
            const date = m ? new Date(m[1].replace(' ', 'T') + m[2].toUpperCase()) : null;
            if (!date || Number.isNaN(date.getTime())) {
                throw bad(meta, 'expected date text with an offset, like 2026-10-23T08:00:00+08:00.');
            }
            return date;
        }
        case 'uniqueidentifier':
            if (typeof value !== 'string' || !GUID.test(value)) throw bad(meta, 'expected a GUID like 6F9619FF-8B86-D011-B42D-00C04FC964FF.');
            return value;
        case 'binary': case 'varbinary': case 'image': {
            if (typeof value !== 'string' || !BASE64.test(value)) throw bad(meta, 'expected base64 text.');
            const bytes = Buffer.from(value, 'base64');
            const length = declaredLength(meta);
            if (length !== null && bytes.length > length) throw bad(meta, `longer than the ${length} bytes it can hold.`);
            return bytes;
        }
        default:
            throw bad(meta, `its type (${meta.typeName || 'unknown'}) is not supported by this API.`);
    }
};
