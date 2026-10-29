const EventEmitter = require('node:events');
const real = require('mssql');

// A stand-in for the mssql module, so database.js can be tested without a SQL Server.
// It keeps the real type objects (sql.Int, sql.VarChar(50), ...) and fakes the connection side.
//   script.onQuery(text, request)       -> { recordset }
//   script.onExecute(name, request)     -> { recordsets, returnValue }
//   script.messages                     -> PRINT lines emitted as 'info' before execute returns
//   script.connectError                 -> makes pool.connect() reject
exports.createFakeSql = (script = {}) => {
    const state = { pools: [], requests: [], connectCalls: 0 };

    class FakeRequest extends EventEmitter {
        constructor(pool, overrides) {
            super();
            this.pool = pool;
            this.overrides = overrides || {};
            this.inputs = [];
            state.requests.push(this);
        }

        input(name, type, value) {
            this.inputs.push({ name, type, value });
            return this;
        }

        async query(text) {
            this.text = text;
            return script.onQuery(text, this);
        }

        async execute(name) {
            this.procedure = name;
            for (const message of script.messages || []) this.emit('info', { message });
            return script.onExecute(name, this);
        }
    }

    class FakePool extends EventEmitter {
        constructor(config) {
            super();
            this.config = config;
            this.closed = false;
            state.pools.push(this);
        }

        async connect() {
            state.connectCalls += 1;
            if (script.connectError) throw script.connectError;
            return this;
        }

        request(overrides) {
            return new FakeRequest(this, overrides);
        }

        async close() {
            this.closed = true;
        }
    }

    return { sql: { ...real, ConnectionPool: FakePool }, state, script };
};

// Rows as sys.parameters would return them for proc-catalog.js.
// Each entry: [name, type, maxLength, precision, scale]
exports.parameterRows = (list) => (list.length === 0
    ? [{ name: null, type_name: null, max_length: null, precision: null, scale: null }]
    : list.map(([name, type, maxLength = 0, precision = 0, scale = 0]) => ({
        name: '@' + name, type_name: type, max_length: maxLength, precision, scale
    })));

// A recordset like the driver's: an array of rows with a non-enumerable `columns` property.
exports.recordset = (rows, columnTypes = {}) => {
    const set = [...rows];
    const columns = {};
    for (const [name, declaration] of Object.entries(columnTypes)) {
        columns[name] = { name, type: { declaration } };
    }
    Object.defineProperty(set, 'columns', { value: columns, enumerable: false });
    return set;
};
