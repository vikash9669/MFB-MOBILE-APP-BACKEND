const test = require("node:test");
const assert = require("node:assert");

const { TABLES, COLUMNS } = require("../util/schema/definitions");

// The boot-time schema migration.
//
// This runs automatically against production, so the properties below are not
// stylistic — each one corresponds to a way a deploy can leave a database
// half-built.

test("tables are ordered so every foreign key target already exists", () => {
  // The generated file was alphabetical at first. Six tables reference
  // store_delivery_partners or store_delivery_orders, and MySQL refuses a
  // REFERENCES clause pointing at a table that does not exist yet — so a fresh
  // database got twelve tables and four errors, and nothing said so loudly.
  const names = new Set(TABLES.map((t) => t.name));
  const created = new Set();
  for (const t of TABLES) {
    const refs = [...new Set([...t.ddl.matchAll(/REFERENCES `([^`]+)`/g)].map((m) => m[1]))];
    for (const r of refs) {
      if (!names.has(r) || r === t.name) continue; // legacy table, or self-reference
      assert.ok(
        created.has(r),
        `${t.name} references ${r}, which this migration creates later — reorder it`
      );
    }
    created.add(t.name);
  }
});

test("every statement is additive — nothing destructive may run at boot", () => {
  // The whole reason this is safe to leave switched on. A DROP or MODIFY that
  // slips into the generated file would run unattended against live data.
  const forbidden = /\b(DROP\s+(TABLE|COLUMN|DATABASE)|TRUNCATE|DELETE\s+FROM|MODIFY\s+COLUMN|RENAME|ALTER\s+COLUMN)\b/i;
  for (const t of TABLES) {
    assert.ok(!forbidden.test(t.ddl), `${t.name} DDL contains a destructive statement`);
    assert.match(t.ddl, /^CREATE TABLE IF NOT EXISTS/, `${t.name} must be CREATE TABLE IF NOT EXISTS`);
  }
  for (const c of COLUMNS) {
    assert.ok(!forbidden.test(c.sql), `${c.table}.${c.column} is destructive`);
    assert.match(c.sql, /^ALTER TABLE `[^`]+` ADD COLUMN /, `${c.table}.${c.column} must be ADD COLUMN`);
  }
});

test("no CREATE TABLE carries a hardcoded AUTO_INCREMENT counter", () => {
  // Copied straight from SHOW CREATE TABLE, that would set a fresh table's
  // counter to whatever the dev database happened to be at.
  for (const t of TABLES) {
    assert.ok(!/AUTO_INCREMENT=\d/.test(t.ddl), `${t.name} pins an AUTO_INCREMENT value`);
  }
});

test("table and column entries are unique", () => {
  const t = TABLES.map((x) => x.name);
  assert.equal(new Set(t).size, t.length, "duplicate table entry");
  const c = COLUMNS.map((x) => `${x.table}.${x.column}`);
  assert.equal(new Set(c).size, c.length, "duplicate column entry");
});

test("each column entry's SQL targets the table it claims", () => {
  // A copy-paste slip here adds a column to the wrong table, which ADD COLUMN
  // will happily do.
  for (const c of COLUMNS) {
    assert.ok(
      c.sql.includes(`ALTER TABLE \`${c.table}\``),
      `${c.table}.${c.column}: sql targets a different table`
    );
    assert.ok(
      c.sql.includes(`ADD COLUMN \`${c.column}\``),
      `${c.table}.${c.column}: sql adds a different column`
    );
  }
});

test("the definitions are not empty", () => {
  // A regeneration that silently produced nothing would make the runner a no-op
  // and every deploy would look fine while creating nothing.
  assert.ok(TABLES.length >= 18, `only ${TABLES.length} tables defined`);
  assert.ok(COLUMNS.length >= 14, `only ${COLUMNS.length} columns defined`);
});
