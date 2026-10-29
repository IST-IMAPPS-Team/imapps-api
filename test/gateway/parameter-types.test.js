const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sql = require('mssql');

const { typeFor, convertValue } = require('../../src/gateway/db/parameter-types');
const { ApiError } = require('../../src/api/errors');

const meta = (typeName, extra = {}) => ({ name: 'P', typeName, maxLength: 0, precision: 0, scale: 0, ...extra });
const refuses = (m, value, pattern) => assert.throws(
    () => convertValue(m, value),
    (e) => e instanceof ApiError && e.status === 400 && e.code === 'bad_request' && pattern.test(e.message) && !/SENTINEL/.test(e.message),
    `${m.typeName} ${JSON.stringify(value)}`
);

describe('typing a parameter from its catalog entry', () => {
    it('picks the SQL type, with the declared length', () => {
        assert.equal(typeFor(sql, meta('varchar', { maxLength: 20 })).type.declaration, 'varchar');
        assert.equal(typeFor(sql, meta('varchar', { maxLength: 20 })).length, 20);
        assert.equal(typeFor(sql, meta('nvarchar', { maxLength: 100 })).length, 50); // bytes -> characters
        assert.equal(typeFor(sql, meta('nvarchar', { maxLength: -1 })).length, sql.MAX);
        assert.equal(typeFor(sql, meta('decimal', { precision: 18, scale: 5 })).scale, 5);
        assert.equal(typeFor(sql, meta('bit')), sql.Bit);
        assert.equal(typeFor(sql, meta('uniqueidentifier')), sql.UniqueIdentifier);
    });

    it('refuses types this API does not support', () => {
        for (const type of ['sql_variant', 'geography', 'hierarchyid', 'timestamp', null]) {
            assert.throws(() => typeFor(sql, meta(type)), (e) => e.status === 400 && /not supported/.test(e.message));
        }
    });
});

describe('converting a JSON value for a parameter', () => {
    it('null is always allowed', () => {
        for (const type of ['int', 'varchar', 'datetime', 'bit', 'uniqueidentifier']) assert.equal(convertValue(meta(type), null), null);
    });

    it('bit: true/false, 1/0 and their text', () => {
        for (const v of [true, 1, '1', 'true', 'TRUE']) assert.equal(convertValue(meta('bit'), v), true, String(v));
        for (const v of [false, 0, '0', 'false']) assert.equal(convertValue(meta('bit'), v), false, String(v));
        refuses(meta('bit'), 'yes', /true or false/);
        refuses(meta('bit'), 2, /true or false/);
    });

    it('integers: numbers or digit text, within the type range', () => {
        assert.equal(convertValue(meta('int'), '42'), 42);
        assert.equal(convertValue(meta('int'), -7), -7);
        assert.equal(convertValue(meta('tinyint'), 255), 255);
        refuses(meta('tinyint'), 256, /0 to 255/);
        refuses(meta('smallint'), 40000, /whole number/);
        refuses(meta('int'), 1.5, /whole number/);
        refuses(meta('int'), '12abc', /whole number/);
        refuses(meta('int'), true, /whole number/);
    });

    it('bigint goes out as a BigInt and refuses values beyond the safe range', () => {
        assert.equal(convertValue(meta('bigint'), '123'), 123n);
        refuses(meta('bigint'), 1e20, /whole number/);
    });

    it('decimal, money and float accept numbers and numeric text', () => {
        assert.equal(convertValue(meta('decimal', { precision: 18, scale: 2 }), '12.50'), 12.5);
        assert.equal(convertValue(meta('float'), 3.25), 3.25);
        assert.equal(convertValue(meta('money'), '-1e2'), -100);
        refuses(meta('float'), 'abc', /a number/);
        refuses(meta('float'), Infinity, /a number/);
    });

    it('text: refuses a value longer than the parameter, naming the limit but not the value', () => {
        const m = meta('varchar', { maxLength: 20, name: 'MfgLoc' });
        assert.equal(convertValue(m, 'A'.repeat(20)), 'A'.repeat(20));
        assert.throws(
            () => convertValue(m, 'SENTINEL'.repeat(5)),
            (e) => e.status === 400 && /@MfgLoc: longer than the 20 characters/.test(e.message) && !/SENTINEL/.test(e.message)
        );
        assert.equal(convertValue(meta('nvarchar', { maxLength: 100 }), 'x'.repeat(50)).length, 50);
        refuses(meta('nvarchar', { maxLength: 100 }), 'x'.repeat(51), /50 characters/);
        assert.equal(convertValue(meta('varchar', { maxLength: -1 }), 'x'.repeat(100000)).length, 100000);
        assert.equal(convertValue(meta('varchar', { maxLength: 10 }), 5), '5');
        refuses(meta('varchar', { maxLength: 10 }), { a: 1 }, /expected text/);
    });

    it('dates are read as the database clock: date text with no time zone', () => {
        const d = convertValue(meta('datetime'), '2026-10-23T08:15:30');
        assert.equal(d.toISOString(), '2026-10-23T08:15:30.000Z'); // held as UTC so the driver sends 08:15:30
        assert.equal(convertValue(meta('datetime'), '2026-10-23 08:15').toISOString(), '2026-10-23T08:15:00.000Z');
        assert.equal(convertValue(meta('date'), '2026-10-23').toISOString(), '2026-10-23T00:00:00.000Z');
        assert.equal(convertValue(meta('datetime2'), '2026-10-23T08:00:00.1234567').getUTCMilliseconds(), 123);
        refuses(meta('datetime'), '2026-10-23T08:00:00Z', /no time zone/);
        refuses(meta('datetime'), '23/10/2026', /no time zone/);
        refuses(meta('datetime'), '2026-02-30', /real date/);
        refuses(meta('datetime'), '2026-10-23T25:00:00', /real date/);
        refuses(meta('datetime'), '1700-01-01', /1753/);
        refuses(meta('smalldatetime'), '2100-01-01', /1900 to 2079/);
        refuses(meta('datetime'), 20261023, /no time zone/);
    });

    it('time and datetimeoffset', () => {
        assert.equal(convertValue(meta('time'), '08:30').toISOString(), '1970-01-01T08:30:00.000Z');
        refuses(meta('time'), '25:00', /time text/);
        const o = convertValue(meta('datetimeoffset'), '2026-10-23T08:00:00+08:00');
        assert.equal(o.toISOString(), '2026-10-23T00:00:00.000Z');
        refuses(meta('datetimeoffset'), '2026-10-23T08:00:00', /offset/);
    });

    it('uniqueidentifier and binary', () => {
        const guid = '6F9619FF-8B86-D011-B42D-00C04FC964FF';
        assert.equal(convertValue(meta('uniqueidentifier'), guid), guid);
        refuses(meta('uniqueidentifier'), 'not-a-guid', /GUID/);
        assert.deepEqual(convertValue(meta('varbinary', { maxLength: 10 }), 'aGk='), Buffer.from('hi'));
        refuses(meta('varbinary', { maxLength: 1 }), 'aGk=', /1 bytes/);
        refuses(meta('varbinary', { maxLength: -1 }), '!!!', /base64/);
    });
});
