const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('../apps/web/node_modules/typescript');
const filename = path.resolve(__dirname, '../apps/web/src/lib/format-sql.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { formatSql } = loaded.exports;

test('formats wrapped PostgreSQL query with FILTER and interval literals', () => {
    const sql = `SELECT * FROM (SELECT COUNT(*) AS "total_users", COUNT(*) FILTER (WHERE activated_at IS NOT NULL AND activated_at <= signup_at + INTERVAL '7 days') AS activated_7d_users FROM product_users) AS result LIMIT 1000`;
    const output = formatSql(sql);
    assert.ok(output.split('\n').length > 8);
    assert.match(output, /\n +SELECT/);
    assert.ok(output.includes("'7 days'"));
    assert.ok(output.includes('"total_users"'));
    assert.equal(formatSql(output), output);
});
test('preserves strings and comments containing SQL punctuation', () => {
    const output = formatSql("SELECT 'from, select (x)' AS label -- keep this comment\nFROM product_users");
    assert.ok(output.includes("'from, select (x)'"));
    assert.ok(output.includes('-- keep this comment\n'));
});
test('keeps unsupported SQL visible and handles missing content', () => {
    assert.equal(formatSql("SELECT 'unterminated"), "SELECT 'unterminated");
    assert.equal(formatSql(undefined), '');
});
