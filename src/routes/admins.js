// Super admin only: manage admin accounts and reveal their passwords.
const router = require("express").Router();
const { pool } = require("../config/db");
const { asyncHandler, requireFields, HttpError } = require("../utils/http");
const { encryptPassword, decryptPassword } = require("../utils/passwordCrypto");
const { authenticate, requireAdmin } = require("../middleware/auth");

router.use(authenticate, requireAdmin("super_admin"));

// GET /api/admins -> every admin and super admin
router.get("/", asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.name, a.email, a.phone, a.role, a.status, a.created_at, c.name AS created_by_name
       FROM admins a LEFT JOIN admins c ON c.id = a.created_by
      ORDER BY a.role = 'super_admin' DESC, a.created_at DESC`
  );
  res.json(rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  requireFields(req.body, ["name", "email", "password"]);
  if (req.body.password.length < 6) throw new HttpError(400, "Password must be at least 6 characters");
  const role = req.body.role === "super_admin" ? "super_admin" : "admin";
  const [r] = await pool.query(
    "INSERT INTO admins (name, email, phone, password, role, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    [req.body.name.trim(), req.body.email.trim().toLowerCase(), req.body.phone || null, encryptPassword(req.body.password), role, req.user.id]
  );
  res.status(201).json({ id: r.insertId });
}));

// PATCH /api/admins/:id   { name?, phone?, status?, password? }
router.patch("/:id", asyncHandler(async (req, res) => {
  const [[admin]] = await pool.query("SELECT * FROM admins WHERE id = ?", [req.params.id]);
  if (!admin) throw new HttpError(404, "Admin not found");
  const { name = admin.name, phone = admin.phone, status = admin.status, password } = req.body;
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "Invalid status");
  if (admin.id === req.user.id && status !== "active") throw new HttpError(400, "You cannot deactivate yourself");
  if (password !== undefined && String(password).length < 6) throw new HttpError(400, "Password must be at least 6 characters");
  await pool.query("UPDATE admins SET name = ?, phone = ?, status = ?, password = ? WHERE id = ?", [
    name, phone, status, password ? encryptPassword(password) : admin.password, admin.id,
  ]);
  res.json({ message: "Admin updated" });
}));

// GET /api/admins/:id/password -> decrypted with the same TripleDES algorithm
router.get("/:id/password", asyncHandler(async (req, res) => {
  const [[admin]] = await pool.query("SELECT id, email, password FROM admins WHERE id = ?", [req.params.id]);
  if (!admin) throw new HttpError(404, "Admin not found");
  console.log(`[password-reveal] super admin #${req.user.id} viewed admin #${admin.id}`);
  res.json({ id: admin.id, email: admin.email, password: decryptPassword(admin.password) });
}));

module.exports = router;
