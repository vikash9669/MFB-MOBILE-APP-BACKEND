// Brings a database up to the schema this code expects, at boot.
//
// The problem it solves: the app is deployed against a restore of the legacy
// PHP database, which has none of the delivery tables and none of the columns
// added since. Previously that meant running six SQL files by hand in the right
// order, and the cost of forgetting one was a feature that silently did nothing
// — the readiness probes are deliberately quiet, so a missing table looks
// exactly like a disabled feature.
//
// WHAT IT WILL AND WILL NOT DO
//
// Additive only. It creates tables that are absent and adds columns that are
// absent. It never drops, renames, retypes or deletes anything, so it is safe
// to leave switched on against production: the worst case is that it finds
// nothing to do. Anything destructive stays a hand-run migration.
//
// It is not a substitute for reviewing what changed — it is a substitute for
// remembering to run it.
const { TABLES, COLUMNS } = require("./definitions");

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : String(v).toLowerCase() === "true");

/** Set AUTO_MIGRATE=false to inspect a database without letting boot change it. */
const enabled = () => bool(process.env.AUTO_MIGRATE, true);

const existingTables = async (sequelize) => {
  const [rows] = await sequelize.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
  );
  return new Set(rows.map((r) => r.t || r.TABLE_NAME));
};

const existingColumns = async (sequelize, tables) => {
  if (tables.length === 0) return new Set();
  const list = tables.map((t) => `'${t}'`).join(",");
  const [rows] = await sequelize.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${list})`
  );
  return new Set(rows.map((r) => `${r.t || r.TABLE_NAME}.${r.c || r.COLUMN_NAME}`));
};

/**
 * Reports what is missing without changing anything.
 *
 * Separate from applying it so the same check can answer "is this database up
 * to date?" — used by the boot log, and by `npm run schema:check`.
 */
async function pending(sequelize) {
  const tables = await existingTables(sequelize);
  const missingTables = TABLES.filter((t) => !tables.has(t.name));

  // Only ask about columns on tables that actually exist. A column destined for
  // a table this run is about to create is not "missing" — it arrives with it.
  const targets = [...new Set(COLUMNS.map((c) => c.table))].filter((t) => tables.has(t));
  const columns = await existingColumns(sequelize, targets);
  const missingColumns = COLUMNS.filter(
    (c) => tables.has(c.table) && !columns.has(`${c.table}.${c.column}`)
  );

  return { missingTables, missingColumns };
}

/**
 * Applies whatever is missing. Returns a summary; never throws for a single
 * failed statement — one bad column must not stop the rest, and must not stop
 * the server from starting.
 */
async function ensureSchema(sequelize) {
  if (!enabled()) {
    const { missingTables, missingColumns } = await pending(sequelize);
    const behind = missingTables.length + missingColumns.length;
    console.log(
      behind
        ? `MFB ~ schema: ${behind} object(s) missing and AUTO_MIGRATE=false — not applying. Run npm run schema:apply.`
        : "MFB ~ schema: up to date (AUTO_MIGRATE=false)"
    );
    return { applied: 0, skipped: behind, failed: 0 };
  }

  const { missingTables, missingColumns } = await pending(sequelize);
  if (missingTables.length === 0 && missingColumns.length === 0) {
    return { applied: 0, skipped: 0, failed: 0 };
  }

  console.log(
    `MFB ~ schema: applying ${missingTables.length} table(s) and ` +
      `${missingColumns.length} column(s)`
  );

  let applied = 0;
  const failures = [];

  for (const t of missingTables) {
    try {
      await sequelize.query(t.ddl);
      applied += 1;
      console.log(`   + table ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}: ${err.message}`);
    }
  }

  for (const c of missingColumns) {
    try {
      await sequelize.query(c.sql);
      applied += 1;
      console.log(`   + column ${c.table}.${c.column}`);
    } catch (err) {
      // Duplicate column means something else added it between the check and
      // now — two instances booting together. That is success, not failure.
      if (/duplicate column/i.test(err.message)) {
        console.log(`   = column ${c.table}.${c.column} (already added concurrently)`);
        continue;
      }
      failures.push(`${c.table}.${c.column}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.log(`MFB-error-logs ~ schema: ${failures.length} statement(s) failed:`);
    failures.forEach((f) => console.log(`   ! ${f}`));
  }
  console.log(`MFB ~ schema: ${applied} applied, ${failures.length} failed`);
  return { applied, skipped: 0, failed: failures.length };
}

module.exports = { ensureSchema, pending, enabled };
