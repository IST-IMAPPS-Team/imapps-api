const { quote, qualified } = require('../../gateway/db/sql-names');
const { serialiseRecordsets } = require('../../gateway/db/serialise');
const { loadPlanTable, column, readFields, valueFor } = require('./plan-table');

// The load audit row the legacy app writes (BOTimestamp: MfgLoc, Process, UserId, Timestamp).
// The time is the database clock (GETDATE(), as the legacy does) and the user is the signed-in
// user from the token, never a value from the request, so a row can not be written in someone
// else's name. The table has no key and no defaults: every call adds one row.
const TABLE = 'BOTimestamp';
const COLUMNS = ['MfgLoc', 'Process', 'UserId', 'Timestamp'];

// POST { Process, MfgLoc? } -> { inserted: 1, row } (row is null for a table with enabled triggers)
exports.writeTimestamp = async (database, profileName, body, userId) => {
    const given = readFields(body, { required: ['Process'], optional: ['MfgLoc'] });
    const table = await loadPlanTable(database, profileName, TABLE, COLUMNS);

    const input = (name, parameter, value) => ({ name: parameter, meta: column(table, name), value: valueFor(table, name, value) });
    const inputs = [
        input('MfgLoc', 'mfgLoc', given.MfgLoc === undefined ? null : given.MfgLoc),
        input('Process', 'process', given.Process),
        input('UserId', 'userId', userId)
    ];

    const output = table.hasTriggers ? '' : ` OUTPUT ${COLUMNS.map((c) => `INSERTED.${quote(c)}`).join(', ')}`;
    const text = `INSERT INTO ${qualified(table)} (${COLUMNS.map(quote).join(', ')})${output} VALUES (@mfgLoc, @process, @userId, GETDATE())`;

    const result = await database.query(profileName, text, inputs);
    const row = output ? serialiseRecordsets(result.recordsets)[0]?.[0] || null : null;
    return { inserted: 1, row };
};
