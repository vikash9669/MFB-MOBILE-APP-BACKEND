const Business = require("./business");
const Menu = require("./menu");
const Product = require("./product");
const ProductMenu = require("./productmenu");
const StoreOrderDetails = require("./store_orders_details");
const StoreOrderLogs = require("./store_orders_log");
const StoreOrders = require("./store_orders");
const StoreUserShippingAddress = require("./store_users_shipping_address");
const User = require("./user");
const Area = require("./area");
const Location = require("./location");
const Address = require("./store_users_shipping_address");
const Banner = require("./banner");
const DeliveryPartner = require("./delivery_partner");
const DeliveryOrder = require("./delivery_order");
const DeliveryOrderEvent = require("./delivery_order_event");
const DeliveryWalletTxn = require("./delivery_wallet_txn");
const DeliveryShift = require("./delivery_shift");
const DeliverySession = require("./delivery_session");
const DeliverySessionPoint = require("./delivery_session_point");
const DeliveryDocument = require("./delivery_document");
const DeliveryNotification = require("./delivery_notification");
const DeliveryDevice = require("./delivery_device");
const UserDevice = require("./user_device");
const UserNotification = require("./user_notification");
const PaymentIntent = require("./payment_intent");
const Category = require("./category");
const UserBank = require("./user_bank");
const Cashback = require("./cashback");
const PromoCampaign = require("./promo_campaign");
const PromoTarget = require("./promo_target");
const PromoRedemption = require("./promo_redemption");

Business.hasMany(Menu, {
  foreignKey: "menu_user_id",
  sourceKey: "user_id",
  as: "menus",
});

Menu.belongsTo(Business, {
  foreignKey: "menu_user_id",
  targetKey: "user_id",
});

Menu.belongsToMany(Product, {
  through: ProductMenu,
  foreignKey: "product_menu_id",
  otherKey: "product_id",
  as: "products",
});

Product.belongsToMany(Menu, {
  through: ProductMenu,
  foreignKey: "product_id",
  otherKey: "product_menu_id",
  as: "menus",
});

User.hasMany(Business, {
  as: "store_users_businesses",
  foreignKey: "user_id",
});

Business.belongsTo(User, {
  as: "user",
  foreignKey: "user_id",
});

StoreOrders.hasMany(StoreOrderDetails, { foreignKey: "order_id" });
StoreOrderDetails.belongsTo(StoreOrders, { foreignKey: "order_id" });

StoreOrderDetails.belongsTo(Product, { foreignKey: "product_id" });
Product.hasMany(StoreOrderDetails, { foreignKey: "product_id" });

StoreOrderLogs.belongsTo(StoreOrders, { foreignKey: "order_id" });
StoreOrders.hasMany(StoreOrderLogs, { foreignKey: "order_id" });

StoreOrders.belongsTo(Business, {
  foreignKey: "vendor_id",
  targetKey: "user_id",
});

Area.belongsTo(User, {
  as: "user",
  foreignKey: "area_user_id",
  targetKey: "user_id",
});

User.hasMany(Area, {
  foreignKey: "area_user_id",
  as: "areas",
});

Area.belongsTo(Location, {
  as: "location",
  foreignKey: "area_id",
  targetKey: "location_id",
});

Location.hasMany(Area, {
  foreignKey: "area_id",
});

Address.belongsTo(Location, {
  as: "location",
  foreignKey: "delivery_city",
  targetKey: "location_id",
});

Location.hasMany(Address, {
  foreignKey: "delivery_city",
});

StoreOrders.belongsTo(Address, {
  as: "address",
  foreignKey: "address_id",
  targetKey: "delivery_id",
});

Address.hasMany(StoreOrders, {
  foreignKey: "address_id",
});

// ── Delivery-partner collections (kept separate from the customer app) ──
DeliveryPartner.hasMany(DeliveryOrder, { foreignKey: "dp_id", sourceKey: "dp_id", as: "orders" });
DeliveryOrder.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id", as: "partner" });

