const cron = require("node-cron");
const { pool, withTransaction } = require("../config/db");
const { getIO } = require("../socket");
const { closeTender, logStatus } = require("../services/tenderService");

let running = false;

/** published -> running when open time comes; running -> closed (with winner) when close time comes. */
async function tick() {
  if (running) return; // never overlap two ticks
  running = true;
  try {
    const [toOpen] = await pool.query("SELECT id FROM tenders WHERE status = 'published' AND open_at <= NOW()");
    for (const t of toOpen) {
      const opened = await withTransaction(async (conn) => {
        const [r] = await conn.query("UPDATE tenders SET status = 'running' WHERE id = ? AND status = 'published'", [t.id]);
        if (r.affectedRows) await logStatus(conn, t.id, "running", "Open time reached");
        return r.affectedRows > 0;
      });
      if (opened) getIO().emit("tender:status", { tender_id: t.id, status: "running" });
    }

    const [toClose] = await pool.query(
      "SELECT id FROM tenders WHERE status IN ('published','running') AND close_at <= NOW()"
    );
    for (const t of toClose) await closeTender(t.id);
  } catch (err) {
    console.error("[scheduler]", err.message);
  } finally {
    running = false;
  }
}

function startTenderScheduler() {
  cron.schedule("*/2 * * * * *", tick); // every 2 seconds, so a tender closes right on time
  tick();
}

module.exports = { startTenderScheduler, tick };
