// Onboarding / KYC gate for delivery partners.
// A new partner starts as "pending" and can see ONLY the onboarding flow until
// an admin approves them (see controllers/deliveryAdmin.js). This controller
// reports what's still needed and moves a completed application to
// "under_review". It never writes to the customer/vendor tables.
const { DeliveryPartner, DeliveryDocument } = require("../models");

// KYC documents a partner may upload, in display order.
//
// At least ONE is required, not all five — the same "any acceptable proof will
// do" rule the bank step already uses (full bank details OR a UPI id). Real
// riders frequently have some of these and not others: a rider on a borrowed
// bike has no RC in their name, plenty have no PAN, and demanding the full set
// turned an onboarding flow into a wall. An admin still reviews the
// application and can reject or ask for more, so this loosens what blocks
// *submission*, not what gets someone approved.
const REQUIRED_DOCS = [
  { doc_type: "aadhaar", title: "Aadhaar card" },
  { doc_type: "pan", title: "PAN card" },
  { doc_type: "license", title: "Driving licence" },
  { doc_type: "rc", title: "Vehicle RC" },
  { doc_type: "insurance", title: "Insurance" },
];

const hasText = (v) => typeof v === "string" && v.trim().length > 0;

// Bank payout is complete with either full bank details OR a UPI id.
const bankComplete = (p) =>
  (hasText(p.dp_bank_account) && hasText(p.dp_bank_ifsc) && hasText(p.dp_bank_holder)) ||
  hasText(p.dp_upi_id);

const profileComplete = (p) =>
  hasText(p.dp_name) && hasText(p.dp_vehicle_type) && hasText(p.dp_vehicle_number);

/** The document rule: any one upload satisfies it. */
const documentsComplete = (documents) => documents.some((d) => d.uploaded);

// How many documents the applicant must provide. Named because it appears in
// the checklist, the error message and the app's progress count, and those
// three drifting apart is how a form starts lying about what it wants.
const MIN_DOCUMENTS = 1;

// Builds the onboarding checklist for a partner given their uploaded docs.
const buildChecklist = (partner, docs) => {
  const uploaded = new Set(
    docs.filter((d) => hasText(d.file_url)).map((d) => d.doc_type)
  );
  const documents = REQUIRED_DOCS.map((r) => {
    const row = docs.find((d) => d.doc_type === r.doc_type);
    return {
      doc_type: r.doc_type,
      title: r.title,
      uploaded: uploaded.has(r.doc_type),
      status: row ? row.status : "missing",
    };
  });
  return {
    profile: profileComplete(partner),
    photo: hasText(partner.dp_photo),
    bank: bankComplete(partner),
    documents,
    // Told to the client rather than inferred there, so the app and the server
    // cannot disagree about whether the form is submittable.
    documents_ok: documentsComplete(documents),
    min_documents: MIN_DOCUMENTS,
  };
};

// Lists every unmet requirement as a human-readable string (for submit errors).
const missingItems = (checklist) => {
  const missing = [];
  if (!checklist.profile) missing.push("Profile details (name, vehicle)");
  if (!checklist.photo) missing.push("Profile photo");
  if (!checklist.bank) missing.push("Bank or UPI details");
  // One line, not one per document. Listing all five unmet requirements when
  // any single one would do told the applicant to go and find four documents
  // they do not need.
  if (!checklist.documents_ok) {
    missing.push(
      `At least one identity document (${checklist.documents
        .map((d) => d.title)
        .join(", ")})`
    );
  }
  return missing;
};

// GET /delivery/onboarding — status + checklist for the onboarding screens.
exports.getStatus = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    const docs = await DeliveryDocument.findAll({ where: { dp_id: partner.dp_id } });
    const checklist = buildChecklist(partner, docs);
    const complete =
      checklist.profile &&
      checklist.photo &&
      checklist.bank &&
      checklist.documents_ok;

    res.json({
      verification_status: partner.dp_verification_status,
      rejection_reason: partner.dp_rejection_reason || null,
      submitted_at: partner.dp_submitted_at || null,
      checklist,
      missing: missingItems(checklist),
      // Can submit only when everything is filled and not already in review.
      can_submit:
        complete &&
        (partner.dp_verification_status === "pending" ||
          partner.dp_verification_status === "rejected"),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery onboarding status ~ err:", err);
    res.status(500).json({ message: "Failed to load onboarding status", err });
  }
};

// POST /delivery/onboarding/submit — move a completed application to review.
exports.submit = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    if (partner.dp_verification_status === "approved") {
      return res.json({ verification_status: "approved" });
    }
    if (partner.dp_verification_status === "under_review") {
      return res.json({
        verification_status: "under_review",
        submitted_at: partner.dp_submitted_at,
      });
    }

    const docs = await DeliveryDocument.findAll({ where: { dp_id: partner.dp_id } });
    const checklist = buildChecklist(partner, docs);
    const missing = missingItems(checklist);
    if (missing.length > 0) {
      return res
        .status(400)
        .json({ message: "Please complete your application first", missing });
    }

    await partner.update({
      dp_verification_status: "under_review",
      dp_submitted_at: new Date(),
      dp_rejection_reason: null,
    });

    res.json({
      message: "Application submitted for review",
      verification_status: "under_review",
      submitted_at: partner.dp_submitted_at,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery onboarding submit ~ err:", err);
    res.status(500).json({ message: "Failed to submit application", err });
  }
};

module.exports.REQUIRED_DOCS = REQUIRED_DOCS;
module.exports.MIN_DOCUMENTS = MIN_DOCUMENTS;
// Exported for tests: these are pure, and the "how much is enough" rule is
// worth testing without standing up a database to do it.
module.exports._buildChecklist = buildChecklist;
module.exports._missingItems = missingItems;
