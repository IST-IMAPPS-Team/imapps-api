// Identifiers for SQL text. They only ever come from the database catalog or from names fixed in
// the code, never from a request, and are still quoted as [name] (a "]" inside is doubled).
exports.quote = (name) => `[${String(name).replace(/]/g, ']]')}]`;
exports.qualified = (table) => `${exports.quote(table.schema)}.${exports.quote(table.name)}`;
