// Products + Categories — the React equivalent of administration/Products::Index,
// administration/Categories::Index and the Ajax::Status / Ajax::Delete helpers
// those pages relied on.
const { Op } = require("sequelize");
const {
  Product,
  Category,
  Business,
  Menu,
  ProductMenu,
  StoreOrderDetails,
} = require("../../models");
const sequelize = require("../../util/database");
const { isAdminRole } = require("../../middlewares/verifyAdmin");

const num = (v) => Number(v || 0);

const serializeProduct = (p, vendorName) => ({
  product_id: p.product_id,
  name: p.product_name,
  mrp: num(p.product_mrp),
  price: num(p.product_price),
  minimum: num(p.product_minimum),
  title: p.product_title || "",
  keywords: p.product_keywords || "",
  description: p.product_description || "",
  order: num(p.product_order),
  open: p.product_open,
  close: p.product_close,
  status: Number(p.product_status ?? 1),
  vendor_id: p.product_user_id,
  vendor_name: vendorName || null,
  image: p.product_image || null,
});

// Products::Index validated name, price, mrp, minimum, title and at least one
// category before writing anything. Same rules, one place.
function validateProduct(body, { partial = false } = {}) {
  const errors = {};
  const has = (k) => body[k] !== undefined && body[k] !== null && body[k] !== "";

  if (!partial || has("name")) {
    if (!has("name")) errors.name = "Product name is required";
    else if (String(body.name).length > 100) errors.name = "Name must be 100 characters or fewer";
  }
  if (!partial || has("title")) {
    if (!has("title")) errors.title = "Title is required";
    else if (String(body.title).length > 70) errors.title = "Title must be 70 characters or fewer";
  }
  for (const field of ["mrp", "price"]) {
    if (!partial || has(field)) {
      if (!has(field)) errors[field] = `${field.toUpperCase()} is required`;
      else if (Number.isNaN(Number(body[field])) || Number(body[field]) < 0) {
        errors[field] = "Must be a number";
      }
    }
  }
  if (has("minimum") && (!Number.isInteger(Number(body.minimum)) || Number(body.minimum) < 0)) {
    errors.minimum = "Minimum order quantity must be a whole number";
  }
  if (!partial && (!Array.isArray(body.category_ids) || body.category_ids.length === 0)) {
    errors.category_ids = "Pick at least one category";
  }
  return errors;
}

/** Replaces a product's store_products_menu rows, as Products_Model did. */
async function syncCategories(productId, categoryIds, transaction) {
  await ProductMenu.destroy({ where: { product_id: productId }, transaction });
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return;
  await ProductMenu.bulkCreate(
    [...new Set(categoryIds.map(Number))].map((id) => ({
      product_id: productId,
      product_menu_id: id,
    })),
    { transaction }
  );
}

/** Vendors may only touch their own catalogue; admin staff may touch any. */
const mayEdit = (panel, product) =>
  isAdminRole(panel.role) || Number(product.product_user_id) === Number(panel.user_id);

// GET /admin/products?page=&limit=&search=&vendor_id=&status=
exports.listProducts = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const where = {};
    if (req.query.search) {
      where.product_name = { [Op.like]: `%${String(req.query.search).trim()}%` };
    }
    if (req.query.vendor_id) {
      where.product_user_id = Number(req.query.vendor_id);
    }
    if (req.query.status !== undefined && req.query.status !== "") {
      where.product_status = Number(req.query.status);
    }

    const { count, rows } = await Product.findAndCountAll({
      where,
      order: [["product_id", "DESC"]],
      limit,
      offset: (page - 1) * limit,
      raw: true,
    });

    const vendorIds = [...new Set(rows.map((r) => r.product_user_id).filter(Boolean))];
    const businesses = vendorIds.length
      ? await Business.findAll({
          where: { user_id: vendorIds },
          attributes: ["user_id", "business_name"],
          raw: true,
        })
      : [];
    const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));

    res.json({
      products: rows.map((p) => serializeProduct(p, bizById[p.product_user_id])),
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin products ~ err:", err);
    res.status(500).json({ message: "Failed to load products" });
  }
};

