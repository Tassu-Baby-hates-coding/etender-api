const router = require("express").Router();
const { pool, withTransaction } = require("../config/db");
const { asyncHandler, requireFields, HttpError } = require("../utils/http");
const { authenticate, requireAdmin, requireApprovedBidder, isAdmin } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { nextTenderNo } = require("../utils/tenderNo");
const { isRateLimited } = require("../utils/rateLimit");
const {
  getVisibleTender, getItems, currentRates, rankItem, getBoard, anonymizeBoard, broadcastBoard, logStatus, extendCloseTime,
} = require("../services/tenderService");
const { notify } = require("../services/notificationService");
const { getIO } = require("../socket");

// live rule: a bid with <= 11 seconds left adds 5 minutes, so nobody wins by sniping
const AUTO_EXTEND_WINDOW_SECONDS = Number(process.env.AUTO_EXTEND_WINDOW_SECONDS || 11);
const AUTO_EXTEND_MINUTES = Number(process.env.AUTO_EXTEND_MINUTES || 5);

const round2 = (n) => Math.round(n * 100) / 100;
const optionalNumber = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

router.use(authenticate);

/** Parses and validates the item grid from the admin form (JSON string or array). */
function parseItems(raw) {
  let items = raw;
  if (typeof raw === "string") {
    try { items = JSON.parse(raw); } catch { throw new HttpError(400, "Items must be valid JSON"); }
  }
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Add at least one item");
  return items.map((it, i) => {
    const quantity = Number(it.quantity);
    const baseRate = Number(it.base_rate);
    const lastRate = optionalNumber(it.last_rate);
    if (!it.item_name || !String(it.item_name).trim()) throw new HttpError(400, `Item ${i + 1}: name is required`);
    if (!it.unit || !String(it.unit).trim()) throw new HttpError(400, `Item ${i + 1}: unit is required`);
    if (!(quantity > 0)) throw new HttpError(400, `Item ${i + 1}: quantity must be more than 0`);
    if (!(baseRate >= 0)) throw new HttpError(400, `Item ${i + 1}: base rate must be 0 or more`);
    if (lastRate !== null && !(lastRate >= 0)) throw new HttpError(400, `Item ${i + 1}: last rate must be 0 or more`);
    return {
      item_name: String(it.item_name).trim(), remarks: it.remarks || null, grade: it.grade || null,
      unit: String(it.unit).trim(), quantity, last_rate: lastRate, base_rate: baseRate, item_value: round2(quantity * baseRate),
    };
  });
}

async function insertItems(conn, tenderId, items) {
  await conn.query(
    "INSERT INTO tender_items (tender_id, item_name, remarks, grade, unit, quantity, last_rate, base_rate, item_value) VALUES ?",
    [items.map((it) => [tenderId, it.item_name, it.remarks, it.grade, it.unit, it.quantity, it.last_rate, it.base_rate, it.item_value])]
  );
}

// ---------- lists ----------

// GET /api/tenders?status=draft|published|running|closed
router.get("/", asyncHandler(async (req, res) => {
  const bidderId = isAdmin(req.user) ? 0 : req.user.id;
  const where = [];
  const params = [bidderId, bidderId];
  if (!isAdmin(req.user)) {
    if (req.user.status !== "approved") return res.json({ tenders: [], server_time: new Date() });
    where.push("t.status <> 'draft'");
    where.push("t.category_id IN (SELECT category_id FROM bidder_categories WHERE bidder_id = ?)");
    where.push("NOT EXISTS (SELECT 1 FROM tender_excluded_bidders x WHERE x.tender_id = t.id AND x.bidder_id = ?)");
    params.push(bidderId, bidderId);
  }
  if (req.query.status) {
    where.push("t.status = ?");
    params.push(req.query.status);
  }
  // Rates never go down for a bidder, so MAX(rate) on an item = its current top price.
  const [rows] = await pool.query(
    `SELECT t.*, c.name AS category_name, a.name AS created_by_name,
            (SELECT COUNT(*) FROM tender_items i WHERE i.tender_id = t.id) AS item_count,
            (SELECT COUNT(DISTINCT bi.bidder_id) FROM bid_items bi WHERE bi.tender_id = t.id) AS bidder_count,
            (SELECT SUM(ti.quantity * (SELECT MAX(bi.rate) FROM bid_items bi WHERE bi.tender_item_id = ti.id))
               FROM tender_items ti WHERE ti.tender_id = t.id) AS top_total,
            (SELECT SUM(ti.quantity * (SELECT MAX(bi.rate) FROM bid_items bi WHERE bi.tender_item_id = ti.id AND bi.bidder_id = ?))
               FROM tender_items ti WHERE ti.tender_id = t.id) AS my_total,
            (SELECT COUNT(*) FROM tender_items ti JOIN bid_items w ON w.id = ti.winner_bid_item_id
              WHERE ti.tender_id = t.id AND w.bidder_id = ?) AS my_won_items,
            (SELECT COUNT(*) FROM tender_items ti WHERE ti.tender_id = t.id AND ti.winner_bid_item_id IS NOT NULL) AS awarded_items,
            (SELECT COUNT(DISTINCT w.bidder_id) FROM tender_items ti JOIN bid_items w ON w.id = ti.winner_bid_item_id
              WHERE ti.tender_id = t.id) AS winner_count,
            (SELECT COUNT(*) FROM tender_excluded_bidders x WHERE x.tender_id = t.id) AS excluded_count
       FROM tenders t
       JOIN categories c ON c.id = t.category_id
       JOIN admins a ON a.id = t.created_by
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.created_at DESC`,
    params
  );
  res.json({
    tenders: isAdmin(req.user) ? rows.map(({ my_total, my_won_items, ...r }) => r) : rows.map(forBidder),
    server_time: new Date(),
  });
}));

