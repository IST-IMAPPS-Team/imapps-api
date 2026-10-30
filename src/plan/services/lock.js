const { ApiError } = require('../../api/errors');
const { quote, qualified } = require('../../gateway/db/sql-names');
const { serialiseRecordsets } = require('../../gateway/db/serialise');
const { loadPlanTable, column, readFields, readQuery, valueFor } = require('./plan-table');

// The Planning Board edit lock: one row in BOLocking per location, MfgLoc is the key.
// The table has no key of its own (sp_help BOLocking: no primary key, no unique index), so
// "one user per location" is enforced here: taking the lock runs in one short transaction that
// makes any other take for the same location wait (sp_getapplock), then looks before it writes.
const TABLE = 'BOLocking';
const COLUMNS = ['MfgLoc', 'LockedBy', 'LockedDt', 'Session', 'Remarks'];
const SHOWN = ['MfgLoc', 'LockedBy', 'LockedDt', 'Session', 'Remarks'].map(quote).join(', ');

const APPLOCK = [
    'DECLARE @result int;',
    "EXEC @result = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;",
    'SELECT @result AS result;'
].join('\n');
const RESOURCE_META = { typeName: 'nvarchar', maxLength: 510 };

const input = (table, name, parameter, value) => ({ name: parameter, meta: column(table, name), value: valueFor(table, name, value) });
const firstRows = (result) => serialiseRecordsets(result.recordsets)[0] || [];
const firstRow = (result) => firstRows(result)[0];

// POST: takes the lock, or says who holds it.
//   no row for MfgLoc        -> inserted      { locked: true, alreadyHeld: false, lock }  (201)
//   a row held by LockedBy   -> refreshed     { locked: true, alreadyHeld: true, lock }   (200)
//   a row held by someone else -> 409 conflict with holder { LockedBy, LockedDt, Session }
exports.takeLock = async (database, profileName, body) => {
    const given = readFields(body, { required: ['MfgLoc', 'LockedBy'], optional: ['Session', 'Remarks'] });
    const table = await loadPlanTable(database, profileName, TABLE, ['Recid', ...COLUMNS]);
    const T = qualified(table);

    const mfgLoc = input(table, 'MfgLoc', 'mfgLoc', given.MfgLoc);
    const lockedBy = input(table, 'LockedBy', 'lockedBy', given.LockedBy);
    const optional = ['Session', 'Remarks'].filter((name) => given[name] !== undefined)
        .map((name) => ({ name, input: input(table, name, name.toLowerCase(), given[name]) }));

    return database.transaction(profileName, async (tx) => {
        const gate = await tx.query(APPLOCK, [{ name: 'resource', meta: RESOURCE_META, value: `BOLocking:${String(mfgLoc.value).toLowerCase()}` }]);
        const result = (gate.recordsets[0] || [])[0]?.result;
        if (!(result >= 0)) throw new ApiError(409, 'conflict', 'Another request is changing this lock. Try again.');

        const holders = firstRows(await tx.query(
            `SELECT ${SHOWN}, CASE WHEN ${quote('LockedBy')} = @lockedBy THEN 1 ELSE 0 END AS isMine FROM ${T} WHERE ${quote('MfgLoc')} = @mfgLoc ORDER BY ${quote('LockedDt')}, ${quote('Recid')}`,
            [mfgLoc, lockedBy]
        ));

        const mine = holders.some((row) => row.isMine === 1 || row.isMine === true);
        if (holders.length > 0 && !mine) {
            const { LockedBy, LockedDt, Session } = holders[0];
            throw new ApiError(409, 'conflict', 'This location is locked by another user.', { holder: { LockedBy, LockedDt, Session } });
        }

        const sameKey = `${quote('MfgLoc')} = @mfgLoc AND ${quote('LockedBy')} = @lockedBy`;
        if (holders.length === 0) {
            const names = [quote('MfgLoc'), quote('LockedBy'), ...optional.map((o) => quote(o.name))].join(', ');
            const values = ['@mfgLoc', '@lockedBy', ...optional.map((o) => `@${o.input.name}`)].join(', ');
            await tx.query(`INSERT INTO ${T} (${names}) VALUES (${values})`, [mfgLoc, lockedBy, ...optional.map((o) => o.input)]);
        } else {
            const sets = [`${quote('LockedDt')} = GETDATE()`, ...optional.map((o) => `${quote(o.name)} = @${o.input.name}`)].join(', ');
            await tx.query(`UPDATE ${T} SET ${sets} WHERE ${sameKey}`, [mfgLoc, lockedBy, ...optional.map((o) => o.input)]);
        }

        const stored = firstRow(await tx.query(
            `SELECT TOP (1) ${SHOWN} FROM ${T} WHERE ${sameKey} ORDER BY ${quote('LockedDt')} DESC, ${quote('Recid')}`,
            [mfgLoc, lockedBy]
        ));
        return { locked: true, alreadyHeld: holders.length > 0, lock: stored || null };
    });
};

// GET ?MfgLoc=: who holds the lock (the earliest row if an old race left several).
exports.readLock = async (database, profileName, query) => {
    const { MfgLoc } = readQuery(query, ['MfgLoc']);
    const table = await loadPlanTable(database, profileName, TABLE, ['Recid', ...COLUMNS]);
    const result = await database.query(
        profileName,
        `SELECT TOP (1) ${SHOWN} FROM ${qualified(table)} WHERE ${quote('MfgLoc')} = @mfgLoc ORDER BY ${quote('LockedDt')}, ${quote('Recid')}`,
        [input(table, 'MfgLoc', 'mfgLoc', MfgLoc)]
    );
    const lock = firstRow(result);
    return lock ? { locked: true, lock } : { locked: false };
};

// DELETE ?MfgLoc=&LockedBy=: releases your own lock. Nothing to delete is not an error.
exports.releaseLock = async (database, profileName, query) => {
    const { MfgLoc, LockedBy } = readQuery(query, ['MfgLoc', 'LockedBy']);
    const table = await loadPlanTable(database, profileName, TABLE, ['Recid', ...COLUMNS]);
    const result = await database.query(
        profileName,
        `SET NOCOUNT ON; DELETE FROM ${qualified(table)} WHERE ${quote('MfgLoc')} = @mfgLoc AND ${quote('LockedBy')} = @lockedBy; SELECT @@ROWCOUNT AS released;`,
        [input(table, 'MfgLoc', 'mfgLoc', MfgLoc), input(table, 'LockedBy', 'lockedBy', LockedBy)]
    );
    const row = (result.recordsets[0] || [])[0];
    return { released: Boolean(row && row.released > 0) };
};
