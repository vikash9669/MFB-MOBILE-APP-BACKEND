// Admin review endpoints for delivery-partner onboarding.
// Guarded by requireAdmin (shared ADMIN_API_KEY). Lets an operator list
// applications, inspect a partner's KYC, and approve/reject them. On approval
// the partner's app unlocks; on rejection they're sent back to fix documents.
const { DeliveryPartner, DeliveryDocument } = require("../models");
const { serializePartner } = require("../util/delivery");
const { notifyPartner } = require("../util/deliveryNotify");
const { alertRiderDecision } = require("../util/riderAlerts");
const { summaryForPartner, recentForPartner } = require("../util/ratings");
const {
  ensurePanelRider,
  findPanelRider,
  panelRiderIdsByPhone,
  setPanelRiderAccess,
} = require("../util/riderLink");

const serializeDoc = (d) => ({
  id: d.doc_id,
  doc_type: d.doc_type,
  title: d.title,
  status: d.status,
  file_url: d.file_url,
});

// GET /delivery/admin/partners?status=under_review — list applications.
exports.listPartners = async (req, res) => {
  try {
    const where = {};
    if (req.query.status) {
      where.dp_verification_status = req.query.status;
    }
    const partners = await DeliveryPartner.findAll({
      where,
      order: [
        ["dp_submitted_at", "DESC"],
        ["dp_id", "DESC"],
      ],
    });
    // Whether each partner already exists on the panel side. Resolved here
    // rather than in the client, which only ever sees one page of riders and
    // so cannot tell "not linked" from "linked, on another page".
    const riderIds = await panelRiderIdsByPhone(partners.map((p) => p.dp_phone));
    res.json({
      partners: partners.map((p) => ({
        dp_id: p.dp_id,
        name: p.dp_name,
        phone: p.dp_phone,
        verification_status: p.dp_verification_status,
        submitted_at: p.dp_submitted_at,
        rejection_reason: p.dp_rejection_reason,
        panel_rider_id: riderIds.get(String(p.dp_phone || "").replace(/\D/g, "").slice(-10)) ?? null,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin listPartners ~ err:", err);
    res.status(500).json({ message: "Failed to list partners" });
  }
};

// GET /delivery/admin/partners/:id — full profile + uploaded documents.
exports.getPartner = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.params.id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    const docs = await DeliveryDocument.findAll({
      where: { dp_id: partner.dp_id },
      order: [["doc_id", "ASC"]],
    });
    // The matching store_users rider, if one exists. Additive field; existing
    // consumers ignore it.
    const rider = await findPanelRider(partner.dp_phone);
    // What customers have actually said about this rider. Additive; null when
    // the ratings migration has not run.
    const ratings = await summaryForPartner(partner.dp_id);

    res.json({
      partner: serializePartner(partner),
      documents: docs.map(serializeDoc),
      ratings,
      panel_rider: rider
        ? { user_id: rider.user_id, name: rider.user_name, role: Number(rider.user_role) }
        : null,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin getPartner ~ err:", err);
    res.status(500).json({ message: "Failed to load partner" });
  }
};

// PUT /delivery/admin/partners/:id/verify — approve or reject an application.
// body: { status: "approved" | "rejected", reason?, reject_docs?: string[] }
exports.verify = async (req, res) => {
  try {
    const { status, reason, reject_docs } = req.body;
    if (status !== "approved" && status !== "rejected") {
      return res
        .status(400)
        .json({ message: "status must be 'approved' or 'rejected'" });
    }
    const partner = await DeliveryPartner.findByPk(req.params.id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }

    if (status === "approved") {
      await partner.update({
        dp_verification_status: "approved",
        dp_reviewed_at: new Date(),
        dp_rejection_reason: null,
      });
      // Clear pending KYC docs to active.
      await DeliveryDocument.update(
        { status: "active" },
        { where: { dp_id: partner.dp_id, status: "pending" } }
      );
      await notifyPartner(partner.dp_id, {
        category: "system",
        icon: "verified",
        title: "You're approved! 🎉",
        body: "Your account is verified — you can start delivering now.",
        data: { type: "verification", status: "approved" },
      });

      // An approved partner is a rider, so make sure the panel side exists too:
      // without it they are missing from the Riders list, the order-assignment
      // dropdown and reports, all of which read store_users. Additive only —
      // an existing account is linked, never rewritten. Wrapped because a
      // failure here must not undo an approval that already succeeded.
      try {
        const link = await ensurePanelRider(partner);
        // Re-approval after a rejection has to undo the delist/disable that
        // the rejection applied, or they stay locked out of the panel side.
        const access = await setPanelRiderAccess(partner, true);
        console.log(
          `MFB ~ approve dp_id ${partner.dp_id} ~ panel rider: ${link.reason}` +
            (link.rider ? ` (user_id ${link.rider.user_id})` : "") +
            ` ~ access: ${access.reason}`
        );
      } catch (linkErr) {
        console.log("MFB-error-logs ~ approve panel-rider link ~ err:", linkErr);
      }

      // Off-app confirmation. Last, and wrapped: the approval and the panel
      // link are both already committed, and neither may be undone by an SMS
      // provider being down — which, as of this writing, it is.
      try {
        const alert = await alertRiderDecision(partner, { approved: true });
        console.log(
          `MFB ~ approve dp_id ${partner.dp_id} ~ rider told:`,
          `email=${alert.email ? alert.email.sent : "off"}`,
          `sms=${alert.sms ? alert.sms.sent : "off"}`
        );
      } catch (alertErr) {
        console.log("MFB-error-logs ~ approve rider alert ~", alertErr.message);
      }
    } else {
      await partner.update({
        dp_verification_status: "rejected",
        dp_reviewed_at: new Date(),
        dp_rejection_reason: reason || "Some details need to be corrected.",
      });
      if (Array.isArray(reject_docs) && reject_docs.length > 0) {
        await DeliveryDocument.update(
          { status: "rejected" },
          { where: { dp_id: partner.dp_id, doc_type: reject_docs } }
        );
      }
      await notifyPartner(partner.dp_id, {
        category: "system",
        icon: "error",
        title: "Action needed on your application",
        body: reason || "Please review and re-submit your documents.",
        data: { type: "verification", status: "rejected" },
      });

      // Rejecting someone who was previously approved must also close the
      // panel side, otherwise they remain Listed and Active and could still be
      // assigned an order while their app is locked. Best-effort: a failure
      // here must not undo a rejection that already succeeded.
      try {
        const access = await setPanelRiderAccess(partner, false);
        console.log(
          `MFB ~ reject dp_id ${partner.dp_id} ~ panel rider access: ${access.reason}`
        );
      } catch (accessErr) {
        console.log("MFB-error-logs ~ reject panel-rider access ~ err:", accessErr);
      }

      try {
        const alert = await alertRiderDecision(partner, {
          approved: false,
          reason: partner.dp_rejection_reason,
        });
        console.log(
          `MFB ~ reject dp_id ${partner.dp_id} ~ rider told:`,
          `email=${alert.email ? alert.email.sent : "off"}`,
          `sms=${alert.sms ? alert.sms.sent : "off"}`
        );
      } catch (alertErr) {
        console.log("MFB-error-logs ~ reject rider alert ~", alertErr.message);
      }
    }

    res.json({ message: "Partner updated", verification_status: status });
  } catch (err) {
    console.log("MFB-error-logs ~ admin verify ~ err:", err);
    res.status(500).json({ message: "Failed to update partner" });
  }
};


// GET /admin/delivery/partners/:id/ratings — the individual ratings behind a
// rider's average.
//
// Separate from the detail endpoint because it is a list that grows: an
// operator investigating a complaint wants the comments, and everyone else
// loading the rider's profile should not pay for them.
exports.listRatings = async (req, res) => {
  try {
    const dpId = Number(req.params.id);
    if (!Number.isInteger(dpId)) {
      return res.status(400).json({ message: "Invalid partner" });
    }
    const summary = await summaryForPartner(dpId);
    if (summary == null) {
      // Not an error: the feature simply is not switched on for this database.
      return res.json({ enabled: false, summary: null, ratings: [] });
    }
    res.json({
      enabled: true,
      summary,
      ratings: await recentForPartner(dpId, { limit: req.query.limit ?? 50 }),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin listRatings ~ err:", err);
    res.status(500).json({ message: "Failed to load ratings" });
  }
};
