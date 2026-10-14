const { pool } = require("../config/db");
const { getIO } = require("../socket");

/**
 * Saves one notification per recipient and pushes it live.
 * type: 'admin' | 'bidder', ids: their ids.
 */
async function notify(type, ids, { tenderId = null, kind, message }) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return;
  const col = type === "admin" ? "admin_id" : "bidder_id";
  await pool.query(
    `INSERT INTO notifications (${col}, tender_id, type, message) VALUES ?`,
    [unique.map((id) => [id, tenderId, kind, message])]
  );
  const io = getIO();
  unique.forEach((id) => io.to(`${type}:${id}`).emit("notification:new", { tender_id: tenderId, type: kind, message }));
}

async function notifyAllAdmins(payload) {
  const [rows] = await pool.query("SELECT id FROM admins WHERE status = 'active'");
  await notify("admin", rows.map((r) => r.id), payload);
}

module.exports = { notify, notifyAllAdmins };
