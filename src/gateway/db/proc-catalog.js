// Reads a procedure's parameter list (name, type, length) from the database catalog and keeps it
// for a few minutes, so a call can be checked and typed before it is sent.
// Written for SQL Server 2014: only catalog views that exist there.
const DESCRIBE = `
SELECT p.name, t.name AS type_name, p.max_length, p.precision, p.scale
FROM sys.objects o
LEFT JOIN sys.parameters p ON p.object_id = o.object_id AND p.parameter_id > 0
LEFT JOIN sys.types t ON t.user_type_id = p.system_type_id
WHERE o.object_id = OBJECT_ID(@name) AND o.type IN ('P', 'PC')
ORDER BY p.parameter_id`;

exports.createProcedureCatalog = ({ ttlMs = 5 * 60 * 1000, now = Date.now } = {}) => {
    const cache = new Map();

    // Returns { params: Map(lowercase name without @ -> meta) } or null when there is no such
    // procedure (or the login can not see it). "Not found" is not cached.
    const describe = async (pool, sql, profileName, procedureName) => {
        const key = `${profileName}|${procedureName.toLowerCase()}`;
        const hit = cache.get(key);
        if (hit && hit.expires > now()) return hit.value;

        const result = await pool.request().input('name', sql.NVarChar(776), procedureName).query(DESCRIBE);
        const rows = result.recordset || [];
        if (rows.length === 0) {
            cache.delete(key);
            return null;
        }

        const params = new Map();
        for (const row of rows) {
            if (row.name === null || row.name === undefined) continue; // a procedure with no parameters
            const name = String(row.name).replace(/^@/, '');
            params.set(name.toLowerCase(), {
                name,
                typeName: row.type_name ? String(row.type_name).toLowerCase() : null,
                maxLength: row.max_length,
                precision: row.precision,
                scale: row.scale
            });
        }
        const value = { params };
        cache.set(key, { value, expires: now() + ttlMs });
        return value;
    };

    return { describe, clear: () => cache.clear() };
};
