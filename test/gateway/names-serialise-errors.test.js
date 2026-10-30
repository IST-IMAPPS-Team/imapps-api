const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sql = require('mssql');

const { checkProcedureName } = require('../../src/gateway/guards/names');
const { serialiseRecordsets } = require('../../src/gateway/db/serialise');
const { mapSqlError } = require('../../src/gateway/db/sql-errors');
const { ApiError } = require('../../src/api/errors');
const { recordset } = require('../helpers/fake-sql');

const quietLog = () => ({ errors: [], info() {}, error(line) { this.errors.push(line); } });

describe('procedure name check', () => {
    it('accepts name and schema.name', () => {
        for (const name of ['prdGetBoSP', 'dbo.prdGetBoSP', 'NGP_GetAuthUsers', '_x1']) {
            assert.equal(checkProcedureName(name), name);
        }
    });

    it('refuses anything that could carry SQL or a database prefix', () => {
        const bad = ['', 'a b', 'a;b', "a'b", 'a--b', 'db.dbo.proc', 'a.b.c.d', '1abc', 'a]b', '[dbo].[x]', 'a/b', 'x'.repeat(129), null, 5, {}];
        for (const name of bad) {
            assert.throws(() => checkProcedureName(name), (e) => e instanceof ApiError && e.status === 400 && e.code === 'bad_request', String(name));
        }
    });

    it('blocks prdGetBOBulkCopyConnectString in any case and with a schema prefix (403)', () => {
        for (const name of ['prdGetBOBulkCopyConnectString', 'PRDGETBOBULKCOPYCONNECTSTRING', 'dbo.prdgetbobulkcopyconnectstring']) {
            assert.throws(() => checkProcedureName(name), (e) => e.status === 403 && e.code === 'forbidden', name);
        }
    });
});

describe('system procedures are blocked', () => {
    it('refuses sp_ and xp_ names in any letter case and with any schema, and the sys and INFORMATION_SCHEMA schemas (403)', () => {
        const blocked = [
            'sp_executesql', 'SP_EXECUTESQL', 'sp_who', 'xp_cmdshell', 'XP_CmdShell', 'sp_', 'xp_x',
            'dbo.sp_who', 'dbo.xp_cmdshell', 'sys.sp_executesql', 'sys.anything', 'SYS.Whatever', 'INFORMATION_SCHEMA.proc', 'information_schema.x'
        ];
        for (const name of blocked) {
            assert.throws(
                () => checkProcedureName(name),
                (e) => e instanceof ApiError && e.status === 403 && e.code === 'forbidden' && /System procedures/.test(e.message),
                name
            );
        }
    });

    it('still allows the Planning Board\'s own procedures and names that only contain sp_ or xp_ somewhere inside', () => {
        for (const name of ['prdGetBoSP', 'plnUpdBOOutputV4', 'NGP_GetAuthUsers', 'dbo.prdSaveBulkSP', 'spGetData', 'sp1', 'my_sp_proc', 'prdSp_x', 'xpander', 'dbo.xp', 'syslog_proc', 'dbo.sys_report']) {
            assert.equal(checkProcedureName(name), name);
        }
    });

    it('the previous block on prdGetBOBulkCopyConnectString keeps its own message', () => {
        assert.throws(() => checkProcedureName('prdGetBOBulkCopyConnectString'), (e) => e.status === 403 && /This procedure is not available/.test(e.message));
    });
});

describe('serialising database values', () => {
    it('writes datetimes as local text with no zone and no Z', () => {
        const rows = serialiseRecordsets([recordset([{
            A: new Date(Date.UTC(2026, 9, 23, 8, 0, 0)),
            B: new Date(Date.UTC(2026, 9, 23, 8, 0, 0, 120)),
            C: new Date(Date.UTC(2026, 0, 5, 0, 0, 0, 7)),
            D: new Date(Date.UTC(2026, 9, 23))
        }], { A: 'datetime', B: 'datetime2', C: 'datetime2', D: 'date' })]);
        assert.deepEqual(rows[0][0], {
            A: '2026-10-23T08:00:00',
            B: '2026-10-23T08:00:00.12',
            C: '2026-01-05T00:00:00.007',
            D: '2026-10-23T00:00:00'
        });
    });

    it('writes time columns as time text and datetimeoffset with its UTC instant', () => {
        const rows = serialiseRecordsets([recordset([{
            T: new Date(Date.UTC(1970, 0, 1, 8, 30, 15)),
            O: new Date(Date.UTC(2026, 9, 23, 0, 0, 0))
        }], { T: 'time', O: 'datetimeoffset' })]);
        assert.deepEqual(rows[0][0], { T: '08:30:15', O: '2026-10-23T00:00:00.000Z' });
    });

    it('keeps column names, numbers, booleans, text and null; big integers, GUIDs and binary become text', () => {
        const rows = serialiseRecordsets([recordset([{
            COLORDESC: 'Red', BALQTY: 12.5, Flag: true, Nothing: null,
            Big: 9007199254740993n, Id: '6F9619FF-8B86-D011-B42D-00C04FC964FF', Bin: Buffer.from('hi')
        }], { Id: 'uniqueidentifier' })]);
        assert.deepEqual(rows[0][0], {
            COLORDESC: 'Red', BALQTY: 12.5, Flag: true, Nothing: null,
            Big: '9007199254740993', Id: '6f9619ff-8b86-d011-b42d-00c04fc964ff', Bin: 'aGk='
        });
    });

    it('serialises every result set and survives sets with no columns metadata', () => {
        const plain = [{ X: 1 }];
        const out = serialiseRecordsets([plain, recordset([])]);
        assert.deepEqual(out, [[{ X: 1 }], []]);
        assert.deepEqual(serialiseRecordsets(undefined), []);
        assert.doesNotThrow(() => JSON.stringify(out));
    });
});