// GET /admin/products/search?search= — the picker behind "Copy Products".
//
// Unlike listProducts this is open to vendors as well, because the whole point
// of the PHP screen was letting a vendor browse everyone's catalogue and pull a
// dish into their own. It returns other people's products only.
exports.searchCatalogue = async (req, res) => {
  try {
    const term = String(req.query.search || "").trim();
    if (term.length < 2) {
      return res.json({ products: [] });
    }
    const isAdmin = isAdminRole(req.panel.role);
    const mine = isAdmin && req.query.vendor_id ? Number(req.query.vendor_id) : req.panel.user_id;

    const rows = await Product.findAll({
      where: {
        product_name: { [Op.like]: `%${term}%` },
        product_user_id: { [Op.ne]: mine },
      },
      order: [["product_name", "ASC"]],
      limit: 40,
      raw: true,
    });

    const vendorIds = [...new Set(rows.map((r) => r.product_user_id).filter(Boolean))];
    const businesses = vendorIds.length
      ? await Business.findAll({
          where: { user_id: vendorIds },
          attributes: ["user_id", "business_name"],
          raw: true,
        })
      : [];
    const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));

    res.json({ products: rows.map((p) => serializeProduct(p, bizById[p.product_user_id])) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin catalogue search ~ err:", err);
    res.status(500).json({ message: "Failed to search products" });
  }
};

// GET /admin/products/:id — the `isset($proid)` branch of Products::Index,
// which the edit form called to populate itself.
exports.productDetail = async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id, { raw: true });
    if (product == null) {
      return res.status(404).json({ message: "Product not found" });
    }
    if (!mayEdit(req.panel, product)) {
      return res.status(403).json({ message: "That product is not yours" });
    }
    const [business, links] = await Promise.all([
      Business.findOne({ where: { user_id: product.product_user_id }, raw: true }),
      ProductMenu.findAll({ where: { product_id: product.product_id }, raw: true }),
    ]);
    res.json({
      product: serializeProduct(product, business?.business_name),
      category_ids: links.map((l) => l.product_menu_id),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin product detail ~ err:", err);
    res.status(500).json({ message: "Failed to load product" });
  }
};

// POST /admin/products — Products::Index's insert branch.
//
// The PHP had no create screen an admin could reach for someone else's store:
// it always wrote product_user_id = the logged-in user, so staff could only add
// products to their own (non-existent) shop. Here a vendor is chosen explicitly,
// defaulting to the caller, which is what the form was clearly meant to do.
exports.createProduct = async (req, res) => {
  const errors = validateProduct(req.body);
  if (Object.keys(errors).length > 0) {
    return res.status(422).json({ message: "Check the highlighted fields", errors });
  }
  if (!req.body.image) {
    return res.status(422).json({
      message: "Check the highlighted fields",
      errors: { image: "A product image is required" },
    });
  }

  const isAdmin = isAdminRole(req.panel.role);
  const vendorId = isAdmin && req.body.vendor_id ? Number(req.body.vendor_id) : req.panel.user_id;

  const transaction = await sequelize.transaction();
  try {
    // Categories must belong to the vendor the product is being filed under,
    // or the storefront would list it in a menu that is not the store's.
    const categoryIds = [...new Set((req.body.category_ids || []).map(Number))];
    const owned = await Menu.count({
      where: { menu_id: { [Op.in]: categoryIds }, menu_user_id: vendorId },
      transaction,
    });
    if (owned !== categoryIds.length) {
      await transaction.rollback();
      return res.status(422).json({
        message: "Check the highlighted fields",
        errors: { category_ids: "Those categories do not belong to this vendor" },
      });
    }

    const created = await Product.create(
      {
        product_name: String(req.body.name),
        product_title: String(req.body.title).slice(0, 70),
        product_keywords: req.body.keywords ? String(req.body.keywords).slice(0, 190) : null,
        product_description: req.body.description || String(req.body.name),
        product_mrp: num(req.body.mrp),
        product_price: num(req.body.price),
        product_minimum: num(req.body.minimum) || 1,
        product_image: String(req.body.image),
        product_order: num(req.body.order),
        product_user_id: vendorId,
        product_status: req.body.status === undefined ? 1 : Number(req.body.status) ? 1 : 0,
        product_open: req.body.open || "00:00:00",
        product_close: req.body.close || "23:59:59",
      },
      { transaction }
    );

    await syncCategories(created.product_id, categoryIds, transaction);
    await transaction.commit();
    res.status(201).json({ message: "Product created", product_id: created.product_id });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin create product ~ err:", err);
    res.status(500).json({ message: "Failed to create product" });
  }
};

