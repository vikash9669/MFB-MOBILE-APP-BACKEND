const test = require("node:test");
const assert = require("node:assert");

const { ensureSchema, pending } = require("../util/schema");
const { TABLES, COLUMNS } = require("../util/schema/definitions");

// The runner, exercised against a fake database.
//
// The definitions are checked elsewhere; this is about the decisions the runner
// makes — what it creates, what it leaves alone, and what it does when a
// statement fails. Those decisions run unattended against production, so
// "it worked on my machine" is not evidence.

/**
 * A minimal stand-in for a Sequelize instance.
 *
 * @param existingTables  table names the fake database already has
 * @param existingColumns "table.column" entries it already has
 * @param failOn          substring; any statement containing it throws
 */
function fakeDb({ tables = [], columns = [], failOn = null } = {}) {
  const executed = [];
  return {
    executed,
    async query(sql) {
      if (/information_schema\.TABLES/i.test(sql)) {
        return [tables.map((t) => ({ t })), {}];
      }
      if (/information_schema\.COLUMNS/i.test(sql)) {
        return [columns.map((c) => ({ t: c.split(".")[0], c: c.split(".")[1] })), {}];
      }
      executed.push(sql);
      if (failOn && sql.includes(failOn)) throw new Error(`boom: ${failOn}`);
      return [[], {}];
    },
  };
}

const withAutoMigrate = async (value, fn) => {
  const prev = process.env.AUTO_MIGRATE;
  if (value === undefined) delete process.env.AUTO_MIGRATE;
  else process.env.AUTO_MIGRATE = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.AUTO_MIGRATE;
    else process.env.AUTO_MIGRATE = prev;
  }
};

test("an empty database gets every table", async () => {
  const db = fakeDb({ tables: [] });
  const r = await withAutoMigrate("true", () => ensureSchema(db));
  assert.equal(r.failed, 0);
  assert.equal(r.applied, TABLES.length, "every table should be created");
  // No column runs: their target tables do not exist yet, so the columns arrive
  // with the CREATE TABLE rather than as ALTERs.
  assert.equal(db.executed.filter((s) => /ADD COLUMN/.test(s)).length, 0);
});

test("a fully migrated database is left completely alone", async () => {
  const db = fakeDb({
    tables: [...TABLES.map((t) => t.name), ...new Set(COLUMNS.map((c) => c.table))],
    columns: COLUMNS.map((c) => `${c.table}.${c.column}`),
  });
  const r = await withAutoMigrate("true", () => ensureSchema(db));
  assert.equal(r.applied, 0);
  assert.equal(db.executed.length, 0, "a healthy database must receive no DDL at all");
});

test("a legacy database gets the columns but not the tables it already has", async () => {
  // The real deployment case: legacy tables present, delivery tables absent.
  const legacyTables = [...new Set(COLUMNS.map((c) => c.table))];
  const db = fakeDb({ tables: legacyTables, columns: [] });
  const r = await withAutoMigrate("true", () => ensureSchema(db));
  assert.equal(r.failed, 0);
  assert.equal(r.applied, TABLES.length + COLUMNS.length);
  const creates = db.executed.filter((s) => /CREATE TABLE/.test(s));
  assert.equal(creates.length, TABLES.length);
  // It must not try to re-create a table the legacy schema already has.
  for (const t of legacyTables) {
    assert.ok(
      !creates.some((s) => new RegExp("CREATE TABLE IF NOT EXISTS `" + t + "`").test(s)),
      `must not attempt to create the existing legacy table ${t}`
    );
  }
});

test("half-migrated is repaired without touching what is already there", async () => {
  // Hand-edited databases are the norm, and are exactly what a version ledger
  // cannot recover from.
  const db = fakeDb({
    tables: [TABLES[0].name, ...new Set(COLUMNS.map((c) => c.table))],
    columns: [`${COLUMNS[0].table}.${COLUMNS[0].column}`],
  });
  const r = await withAutoMigrate("true", () => ensureSchema(db));
  assert.equal(r.applied, TABLES.length - 1 + COLUMNS.length - 1);
  assert.ok(
    !db.executed.some((s) => s.includes(`\`${COLUMNS[0].column}\``)),
    "the column that already exists must not be re-added"
  );
});

test("one failing statement does not stop the rest", async () => {
  // A single bad object must not leave the remaining tables uncreated, and must
  // not stop the server from starting.
  const db = fakeDb({ tables: [], failOn: TABLES[0].name });
  const r = await withAutoMigrate("true", () => ensureSchema(db));
  assert.equal(r.failed, 1);
  assert.equal(r.applied, TABLES.length - 1, "the other tables should still be created");
});

test("a concurrent duplicate column counts as success, not failure", async () => {
  // Two instances booting together: the second loses the race. That is fine —
  // the column exists, which is all that was wanted.
  const db = {
    async query(sql) {
      if (/information_schema\.TABLES/i.test(sql))
        return [[...new Set(COLUMNS.map((c) => c.table))].map((t) => ({ t })), {}];
      if (/information_schema\.COLUMNS/i.test(sql)) return [[], {}];
      if (/CREATE TABLE/.test(sql)) return [[], {}];
      throw new Error("Duplicate column name 'x'");
    },
  };
  const r = await withAutoMigrate("true", () => ensureSchema(db));
  assert.equal(r.failed, 0, "duplicate-column races must not be reported as failures");
});

test("AUTO_MIGRATE=false inspects but never writes", async () => {
  const db = fakeDb({ tables: [] });
  const r = await withAutoMigrate("false", () => ensureSchema(db));
  assert.equal(r.applied, 0);
  assert.ok(r.skipped > 0, "it should report how far behind the database is");
  assert.equal(db.executed.length, 0, "nothing may be executed when disabled");
});

test("pending() reports without changing anything", async () => {
  const db = fakeDb({ tables: [] });
  const p = await pending(db);
  assert.equal(p.missingTables.length, TABLES.length);
  assert.equal(db.executed.length, 0);
});
