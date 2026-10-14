const { pool, withTransaction } = require("../config/db");
const { HttpError } = require("../utils/http");
const { getIO } = require("../socket");
const { notify } = require("./notificationService");

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Loads a tender the user may see, or throws 404.
 * Admins see everything. A bidder sees a non-draft tender when they are approved,
 * subscribed to its category and not excluded from it.
 */
async function getVisibleTender(user, tenderId, conn = pool) {
  const [[tender]] = await conn.query(
    `SELECT t.*, c.name AS category_name
       FROM tenders t JOIN categories c ON c.id = t.category_id
      WHERE t.id = ?`,
    [tenderId]
  );
  if (!tender) throw new HttpError(404, "Tender not found");
  if (user.type === "admin") return tender;

  if (tender.status === "draft" || user.status !== "approved") throw new HttpError(404, "Tender not found");
  const [[allowed]] = await conn.query(
    `SELECT 1 AS ok FROM bidder_categories bc
      WHERE bc.bidder_id = ? AND bc.category_id = ?
        AND NOT EXISTS (SELECT 1 FROM tender_excluded_bidders x WHERE x.tender_id = ? AND x.bidder_id = bc.bidder_id)`,
    [user.id, tender.category_id, tender.id]
  );
  if (!allowed) throw new HttpError(404, "Tender not found");
  return tender;
}

async function getItems(tenderId, conn = pool) {
  const [items] = await conn.query("SELECT * FROM tender_items WHERE tender_id = ? ORDER BY id", [tenderId]);
  return items;
}

/**
 * Every bidder's CURRENT rate on every item (their newest bid_items row per item),
 * as rows { id, bidder_id, tender_item_id, rate, created_at }.
 */
async function currentRates(tenderId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT bi.id, bi.bidder_id, bi.tender_item_id, bi.rate, bi.created_at
       FROM bid_items bi
       JOIN (SELECT MAX(id) AS id FROM bid_items WHERE tender_id = ? GROUP BY bidder_id, tender_item_id) cur
         ON cur.id = bi.id`,
    [tenderId]
  );
  return rows;
}

/** Ranks the current rates of one item: highest first, tie = earlier entry (lower id) first. */
const rankItem = (rows) => [...rows].sort((a, b) => b.rate - a.rate || a.id - b.id);

/**
 * Full item-wise board (admin view).
 *   item_board: { [itemId]: { top_rate, top_bidder_id, top_bid_item_id, bidder_count, ranking: [bidder_id...] } }
 *   bidders: [{ bidder_id, company_name, contact_name, phone, rates: {itemId: rate}, total_amount, leading_items, submissions }]
 *   top_total: sum of top_rate x quantity
 */
async function getBoard(tenderId, conn = pool) {
  const [tenderItems, rates, [[t]]] = await Promise.all([
    getItems(tenderId, conn),
    currentRates(tenderId, conn),
    conn.query("SELECT close_at, status FROM tenders WHERE id = ?", [tenderId]),
  ]);

  const items = {};
  let topTotal = 0;
  for (const it of tenderItems) {
    const ranked = rankItem(rates.filter((r) => r.tender_item_id === it.id));
    const top = ranked[0];
    items[it.id] = {
      top_rate: top ? top.rate : null,
      top_bidder_id: top ? top.bidder_id : null,
      top_bid_item_id: top ? top.id : null,
      winner_bid_item_id: it.winner_bid_item_id,
      bidder_count: ranked.length,
      ranking: ranked.map((r) => r.bidder_id),
    };
    if (top) topTotal += top.rate * it.quantity;
  }

  const bidderIds = [...new Set(rates.map((r) => r.bidder_id))];
  let bidders = [];
  if (bidderIds.length) {
    const [info] = await conn.query(
      `SELECT b.id AS bidder_id, b.company_name, b.contact_name, b.phone,
              (SELECT COUNT(*) FROM bids x WHERE x.tender_id = ? AND x.bidder_id = b.id) AS submissions
         FROM bidders b WHERE b.id IN (?)`,
      [tenderId, bidderIds]
    );
    bidders = info.map((b) => {
      const mine = rates.filter((r) => r.bidder_id === b.bidder_id);
      const rateMap = Object.fromEntries(mine.map((r) => [r.tender_item_id, r.rate]));
      const total = tenderItems.reduce((s, it) => s + (rateMap[it.id] || 0) * it.quantity, 0);
      return {
        ...b,
        rates: rateMap,
        total_amount: round2(total),
        leading_items: tenderItems.filter((it) => items[it.id].top_bidder_id === b.bidder_id).length,
      };
    }).sort((a, b) => b.leading_items - a.leading_items || b.total_amount - a.total_amount);
  }

  return { item_board: items, bidders, top_total: round2(topTotal), close_at: t?.close_at, status: t?.status, server_time: new Date() };
}

/**
 * What ONE bidder may see: per item only the top price, their own rate and position.
 * No other bidder's name, phone, id, rates or count, so bidders cannot find each other
 * and form a syndicate. Same as the live bidder screen (Top Price / Your Price).
 */
function anonymizeBoard(board, bidderId) {
  const items = {};
  let myTotal = 0;
  const me = board.bidders.find((b) => b.bidder_id === bidderId);
  for (const [itemId, it] of Object.entries(board.item_board)) {
    const myRate = me?.rates[itemId] ?? null;
    const position = it.ranking.indexOf(bidderId);
    items[itemId] = {
      top_rate: it.top_rate,
      my_rate: myRate,
      my_position: position >= 0 ? position + 1 : null,
      is_leading: it.top_bidder_id === bidderId,
      i_won: board.status === "closed" && it.winner_bid_item_id !== null && it.top_bidder_id === bidderId,
    };
  }
  if (me) myTotal = me.total_amount;
  return {
    item_board: items,
    top_total: board.top_total,
    my_total: myTotal,
    close_at: board.close_at,
    status: board.status,
    server_time: board.server_time,
  };
}

/**
 * Pushes the fresh board to everyone watching this tender: admins get the full board,
 * each bidder socket gets its own anonymized copy. List pages get a price-only summary.
 */
async function broadcastBoard(tenderId, event = "board:update") {
  const board = await getBoard(tenderId);
  const io = getIO();
  io.to(`tender:${tenderId}:admins`).emit(event, { tender_id: tenderId, ...board });
  const bidderSockets = await io.in(`tender:${tenderId}:bidders`).fetchSockets();
  bidderSockets.forEach((s) => s.emit(event, { tender_id: tenderId, ...anonymizeBoard(board, s.data.user.id) }));
  io.emit("tender:stats", { tender_id: tenderId, top_total: board.top_total, close_at: board.close_at });
  return board;
}

function logStatus(conn, tenderId, status, note = null, adminId = null) {
  return conn.query(
    "INSERT INTO tender_status_logs (tender_id, status, note, admin_id) VALUES (?, ?, ?, ?)",
    [tenderId, status, note, adminId]
  );
}

/**
 * Moves close_at forward by `minutes` and logs it in timer_logs.
 * Call inside a transaction that already locked the tender row.
 */
async function extendCloseTime(conn, tender, minutes, { source, bidId = null, adminId = null }) {
  const oldClose = new Date(tender.close_at);
  const newClose = new Date(oldClose.getTime() + minutes * 60 * 1000);
  await conn.query("UPDATE tenders SET close_at = ? WHERE id = ?", [newClose, tender.id]);
  await conn.query(
    `INSERT INTO timer_logs (tender_id, minutes, source, bid_id, admin_id, old_close_at, new_close_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tender.id, minutes, source, bidId, adminId, oldClose, newClose]
  );
  await logStatus(conn, tender.id, "extended",
    `${minutes > 0 ? "+" : ""}${minutes} min (${source === "auto_bid" ? "late bid" : "by admin"})`, adminId);
  return newClose;
}

