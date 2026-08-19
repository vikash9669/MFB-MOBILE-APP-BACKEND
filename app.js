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
    // 8080 stays the default so nothing that hardcodes it breaks; PORT exists so
    // a second instance can be run alongside for testing.
    app.listen(Number(process.env.PORT) || 8080);
  })
  .catch((err) => {
    console.log(err);
  });