describe('mapping SQL Server errors', () => {
    const requestError = (number, severity, message, code = 'EREQUEST') => {
        const base = new Error(message);
        base.info = { number, class: severity };
        return new sql.RequestError(base, code);
    };

    it('duplicate keys and constraints are 409 conflict', () => {
        for (const number of [2627, 2601, 547, 1205]) {
            const e = mapSqlError(requestError(number, 14, 'Violation of PRIMARY KEY ... value (SENTINEL)'), quietLog());
            assert.equal(e.status, 409, String(number));
            assert.equal(e.code, 'conflict');
            assert.doesNotMatch(e.message, /SENTINEL/);
        }
    });

    it('permission denied is 403 and keeps the SQL message so the grant can be fixed', () => {
        const e = mapSqlError(requestError(229, 14, "The EXECUTE permission was denied on the object 'prdX'."), quietLog());
        assert.equal(e.status, 403);
        assert.equal(e.code, 'forbidden');
        assert.match(e.message, /prdX/);
    });

    it('errors raised by a procedure (class 11 to 16) are 400 sql_error with the SQL message', () => {
        const e = mapSqlError(requestError(50000, 16, 'Batch 12 is locked by another user.'), quietLog());
        assert.deepEqual([e.status, e.code, e.message], [400, 'sql_error', 'Batch 12 is locked by another user.']);
    });

    it('could not find the procedure is 404; lock timeout is 504', () => {
        assert.equal(mapSqlError(requestError(2812, 16, 'Could not find stored procedure'), quietLog()).status, 404);
        assert.equal(mapSqlError(requestError(1222, 16, 'Lock request time out period exceeded'), quietLog()).code, 'timeout');
    });

    it('a request that runs too long is 504 timeout', () => {
        const e = mapSqlError(new sql.RequestError('Timeout: Request failed to complete in 300000ms', 'ETIMEOUT'), quietLog());
        assert.deepEqual([e.status, e.code], [504, 'timeout']);
    });

    it('connection and login problems are 503 db_unavailable with generic text; the detail is only logged', () => {
        const log = quietLog();
        for (const err of [
            new sql.ConnectionError("Login failed for user 'sql_login'.", 'ELOGIN'),
            new sql.ConnectionError('Failed to connect to db.test:1433 in 15000ms', 'ETIMEOUT'),
            new sql.RequestError('Connection lost', 'ECONNCLOSED')
        ]) {
            const e = mapSqlError(err, log);
            assert.deepEqual([e.status, e.code, e.message], [503, 'db_unavailable', 'The database can not be reached.']);
        }
        assert.equal(log.errors.length, 3);
        assert.match(log.errors[0], /Login failed/);
    });

    it('no free connection in time (the pool library\'s TimeoutError) is 503, logged', () => {
        const log = quietLog();
        const err = Object.assign(new Error('operation timed out for an unknown reason'), { name: 'TimeoutError' });
        const e = mapSqlError(err, log);
        assert.deepEqual([e.status, e.code, e.message], [503, 'db_unavailable', 'All database connections are busy. Try again.']);
        assert.match(log.errors[0], /no free connection/);
    });

    it('a value the driver can not send is 400 bad_request', () => {
        const e = mapSqlError(new sql.RequestError('Validation failed for parameter', 'EPARAM'), quietLog());
        assert.deepEqual([e.status, e.code], [400, 'bad_request']);
    });

    it('severe or unknown SQL errors are a generic 500, logged', () => {
        const log = quietLog();
        const e = mapSqlError(requestError(824, 24, 'SENTINEL internal detail'), log);
        assert.deepEqual([e.status, e.code, e.message], [500, 'internal', 'An unexpected error occurred.']);
        assert.match(log.errors[0], /SENTINEL/);
    });

    it('leaves ApiErrors and non-database errors unchanged', () => {
        const api = new ApiError(404, 'not_found', 'x');
        assert.equal(mapSqlError(api, quietLog()), api);
        const other = new TypeError('boom');
        assert.equal(mapSqlError(other, quietLog()), other);
    });
});
