const express = require("express");
const sequelize = require("./util/database");
require("./models");
require("./server");

const app = express();
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const userRoutes = require("./routes/users");
const addressRoutes = require("./routes/address");
const { startSessionSweeper } = require("./util/sessionSweeper");
const { startPaymentSweeper } = require("./util/paymentSweeper");
const { startOrderAcceptSweeper } = require("./util/orderAcceptSweeper");
const { startDispatchEngine } = require("./util/dispatch/engine");
const bannerRoutes = require("./routes/banner");
const deliveryAuthRoutes = require("./routes/deliveryAuth");
const deliveryAdminRoutes = require("./routes/deliveryAdmin");
const deliveryRoutes = require("./routes/delivery");
const adminPanelRoutes = require("./routes/admin");
const internalNotifyRoutes = require("./routes/internalNotify");
const paymentRoutes = require("./routes/payment");
const healthRoutes = require("./routes/health");
const liveSend = require("./util/liveSend");
const { ensureSchema, pending } = require("./util/schema");
const { reportBoot, reportListening, reportFatal } = require("./util/startupReport");
const { requestLog } = require("./middlewares/requestLog");

// Every per-IP rate limit reads req.ip, which Express derives from the socket
// unless it is told a proxy sits in front. Behind nginx or a load balancer that
// makes every caller look like the proxy — one shared bucket, so the caps still
// hold but stop distinguishing anybody.
//
// Off by default, and deliberately not "always on": trusting X-Forwarded-For
// when nothing strips it lets a caller name their own IP and mint a fresh
// allowance per request, which is worse than one shared bucket. Set TRUST_PROXY
// only once something in front is actually rewriting the header — "true", a hop
// count ("1" for a single proxy, the usual case), or an Express trust-proxy
// expression such as "loopback".
if (process.env.TRUST_PROXY) {
  const raw = String(process.env.TRUST_PROXY).trim();
  const hops = Number(raw);
  app.set("trust proxy", Number.isInteger(hops) && hops >= 0 ? hops : raw === "true" ? true : raw);
}

// Before the routers, so every request is logged whichever one answers it —
// including the 404s that no router claims.
app.use(requestLog);

app.use(express.json({ limit: "6mb" }));

// CORS for the web app — MFB-ADMIN-PANEL (:5173), which serves the customer
// storefront at / and the staff portals at /admin, /vendor and /rider from one
// origin. It was previously two SPAs on two ports; the storefront was merged in,
// so :5174 is no longer used. The mobile apps are native and unaffected.
// Origins are configurable via ADMIN_PANEL_ORIGINS (comma-separated); the Vite
// default is allowed so a fresh checkout works without extra setup.
const ADMIN_ORIGINS = (
  process.env.ADMIN_PANEL_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ADMIN_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

// First, and above everything else: a health check must answer even when the
// rest of the app is unhappy, and must never be captured by the catch-all "/"
// routers mounted further down.
app.use("/health", healthRoutes);

app.use("/auth", authRoutes);
// Public partner auth + admin (own key) first, then the token-guarded partner
// APIs. Keep this order so /delivery/auth/* and /delivery/admin/* aren't
// captured by the protected /delivery router.
app.use("/admin", adminPanelRoutes);
app.use("/delivery/auth", deliveryAuthRoutes);
app.use("/delivery/admin", deliveryAdminRoutes);
app.use("/delivery", deliveryRoutes);
app.use("/notify", internalNotifyRoutes);
// Public gateway callback (signature-verified, no JWT) — must sit before the
// catch-all "/" routers so it isn't swallowed by them.
app.use("/payment", paymentRoutes);
app.use("/", productRoutes);
app.use("/user", userRoutes);
app.use("/", addressRoutes);
app.use("/banners", bannerRoutes);

sequelize
  .sync({ logging: false })
  .then(async () => {
    // Bring the database up to the schema this build expects before anything
    // reads from it. Deploying against a restore of the legacy PHP database
    // used to mean running six SQL files by hand in order, and forgetting one
    // produced a feature that silently did nothing rather than an error.
    // Additive only — see util/schema/index.js. AUTO_MIGRATE=false disables it.
    const applied = await ensureSchema(sequelize);
    const left = await pending(sequelize);
    const behind = left.missingTables.length + left.missingColumns.length;
    const schemaLine = behind
      ? `${behind} object(s) STILL MISSING after migration — features depending on them will be dormant`
      : applied.applied
        ? `up to date (${applied.applied} object(s) created this boot)`
        : "up to date (nothing to apply)";

    const [[tz]] = await sequelize.query("SELECT @@session.time_zone AS tz");
    reportBoot({
      dbName: process.env.DB_NAME,
      dbHost: process.env.DB_HOST,
      dbPort: process.env.DB_PORT || 3306,
      timezone: tz.tz,
      schema: schemaLine,
    });

    // Closes online sessions that stopped reporting — a partner who loses data
    // or force-quits would otherwise stay online indefinitely.
    startSessionSweeper();
    // Recovers payments that succeeded at PhonePe but whose confirm call never
    // arrived — without this the customer is charged and no order is created.
    startPaymentSweeper();
    // Re-alerts vendors who haven't accepted, then escalates to admin staff.
    startOrderAcceptSweeper();
    // Scores riders and offers accepted orders to them one at a time. Dormant
    // until migrations/2026-08-09-dispatch-engine.sql has run.
    startDispatchEngine();
    // Say so at boot, not on the first refused message. With the allowlist set,
    // real customers receive nothing — that is correct on a laptop pointed at a
    // clone of production and catastrophic on the real thing, so it needs to be
    // visible in the startup log rather than discovered from a support call.
    if (!liveSend.unrestricted()) {
      console.log(
        "MFB ~ ⚠️  LIVE_SEND_ALLOWLIST is set — only listed recipients will receive " +
          "SMS, WhatsApp, calls or email. Clear it in production."
      );
    }

    // 8080 stays the default so nothing that hardcodes it breaks; PORT exists so
    // a second instance can be run alongside for testing.
    const port = Number(process.env.PORT) || 8080;
    // Log from the callback, not before it — "listening" printed ahead of the
    // bind is a lie if the port is already taken.
    app.listen(port, () => reportListening(port));
  })
  .catch((err) => {
    // Exit non-zero. Staying alive with no listener makes a host report a
    // healthy deploy that serves nothing, which is the worst of both.
    reportFatal(err);
    process.exit(1);
  });
