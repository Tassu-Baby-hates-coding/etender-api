const router = require("express").Router();
const { pool } = require("../config/db");
const { asyncHandler, requireFields, HttpError } = require("../utils/http");
const { authenticate, requireAdmin } = require("../middleware/auth");

// GET /api/categories           -> active categories (public: used by registration form)
// GET /api/categories?all=1     -> all, with usage counts (admin pages send a token)
router.get("/", asyncHandler(async (req, res) => {
  const all = req.query.all === "1";
  const [rows] = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM tenders t WHERE t.category_id = c.id) AS tender_count,
            (SELECT COUNT(*) FROM bidder_categories bc WHERE bc.category_id = c.id) AS bidder_count
       FROM categories c ${all ? "" : "WHERE c.is_active = 1"}
      ORDER BY c.name`
  );
  res.json(rows);
}));

router.post("/", authenticate, requireAdmin(), asyncHandler(async (req, res) => {
  requireFields(req.body, ["name"]);
  const [r] = await pool.query("INSERT INTO categories (name, description) VALUES (?, ?)", [
    req.body.name.trim(), req.body.description || null,
  ]);
  res.status(201).json({ id: r.insertId });
}));

router.put("/:id", authenticate, requireAdmin(), asyncHandler(async (req, res) => {
  requireFields(req.body, ["name"]);
  const [r] = await pool.query("UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?", [
    req.body.name.trim(), req.body.description || null, req.body.is_active === false || req.body.is_active === 0 ? 0 : 1, req.params.id,
  ]);
  if (!r.affectedRows) throw new HttpError(404, "Category not found");
  res.json({ message: "Category updated" });
}));

// Delete only if unused; otherwise ask the admin to deactivate it
router.delete("/:id", authenticate, requireAdmin(), asyncHandler(async (req, res) => {
  const [[used]] = await pool.query("SELECT COUNT(*) AS n FROM tenders WHERE category_id = ?", [req.params.id]);
  if (used.n) throw new HttpError(409, "Category is used by tenders; deactivate it instead");
  const [r] = await pool.query("DELETE FROM categories WHERE id = ?", [req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, "Category not found");
  res.json({ message: "Category deleted" });
}));

module.exports = router;
