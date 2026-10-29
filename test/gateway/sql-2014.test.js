const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The database is SQL Server 2014. These need 2016 or later, so no SQL text in src/ may use them.
const FORBIDDEN = [
    /STRING_SPLIT/i, /STRING_AGG/i, /OPENJSON/i, /JSON_VALUE/i, /JSON_QUERY/i, /JSON_MODIFY/i, /FOR\s+JSON/i,
    /CREATE\s+OR\s+ALTER/i, /DROP\s+\w+\s+IF\s+EXISTS/i, /CONCAT_WS/i, /(?<![.\w])TRIM\s*\(/i, /(?<![.\w])TRANSLATE\s*\(/i
];

const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
});

describe('SQL Server 2014', () => {
    it('no file in src/ uses a function or statement that needs a newer SQL Server', () => {
        const files = listJs(path.join(__dirname, '..', '..', 'src'));
        assert.ok(files.length > 5);
        const hits = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            for (const pattern of FORBIDDEN) if (pattern.test(text)) hits.push(`${path.relative(process.cwd(), file)}: ${pattern}`);
        }
        assert.deepEqual(hits, []);
    });
});
