// Reads a table's (or view's) columns from the database catalog and keeps them for a few minutes.
// Every table and column name used in SQL later comes from here, never from the request.
// Written for SQL Server 2014. System objects (is_ms_shipped) are left out.
const DESCRIBE = `
SELECT SCHEMA_NAME(o.schema_id) AS schema_name, o.name AS table_name, o.type AS object_type,
       CASE WHEN EXISTS (SELECT 1 FROM sys.triggers tr WHERE tr.parent_id = o.object_id AND tr.is_disabled = 0) THEN 1 ELSE 0 END AS has_triggers,
       c.name AS column_name, t.name AS type_name, c.max_length, c.precision, c.scale,
       c.is_nullable, c.is_identity, c.is_computed
FROM sys.objects o
JOIN sys.columns c ON c.object_id = o.object_id
LEFT JOIN sys.types t ON t.user_type_id = c.system_type_id
WHERE o.object_id = OBJECT_ID(@name) AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
ORDER BY c.column_id`;

exports.createTableCatalog = ({ ttlMs = 5 * 60 * 1000, now = Date.now } = {}) => {
    const cache = new Map();

    // Returns { schema, name, isView, hasTriggers, columns, byLower } or null when there is no such
    // table (or the login can not see it). "Not found" is not cached.
    const describe = async (pool, sql, profileName, tableName) => {
        const key = `${profileName}|${tableName.toLowerCase()}`;
        const hit = cache.get(key);
        if (hit && hit.expires > now()) return hit.value;

        const result = await pool.request().input('name', sql.NVarChar(776), tableName).query(DESCRIBE);
        const rows = result.recordset || [];
        if (rows.length === 0) {
            cache.delete(key);
            return null;
        }

        const columns = rows.map((row) => ({
            kind: 'column',
            name: row.column_name,
            typeName: row.type_name ? String(row.type_name).toLowerCase() : null,
            maxLength: row.max_length,
            precision: row.precision,
            scale: row.scale,
            nullable: Boolean(row.is_nullable),
            identity: Boolean(row.is_identity),
            computed: Boolean(row.is_computed)
        }));
        const value = {
            schema: rows[0].schema_name,
            name: rows[0].table_name,
            isView: String(rows[0].object_type).trim() === 'V',
            hasTriggers: Boolean(rows[0].has_triggers),
            columns,
            byLower: new Map(columns.map((c) => [c.name.toLowerCase(), c]))
        };
        cache.set(key, { value, expires: now() + ttlMs });
        return value;
    };

    return { describe, clear: () => cache.clear() };
};
