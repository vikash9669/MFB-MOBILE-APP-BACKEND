const StoreProducts = require("../models/product");
const Restaurants = require("../models/business");
const Menu = require("../models/menu");

const {
  StoreName,
  StoreMenu,
  StoreItems,
} = require("../models/menu-relations");
const { Op } = require("sequelize");

const getRestaurants = async (req, res) => {
  try {
    const restaurants = await Restaurants.findAll({
      attributes: [
        "business_id",
        "user_id",
        "business_name",
        "business_menu_types",
        "business_open",
        "business_close",
        "business_commision",
      ],
    });
    res.status(200).json(restaurants);
    console.log("working");
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching store products" });
  }
};

const getProducts = async (req, res) => {
  try {
    const products = await StoreProducts.findAll({
      attributes: ["product_name", "product_id", "product_user_id"],
    });
    res.status(200).json(products);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching store products" });
  }
};

const getMenu = async (req, res) => {
  try {
    const stores = await Restaurants.findAll({
      attributes: [
        "business_id",
        "user_id",
        "business_name",
        "business_menu_types",
      ],
    });

    const menuStoreMap = new Map();

    stores.forEach((store) => {
      const menuIds = store.business_menu_types
        .split(",")
        .map((id) => parseInt(id.trim()));
      menuIds.forEach((menuId) => {
        if (!menuStoreMap.has(menuId)) {
          menuStoreMap.set(menuId, []);
        }
        menuStoreMap.get(menuId).push({
          business_id: store.business_id,
          user_id: store.user_id,
          business_name: store.business_name,
        });
      });
    });

    const uniqueMenuIds = [...menuStoreMap.keys()];
    const menuItems = await Menu.findAll({
      attributes: ["menu_id", "menu_name", "menu_user_id"],
      where: {
        menu_id: {
          [Op.in]: uniqueMenuIds,
        },
      },
    });

    const result = menuItems.map((menu) => ({
      menu_id: menu.menu_id,
      menu_name: menu.menu_name,
      business_names: menuStoreMap.get(menu.menu_id) || [],
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({
        message:
          "An error occurred while fetching unique menu names with store details",
      });
  }
};

const getBusinessByMenuId = async (req, res) => {
  const { businessId } = req.params;

  try {
    const stores = await Restaurants.findAll({
      where: {
        business_id: businessId,
      },
      attributes: [
        "business_id",
        "user_id",
        "business_name",
        "business_menu_types",
      ],
    });

    if (stores.length === 0) {
      return res.status(404).json({ message: "Business not found" });
    }

    const business = stores[0];
    const menuIds = business.business_menu_types
      .split(",")
      .map((id) => parseInt(id.trim()));

    const menuItems = await Menu.findAll({
      attributes: ["menu_id", "menu_name", "menu_user_id"],
      where: {
        menu_id: {
          [Op.in]: menuIds,
        },
      },
    });

    const result = {
      business_id: business.business_id,
      user_id: business.user_id,
      business_name: business.business_name,
      menus: menuItems.map((menu) => ({
        menu_id: menu.menu_id,
        menu_name: menu.menu_name,
      })),
    };

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({
        message: "An error occurred while fetching business details by menu id",
      });
  }
};

const getMenuForBusinesses = async (req, res) => {
  try {
    const businesses = await Restaurants.findAll({
      attributes: [
        "business_id",
        "user_id",
        "business_name",
        "business_offer_text",
        "business_open",
        "business_close",
        "business_status",
        "business_discount",
        "business_slug",
        "business_menu_types",
      ],
    });

    const response = [];

    for (const business of businesses) {
      const menuIds = business.business_menu_types
        .split(",")
        .map((id) => parseInt(id.trim()));

      const menuItems = await Menu.findAll({
        attributes: ["menu_id", "menu_name"],
        where: {
          menu_id: {
            [Op.in]: menuIds,
          },
        },
      });

      const businessData = {
        business_id: business.business_id,
        user_id: business.user_id,
        business_name: business.business_name,
        business_open: business.business_open,
        business_close: business.business_close,
        business_slug: business.business_slug,
        business_offer_text: business.business_offer_text,
        business_status: business.business_status,
        menus: menuItems.map((menu) => ({
          menu_id: menu.menu_id,
          menu_name: menu.menu_name,
        })),
      };

      response.push(businessData);
    }

    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({
        message: "An error occurred while fetching menus for businesses",
      });
  }
};

const getProductNamesByMenuUserId = async (req, res) => {
  const { menu_user_id } = req.params;

  try {
    const products = await StoreMenu.findOne({
      where: { menu_user_id: menu_user_id },
      include: {
        model: StoreItems,
        as: "products",
        attributes: ["product_id", "product_name", "product_user_id"],
      },
    });

    if (!products) {
      return res.status(404).json({ message: "Products not found" });
    }

    const productNames = products.products.map((product) => ({
      product_id: product.product_id,
      product_name: product.product_name,
      product_user_id: product.product_user_id,
    }));

    res.status(200).json(productNames);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching menu names" });
  }
};

const getProductsByMenuId = async (req, res) => {
  const { menuId } = req.params;

  try {
    const menu = await StoreMenu.findOne({
      where: {
        menu_id: menuId,
      },
      include: {
        model: StoreProducts,
        as: "products",
        attributes: ["product_id", "product_name", "product_mrp"],
      },
    });

    if (!menu) {
      return res.status(404).json({ message: "Menu not found" });
    }

    const products = menu.products.map((product) => ({
      product_id: product.product_id,
      product_name: product.product_name,
      product_mrp: product.product_mrp,
    }));

    res.status(200).json(products);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching products" });
  }
};
const getRestaurantDetailsByRestaurantId = async (req, res) => {
  const { restaurantId } = req.params;

  try {
    const business = await StoreName.findOne({
      where: { user_id: restaurantId },
      include: {
        model: StoreMenu,
        as: "menus",
        attributes: ["menu_id", "menu_name", "menu_user_id"],
        include: {
          model: StoreProducts,
          as: "products",
          attributes: ["product_id", "product_name", "product_mrp"],
        },
      },
    });

    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    const restaurantDetails = {
      business_name: business.store_name,
      menus: business.menus.map((menu) => ({
        menu_id: menu.menu_id,
        menu_name: menu.menu_name,
        menu_user_id: menu.menu_user_id,
        products: menu.products.map((product) => ({
          product_id: product.product_id,
          product_name: product.product_name,
          product_mrp: product.product_mrp,
        })),
      })),
    };

    res.status(200).json(restaurantDetails);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching restaurant details" });
  }
};

const getMenuNamesByUserId = async (req, res) => {
  const { userId } = req.params;
  try {
    // Fetch the business to verify it exists
    const business = await StoreName.findOne({
      where: { user_id: userId },
      include: {
        model: StoreMenu,
        as: "menus",
        attributes: ["menu_id", "menu_name", "menu_user_id"],
      },
    });

    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    const menuNames = business.menus.map((menu) => ({
      menu_id: menu.menu_id,
      menu_name: menu.menu_name,
      menu_user_id: menu.menu_user_id,
    }));

    res.status(200).json(menuNames);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching menu names" });
  }
};

module.exports = {
  getMenuNamesByUserId,
  getProducts,
  getRestaurants,
  getMenu,
  getBusinessByMenuId,
  getProductNamesByMenuUserId,
  getProductsByMenuId,
  getMenuForBusinesses,
  getRestaurantDetailsByRestaurantId,
};
