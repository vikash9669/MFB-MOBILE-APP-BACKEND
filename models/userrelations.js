const StoreOrders = require('./store_orders');
const StoreOrderDetails = require('./store_orders_details');
const StoreProducts = require('./product');
const StoreUsersBusiness = require('./business');

StoreOrders.hasMany(StoreOrderDetails, { foreignKey: 'order_id' });
StoreOrderDetails.belongsTo(StoreOrders, { foreignKey: 'order_id' });

StoreProducts.belongsTo(StoreOrderDetails, { foreignKey: 'product_id' });

StoreOrders.belongsTo(StoreUsersBusiness, { foreignKey: 'vendor_id', targetKey: 'user_id' });

module.exports = {
    StoreOrders,
    StoreOrderDetails,
    StoreProducts,
    StoreUsersBusiness
};
