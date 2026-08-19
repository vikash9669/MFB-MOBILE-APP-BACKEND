const test = require("node:test");
const assert = require("node:assert");

const {
  _buildChecklist: buildChecklist,
  _missingItems: missingItems,
  REQUIRED_DOCS,
  MIN_DOCUMENTS,
} = require("../controllers/deliveryOnboarding");

// The KYC document rule: ANY ONE document is enough to submit an application.
//
// This used to demand all five, which blocked real riders — no RC on a
// borrowed bike, no PAN at all — behind paperwork they could not produce. An
// admin still reviews every application, so this governs what blocks
// submission, not what earns approval.

/** A partner with everything except documents filled in. */
const partner = () => ({
  dp_name: "Test Rider",
  dp_vehicle_type: "bike",
  dp_vehicle_number: "MP09AB1234",
  dp_photo: "photo.jpg",
  dp_upi_id: "rider@upi",
});

const doc = (doc_type) => ({ doc_type, file_url: `${doc_type}.jpg`, status: "pending" });

const submittable = (c) => c.profile && c.photo && c.bank && c.documents_ok;

test("one document is enough, whichever one it is", () => {
  // Every type must count on its own — an applicant with only insurance is as
  // submittable as one with only Aadhaar.
  for (const { doc_type } of REQUIRED_DOCS) {
    const c = buildChecklist(partner(), [doc(doc_type)]);
    assert.equal(c.documents_ok, true, `${doc_type} alone should satisfy the rule`);
    assert.equal(submittable(c), true, `${doc_type} alone should be submittable`);
  }
});

test("no documents is still not enough", () => {
  const c = buildChecklist(partner(), []);
  assert.equal(c.documents_ok, false);
  assert.equal(submittable(c), false);
});

test("a document row with no file does not count", () => {
  // A row can exist from a failed or abandoned upload; only a stored file is
  // evidence of anything.
  const c = buildChecklist(partner(), [{ doc_type: "pan", file_url: "", status: "missing" }]);
  assert.equal(c.documents_ok, false);
});

test("missing lists documents as ONE line, not one per document", () => {
  const missing = missingItems(buildChecklist(partner(), []));
  const docLines = missing.filter((m) => /identity document/i.test(m));

  assert.equal(docLines.length, 1, "should ask once, not five times");
  // The single line still names the options, so the applicant knows what counts.
  for (const { title } of REQUIRED_DOCS) {
    assert.match(docLines[0], new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("once any document is uploaded, documents drop out of missing entirely", () => {
  const missing = missingItems(buildChecklist(partner(), [doc("license")]));
  assert.equal(
    missing.filter((m) => /identity document/i.test(m)).length,
    0
  );
  assert.deepEqual(missing, [], "nothing else was outstanding");
});

test("the other requirements are untouched by this change", () => {
  // Loosening documents must not have loosened profile, photo or payout.
  const noPhoto = buildChecklist({ ...partner(), dp_photo: "" }, [doc("aadhaar")]);
  assert.equal(submittable(noPhoto), false);
  assert.ok(missingItems(noPhoto).some((m) => /photo/i.test(m)));

  const noBank = buildChecklist({ ...partner(), dp_upi_id: "" }, [doc("aadhaar")]);
  assert.equal(submittable(noBank), false);

  const noVehicle = buildChecklist({ ...partner(), dp_vehicle_number: "" }, [doc("aadhaar")]);
  assert.equal(submittable(noVehicle), false);
});

test("bank details still satisfy payout without a UPI id", () => {
  const c = buildChecklist(
    {
      ...partner(),
      dp_upi_id: "",
      dp_bank_account: "123456789",
      dp_bank_ifsc: "HDFC0001234",
      dp_bank_holder: "Test Rider",
    },
    [doc("aadhaar")]
  );
  assert.equal(submittable(c), true);
});

test("the checklist still reports every document so the app can list them", () => {
  // The rule loosened; the form did not shrink. A rider with more documents
  // should still be able to upload them.
  const c = buildChecklist(partner(), [doc("pan")]);
  assert.equal(c.documents.length, REQUIRED_DOCS.length);
  assert.equal(c.documents.filter((d) => d.uploaded).length, 1);
  assert.equal(c.min_documents, MIN_DOCUMENTS);
  assert.equal(MIN_DOCUMENTS, 1);
});
