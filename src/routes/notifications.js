const router = require("express").Router();
const { pool } = require("../config/db");
const { asyncHandler } = require("../utils/http");
const { authenticate } = require("../middleware/auth");

router.use(authenticate);

// column is fixed by the account type, never taken from the request
const ownerCol = (user) => (user.type === "admin" ? "admin_id" : "bidder_id");

router.get("/", asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM notifications WHERE ${ownerCol(req.user)} = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
    [req.user.id]
  );
  const [[{ unread }]] = await pool.query(
    `SELECT COUNT(*) AS unread FROM notifications WHERE ${ownerCol(req.user)} = ? AND is_read = 0`,
    [req.user.id]
  );
  res.json({ notifications: rows, unread });
}));

router.patch("/read-all", asyncHandler(async (req, res) => {
  await pool.query(`UPDATE notifications SET is_read = 1 WHERE ${ownerCol(req.user)} = ?`, [req.user.id]);
  res.json({ message: "All marked as read" });
}));

module.exports = router;
