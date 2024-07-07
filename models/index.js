const Business = require("./business");
const Menu = require("./menu");
const Product = require("./product");
const ProductMenu = require("./productmenu");
const StoreOrderDetails = require("./store_orders_details");
const StoreOrderLogs = require("./store_orders_log");
const StoreOrders = require("./store_orders");
const StoreUserShippingAddress = require("./store_users_shipping_address");
const User = require("./user");

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

StoreOrders.belongsTo(Business, {
  foreignKey: "vendor_id",
  targetKey: "user_id",
});

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
};
