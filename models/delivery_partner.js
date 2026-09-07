const crypto = require("node:crypto");
const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// A delivery partner IS a store_users row with user_role = 3.
//
// There used to be a separate store_delivery_partners table, joined to the
// panel's rider roster on phone number. That join was the flaw: a phone that
// already belonged to a customer matched it, so a genuine application looked
// "already linked" and showed up in neither the review queue nor the roster.
// It also meant the 92 riders who existed only in the panel could not sign in
// to the partner app at all.
//
// The attribute names are unchanged — dp_id, dp_phone and the rest still work
// everywhere they are used — but they now map onto store_users columns. Eight
// of them are shared with the user's own fields rather than duplicated:
// keeping two copies of a phone number on one row is how they drift apart.
//
// See migrations/2026-08-21-unify-delivery-partners-into-store-users.sql.
const DeliveryPartner = sequelize.define(
  "delivery_partner",
  {
    // Not a dp_ field, but the one that defines a partner. Exposed so a create
    // sets it and so the default scope has something to match.
    user_role: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 3,
    },

    // ── store_users columns a partner does not use ───────────────────
    // Eleven columns on store_users are NOT NULL with no default and mean
    // nothing to a delivery partner. They are declared here for one reason:
    // Sequelize builds its INSERT from DECLARED attributes, so a value set
    // on an undeclared key — which is what beforeCreate used to do — is
    // dropped without a word. On this MariaDB (sql_mode has neither
    // STRICT_TRANS_TABLES nor STRICT_ALL_TABLES) the INSERT then succeeded
    // and quietly wrote '' into every one of them, including user_password
    // on a row the PHP panel authenticates against.
    //
    // A defaultValue rather than a hook, because defaults are applied by
    // Model.build and so survive paths a beforeCreate hook cannot reach.
    // Only the phone-derived ones are left to the hook below.
    user_phone_1: {
      type: DataTypes.STRING(12),
      allowNull: false,
      defaultValue: "",
    },
    // Unusable by design: partners sign in with an OTP, never a password.
    // Random, not blank — a blank one would let an empty submitted password
    // match, and store_users is what the panel authenticates against.
    user_password: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: () => crypto.randomBytes(16).toString("hex"),
    },
    user_landmark: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "",
    },
    user_state: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    user_city: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "1",
    },
    user_zip: {
      type: DataTypes.STRING(6),
      allowNull: false,
      defaultValue: "000000",
    },
    user_location: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    user_otp: {
      type: DataTypes.STRING(6),
      allowNull: false,
      defaultValue: "000000",
    },
    user_code: {
      type: DataTypes.STRING(12),
      allowNull: false,
      defaultValue: () => `D${Date.now().toString().slice(-8)}`,
    },
    dp_id: {
      field: "user_id",
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_name: {
      field: "user_name",
      // 40, not 80 — store_users.user_name is varchar(40).
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: "",
    },
    dp_email: {
      field: "user_email",
      // 80, not 120 — store_users.user_email is varchar(80).
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: "",
    },
    dp_phone: {
      field: "user_phone",
      type: DataTypes.STRING(12),
      allowNull: false,
    },
    dp_code: {
      type: DataTypes.STRING(12),
      allowNull: false,
    },
    // Holds the latest OTPless requestId between get-otp and verify-otp.
    dp_request_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    // Bumped on logout to invalidate all outstanding refresh tokens.
    dp_token_version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    // Server-synced app settings / permission flags (JSON blob).
    dp_settings: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    // ── Profile / vehicle ────────────────────────────────────────────
    dp_vehicle_type: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "Bike",
    },
    dp_vehicle_number: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    // Profile selfie (base64 data URI or URL), captured during onboarding.
    // LONGTEXT: a base64 image is far larger than TEXT's 64KB cap.
    //
    // Its own column, NOT store_users.user_image. That one is varchar(100) —
    // the legacy panel keeps a filename there — so mapping onto it truncated
    // every selfie to 100 characters without erroring.
    dp_photo: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
    },
    // ── Onboarding / verification (admin-gated) ──────────────────────
    // pending      → new account, still filling profile + KYC
    // under_review → submitted, waiting on admin
    // approved     → full app unlocked
    // rejected     → admin sent it back (see dp_rejection_reason)
    dp_verification_status: {
      type: DataTypes.ENUM("pending", "under_review", "approved", "rejected"),
      allowNull: false,
      defaultValue: "pending",
    },
    dp_rejection_reason: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    dp_submitted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    dp_reviewed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // ── Payout details (collected at onboarding) ─────────────────────
    dp_bank_account: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    dp_bank_ifsc: {
      type: DataTypes.STRING(15),
      allowNull: true,
    },
    dp_bank_holder: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    dp_upi_id: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    // ── Live status ──────────────────────────────────────────────────
    // Whether the partner is currently online and accepting orders.
    dp_online: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 0,
    },
    dp_lat: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    },
    dp_lng: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    },
    // ── Money ────────────────────────────────────────────────────────
    // Withdrawable wallet balance (kept as a running total in rupees).
    dp_wallet_balance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // COD cash the partner is holding and still owes the company.
    dp_cash_in_hand: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // ── Performance metrics ──────────────────────────────────────────
    dp_rating: {
      type: DataTypes.DECIMAL(3, 2),
      allowNull: false,
      defaultValue: 5.0,
    },
    dp_total_deliveries: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    dp_on_time_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    dp_acceptance_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    dp_completion_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    dp_cancellation_pct: {
      type: DataTypes.DECIMAL(4, 1),
      allowNull: false,
      defaultValue: 0,
    },
    dp_avg_delivery_min: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    // Deliberately NOT mapped onto user_active. That column is a tri-state
    // panel listing flag — of the 92 existing riders, 66 are 0, 14 are 1 and
    // 12 are 2 — while every dispatch query tests `dp_active: 1`. Merging them
    // would have silently made 78 riders undispatchable.
    //
    // Separating them is only half the job, though, and for a long time it was
    // the only half: setPanelRiderAccess writes user_active/user_status and
    // does NOT touch this column, so nothing on the approval path set it. The
    // outcome was the one the separation was meant to prevent — on the clone,
    // 94 approved partners and 16 the engine could see. controllers/
    // deliveryAdmin.js `verify` now sets it on both branches. If you add
    // another way to approve a rider, it has to set this too.
    dp_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 1,
    },
    dp_registered: {
      field: "user_registered",
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: NOW,
    },
    dp_last_login: {
      field: "user_last_login",
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "store_users",
    // Every query through this model is scoped to riders. Without it, a
    // DeliveryPartner.findOne on a phone number could return a customer — which
    // is precisely the bug this replaced, moved one level down.
    defaultScope: { where: { user_role: 3 } },
    timestamps: false,
    hooks: {
      // Only the values derived from the phone number; everything else
      // store_users demands is an attribute defaultValue above.
      //
      // Every key below must be a DECLARED attribute — setDataValue on a
      // name Sequelize does not know about is a no-op that the INSERT then
      // omits, silently. `dp_name` and `dp_email`, not `user_name` and
      // `user_email`: the attribute is what setDataValue keys off, and the
      // column name it maps to is not an alias for it.
      beforeCreate(partner) {
        const phone = String(partner.dp_phone || "").replace(/\D/g, "").slice(-10);
        const set = (attr, value) => {
          const current = partner.getDataValue(attr);
          if (current == null || current === "") partner.setDataValue(attr, value);
        };
        set("user_phone_1", phone);
        set("dp_name", `Rider ${phone.slice(-4)}`);
        set("dp_email", `dp${phone || Date.now()}@example.com`);
      },
    },
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "dp_id" }],
      },
    ],
  }
);

module.exports = DeliveryPartner;
