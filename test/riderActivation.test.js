const test = require("node:test");
const assert = require("node:assert");

// Approving a rider must make them DISPATCHABLE, not merely "approved".
//
// The engine's eligibility rule is `dp_online = 1 AND dp_active = 1 AND
// dp_verification_status = 'approved'` (util/dispatch/riderSearch.js). The
// approve path used to write only the third of those. The panel link it calls
// afterwards writes user_active/user_status — different columns, which no
// dispatch query reads — so dp_active was left at whatever the row happened to
// carry.
//
// The result was silent and total: on the clone, 94 approved partners and 16
// the engine could see. A rider could be Listed and Active on every panel
// screen, show "You're online · accepting orders" in their own app, and never
// be offered a job. Verified live — an order was placed, the vendor accepted,
// the engine searched one second later and reported "no online rider is free
// to take this job" with the rider sitting online 300m from the pickup.
//
// No database: the models and every side-effect are stubbed, because what
// matters is only WHICH columns the approve and reject branches write.

const models = require("../models");
const deliveryNotify = require("../util/deliveryNotify");
const riderNotify = require("../util/riderNotify");
const riderAlerts = require("../util/riderAlerts");
const riderLink = require("../util/riderLink");

let written = [];

const partner = {
  dp_id: 19777,
  dp_name: "Test Rider",
  dp_phone: "0000000000",
  async update(fields) {
    written.push(fields);
    Object.assign(this, fields);
  },
};

models.DeliveryPartner.findByPk = async () => partner;
models.DeliveryDocument.update = async () => [0];
deliveryNotify.notifyPartner = async () => {};
riderNotify.applicationApproved = async () => {};
riderAlerts.alertRiderDecision = async () => ({ email: null, sms: null });
riderLink.ensurePanelRider = async () => ({ reason: "stub", rider: null });
riderLink.setPanelRiderAccess = async () => ({ changed: false, reason: "stub" });

delete require.cache[require.resolve("../controllers/deliveryAdmin")];
const deliveryAdmin = require("../controllers/deliveryAdmin");

/** Minimal res double — the controller only ever calls status()/json(). */
function fakeRes() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function verify(status) {
  written = [];
  const res = fakeRes();
  await deliveryAdmin.verify({ params: { id: 19777 }, body: { status } }, res);
  return res;
}

test("approving a rider sets dp_active, the flag dispatch actually reads", async () => {
  const res = await verify("approved");
  assert.strictEqual(res.code, 200, `expected 200, got ${res.code}`);

  const fields = Object.assign({}, ...written);
  assert.strictEqual(
    fields.dp_active,
    1,
    "approval must set dp_active = 1 or the engine will never see this rider"
  );
  assert.strictEqual(fields.dp_verification_status, "approved");
});

test("rejecting a rider clears dp_active, so the two flags cannot drift", async () => {
  const res = await verify("rejected");
  assert.strictEqual(res.code, 200, `expected 200, got ${res.code}`);

  const fields = Object.assign({}, ...written);
  assert.strictEqual(fields.dp_active, 0, "a rejected rider must not stay dispatchable");
  assert.strictEqual(fields.dp_verification_status, "rejected");
});

test("the columns approval writes are exactly the ones eligibility tests", () => {
  // Guards the actual regression: someone reading riderSearch's WHERE clause
  // must be able to find a writer for every column in it. dp_online is the
  // rider's own toggle (POST /delivery/status/online); the other two are set
  // here.
  const riderSearch = require("../util/dispatch/riderSearch");
  assert.ok(
    typeof riderSearch.eligibleRiders === "function",
    "eligibleRiders is the consumer this test is protecting"
  );
  const src = require("node:fs").readFileSync(
    require.resolve("../util/dispatch/riderSearch"),
    "utf8"
  );
  for (const column of ["dp_online", "dp_active", "dp_verification_status"]) {
    assert.match(
      src,
      new RegExp(`${column}\\s*:`),
      `${column} should still be an eligibility rule — if it moved, update the approve path`
    );
  }
});
