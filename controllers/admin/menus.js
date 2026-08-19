// Cuisines and categories — administration/Categories::Index, backed by
// Catagories_Model (_GetCategoryTypes, _GetCategoryList, Category).
//
// This is the module the panel's existing "Categories" page does NOT cover.
// That page reads store_categories, a flat table; the PHP screen worked on
// store_menu, which is a different thing entirely:
//
//   menu_type = 0  →  a cuisine ("North Indian", "Chinese") — global, the
//                     vocabulary a vendor picks from in business_menu_types
//   menu_type = 1  →  a category inside one vendor's own menu, nested through
//                     menu_parent_id and tagged with menu_type_id = its cuisine
//
// Both live in store_menu and both are edited here, so nothing that the PHP
// panel could reach is left without a screen.
const { Op } = require("sequelize");
const { Menu, Business, ProductMenu } = require("../../models");
const { isAdminRole } = require("../../middlewares/verifyAdmin");

const CUISINE = 0;
const CATEGORY = 1;

// str_replace(' ,!@#$%^*()' → '-') then '&' → 'and', collapsing repeats, as
// Catagories_Model::Category built menu_slug before handing it to _Slug().
const slugify = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200) || "item";

/** _Slug(): appends the row id when the slug is already taken. */
async function uniqueSlug(base, menuId) {
  const clash = await Menu.findOne({ where: { menu_slug: base }, raw: true });
  if (clash == null || Number(clash.menu_id) === Number(menuId)) return base;
  return `${base}-${menuId}`;
}

const serialize = (m, extra = {}) => ({
  menu_id: m.menu_id,
  name: m.menu_name,
  title: m.menu_title,
  keywords: m.menu_keywords,
  description: m.menu_description,
  slug: m.menu_slug,
  image: m.menu_image,
  order: m.menu_order == null ? 0 : Number(m.menu_order),
  status: Number(m.menu_status),
  type: Number(m.menu_type),
  type_id: Number(m.menu_type_id),
  parent_id: Number(m.menu_parent_id),
  user_id: Number(m.menu_user_id),
  ...extra,
});

// Flattens the vendor's categories into the indented list _GetCategoryList
// produced, but sends `depth` instead of pre-rendered "&nbsp;&#8614;" spacing so
// the UI decides how to draw it.
function flattenTree(rows, parent = 0, depth = 0, out = []) {
  for (const row of rows.filter((r) => Number(r.menu_parent_id) === Number(parent))) {
    out.push(serialize(row, { depth }));
    flattenTree(rows, row.menu_id, depth + 1, out);
  }
  return out;
}

// GET /admin/menus/cuisines — the global cuisine vocabulary (menu_type 0).
exports.listCuisines = async (req, res) => {
  try {
    const rows = await Menu.findAll({
      where: { menu_type: CUISINE },
      order: [
        ["menu_order", "ASC"],
        ["menu_name", "ASC"],
      ],
      raw: true,
    });
    res.json({ cuisines: rows.map((r) => serialize(r)) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin cuisines ~ err:", err);
    res.status(500).json({ message: "Failed to load cuisines" });
  }
};

// GET /admin/menus/categories?vendor_id=&cuisine_id=
//
// A vendor may only ever see their own tree; an admin picks whose to look at.
// _GetCategoryList took user_id as its first argument for exactly this reason.
exports.listCategories = async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.panel.role);
    const vendorId = isAdmin && req.query.vendor_id ? Number(req.query.vendor_id) : req.panel.user_id;

    const where = { menu_type: CATEGORY, menu_user_id: vendorId };
    if (req.query.cuisine_id) where.menu_type_id = Number(req.query.cuisine_id);

    const rows = await Menu.findAll({
      where,
      order: [
        ["menu_order", "ASC"],
        ["menu_name", "ASC"],
      ],
      raw: true,
    });

    // Product counts, so an admin can see which categories are actually in use
    // before disabling one.
    const links = rows.length
      ? await ProductMenu.findAll({
          where: { product_menu_id: rows.map((r) => r.menu_id) },
          raw: true,
        })
      : [];
    const counts = {};
    for (const l of links) counts[l.product_menu_id] = (counts[l.product_menu_id] || 0) + 1;

    const tree = flattenTree(rows).map((n) => ({ ...n, product_count: counts[n.menu_id] || 0 }));
    res.json({ categories: tree, vendor_id: vendorId });
  } catch (err) {
    console.log("MFB-error-logs ~ admin categories tree ~ err:", err);
    res.status(500).json({ message: "Failed to load categories" });
  }
};

