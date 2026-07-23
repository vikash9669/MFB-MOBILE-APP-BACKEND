// Seeds a couple of restaurants (vendor user + business + menus + products)
// so the customer app has something to show against a fresh local database.
// Run with:  npm run seed   (loads .env for the DB connection)
//
// Fully re-runnable: it first removes any previous seed rows (matched by the
// vendor phone numbers below) and recreates them inside a transaction, so a
// partial/failed run leaves no orphans.
const sequelize = require("../util/database");
const {
  User,
  Business,
  Menu,
  Product,
  ProductMenu,
  Location,
  Area,
} = require("../models");

// Must match DEFAULT_CITY_PINCODE in controllers/products.js — the restaurant
// listing only returns vendors whose user_zip equals the requested pincode.
const PINCODE = "312601";

const restaurants = [
  {
    vendor: { name: "Spice Villa", phone: "9000000001" },
    business: {
      slug: "spice-villa",
      offer: "20% OFF up to ₹100",
      order: 1,
      open: "09:00:00",
      close: "23:00:00",
    },
    menus: [
      {
        name: "Starters",
        products: [
          { name: "Paneer Tikka", mrp: 220, desc: "Char-grilled cottage cheese with spices." },
          { name: "Veg Manchurian", mrp: 180, desc: "Fried veg balls in spicy Indo-Chinese gravy." },
        ],
      },
      {
        name: "Main Course",
        products: [
          { name: "Dal Makhani", mrp: 240, desc: "Creamy black lentils simmered overnight." },
          { name: "Butter Naan", mrp: 45, desc: "Soft tandoor bread brushed with butter." },
        ],
      },
    ],
  },
  {
    vendor: { name: "Biryani House", phone: "9000000002" },
    business: {
      slug: "biryani-house",
      offer: "Free delivery over ₹299",
      order: 2,
      open: "11:00:00",
      close: "23:30:00",
    },
    menus: [
      {
        name: "Biryani",
        products: [
          { name: "Chicken Dum Biryani", mrp: 260, desc: "Fragrant basmati layered with spiced chicken." },
          { name: "Veg Biryani", mrp: 200, desc: "Basmati rice cooked with mixed vegetables." },
        ],
      },
      {
        name: "Beverages",
        products: [
          { name: "Masala Chaas", mrp: 40, desc: "Spiced buttermilk, served chilled." },
        ],
      },
    ],
  },
];

const slugify = (s) => s.toLowerCase().replace(/\s+/g, "-");

// Removes any previously-seeded rows for these vendors, child-before-parent so
// foreign keys stay satisfied.
async function clearPreviousSeed(t) {
  const phones = restaurants.map((r) => r.vendor.phone);
  const seedUsers = await User.findAll({
    where: { user_phone: phones },
    attributes: ["user_id"],
    transaction: t,
  });
  const userIds = seedUsers.map((u) => u.user_id);
  if (userIds.length === 0) {
    return;
  }

  const products = await Product.findAll({
    where: { product_user_id: userIds },
    attributes: ["product_id"],
    transaction: t,
  });
  const productIds = products.map((p) => p.product_id);

  if (productIds.length) {
    await ProductMenu.destroy({ where: { product_id: productIds }, transaction: t });
  }
  await Product.destroy({ where: { product_user_id: userIds }, transaction: t });
  await Menu.destroy({ where: { menu_user_id: userIds }, transaction: t });
  await Area.destroy({ where: { area_user_id: userIds }, transaction: t });
  await Business.destroy({ where: { user_id: userIds }, transaction: t });
  await User.destroy({ where: { user_id: userIds }, transaction: t });
}

async function seedRestaurant(restaurant, location, t) {
  const vendor = await User.create(
    {
      user_name: restaurant.vendor.name,
      user_email: `${restaurant.business.slug}@example.com`,
      user_phone: restaurant.vendor.phone,
      user_phone_1: "",
      user_otp: "",
      user_code: restaurant.business.slug.toUpperCase().slice(0, 12),
      user_password: "",
      user_landmark: "",
      user_city: "101",
      user_state: 29,
      user_zip: PINCODE,
      user_active: 1,
    },
    { transaction: t }
  );

  // The business must exist before its menus: an association-generated FK ties
  // store_menu.menu_user_id to store_users_business.user_id.
  const business = await Business.create(
    {
      user_id: vendor.user_id,
      business_name: restaurant.vendor.name,
      business_order: restaurant.business.order,
      business_slug: restaurant.business.slug,
      business_menu_types: "0", // placeholder, updated once menu ids are known
      business_status: true,
      business_discount: 10,
      business_offer_text: restaurant.business.offer,
      business_open: restaurant.business.open,
      business_close: restaurant.business.close,
      business_fssai: "12345678901234",
    },
    { transaction: t }
  );

  const menuIds = [];
  for (const [menuIndex, menu] of restaurant.menus.entries()) {
    const createdMenu = await Menu.create(
      {
        menu_type: 0,
        menu_type_id: 1,
        menu_parent_id: 0,
        menu_name: menu.name,
        menu_slug: `${restaurant.business.slug}-${slugify(menu.name)}`,
        menu_order: menuIndex + 1,
        menu_user_id: vendor.user_id,
        menu_status: 1,
      },
      { transaction: t }
    );
    menuIds.push(createdMenu.menu_id);

    for (const [productIndex, product] of menu.products.entries()) {
      const createdProduct = await Product.create(
        {
          product_name: product.name,
          product_mrp: product.mrp,
          product_minimum: 1,
          product_price: product.mrp,
          product_image: "placeholder.webp",
          product_description: product.desc,
          product_user_id: vendor.user_id,
          product_order: productIndex + 1,
          product_status: 1,
        },
        { transaction: t }
      );
      await ProductMenu.create(
        { product_id: createdProduct.product_id, product_menu_id: createdMenu.menu_id },
        { transaction: t }
      );
    }
  }

  await business.update({ business_menu_types: menuIds.join(",") }, { transaction: t });

  await Area.create(
    {
      area_id: location.location_id,
      area_pincode: PINCODE,
      area_user_id: vendor.user_id,
      area_status: 1,
    },
    { transaction: t }
  );

  console.log(`Seeded "${restaurant.vendor.name}" (user_id=${vendor.user_id})`);
}

async function seed() {
  await sequelize.sync();

  await sequelize.transaction(async (t) => {
    await clearPreviousSeed(t);

    const [location] = await Location.findOrCreate({
      where: { location_pincode: PINCODE },
      defaults: {
        location_parent_id: 29,
        location_name: "Chittorgarh",
        location_pincode: PINCODE,
      },
      transaction: t,
    });

    for (const restaurant of restaurants) {
      await seedRestaurant(restaurant, location, t);
    }
  });

  console.log(`\nDone. Restaurants are visible for pincode ${PINCODE}.`);
}

seed()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error("Seed failed:", err);
    await sequelize.close();
    process.exit(1);
  });
