// Admins: approve bidders, check documents, reveal and reset bidder passwords.
const router = require("express").Router();
const { pool } = require("../config/db");
const { asyncHandler, HttpError } = require("../utils/http");
const { encryptPassword, decryptPassword } = require("../utils/passwordCrypto");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { notify } = require("../services/notificationService");

router.use(authenticate, requireAdmin());

const BIDDER_SELECT = `
  SELECT b.id, b.company_name, b.contact_name AS name, b.email, b.phone, b.company_address,
         b.trade_license_no, b.status, b.is_active, b.approved_at, b.created_at,
         ap.name AS approved_by_name,
         (SELECT GROUP_CONCAT(c.name ORDER BY c.name SEPARATOR ', ')
            FROM bidder_categories bc JOIN categories c ON c.id = bc.category_id
           WHERE bc.bidder_id = b.id) AS categories,
         (SELECT GROUP_CONCAT(bc.category_id) FROM bidder_categories bc WHERE bc.bidder_id = b.id) AS category_ids,
         (SELECT COUNT(*) FROM bidder_documents d WHERE d.bidder_id = b.id) AS document_count
    FROM bidders b
    LEFT JOIN admins ap ON ap.id = b.approved_by`;

// GET /api/bidders?status=pending|approved|rejected&category_id=
router.get("/", asyncHandler(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push("b.status = ?"); params.push(req.query.status); }
  if (req.query.category_id) {
    where.push("EXISTS (SELECT 1 FROM bidder_categories bc WHERE bc.bidder_id = b.id AND bc.category_id = ?)");
    params.push(req.query.category_id);
  }
  const [rows] = await pool.query(
    `${BIDDER_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY b.created_at DESC`,
    params
  );
  res.json(rows);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const [[bidder]] = await pool.query(`${BIDDER_SELECT} WHERE b.id = ?`, [req.params.id]);
  if (!bidder) throw new HttpError(404, "Bidder not found");
  const [documents] = await pool.query(
    `SELECT d.*, t.name AS document_type FROM bidder_documents d
       JOIN document_types t ON t.id = d.document_type_id
      WHERE d.bidder_id = ? ORDER BY t.id`,
    [bidder.id]
  );
  res.json({ ...bidder, documents });
}));

// PATCH /api/bidders/:id/status  { status: 'approved' | 'rejected' }
router.patch("/:id/status", asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["approved", "rejected"].includes(status)) throw new HttpError(400, "Status must be approved or rejected");
  const [r] = await pool.query("UPDATE bidders SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?", [
    status, req.user.id, req.params.id,
  ]);
  if (!r.affectedRows) throw new HttpError(404, "Bidder not found");
  await notify("bidder", [Number(req.params.id)], {
    kind: status,
    message: status === "approved" ? "Your account is approved. You can now bid." : "Your registration was rejected.",
  });
  res.json({ message: `Bidder ${status}` });
}));

// PATCH /api/bidders/:id/active  { is_active: true|false }  (block / unblock login)
router.patch("/:id/active", asyncHandler(async (req, res) => {
  const [r] = await pool.query("UPDATE bidders SET is_active = ? WHERE id = ?", [req.body.is_active ? 1 : 0, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, "Bidder not found");
  res.json({ message: req.body.is_active ? "Bidder activated" : "Bidder blocked" });
}));

// PATCH /api/bidders/:id/documents/:docId  { is_approved: true|false }
router.patch("/:id/documents/:docId", asyncHandler(async (req, res) => {
  const [r] = await pool.query(
    "UPDATE bidder_documents SET is_approved = ?, approved_by = ? WHERE id = ? AND bidder_id = ?",
    [req.body.is_approved ? 1 : 0, req.user.id, req.params.docId, req.params.id]
  );
  if (!r.affectedRows) throw new HttpError(404, "Document not found");
  res.json({ message: "Document updated" });
}));

// PATCH /api/bidders/:id/password  { password }  (admin resets a bidder's password)
router.patch("/:id/password", asyncHandler(async (req, res) => {
  if (!req.body.password || String(req.body.password).length < 6) throw new HttpError(400, "Password must be at least 6 characters");
  const [r] = await pool.query("UPDATE bidders SET password = ? WHERE id = ?", [encryptPassword(req.body.password), req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, "Bidder not found");
  res.json({ message: "Password changed" });
}));

// GET /api/bidders/:id/password -> decrypted with the same TripleDES algorithm
router.get("/:id/password", asyncHandler(async (req, res) => {
  const [[b]] = await pool.query("SELECT id, email, password FROM bidders WHERE id = ?", [req.params.id]);
  if (!b) throw new HttpError(404, "Bidder not found");
  console.log(`[password-reveal] ${req.user.role} #${req.user.id} viewed bidder #${b.id}`);
  res.json({ id: b.id, email: b.email, password: decryptPassword(b.password) });
}));

module.exports = router;