// POST /admin/menus  { type, name, title, keywords, description, image,
//                      parent_id, type_id, vendor_id, order, status }
exports.create = async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.panel.role);
    const type = Number(req.body.type) === CUISINE ? CUISINE : CATEGORY;

    if (type === CUISINE && !isAdmin) {
      return res.status(403).json({ message: "Only admin staff can add cuisines" });
    }
    if (!req.body.name) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!req.body.title) {
      return res.status(400).json({ message: "Title is required" });
    }

    // A cuisine belongs to nobody in particular; a category belongs to a vendor.
    // Only an admin may file one under someone else's account.
    let vendorId = req.panel.user_id;
    if (req.body.vendor_id && (isAdmin || type === CUISINE)) {
      vendorId = Number(req.body.vendor_id);
    }

    const created = await Menu.create({
      menu_type: type,
      menu_type_id: type === CUISINE ? 0 : Number(req.body.type_id) || 0,
      menu_parent_id: Number(req.body.parent_id) || 0,
      menu_name: String(req.body.name),
      menu_title: String(req.body.title).slice(0, 70),
      menu_keywords: req.body.keywords ? String(req.body.keywords).slice(0, 100) : null,
      menu_description: req.body.description || null,
      menu_slug: slugify(req.body.name),
      menu_order: Number(req.body.order) || 0,
      menu_image: req.body.image || null,
      menu_user_id: vendorId,
      menu_status: req.body.status === undefined ? 1 : Number(req.body.status) ? 1 : 0,
    });

    await created.update({ menu_slug: await uniqueSlug(slugify(req.body.name), created.menu_id) });
    res.status(201).json({ message: "Saved", menu: serialize(created) });
  } catch (err) {
    if (err?.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ message: "One with that name already exists here" });
    }
    console.log("MFB-error-logs ~ admin create menu ~ err:", err);
    res.status(500).json({ message: "Failed to save" });
  }
};

// PUT /admin/menus/:id
exports.update = async (req, res) => {
  try {
    const menu = await Menu.findByPk(req.params.id);
    if (menu == null) {
      return res.status(404).json({ message: "Not found" });
    }
    const isAdmin = isAdminRole(req.panel.role);
    if (!isAdmin && Number(menu.menu_user_id) !== Number(req.panel.user_id)) {
      return res.status(403).json({ message: "That is not yours to edit" });
    }
    if (Number(menu.menu_type) === CUISINE && !isAdmin) {
      return res.status(403).json({ message: "Only admin staff can edit cuisines" });
    }

    const patch = {};
    if (req.body.name !== undefined) patch.menu_name = String(req.body.name);
    if (req.body.title !== undefined) patch.menu_title = String(req.body.title).slice(0, 70);
    if (req.body.keywords !== undefined) {
      patch.menu_keywords = req.body.keywords ? String(req.body.keywords).slice(0, 100) : null;
    }
    if (req.body.description !== undefined) patch.menu_description = req.body.description || null;
    if (req.body.image !== undefined) patch.menu_image = req.body.image || null;
    if (req.body.order !== undefined) patch.menu_order = Number(req.body.order) || 0;
    if (req.body.status !== undefined) patch.menu_status = Number(req.body.status) ? 1 : 0;
    if (req.body.type_id !== undefined) patch.menu_type_id = Number(req.body.type_id) || 0;

    // Reparenting: a node may not become its own descendant.
    if (req.body.parent_id !== undefined) {
      const parentId = Number(req.body.parent_id) || 0;
      if (parentId === Number(menu.menu_id)) {
        return res.status(400).json({ message: "A category cannot be its own parent" });
      }
      if (parentId !== 0) {
        let cursor = await Menu.findByPk(parentId, { raw: true });
        while (cursor && Number(cursor.menu_parent_id) !== 0) {
          if (Number(cursor.menu_parent_id) === Number(menu.menu_id)) {
            return res.status(400).json({ message: "That would nest this category inside itself" });
          }
          cursor = await Menu.findByPk(cursor.menu_parent_id, { raw: true });
        }
      }
      patch.menu_parent_id = parentId;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }
    await menu.update(patch);

    if (patch.menu_name) {
      await menu.update({ menu_slug: await uniqueSlug(slugify(patch.menu_name), menu.menu_id) });
    }
    res.json({ message: "Saved", menu: serialize(menu) });
  } catch (err) {
    if (err?.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ message: "One with that name already exists here" });
    }
    console.log("MFB-error-logs ~ admin update menu ~ err:", err);
    res.status(500).json({ message: "Failed to save" });
  }
};

