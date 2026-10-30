const { ApiError } = require('../../api/errors');
const { createPoolRegistry } = require('./pool-registry');
const { createProcedureCatalog } = require('./proc-catalog');
const { createTableCatalog } = require('./table-catalog');
const { typeFor, convertValue } = require('./parameter-types');
const { mapSqlError } = require('./sql-errors');

// THE one place that talks to SQL Server. Everything else asks this object, so tests can
// swap in a fake with the same methods (see test/helpers/fake-database.js).
//   callProcedure(profile, procedure, params, { multi }) -> { recordsets, messages, returnValue }
//   describeTable(profile, table) -> { schema, name, columns, ... } or null
//   query(profile, sqlText, inputs) -> { recordsets }
//   transaction(profile, async (tx) => result)   tx.query(sqlText, inputs); commits, or rolls back if it throws
//   ping(profile) -> true
//   close()
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

    const callProcedure = async (profileName, procedureName, params = {}, { multi = false } = {}) => {
        try {
            const pool = await registry.get(profileName);
            const meta = await catalog.describe(pool, sql, profileName, procedureName);
            if (!meta) throw new ApiError(404, 'not_found', 'No such procedure.');
            const inputs = bindParameters(meta, params);

            const profile = profiles[profileName];
            const seconds = multi ? profile.multiTimeoutSeconds : profile.dataTimeoutSeconds;
            const request = pool.request({ requestTimeout: seconds * 1000 });
            const messages = [];
            request.on('info', (info) => messages.push(info.message));
            for (const input of inputs) request.input(input.name, input.type, input.value);

            const result = await request.execute(procedureName);
            return { recordsets: result.recordsets || [], messages, returnValue: result.returnValue };
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

    // Runs SQL text built by the table service. The text holds only catalog identifiers and
    // @placeholders; every value is an input: { name, meta, value }, typed from its column.
    const query = async (profileName, text, inputs = [], { timeoutSeconds } = {}) => {
        try {
            const pool = await registry.get(profileName);
            const seconds = timeoutSeconds || profiles[profileName].dataTimeoutSeconds;
            const request = pool.request({ requestTimeout: seconds * 1000 });
            for (const input of inputs) request.input(input.name, typeFor(sql, input.meta), input.value);
            const result = await request.query(text);
            return { recordsets: result.recordsets || (result.recordset ? [result.recordset] : []) };
        } catch (err) {
            throw mapSqlError(err, log);
        }
    };

    // Runs `work(tx)` in one database transaction on one connection: commit when it returns,
    // roll back when it throws. tx.query(text, inputs) is like query() above. Keep the work short.
    const transaction = async (profileName, work) => {
        let tx;
        try {
            const pool = await registry.get(profileName);
            const timeoutMs = profiles[profileName].dataTimeoutSeconds * 1000;
            tx = new sql.Transaction(pool);
            await tx.begin();
            const runner = {
                query: async (text, inputs = []) => {
                    const request = tx.request({ requestTimeout: timeoutMs });
                    for (const input of inputs) request.input(input.name, typeFor(sql, input.meta), input.value);
                    const result = await request.query(text);
                    return { recordsets: result.recordsets || (result.recordset ? [result.recordset] : []) };
                }
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
            throw mapSqlError(err, log);
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

    return { callProcedure, describeTable, query, transaction, ping, close: () => registry.closeAll() };
};
