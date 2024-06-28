// models/index.js
const StoreName = require('./business')
const StoreMenu = require('./menu');
const StoreItems = require('./product');
const StoreProductsMenu = require('./productmenu')

StoreName.hasMany(StoreMenu, {
    foreignKey: 'menu_user_id',
    sourceKey: 'user_id',
    as: 'menus'
});

StoreMenu.belongsTo(StoreName, {
    foreignKey: 'menu_user_id',
    targetKey: 'user_id'
});


StoreMenu.belongsToMany(StoreItems, {
    through: StoreProductsMenu,
    foreignKey: 'product_menu_id',
    otherKey: 'product_id',
    as: 'products'
});

StoreItems.belongsToMany(StoreMenu, {
    through: StoreProductsMenu,
    foreignKey: 'product_id',
    otherKey: 'product_menu_id',
    as: 'menus'
});



module.exports = {
    StoreName,
    StoreMenu,
    StoreItems,
    StoreProductsMenu
};
