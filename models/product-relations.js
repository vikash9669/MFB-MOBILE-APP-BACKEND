const StoreMenu = require('./menu');
const StoreProducts = require('./product');
const StoreProductsMenu = require('./productmenu');

StoreMenu.belongsToMany(StoreProducts, {
    through: StoreProductsMenu,
    foreignKey: 'product_menu_id',
    otherKey: 'product_id',
    as: 'products'
});

StoreProducts.belongsToMany(StoreMenu, {
    through: StoreProductsMenu,
    foreignKey: 'product_id',
    otherKey: 'product_menu_id',
    as: 'menus'
});

module.exports = {
    StoreMenu,
    StoreProducts,
    StoreProductsMenu
};
