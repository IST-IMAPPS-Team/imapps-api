// Turns database values into the JSON the web app expects.
// The driver runs with useUTC, so a datetime arrives as a JS Date holding the database's own
// clock value as if it were UTC. It is written back as local text, with no time zone and no
// "Z" (for example 2026-10-23T08:00:00), which is what the web app reads.

const pad = (n, width = 2) => String(n).padStart(width, '0');

const fraction = (date) => {
    const ms = date.getUTCMilliseconds();
    return ms === 0 ? '' : '.' + pad(ms, 3).replace(/0+$/, '');
};

const dateText = (d) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const timeText = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${fraction(d)}`;

const convert = (value, declaration) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        if (declaration === 'time') return timeText(value);
        if (declaration === 'datetimeoffset') return value.toISOString();
        return `${dateText(value)}T${timeText(value)}`;
    }
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (typeof value === 'bigint') return value.toString();
    if (declaration === 'uniqueidentifier' && typeof value === 'string') return value.toLowerCase();
    // Duplicate column names arrive as a list of values.
    if (Array.isArray(value)) return value.map((v) => convert(v, declaration));
    return value;
};

// recordset.columns (set by the driver) says each column's SQL type.
const serialiseRecordset = (recordset) => {
    const columns = recordset.columns || {};
    const declarations = {};
    for (const name of Object.keys(columns)) declarations[name] = columns[name]?.type?.declaration;

    return recordset.map((row) => {
        const out = {};
        for (const key of Object.keys(row)) out[key] = convert(row[key], declarations[key]);
        return out;
    });
};

exports.serialiseRecordsets = (recordsets) => (recordsets || []).map(serialiseRecordset);
