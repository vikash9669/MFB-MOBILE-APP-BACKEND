var DataTypes = require("sequelize").DataTypes;
var _orderitems = require("./orderitems");
var _orders = require("./orders");
var _store_menu = require("./store_menu");
var _store_orders = require("./store_orders");
var _store_orders_details = require("./store_orders_details");
var _store_orders_log = require("./store_orders_log");
var _store_products = require("./store_products");
var _store_products_menu = require("./store_products_menu");
var _store_users = require("./store_users");
var _store_users_business = require("./store_users_business");
var _store_users_shipping_address = require("./store_users_shipping_address");

function initModels(sequelize) {
  var orderitems = _orderitems(sequelize, DataTypes);
  var orders = _orders(sequelize, DataTypes);
  var store_menu = _store_menu(sequelize, DataTypes);
  var store_orders = _store_orders(sequelize, DataTypes);
  var store_orders_details = _store_orders_details(sequelize, DataTypes);
  var store_orders_log = _store_orders_log(sequelize, DataTypes);
  var store_products = _store_products(sequelize, DataTypes);
  var store_products_menu = _store_products_menu(sequelize, DataTypes);
  var store_users = _store_users(sequelize, DataTypes);
  var store_users_business = _store_users_business(sequelize, DataTypes);
  var store_users_shipping_address = _store_users_shipping_address(sequelize, DataTypes);

  store_orders_log.belongsTo(store_orders, { as: "order", foreignKey: "order_id"});
  store_orders.hasMany(store_orders_log, { as: "store_orders_logs", foreignKey: "order_id"});
  store_orders_log.belongsTo(store_users, { as: "user", foreignKey: "user_id"});
  store_users.hasMany(store_orders_log, { as: "store_orders_logs", foreignKey: "user_id"});
  store_users_business.belongsTo(store_users, { as: "user", foreignKey: "user_id"});
  store_users.hasMany(store_users_business, { as: "store_users_businesses", foreignKey: "user_id"});

  return {
    orderitems,
    orders,
    store_menu,
    store_orders,
    store_orders_details,
    store_orders_log,
    store_products,
    store_products_menu,
    store_users,
    store_users_business,
    store_users_shipping_address,
  };
}
module.exports = initModels;
module.exports.initModels = initModels;
module.exports.default = initModels;
