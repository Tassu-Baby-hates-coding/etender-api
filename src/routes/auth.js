const fs = require("fs");
const router = require("express").Router();
const { pool, withTransaction } = require("../config/db");
const { asyncHandler, requireFields, HttpError } = require("../utils/http");
const { encryptPassword, passwordMatches } = require("../utils/passwordCrypto");
const { signToken, authenticate } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { notifyAllAdmins } = require("../services/notificationService");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicAdmin = (a) => ({ type: "admin", id: a.id, name: a.name, email: a.email, phone: a.phone, role: a.role });
const publicBidder = (b) => ({
  type: "bidder", role: "bidder", id: b.id, bidder_id: b.id, name: b.contact_name || b.name,
  company_name: b.company_name, email: b.email, phone: b.phone, status: b.status,
});

// POST /api/auth/login  { email, password, portal: 'admin' | 'bidder' }
router.post("/login", asyncHandler(async (req, res) => {
  requireFields(req.body, ["email", "password", "portal"]);
  const email = String(req.body.email).trim().toLowerCase();
  const { password, portal } = req.body;

  if (portal === "admin") {
    const [[a]] = await pool.query("SELECT * FROM admins WHERE email = ?", [email]);
    if (!a || !passwordMatches(password, a.password)) throw new HttpError(401, "Wrong email or password");
    if (a.status !== "active") throw new HttpError(403, "Your account is inactive");
    return res.json({ token: signToken("admin", a.id), user: publicAdmin(a) });
  }

  if (portal === "bidder") {
    const [[b]] = await pool.query("SELECT * FROM bidders WHERE email = ?", [email]);
    if (!b || !passwordMatches(password, b.password)) throw new HttpError(401, "Wrong email or password");
    if (!b.is_active) throw new HttpError(403, "Your account is inactive");
    if (b.status === "pending") throw new HttpError(403, "Your registration is waiting for admin approval");
    if (b.status === "rejected") throw new HttpError(403, "Your registration was rejected");
    return res.json({ token: signToken("bidder", b.id), user: publicBidder(b) });
  }

  throw new HttpError(400, "portal must be admin or bidder");
}));

// GET /api/auth/document-types  (public: registration form)
router.get("/document-types", asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT id, name, is_required FROM document_types WHERE is_active = 1 ORDER BY id");
  res.json(rows);
}));

// POST /api/auth/register  multipart: bidder fields, category_ids, and one file per
// document type in a field named document_<typeId>
router.post("/register", upload.any(), asyncHandler(async (req, res) => {
  const files = req.files || [];
  try {
    requireFields(req.body, ["contact_name", "email", "phone", "password", "company_name"]);
    const email = req.body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Invalid email");
    if (req.body.password.length < 6) throw new HttpError(400, "Password must be at least 6 characters");

    const categoryIds = [...new Set(String(req.body.category_ids || "").replace(/[[\]\s"]/g, "").split(",").map(Number).filter(Boolean))];
    if (!categoryIds.length) throw new HttpError(400, "Select at least one category");

    const [docTypes] = await pool.query("SELECT id, name, is_required FROM document_types WHERE is_active = 1");
    const docs = files.map((f) => ({ file: f, typeId: Number(f.fieldname.replace("document_", "")) }));
    if (docs.some((d) => !docTypes.find((t) => t.id === d.typeId))) throw new HttpError(400, "Unknown document type");
    const missing = docTypes.filter((t) => t.is_required && !docs.find((d) => d.typeId === t.id));
    if (missing.length) throw new HttpError(400, `Upload required documents: ${missing.map((t) => t.name).join(", ")}`);

    const bidderId = await withTransaction(async (conn) => {
      const [b] = await conn.query(
        `INSERT INTO bidders (company_name, contact_name, email, phone, company_address, trade_license_no, password)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.body.company_name.trim(), req.body.contact_name.trim(), email, req.body.phone.trim(),
          req.body.company_address || null, req.body.trade_license_no || null, encryptPassword(req.body.password)]
      );
      const [validCats] = await conn.query("SELECT id FROM categories WHERE id IN (?) AND is_active = 1", [categoryIds]);
      if (!validCats.length) throw new HttpError(400, "Select at least one valid category");
      await conn.query("INSERT INTO bidder_categories (bidder_id, category_id) VALUES ?", [validCats.map((c) => [b.insertId, c.id])]);
      if (docs.length) {
        await conn.query(
          "INSERT INTO bidder_documents (bidder_id, document_type_id, file_url, original_name) VALUES ?",
          [docs.map((d) => [b.insertId, d.typeId, fileUrl(d.file), d.file.originalname.slice(0, 200)])]
        );
      }
      return b.insertId;
    });

    await notifyAllAdmins({ kind: "registration", message: `New bidder registration: ${req.body.company_name}` });
    res.status(201).json({ message: "Registration submitted. Please wait for admin approval.", bidder_id: bidderId });
  } catch (err) {
    files.forEach((f) => fs.unlink(f.path, () => {})); // don't keep files of a failed registration
    throw err;
  }
}));

// GET /api/auth/me
router.get("/me", authenticate, (req, res) =>
  res.json(req.user.type === "admin" ? publicAdmin(req.user) : publicBidder(req.user)));

module.exports = router;
