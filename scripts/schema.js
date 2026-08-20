// Inspect or apply the schema without starting the server.
//
//   npm run schema:check   what is missing, changes nothing
//   npm run schema:apply   apply it
//
// The same code path the server runs at boot, so a green check here means a
// green boot there.
const sequelize = require("../util/database");
const { ensureSchema, pending } = require("../util/schema");

const apply = process.argv.includes("--apply");

(async () => {
  try {
    await sequelize.authenticate();
    console.log(`connected to ${process.env.DB_NAME} at ${process.env.DB_HOST}:${process.env.DB_PORT}`);

    const { missingTables, missingColumns } = await pending(sequelize);
    console.log(`missing: ${missingTables.length} table(s), ${missingColumns.length} column(s)`);
    missingTables.forEach((t) => console.log(`   - table  ${t.name}`));
    missingColumns.forEach((c) => console.log(`   - column ${c.table}.${c.column}`));

    if (!apply) {
      console.log(missingTables.length + missingColumns.length ? "\nrun with --apply to fix" : "\nup to date");
      process.exitCode = missingTables.length + missingColumns.length ? 1 : 0;
    } else {
      // Force it on for the explicit apply command, whatever AUTO_MIGRATE says.
      process.env.AUTO_MIGRATE = "true";
      const r = await ensureSchema(sequelize);
      process.exitCode = r.failed ? 1 : 0;
    }
  } catch (err) {
    console.log("schema command failed:", err.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