/**
 * Closes one tender and picks a winner PER ITEM: the highest current rate,
 * tie = whoever entered that rate first (same rule as the live report). Safe to call twice.
 */
async function closeTender(tenderId) {
  const result = await withTransaction(async (conn) => {
    const [[t]] = await conn.query("SELECT id, tender_no, status FROM tenders WHERE id = ? FOR UPDATE", [tenderId]);
    if (!t || t.status === "closed") return null;

    const [items, rates] = await Promise.all([getItems(tenderId, conn), currentRates(tenderId, conn)]);
    const wonBy = {}; // bidder_id -> [item names]
    for (const it of items) {
      const top = rankItem(rates.filter((r) => r.tender_item_id === it.id))[0];
      await conn.query("UPDATE tender_items SET winner_bid_item_id = ? WHERE id = ?", [top ? top.id : null, it.id]);
      if (top) (wonBy[top.bidder_id] ||= []).push(it.item_name);
    }
    await conn.query("UPDATE tenders SET status = 'closed' WHERE id = ?", [tenderId]);
    const awarded = Object.values(wonBy).reduce((s, l) => s + l.length, 0);
    await logStatus(conn, tenderId, "closed", `${awarded} of ${items.length} item(s) awarded to ${Object.keys(wonBy).length} bidder(s)`);
    const participants = [...new Set(rates.map((r) => r.bidder_id))];
    return { t, wonBy, participants };
  });
  if (!result) return;

  const { t, wonBy, participants } = result;
  await broadcastBoard(tenderId, "tender:closed");
  getIO().emit("tender:status", { tender_id: tenderId, status: "closed" });

  for (const [bidderId, names] of Object.entries(wonBy)) {
    await notify("bidder", [Number(bidderId)], {
      tenderId, kind: "won", message: `Tender ${t.tender_no} closed. You won ${names.length} item(s): ${names.join(", ")}`,
    });
  }
  // others only learn that it closed: never who won
  await notify("bidder", participants.filter((id) => !wonBy[id]), {
    tenderId, kind: "closed", message: `Tender ${t.tender_no} is closed. You did not win any item.`,
  });
}

module.exports = {
  getVisibleTender, getItems, currentRates, rankItem, getBoard, anonymizeBoard, broadcastBoard,
  logStatus, extendCloseTime, closeTender,
};
