// Builds a fully-qualified URL for an uploaded asset (see
// controllers/admin/uploads.js), mirroring MFB_ADMIN_PANEL_REACT's own
// src/panel/lib/format.ts::assetUrl exactly — same kind/webp/name.webp shape.
//
// The client apps normally build these URLs themselves (ASSETS_BASE_URL is
// baked into each app), so the backend has never needed this before. It does
// now: FCM's notification.image field requires a real https URL server-side,
// not a bare filename — see util/promoNotificationSweeper.js.
//
// The default is the LIVE image host, not this backend and not localhost.
// Both of those alternatives fail, in the same silent way:
//
//   • This API serves no static assets at all — there is no express.static
//     anywhere, so /assets/uploads/... is a 404 on Render. Uploads are written
//     to the PHP app's filesystem (controllers/admin/uploads.js) and served by
//     the PHP host; Node only ever writes the file and stores the name.
//   • http://localhost:8091 is the PHP host in dev, and is unreachable from
//     Google's servers, which is what actually fetches the picture.
//
// Either way FCM drops an image it cannot fetch and delivers the notification
// without one — no error, no log, just no picture. So the fallback is the host
// the apps themselves already hardcode for product and vendor images (see
// MFB-Mobile-App/constants/urls.js), which means images work with no
// configuration and ASSETS_BASE_URL is left for pointing at a staging host.
const BASE = (process.env.ASSETS_BASE_URL || "https://www.myfirstbite.in/assets/uploads").replace(/\/$/, "");

const assetUrl = (kind, name) => {
  if (!name) return null;
  if (/\.(webp|jpe?g|png)$/i.test(name)) return `${BASE}/${kind}/webp/${name}`;
  return `${BASE}/${kind}/webp/${name}.webp`;
};

module.exports = { assetUrl };
