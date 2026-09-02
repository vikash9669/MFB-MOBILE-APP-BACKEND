// Builds a fully-qualified URL for an uploaded asset (see
// controllers/admin/uploads.js), mirroring MFB_ADMIN_PANEL_REACT's own
// src/panel/lib/format.ts::assetUrl exactly — same kind/webp/name.webp shape.
//
// The client apps normally build these URLs themselves (ASSETS_BASE_URL is
// baked into each app), so the backend has never needed this before. It does
// now: FCM's notification.image field requires a real https URL server-side,
// not a bare filename — see util/promoNotificationSweeper.js.
const BASE = (process.env.ASSETS_BASE_URL || "http://localhost:8091/assets/uploads").replace(/\/$/, "");

const assetUrl = (kind, name) => {
  if (!name) return null;
  if (/\.(webp|jpe?g|png)$/i.test(name)) return `${BASE}/${kind}/webp/${name}`;
  return `${BASE}/${kind}/webp/${name}.webp`;
};

module.exports = { assetUrl };
