const test = require("node:test");
const assert = require("node:assert");

const DeliveryPartner = require("../models/delivery_partner");

// A delivery partner is a store_users row, and store_users was designed for the
// PHP panel: eleven of its columns are NOT NULL with no default and mean
// nothing to a rider. The tests below all guard the same failure, which is
// invisible at every layer above the database:
//
//   Sequelize builds its INSERT from DECLARED attributes only. A value set on
//   a name the model does not declare — `partner.setDataValue("user_password",
//   …)` when the attribute list has no `user_password` — is dropped without an
//   error. This MariaDB's sql_mode has neither STRICT_TRANS_TABLES nor
//   STRICT_ALL_TABLES, so the short INSERT then SUCCEEDED and wrote '' into
//   all eleven, including the password column the panel authenticates against.
//
// Nothing threw, no test failed, and the row looked fine until you read it.

// The eleven columns, as store_users actually declares them.
const REQUIRED = [
  "user_name",
  "user_phone_1",
  "user_email",
  "user_password",
  "user_landmark",
  "user_state",
  "user_city",
  "user_zip",
  "user_location",
  "user_otp",
  "user_code",
];

// attribute name -> column name, for everything the model declares.
const columnOf = (attr) => {
  const def = DeliveryPartner.rawAttributes[attr];
  return def && (def.field || attr);
};
const columns = () => Object.keys(DeliveryPartner.rawAttributes).map(columnOf);

test("every NOT NULL store_users column is declared, so the INSERT supplies it", () => {
  const have = new Set(columns());
  const missing = REQUIRED.filter((c) => !have.has(c));
  assert.deepStrictEqual(
    missing,
    [],
    `undeclared NOT NULL column(s): ${missing.join(", ")} — the INSERT will omit them`
  );
});

test("the beforeCreate hook writes only attributes the model declares", async () => {
  const partner = DeliveryPartner.build({
    dp_phone: "9876543210",
    dp_name: "",
    dp_email: "",
  });
  await DeliveryPartner.runHooks("beforeCreate", partner);

  // Phone-derived values reach the instance under their ATTRIBUTE names. The
  // original hook set "user_name"/"user_email" — the column names — which are
  // not aliases for dp_name/dp_email and went nowhere.
  assert.strictEqual(partner.getDataValue("dp_name"), "Rider 3210");
  assert.strictEqual(partner.getDataValue("dp_email"), "dp9876543210@example.com");
  assert.strictEqual(partner.getDataValue("user_phone_1"), "9876543210");
});

test("a new partner never gets a blank password", () => {
  // store_users is what the PHP panel authenticates against. A blank password
  // is not an inert placeholder there — it is a row anyone can sign in as.
  const a = DeliveryPartner.build({ dp_phone: "9876543210" });
  const b = DeliveryPartner.build({ dp_phone: "9876543211" });

  for (const p of [a, b]) {
    const pw = p.getDataValue("user_password");
    assert.ok(pw, "user_password is blank");
    assert.match(pw, /^[0-9a-f]{32}$/, "user_password is not random hex");
  }
  assert.notStrictEqual(
    a.getDataValue("user_password"),
    b.getDataValue("user_password"),
    "two partners share a password — the default is a constant, not per-row"
  );
});

test("a build supplies every NOT NULL column without the hook running", () => {
  // Defaults are applied by Model.build, so they hold on paths a beforeCreate
  // hook does not reach. Only the phone-derived three are the hook's job.
  const partner = DeliveryPartner.build({ dp_phone: "9876543210" });
  const hookFills = new Set(["user_name", "user_email", "user_phone_1"]);
  for (const col of REQUIRED) {
    if (hookFills.has(col)) continue;
    const attr = Object.keys(DeliveryPartner.rawAttributes).find((a) => columnOf(a) === col);
    const v = partner.getDataValue(attr);
    assert.ok(v !== undefined && v !== null, `${col} has no value before INSERT`);
  }
});

test("dp_photo is not mapped onto user_image", () => {
  // user_image is varchar(100) — the legacy panel keeps a filename there.
  // dp_photo holds a base64 selfie, which that column truncated to 100
  // characters silently, leaving a corrupt image and an onboarding gate that
  // still saw "a photo is present".
  assert.strictEqual(
    columnOf("dp_photo"),
    "dp_photo",
    "dp_photo maps onto a varchar column that will truncate a base64 image"
  );
});

test("declared string widths do not exceed the real store_users columns", () => {
  // A too-wide STRING is not caught by Sequelize; the database truncates.
  const widths = { user_name: 40, user_email: 80, user_phone: 12, user_phone_1: 12, user_zip: 6, user_code: 12, user_password: 100 };
  for (const [attr, def] of Object.entries(DeliveryPartner.rawAttributes)) {
    const col = columnOf(attr);
    const max = widths[col];
    if (!max) continue;
    const declared = def.type && def.type.options && def.type.options.length;
    if (declared == null) continue;
    assert.ok(declared <= max, `${attr} declares ${declared} chars but ${col} is varchar(${max})`);
  }
});