// PUT /admin/products/:id — the update branch. Every field is optional so the
// list page's one-click publish/hide keeps working unchanged.
exports.updateProduct = async (req, res) => {
  const errors = validateProduct(req.body, { partial: true });
  if (Object.keys(errors).length > 0) {
    return res.status(422).json({ message: "Check the highlighted fields", errors });
  }

  const transaction = await sequelize.transaction();
  try {
    const product = await Product.findByPk(req.params.id, { transaction });
    if (product == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Product not found" });
    }
    if (!mayEdit(req.panel, product)) {
      await transaction.rollback();
      return res.status(403).json({ message: "That product is not yours" });
    }

    const patch = {};
    if (req.body.name !== undefined) patch.product_name = String(req.body.name);
    if (req.body.title !== undefined) patch.product_title = String(req.body.title).slice(0, 70);
    if (req.body.keywords !== undefined) {
      patch.product_keywords = req.body.keywords ? String(req.body.keywords).slice(0, 190) : null;
    }
    if (req.body.description !== undefined) patch.product_description = req.body.description || "";
    if (req.body.mrp !== undefined) patch.product_mrp = num(req.body.mrp);
    if (req.body.price !== undefined) patch.product_price = num(req.body.price);
    if (req.body.minimum !== undefined) patch.product_minimum = num(req.body.minimum);
    if (req.body.image !== undefined && req.body.image) patch.product_image = String(req.body.image);
    if (req.body.order !== undefined) patch.product_order = num(req.body.order);
    if (req.body.open !== undefined) patch.product_open = req.body.open;
    if (req.body.close !== undefined) patch.product_close = req.body.close;
    if (req.body.status !== undefined) patch.product_status = Number(req.body.status) ? 1 : 0;

    const changingCategories = Array.isArray(req.body.category_ids);
    if (Object.keys(patch).length === 0 && !changingCategories) {
      await transaction.rollback();
      return res.status(400).json({ message: "Nothing to update" });
    }

    if (changingCategories) {
      const categoryIds = [...new Set(req.body.category_ids.map(Number))];
      const owned = await Menu.count({
        where: { menu_id: { [Op.in]: categoryIds }, menu_user_id: product.product_user_id },
        transaction,
      });
      if (owned !== categoryIds.length) {
        await transaction.rollback();
        return res.status(422).json({
          message: "Check the highlighted fields",
          errors: { category_ids: "Those categories do not belong to this vendor" },
        });
      }
      await syncCategories(product.product_id, categoryIds, transaction);
    }

    if (Object.keys(patch).length > 0) await product.update(patch, { transaction });
    await transaction.commit();
    res.json({ message: "Product updated" });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin update product ~ err:", err);
    res.status(500).json({ message: "Failed to update product" });
  }
};

// DELETE /admin/products/:id — Ajax::Delete, which flipped a status rather than
// removing the row. Orders reference products by id forever, so a row that has
// ever been ordered can only be hidden: deleting it would blank out the line
// items of past orders (and store_orders_details holds an FK to it besides).
//
// A dish that has never been ordered has nothing pointing at it, so the vendor's
// "Remove" really removes it — a store that mistyped a product should not be
// stuck with it hidden in their list forever. `deleted` tells the caller which
// of the two happened so the UI can say so.
exports.deleteProduct = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const product = await Product.findByPk(req.params.id, { transaction });
    if (product == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Product not found" });
    }
    if (!mayEdit(req.panel, product)) {
      await transaction.rollback();
      return res.status(403).json({ message: "That product is not yours" });
    }

    const ordered = await StoreOrderDetails.count({
      where: { product_id: product.product_id },
      transaction,
    });
    if (ordered > 0) {
      await product.update({ product_status: 0 }, { transaction });
      await transaction.commit();
      return res.json({
        message: "This dish has been ordered before, so it was hidden rather than deleted",
        deleted: false,
      });
    }

    await syncCategories(product.product_id, [], transaction);
    await product.destroy({ transaction });
    await transaction.commit();
    res.json({ message: "Product removed from the store", deleted: true });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin delete product ~ err:", err);
    res.status(500).json({ message: "Failed to remove product" });
  }
};

