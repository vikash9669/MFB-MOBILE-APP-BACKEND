const {
  Product,
  Business,
  Menu,
  User,
  Area,
  Location,
} = require("../models/index");
const { Op } = require("sequelize");

const getRestaurants = async (req, res) => {
  try {
    const restaurants = await Business.findAll({
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
    const products = await Product.findAll({
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
    const stores = await Business.findAll({
      where: {
        business_status: true,
      },
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
      attributes: ["menu_id", "menu_name", "menu_user_id", "menu_image"],
      where: {
        [Op.and]: [
          {
            menu_id: {
              [Op.in]: uniqueMenuIds,
            },
          },
          { menu_status: 1 },
        ],
      },
    });

    const result = menuItems.map((menu) => ({
      menu_id: menu.menu_id,
      menu_name: menu.menu_name,
      menu_image: menu.menu_image,
      business_names: menuStoreMap.get(menu.menu_id) || [],
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message:
        "An error occurred while fetching unique menu names with store details",
    });
  }
};

const getBusinessByMenuId = async (req, res) => {
  const { businessId } = req.params;

  try {
    const stores = await Business.findAll({
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
    res.status(500).json({
      message: "An error occurred while fetching business details by menu id",
    });
  }
};

const getRestaurantsList = async (req, res) => {
  try {
    const businesses = await Business.findAll({
      where: {
        business_status: true,
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "user_id",
            "user_image",
            "user_name",
            "user_active",
            "user_login",
          ],
        },
      ],
      order: [["business_order", "ASC"]],
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
        "business_fssai",
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

      const areas = await Area.findAll({
        attributes: [
          "area_id",
          "area_checkout",
          "area_charge",
          "area_charge_free",
          "area_status",
          "area_user_id",
        ],
        where: {
          area_user_id: business.user_id,
        },
        include: [
          {
            model: Location,
            as: "location",
          },
        ],
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
        business_fssai: business.business_fssai,
        menus: menuItems.map((menu) => ({
          menu_id: menu.menu_id,
          menu_name: menu.menu_name,
        })),
        user: business.user,
        areas,
      };

      if (businessData.user.user_active) {
        response.push(businessData);
      }
    }

    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "An error occurred while fetching menus for businesses",
    });
  }
};

const getProductNamesByMenuUserId = async (req, res) => {
  const { menu_user_id } = req.params;

  try {
    const products = await Menu.findOne({
      where: { menu_user_id: menu_user_id },
      include: {
        model: Product,
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
    const menu = await Menu.findOne({
      where: {
        menu_id: menuId,
      },
      include: {
        model: Product,
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
    const business = await Business.findOne({
      where: { user_id: restaurantId },
      include: {
        model: Menu,
        as: "menus",
        attributes: ["menu_id", "menu_name", "menu_user_id", "menu_order"],
        include: {
          model: Product,
          where: { product_status: 1 },
          as: "products",
          attributes: [
            "product_id",
            "product_name",
            "product_mrp",
            "product_image",
            "product_description"
          ],
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
        menu_order: menu.menu_order,
        products: menu.products.map((product) => ({
          product_id: product.product_id,
          product_name: product.product_name,
          product_mrp: product.product_mrp,
          product_image: product.product_image,
          product_description: product.product_description
        })),
      })),
    };

    restaurantDetails.menus.sort((a, b) => a.menu_order - b.menu_order);

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
    const business = await Business.findOne({
      where: { user_id: userId },
      include: {
        model: Menu,
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

// const testController = async (req, res) => {
//   // const users = await User.findAll({
//   //   where: {
//   //     user_id: 8769,
//   //   },
//   // });
//   const restaurants = await Business.findAll({
//     where: {
//       user_id: 16,
//     },
//   });
//   res.json({ restaurants });
// };

module.exports = {
  getMenuNamesByUserId,
  getProducts,
  getRestaurants,
  getMenu,
  getBusinessByMenuId,
  getProductNamesByMenuUserId,
  getProductsByMenuId,
  getRestaurantsList,
  getRestaurantDetailsByRestaurantId,
  // testController,
};