DeliveryOrder.hasMany(DeliveryOrderEvent, { foreignKey: "do_id", sourceKey: "do_id", as: "events" });
DeliveryOrderEvent.belongsTo(DeliveryOrder, { foreignKey: "do_id", targetKey: "do_id" });

DeliveryPartner.hasMany(DeliveryWalletTxn, { foreignKey: "dp_id", sourceKey: "dp_id", as: "wallet_txns" });
DeliveryWalletTxn.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id" });

DeliveryPartner.hasMany(DeliveryShift, { foreignKey: "dp_id", sourceKey: "dp_id", as: "shifts" });
DeliveryShift.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id" });
DeliveryPartner.hasMany(DeliverySession, { foreignKey: "dp_id", sourceKey: "dp_id", as: "sessions" });
DeliverySession.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id" });
DeliverySession.hasMany(DeliverySessionPoint, { foreignKey: "session_id", sourceKey: "session_id", as: "points" });
DeliverySessionPoint.belongsTo(DeliverySession, { foreignKey: "session_id", targetKey: "session_id" });

DeliveryPartner.hasMany(DeliveryDocument, { foreignKey: "dp_id", sourceKey: "dp_id", as: "documents" });
DeliveryDocument.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id" });

DeliveryPartner.hasMany(DeliveryNotification, { foreignKey: "dp_id", sourceKey: "dp_id", as: "notifications" });
DeliveryNotification.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id" });

DeliveryPartner.hasMany(DeliveryDevice, { foreignKey: "dp_id", sourceKey: "dp_id", as: "devices" });
DeliveryDevice.belongsTo(DeliveryPartner, { foreignKey: "dp_id", targetKey: "dp_id" });

// ── Customer push devices + in-app notifications (store_user_*) ─────────
User.hasMany(UserDevice, { foreignKey: "user_id", sourceKey: "user_id", as: "devices" });
UserDevice.belongsTo(User, { foreignKey: "user_id", targetKey: "user_id" });

User.hasMany(UserNotification, { foreignKey: "user_id", sourceKey: "user_id", as: "notifications" });
UserNotification.belongsTo(User, { foreignKey: "user_id", targetKey: "user_id" });

// ── Payment intents (checkout parked while the customer is in PhonePe) ──
User.hasMany(PaymentIntent, { foreignKey: "customer_id", sourceKey: "user_id", as: "payment_intents" });
PaymentIntent.belongsTo(User, { foreignKey: "customer_id", targetKey: "user_id" });

// ── Promo campaigns (admin-composed offer/announcement pushes) ──────────
PromoCampaign.hasMany(PromoTarget, { foreignKey: "campaign_id", sourceKey: "campaign_id", as: "targets" });
PromoTarget.belongsTo(PromoCampaign, { foreignKey: "campaign_id", targetKey: "campaign_id" });

PromoCampaign.hasMany(PromoRedemption, { foreignKey: "campaign_id", sourceKey: "campaign_id", as: "redemptions" });
PromoRedemption.belongsTo(PromoCampaign, { foreignKey: "campaign_id", targetKey: "campaign_id" });

module.exports = {
  User,
  Product,
  Business,
  Menu,
  ProductMenu,
  StoreOrders,
  StoreOrderDetails,
  StoreOrderLogs,
  StoreUserShippingAddress,
  Area,
  Location,
  Address,
  Banner,
  DeliveryPartner,
  DeliveryOrder,
  DeliveryOrderEvent,
  DeliveryWalletTxn,
  DeliveryShift,
  DeliverySession,
  DeliverySessionPoint,
  DeliveryDocument,
  DeliveryNotification,
  DeliveryDevice,
  UserDevice,
  UserNotification,
  PaymentIntent,
  Category,
  UserBank,
  Cashback,
  PromoCampaign,
  PromoTarget,
  PromoRedemption,
};