// POST /admin/products/copy  { product_id, vendor_id }
//
// administration/Vendor::Products and Settings::Products — "Copy Products".
// Both searched the whole catalogue and cloned a chosen row into the caller's
// own store at product_status 0, so it lands hidden and has to be reviewed and
// published deliberately. The PHP version copied product_title / keywords /
// description as the product name; that was a bug born of copy-paste, so the
// real values are carried over instead.
exports.copyProduct = async (req, res) => {
  try {
    const source = await Product.findByPk(Number(req.body.product_id), { raw: true });
    if (source == null) {
      return res.status(404).json({ message: "Product not found" });
    }

    const isAdmin = isAdminRole(req.panel.role);
    const vendorId = isAdmin && req.body.vendor_id ? Number(req.body.vendor_id) : req.panel.user_id;

    if (Number(source.product_user_id) === vendorId) {
      return res.status(400).json({ message: "That product is already in this store" });
    }
    const already = await Product.findOne({
      where: { product_user_id: vendorId, product_name: source.product_name },
      raw: true,
    });
    if (already) {
      return res.status(409).json({ message: "A product with that name is already in this store" });
    }

    const created = await Product.create({
      product_name: source.product_name,
      product_title: source.product_title || source.product_name,
      product_keywords: source.product_keywords,
      product_description: source.product_description || source.product_name,
      product_mrp: num(source.product_mrp),
      product_price: num(source.product_price),
      product_minimum: num(source.product_minimum) || 1,
      product_image: source.product_image,
      product_order: num(source.product_order),
      product_user_id: vendorId,
      // Hidden until the new owner sets their own price and publishes it.
      product_status: 0,
      product_open: source.product_open,
      product_close: source.product_close,
    });

    res.status(201).json({
      message: "Copied into the store as a hidden product",
      product_id: created.product_id,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin copy product ~ err:", err);
    res.status(500).json({ message: "Failed to copy product" });
  }
};

// GET /admin/categories
exports.listCategories = async (req, res) => {
  try {
    const rows = await Category.findAll({ order: [["cat_id", "ASC"]], raw: true });
    const counts = await Product.findAll({
      attributes: ["product_cat_id", [Product.sequelize.fn("COUNT", Product.sequelize.col("product_id")), "n"]],
      group: ["product_cat_id"],
      raw: true,
    }).catch(() => []);
    const countById = Object.fromEntries(counts.map((c) => [c.product_cat_id, Number(c.n)]));

    res.json({
      categories: rows.map((c) => ({
        cat_id: c.cat_id,
        name: c.cat_name,
        image: c.cat_image,
        status: Number(c.cat_status),
        product_count: countById[c.cat_id] ?? null,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin categories ~ err:", err);
    res.status(500).json({ message: "Failed to load categories" });
  }
};

// POST /admin/categories  { name, image, status }
exports.createCategory = async (req, res) => {
  try {
    if (!req.body.name) {
      return res.status(400).json({ message: "Category name is required" });
    }
    const created = await Category.create({
      cat_name: String(req.body.name),
      cat_image: req.body.image || null,
      cat_status: req.body.status === undefined ? 1 : Number(req.body.status) ? 1 : 0,
    });
    res.status(201).json({ message: "Category created", cat_id: created.cat_id });
  } catch (err) {
    console.log("MFB-error-logs ~ admin create category ~ err:", err);
    res.status(500).json({ message: "Failed to create category" });
  }
};

// PUT /admin/categories/:id
exports.updateCategory = async (req, res) => {
  try {
    const cat = await Category.findByPk(req.params.id);
    if (cat == null) {
      return res.status(404).json({ message: "Category not found" });
    }
    const patch = {};
    if (req.body.name !== undefined) patch.cat_name = String(req.body.name);
    if (req.body.image !== undefined) patch.cat_image = req.body.image;
    if (req.body.status !== undefined) patch.cat_status = Number(req.body.status) ? 1 : 0;
    await cat.update(patch);
    res.json({ message: "Category updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin update category ~ err:", err);
    res.status(500).json({ message: "Failed to update category" });
  }
};
