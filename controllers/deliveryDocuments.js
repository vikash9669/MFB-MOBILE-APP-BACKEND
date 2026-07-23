const { DeliveryDocument } = require("../models");

const serializeDoc = (d) => ({
  id: d.doc_id,
  doc_type: d.doc_type,
  title: d.title,
  status: d.status,
  expires_on: d.expires_on,
  file_url: d.file_url,
});

// GET /delivery/documents — the partner's KYC documents + a rollup status.
exports.getDocuments = async (req, res) => {
  try {
    const docs = await DeliveryDocument.findAll({
      where: { dp_id: req.user.dp_id },
      order: [["doc_id", "ASC"]],
    });

    const total = docs.length;
    const active = docs.filter((d) => d.status === "active").length;
    const allVerified = total > 0 && docs.every((d) => d.status === "active" || d.status === "expiring");

    res.json({
      kyc_verified: allVerified,
      active_count: active,
      total_count: total,
      documents: docs.map(serializeDoc),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getDocuments ~ err:", err);
    res.status(500).json({ message: "Failed to load documents", err });
  }
};

// POST /delivery/documents/:id/reupload — record a re-upload (marks pending).
exports.reupload = async (req, res) => {
  try {
    const doc = await DeliveryDocument.findOne({
      where: { doc_id: req.params.id, dp_id: req.user.dp_id },
    });
    if (doc == null) {
      return res.status(404).json({ message: "Document not found" });
    }
    await doc.update({
      status: "pending",
      file_url: req.body.file_url || doc.file_url,
      updated_at: new Date(),
    });
    res.json({ message: "Document submitted for review", document: serializeDoc(doc) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery reupload ~ err:", err);
    res.status(500).json({ message: "Failed to submit document", err });
  }
};
