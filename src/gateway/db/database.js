const { ApiError } = require('../../api/errors');
const { createPoolRegistry } = require('./pool-registry');
const { createProcedureCatalog } = require('./proc-catalog');
const { createTableCatalog } = require('./table-catalog');
const { typeFor, convertValue } = require('./parameter-types');
const { mapSqlError } = require('./sql-errors');

// THE one place that talks to SQL Server. Everything else asks this object, so tests can
// swap in a fake with the same methods (see test/helpers/fake-database.js).
//   callProcedure(profile, procedure, params, { multi }) -> { recordsets, messages, returnValue }
//   checkCall(profile, procedure, params)    throws 404/400 if the call could not be made (nothing runs)
//   describeTable(profile, table) -> { schema, name, columns, ... } or null
//   query(profile, sqlText, inputs) -> { recordsets }
//   bulkInsert(profile, { schema, name, columns, rows }) -> { rows }
//   transaction(profile, async (tx) => result)
//       tx has query(sqlText, inputs), callProcedure(procedure, params, { multi }) and bulkInsert(prepared),
//       all on one connection; commits when the work returns and rolls back when it throws
//   ping(profile) -> true
//   close()
// `multi: true` only means "use the longer timeout" (the profile's multiTimeoutSeconds).
// `sql` is the mssql module (injected in tests).
exports.createDatabase = ({ profiles, sql = require('mssql'), log = console, catalogTtlMs } = {}) => {
    const registry = createPoolRegistry({ profiles, sql, log });
    const catalog = createProcedureCatalog({ ttlMs: catalogTtlMs });
    const tables = createTableCatalog({ ttlMs: catalogTtlMs });

    // Checks the caller's parameters against the procedure's own and returns typed inputs.
    const bindParameters = (meta, params) => {
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
            throw new ApiError(400, 'bad_request', 'params must be an object of parameter names and values.');
        }
        const inputs = new Map();
        for (const [given, value] of Object.entries(params)) {
            const key = given.replace(/^@/, '').toLowerCase();
            const declared = meta.params.get(key);
            if (!declared) {
                throw new ApiError(400, 'bad_request', `The procedure has no parameter @${given.replace(/^@/, '').slice(0, 64)}.`);
            }
            if (inputs.has(key)) throw new ApiError(400, 'bad_request', `Parameter @${declared.name} was given twice.`);
            inputs.set(key, { name: declared.name, type: typeFor(sql, declared), value: convertValue(declared, value) });
        }
        return [...inputs.values()];
    };

    const describeProcedure = async (pool, profileName, procedureName) => {
        const meta = await catalog.describe(pool, sql, profileName, procedureName);
        if (!meta) throw new ApiError(404, 'not_found', 'No such procedure.');
        return meta;
    };

    const timeoutFor = (profileName, long) => {
        const profile = profiles[profileName];
        return (long ? profile.multiTimeoutSeconds : profile.dataTimeoutSeconds) * 1000;
    };

    // Runs a procedure on `parent` (the pool, or a transaction). What the procedure PRINTs is kept,
    // also when it fails (err.messages), because the procedures that swallow errors print them.
    const executeProcedure = async (parent, pool, profileName, procedureName, params, long) => {
        const meta = await describeProcedure(pool, profileName, procedureName);
        const inputs = bindParameters(meta, params);

        const request = parent.request({ requestTimeout: timeoutFor(profileName, long) });
        const messages = [];
        request.on('info', (info) => messages.push(info.message));
        for (const input of inputs) request.input(input.name, input.type, input.value);

        try {
            const result = await request.execute(procedureName);
            return { recordsets: result.recordsets || [], messages, returnValue: result.returnValue };
        } catch (err) {
            if (messages.length > 0 && err && typeof err === 'object') err.messages = messages;
            throw err;
        }
    };

    // mapSqlError makes a new error; what the caller attached to the original (what the procedure
    // printed, and the Save step it belongs to) must survive that.
    const keepMessages = (original, mapped) => {
        if (original && mapped && typeof mapped === 'object' && original !== mapped) {
            if (original.messages) mapped.messages = original.messages;
            if (original.stepId) mapped.stepId = original.stepId;
        }
        return mapped;
    };

    const callProcedure = async (profileName, procedureName, params = {}, { multi = false } = {}) => {
        try {
            const pool = await registry.get(profileName);
            return await executeProcedure(pool, pool, profileName, procedureName, params, multi);
        } catch (err) {
            throw keepMessages(err, mapSqlError(err, log));
        }
    };

    // Finds the procedure and checks the parameters, without running anything.
    const checkCall = async (profileName, procedureName, params = {}) => {
        try {
            const pool = await registry.get(profileName);
            bindParameters(await describeProcedure(pool, profileName, procedureName), params);
            return true;
        } catch (err) {
            throw mapSqlError(err, log);
        }
    };

    // A table's columns from the catalog (cached), or null when there is no such table.
    const describeTable = async (profileName, tableName) => {
        try {
            const pool = await registry.get(profileName);
            return await tables.describe(pool, sql, profileName, tableName);
        } catch (err) {
            throw mapSqlError(err, log);
        }
    };

    const runQuery = async (parent, profileName, text, inputs, seconds) => {
        const request = parent.request({ requestTimeout: seconds * 1000 });
        for (const input of inputs) request.input(input.name, typeFor(sql, input.meta), input.value);
        const result = await request.query(text);
        return { recordsets: result.recordsets || (result.recordset ? [result.recordset] : []) };
    };

    // Runs SQL text built by the table service. The text holds only catalog identifiers and
    // @placeholders; every value is an input: { name, meta, value }, typed from its column.
    const query = async (profileName, text, inputs = [], { timeoutSeconds } = {}) => {
        try {
            const pool = await registry.get(profileName);
            return await runQuery(pool, profileName, text, inputs, timeoutSeconds || profiles[profileName].dataTimeoutSeconds);
        } catch (err) {
            throw mapSqlError(err, log);
        }
    };

    // prepared: { schema, name, columns: [column meta from the catalog], rows: [[value, ...]] } with every
    // value already converted to its column's type. A bulk load goes straight into the table.
    const runBulk = async (parent, profileName, prepared) => {
        const table = new sql.Table(`${prepared.schema}.${prepared.name}`);
        table.create = false;
        for (const column of prepared.columns) table.columns.add(column.name, typeFor(sql, column), { nullable: column.nullable });
        for (const row of prepared.rows) table.rows.add(...row);
        await parent.request({ requestTimeout: timeoutFor(profileName, true) }).bulk(table);
        return { rows: prepared.rows.length };
    };

    const bulkInsert = async (profileName, prepared) => {
        try {
            const pool = await registry.get(profileName);
            return await runBulk(pool, profileName, prepared);
        } catch (err) {
            throw mapSqlError(err, log);
        }
    };

    // Runs `work(tx)` in one database transaction on one connection: commit when it returns,
    // roll back when it throws. Keep the work short.
    const transaction = async (profileName, work) => {
        let tx;
        try {
            const pool = await registry.get(profileName);
            tx = new sql.Transaction(pool);
            await tx.begin();
            const runner = {
                query: (text, inputs = []) => runQuery(tx, profileName, text, inputs, profiles[profileName].dataTimeoutSeconds),
                callProcedure: (procedureName, params = {}, { multi = false } = {}) =>
                    executeProcedure(tx, pool, profileName, procedureName, params, multi),
                bulkInsert: (prepared) => runBulk(tx, profileName, prepared)
            };
            const outcome = await work(runner);
            await tx.commit();
            return outcome;
        } catch (err) {
            if (tx) {
                try {
                    await tx.rollback();
                } catch {
                    // the transaction had already ended (the server undid it, or it never began)
                }
            }
            throw keepMessages(err, mapSqlError(err, log));
        }
    };

    const ping = async (profileName) => {
        try {
            const pool = await registry.get(profileName);
            await pool.request({ requestTimeout: 10000 }).query('SELECT 1 AS ok');
            return true;
        } catch (err) {
            throw mapSqlError(err, log);
        }
    };

    return { callProcedure, checkCall, describeTable, query, bulkInsert, transaction, ping, close: () => registry.closeAll() };
};