/** Tender row as a bidder may see it: prices and their own result only, no identities or counts. */
function forBidder(t) {
  const { created_by, created_by_name, published_by, bidder_count, winner_count, excluded_count, ...safe } = t;
  return safe;
}

// GET /api/tenders/dashboard  (admin counts)
router.get("/dashboard", requireAdmin(), asyncHandler(async (req, res) => {
  const [[tenders]] = await pool.query(
    `SELECT SUM(status = 'draft') AS draft, SUM(status = 'published') AS published,
            SUM(status = 'running') AS running, SUM(status = 'closed') AS closed, COUNT(*) AS total
       FROM tenders`
  );
  const [[bidders]] = await pool.query(
    "SELECT SUM(status = 'pending') AS pending, SUM(status = 'approved') AS approved FROM bidders"
  );
  const [[bids]] = await pool.query("SELECT COUNT(*) AS today FROM bids WHERE DATE(created_at) = CURDATE()");
  res.json({ tenders, bidders, bids_today: bids.today });
}));

// GET /api/tenders/my-bids  (bidder: every submit they made)
router.get("/my-bids", requireApprovedBidder, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT bd.id, bd.tender_id, bd.total_amount, bd.is_latest, bd.created_at,
            t.tender_no, t.title, t.status, t.close_at,
            (SELECT COUNT(*) FROM bid_items bi WHERE bi.bid_id = bd.id) AS items_changed
       FROM bids bd JOIN tenders t ON t.id = bd.tender_id
      WHERE bd.bidder_id = ?
      ORDER BY bd.created_at DESC, bd.id DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

// ---------- single tender ----------

// GET /api/tenders/:id  -> tender + items + live board (+ admin-only extras)
router.get("/:id", asyncHandler(async (req, res) => {
  const tender = await getVisibleTender(req.user, req.params.id);
  const [items, board] = await Promise.all([getItems(tender.id), getBoard(tender.id)]);

  // bidders get prices only, so they cannot see who else is bidding
  if (!isAdmin(req.user)) {
    return res.json({ tender: forBidder(tender), items, ...anonymizeBoard(board, req.user.id) });
  }

  const [[excluded], [timers], [statusLogs]] = await Promise.all([
    pool.query(
      `SELECT x.bidder_id, b.company_name, b.phone FROM tender_excluded_bidders x
         JOIN bidders b ON b.id = x.bidder_id WHERE x.tender_id = ?`, [tender.id]),
    pool.query(
      `SELECT l.*, a.name AS admin_name FROM timer_logs l LEFT JOIN admins a ON a.id = l.admin_id
        WHERE l.tender_id = ? ORDER BY l.id DESC`, [tender.id]),
    pool.query(
      `SELECT l.*, a.name AS admin_name FROM tender_status_logs l LEFT JOIN admins a ON a.id = l.admin_id
        WHERE l.tender_id = ? ORDER BY l.id DESC`, [tender.id]),
  ]);
  res.json({ tender, items, ...board, excluded_bidders: excluded, timer_logs: timers, status_logs: statusLogs });
}));

// GET /api/tenders/:id/history  -> every bid in time order (who bid what, when). Admin only:
// bidders see their own bids in /my-bids.
router.get("/:id/history", requireAdmin(), asyncHandler(async (req, res) => {
  const tender = await getVisibleTender(req.user, req.params.id);
  const [rows] = await pool.query(
    `SELECT bd.id, bd.total_amount, bd.is_latest, bd.created_at, b.company_name,
            (SELECT GROUP_CONCAT(CONCAT(ti.item_name, ': ', bi.rate) ORDER BY ti.id SEPARATOR ', ')
               FROM bid_items bi JOIN tender_items ti ON ti.id = bi.tender_item_id
              WHERE bi.bid_id = bd.id) AS changes
       FROM bids bd JOIN bidders b ON b.id = bd.bidder_id
      WHERE bd.tender_id = ? ORDER BY bd.created_at DESC, bd.id DESC`,
    [tender.id]
  );
  res.json(rows);
}));

// ---------- admin: create / edit / delete / publish / extend ----------

// POST /api/tenders (multipart: title, description, category_id, items(JSON), attachment?)
router.post("/", requireAdmin(), upload.single("attachment"), asyncHandler(async (req, res) => {
  requireFields(req.body, ["title", "category_id"]);
  const items = parseItems(req.body.items);
  const total = round2(items.reduce((s, it) => s + it.item_value, 0));

  // retry once if two admins got the same serial at the same moment
  for (let attempt = 1; ; attempt++) {
    try {
      const tender = await withTransaction(async (conn) => {
        const tenderNo = await nextTenderNo(conn);
        const [r] = await conn.query(
          `INSERT INTO tenders (tender_no, title, description, category_id, attachment_url, total_amount, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [tenderNo, req.body.title.trim(), req.body.description || null, req.body.category_id, fileUrl(req.file), total, req.user.id]
        );
        await insertItems(conn, r.insertId, items);
        await logStatus(conn, r.insertId, "created", null, req.user.id);
        return { id: r.insertId, tender_no: tenderNo };
      });
      return res.status(201).json(tender);
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY" || attempt >= 2) throw err;
    }
  }
}));

// PUT /api/tenders/:id  (draft only; replaces items)
router.put("/:id", requireAdmin(), upload.single("attachment"), asyncHandler(async (req, res) => {
  requireFields(req.body, ["title", "category_id"]);
  const items = parseItems(req.body.items);
  const total = round2(items.reduce((s, it) => s + it.item_value, 0));
  await withTransaction(async (conn) => {
    const [[t]] = await conn.query("SELECT id, status, attachment_url FROM tenders WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!t) throw new HttpError(404, "Tender not found");
    if (t.status !== "draft") throw new HttpError(409, "Only draft tenders can be edited");
    await conn.query(
      "UPDATE tenders SET title = ?, description = ?, category_id = ?, attachment_url = ?, total_amount = ? WHERE id = ?",
      [req.body.title.trim(), req.body.description || null, req.body.category_id, fileUrl(req.file) || t.attachment_url, total, t.id]
    );
    await conn.query("DELETE FROM tender_items WHERE tender_id = ?", [t.id]);
    await insertItems(conn, t.id, items);
  });
  res.json({ message: "Tender updated" });
}));

router.delete("/:id", requireAdmin(), asyncHandler(async (req, res) => {
  const [r] = await pool.query("DELETE FROM tenders WHERE id = ? AND status = 'draft'", [req.params.id]);
  if (!r.affectedRows) throw new HttpError(409, "Only draft tenders can be deleted");
  res.json({ message: "Tender deleted" });
}));

// POST /api/tenders/:id/publish  { open_at, close_at, excluded_bidder_ids?: number[] }
router.post("/:id/publish", requireAdmin(), asyncHandler(async (req, res) => {
  requireFields(req.body, ["open_at", "close_at"]);
  const openAt = new Date(req.body.open_at);
  const closeAt = new Date(req.body.close_at);
  const now = new Date();
  if (isNaN(openAt) || isNaN(closeAt)) throw new HttpError(400, "Invalid open or close time");
  if (closeAt <= openAt) throw new HttpError(400, "Close time must be after open time");
  if (closeAt <= now) throw new HttpError(400, "Close time must be in the future");
  const excluded = [...new Set((req.body.excluded_bidder_ids || []).map(Number).filter(Boolean))];
  const status = openAt <= now ? "running" : "published";

  const t = await withTransaction(async (conn) => {
    const [[tender]] = await conn.query("SELECT id, tender_no, title, category_id, status FROM tenders WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!tender) throw new HttpError(404, "Tender not found");
    if (tender.status !== "draft") throw new HttpError(409, "Only draft tenders can be published");
    await conn.query(
      `UPDATE tenders SET open_at = ?, original_close_at = ?, close_at = ?, status = ?, published_by = ?, published_at = NOW()
        WHERE id = ?`,
      [openAt, closeAt, closeAt, status, req.user.id, tender.id]
    );
    if (excluded.length) {
      await conn.query(
        "INSERT INTO tender_excluded_bidders (tender_id, bidder_id, created_by) VALUES ?",
        [excluded.map((b) => [tender.id, b, req.user.id])]
      );
    }
    await logStatus(conn, tender.id, "published", excluded.length ? `${excluded.length} bidder(s) excluded` : null, req.user.id);
    if (status === "running") await logStatus(conn, tender.id, "running", "Opened at publish");
    return tender;
  });

  const [eligible] = await pool.query(
    `SELECT b.id FROM bidders b JOIN bidder_categories bc ON bc.bidder_id = b.id
      WHERE bc.category_id = ? AND b.status = 'approved' AND b.is_active = 1
        AND b.id NOT IN (SELECT bidder_id FROM tender_excluded_bidders WHERE tender_id = ?)`,
    [t.category_id, t.id]
  );
  await notify("bidder", eligible.map((b) => b.id), { tenderId: t.id, kind: "published", message: `New tender ${t.tender_no}: ${t.title}` });
  getIO().emit("tender:published", { tender_id: t.id, status });
  res.json({ message: "Tender published", status });
}));

// POST /api/tenders/:id/extend  { minutes }  (admin; negative = reduce time)
router.post("/:id/extend", requireAdmin(), asyncHandler(async (req, res) => {
  const minutes = Math.trunc(Number(req.body.minutes));
  if (!minutes || Math.abs(minutes) > 7 * 24 * 60) throw new HttpError(400, "Minutes must be a non-zero number");

  const { newClose, tender } = await withTransaction(async (conn) => {
    const [[t]] = await conn.query("SELECT id, tender_no, close_at, status FROM tenders WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!t) throw new HttpError(404, "Tender not found");
    if (!["published", "running"].includes(t.status)) throw new HttpError(409, "Only upcoming or running tenders can be changed");
    const next = new Date(new Date(t.close_at).getTime() + minutes * 60 * 1000);
    if (next <= new Date(Date.now() + 60 * 1000)) throw new HttpError(400, "New close time must be at least 1 minute from now");
    return { newClose: await extendCloseTime(conn, t, minutes, { source: "admin", adminId: req.user.id }), tender: t };
  });

  getIO().emit("tender:extended", { tender_id: tender.id, close_at: newClose });
  await broadcastBoard(tender.id);
  res.json({ message: "Close time changed", close_at: newClose });
}));

// ---------- bidder: place / update a bid ----------

// POST /api/tenders/:id/bids  { items: [{ tender_item_id, rate }] }
// Item-wise, like the live system. A bidder may price only the items they want; an empty
// rate means "not bidding on this item". Rules per item (live TenderDetails screen):
//   - rate >= item base (minimum) rate
//   - rate >= the bidder's own previous rate on that item (HasLastPriceFixed)
//   - rate != the current top price held by another bidder ("price already taken")
//   - at least one item must change
router.post("/:id/bids", requireApprovedBidder, asyncHandler(async (req, res) => {
  const tenderId = Number(req.params.id);
  if (isRateLimited(`${req.user.id}:${tenderId}`)) throw new HttpError(429, "Too many bids for this tender. Please wait a minute.");
  const input = (Array.isArray(req.body.items) ? req.body.items : [])
    .filter((x) => x && x.rate !== null && x.rate !== undefined && x.rate !== "");

  const result = await withTransaction(async (conn) => {
    // lock the tender row: bids on one tender are processed one at a time
    await conn.query("SELECT id FROM tenders WHERE id = ? FOR UPDATE", [tenderId]);
    const tender = await getVisibleTender(req.user, tenderId, conn);

    // the server clock decides, never the browser
    const [[time]] = await conn.query(
      "SELECT NOW() < open_at AS not_started, TIMESTAMPDIFF(SECOND, NOW(), close_at) AS seconds_left FROM tenders WHERE id = ?",
      [tenderId]
    );
    if (!["published", "running"].includes(tender.status) || time.seconds_left <= 0) throw new HttpError(400, "Bidding time is over for this tender");
    if (time.not_started) throw new HttpError(400, "Bidding has not started yet");
    if (!input.length) throw new HttpError(400, "Enter a rate for at least one item");

    const items = await getItems(tenderId, conn);
    const rates = await currentRates(tenderId, conn);
    const itemById = new Map(items.map((it) => [it.id, it]));
    const mineBefore = new Map(rates.filter((r) => r.bidder_id === req.user.id).map((r) => [r.tender_item_id, r.rate]));

    const changed = [];
    for (const x of input) {
      const it = itemById.get(Number(x.tender_item_id));
      if (!it) throw new HttpError(400, "Unknown item in this tender");
      const rate = round2(Number(x.rate));
      const prev = mineBefore.get(it.id);
      if (!(rate > 0)) throw new HttpError(400, `Rate for "${it.item_name}" must be a positive number`);
      if (rate < it.base_rate) throw new HttpError(400, `Rate for "${it.item_name}" must be at least ${it.base_rate}`);
      if (prev !== undefined && rate < prev) throw new HttpError(400, `Rate for "${it.item_name}" cannot be lower than your previous rate ${prev}`);
      if (prev === rate) continue; // unchanged
      const topOther = rankItem(rates.filter((r) => r.tender_item_id === it.id && r.bidder_id !== req.user.id))[0];
      if (topOther && topOther.rate === rate) {
        throw new HttpError(400, `${rate} is already taken on "${it.item_name}". Please choose a different price.`);
      }
      changed.push({ item: it, rate, amount: round2(rate * it.quantity) });
    }
    if (!changed.length) throw new HttpError(400, "You did not change any price. Increase at least one item.");

    // who led each changed item before this bid (for outbid notifications)
    const prevLeaders = changed.map((c) => ({ item: c.item, rate: c.rate, top: rankItem(rates.filter((r) => r.tender_item_id === c.item.id))[0] }));

    // the bidder's running total: new rates where changed, previous rates elsewhere
    const after = new Map(mineBefore);
    changed.forEach((c) => after.set(c.item.id, c.rate));
    const total = round2(items.reduce((s, it) => s + (after.get(it.id) || 0) * it.quantity, 0));

    await conn.query("UPDATE bids SET is_latest = 0 WHERE tender_id = ? AND bidder_id = ?", [tenderId, req.user.id]);
    const [bid] = await conn.query(
      "INSERT INTO bids (tender_id, bidder_id, total_amount, ip_address) VALUES (?, ?, ?, ?)",
      [tenderId, req.user.id, total, (req.ip || "").slice(0, 45)]
    );
    await conn.query(
      "INSERT INTO bid_items (bid_id, tender_id, bidder_id, tender_item_id, rate, amount) VALUES ?",
      [changed.map((c) => [bid.insertId, tenderId, req.user.id, c.item.id, c.rate, c.amount])]
    );
    if (tender.status === "published") {
      await conn.query("UPDATE tenders SET status = 'running' WHERE id = ?", [tenderId]);
      await logStatus(conn, tenderId, "running", "Opened by first bid");
    }

    let extendedTo = null;
    if (time.seconds_left <= AUTO_EXTEND_WINDOW_SECONDS) {
      extendedTo = await extendCloseTime(conn, tender, AUTO_EXTEND_MINUTES, { source: "auto_bid", bidId: bid.insertId });
    }
    return { bidId: bid.insertId, total, tender, prevLeaders, changedCount: changed.length, extendedTo };
  });

  const { prevLeaders, total, tender, extendedTo } = result;
  if (extendedTo) getIO().emit("tender:extended", { tender_id: tenderId, close_at: extendedTo });
  await broadcastBoard(tenderId);

  // tell each bidder who lost the lead on an item (item name and new top price only)
  const outbid = {};
  prevLeaders
    .filter((p) => p.top && p.top.bidder_id !== req.user.id && p.rate > p.top.rate)
    .forEach((p) => (outbid[p.top.bidder_id] ||= []).push(`${p.item.item_name} (${p.rate})`));
  for (const [bidderId, list] of Object.entries(outbid)) {
    await notify("bidder", [Number(bidderId)], {
      tenderId, kind: "outbid", message: `Outbid on tender ${tender.tender_no}: ${list.join(", ")}`,
    });
  }
  res.status(201).json({
    message: "Bid submitted", bid_id: result.bidId, items_changed: result.changedCount, my_total: total, extended_to: extendedTo,
  });
}));

module.exports = router;