// DELETE /admin/menus/:id
//
// Ajax::Delete never really deleted — it set a status column to 0, so nothing
// referring to the row broke. Same here, with the checks the PHP skipped: a
// category holding products or children is refused rather than orphaning them.
exports.disable = async (req, res) => {
  try {
    const menu = await Menu.findByPk(req.params.id);
    if (menu == null) {
      return res.status(404).json({ message: "Not found" });
    }
    const isAdmin = isAdminRole(req.panel.role);
    if (!isAdmin && Number(menu.menu_user_id) !== Number(req.panel.user_id)) {
      return res.status(403).json({ message: "That is not yours to remove" });
    }

    const children = await Menu.count({ where: { menu_parent_id: menu.menu_id } });
    if (children > 0) {
      return res.status(409).json({ message: `Move or remove its ${children} sub-categories first` });
    }
    const linked = await ProductMenu.count({ where: { product_menu_id: menu.menu_id } });
    if (linked > 0) {
      return res.status(409).json({ message: `${linked} products are still in this category` });
    }

    await menu.update({ menu_status: 0 });
    res.json({ message: "Disabled" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin disable menu ~ err:", err);
    res.status(500).json({ message: "Failed to remove" });
  }
};

// GET /admin/menus/vendors — vendors that have a menu, for the admin's picker.
exports.vendors = async (req, res) => {
  try {
    const rows = await Business.findAll({
      attributes: ["user_id", "business_name", "business_menu_types"],
      order: [["business_name", "ASC"]],
      raw: true,
    });
    res.json({
      vendors: rows.map((b) => ({
        user_id: b.user_id,
        name: b.business_name,
        cuisine_ids: String(b.business_menu_types || "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter(Boolean),
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin menu vendors ~ err:", err);
    res.status(500).json({ message: "Failed to load vendors" });
  }
};

// GET /admin/menus/assignable?vendor_id= — the checkbox list the product form
// needs: every category belonging to that vendor, already flattened.
exports.assignable = async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.panel.role);
    const vendorId = isAdmin && req.query.vendor_id ? Number(req.query.vendor_id) : req.panel.user_id;
    const rows = await Menu.findAll({
      where: { menu_type: CATEGORY, menu_user_id: vendorId, menu_status: 1 },
      order: [
        ["menu_order", "ASC"],
        ["menu_name", "ASC"],
      ],
      raw: true,
    });
    res.json({ categories: flattenTree(rows) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin assignable menus ~ err:", err);
    res.status(500).json({ message: "Failed to load categories" });
  }
};

exports.CUISINE = CUISINE;
exports.CATEGORY = CATEGORY;
exports.slugify = slugify;

// Kept for the product controller, which needs the same "is this mine" rule.
exports.ownsMenus = async (vendorId, menuIds) => {
  if (menuIds.length === 0) return true;
  const owned = await Menu.count({
    where: { menu_id: { [Op.in]: menuIds }, menu_user_id: vendorId },
  });
  return owned === menuIds.length;
};
