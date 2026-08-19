// Seeds admin-panel logins for local testing, one per staff role.
//
//   node --env-file=.env scripts/seed-admins.js
//
// SAFETY: refuses to run unless DB_NAME ends in "_dev". These accounts have
// known, weak passwords and full panel access — creating them on a production
// database would be handing out admin credentials. Override only if you are
// certain, with ALLOW_NON_DEV_DB=1.
//
// Rows are matched by phone number and UPDATED in place, because all three
// numbers already exist as customers in the production snapshot. That is fine
// on a replica (re-clone to undo) but it does mean a real customer account
// becomes staff — never replicate this to production.
const { User } = require("../models");
const sequelize = require("../util/database");

// role: 0/1/2 are the roles administration/Index::loginUser let into the panel.
const ADMINS = [
  { phone: "7777777777", password: "Admin@012", role: 0, name: "Admin Level 0" },
  { phone: "8888888888", password: "Admin@123", role: 1, name: "Admin Level 1" },
  { phone: "9999999999", password: "Admin@234", role: 2, name: "Admin Level 2" },
];

async function main() {
  const dbName = process.env.DB_NAME || "";
  if (!dbName.endsWith("_dev") && process.env.ALLOW_NON_DEV_DB !== "1") {
    console.error(
      `Refusing to seed admins into "${dbName}": this script is for *_dev replicas only.\n` +
        "These are known weak passwords with full panel access.\n" +
        "Set ALLOW_NON_DEV_DB=1 only if you are certain."
    );
    process.exit(1);
  }

  console.log(`Seeding admin logins into ${dbName}\n`);

  for (const a of ADMINS) {
    const existing = await User.findOne({ where: { user_phone: a.phone } });

    if (existing) {
      const wasRole = existing.user_role;
      await existing.update({
        user_role: a.role,
        user_password: a.password,
        user_name: existing.user_name || a.name,
        user_status: 1,
        user_active: 1,
      });
      console.log(
        `  ${a.phone}  updated  id=${existing.user_id}  role ${wasRole} -> ${a.role}` +
          (wasRole === 12 ? "  (was a customer)" : "")
      );
    } else {
      const created = await User.create({
        user_role: a.role,
        user_name: a.name,
        user_email: `admin${a.role}@example.com`,
        user_phone: a.phone,
        user_otp: "000000",
        user_code: `ADM${a.role}${a.phone.slice(-4)}`,
        user_manager: 0,
        user_phone_1: a.phone,
        user_landmark: "",
        user_city: "1",
        user_state: 1,
        user_zip: "000000",
        user_password: a.password,
        user_login: 0,
        user_active: 1,
        user_status: 1,
        user_location: 0,
      });
      console.log(`  ${a.phone}  created  id=${created.user_id}  role=${a.role}`);
    }
  }

  console.log("\nSign in at the admin panel with the phone number and password.");
  await sequelize.close();
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
