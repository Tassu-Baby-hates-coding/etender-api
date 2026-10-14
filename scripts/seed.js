// Sample data for demo/testing. Run after `npm run db:init`.
// Test logins (local demo only):
//   super admin  superadmin@etender.test / Super@123   (admin app)
//   admin        admin@etender.test      / Admin@123   (admin app)
//   bidder       rahim@etender.test      / Rahim@123   (bidder app, approved)
//   bidder       karim@etender.test      / Karim@123   (bidder app, approved)
//   bidder       salam@etender.test      / Salam@123   (pending approval)
require("dotenv").config();
const { pool, withTransaction } = require("../src/config/db");
const { encryptPassword } = require("../src/utils/passwordCrypto");
const { nextTenderNo } = require("../src/utils/tenderNo");

const minutes = (m) => new Date(Date.now() + m * 60 * 1000);

(async () => {
  await withTransaction(async (conn) => {
    const admin = async (name, email, phone, password, role, createdBy = null) =>
      (await conn.query("INSERT INTO admins (name, email, phone, password, role, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        [name, email, phone, encryptPassword(password), role, createdBy]))[0].insertId;
    const superId = await admin("Super Admin", "superadmin@etender.test", "01700000001", "Super@123", "super_admin");
    const adminId = await admin("Tender Admin", "admin@etender.test", "01700000002", "Admin@123", "admin", superId);

    const cat = async (name, description) =>
      (await conn.query("INSERT INTO categories (name, description) VALUES (?, ?)", [name, description]))[0].insertId;
    const scrap = await cat("Scrap Metal", "Iron, steel and other metal scrap");
    const fabric = await cat("Fabric Waste", "Cutting waste and leftover fabric");
    const machine = await cat("Old Machinery", "Used machines and spare parts");

    const bidder = async (company, contact, email, phone, password, status, cats) => {
      const [b] = await conn.query(
        `INSERT INTO bidders (company_name, contact_name, email, phone, company_address, trade_license_no, password, status, approved_by, approved_at)
         VALUES (?, ?, ?, ?, 'Dhaka, Bangladesh', ?, ?, ?, ?, ?)`,
        [company, contact, email, phone, `TL-${phone.slice(-4)}`, encryptPassword(password), status,
          status === "approved" ? adminId : null, status === "approved" ? new Date() : null]
      );
      await conn.query("INSERT INTO bidder_categories (bidder_id, category_id) VALUES ?", [cats.map((c) => [b.insertId, c])]);
      return b.insertId;
    };
    await bidder("Rahim Traders", "Rahim Uddin", "rahim@etender.test", "01811111111", "Rahim@123", "approved", [scrap, fabric]);
    const karim = await bidder("Karim Enterprise", "Karim Ahmed", "karim@etender.test", "01822222222", "Karim@123", "approved", [scrap, fabric, machine]);
    await bidder("Salam & Sons", "Abdus Salam", "salam@etender.test", "01833333333", "Salam@123", "pending", [scrap]);

    const tender = async (title, categoryId, items, extra = {}) => {
      const no = await nextTenderNo(conn);
      const rows = items.map(([n, grade, unit, q, last, base]) => [n, grade, unit, q, last, base, Math.round(q * base * 100) / 100]);
      const total = rows.reduce((s, r) => s + r[6], 0);
      const published = Boolean(extra.status);
      const [t] = await conn.query(
        `INSERT INTO tenders (tender_no, title, description, category_id, total_amount, open_at, original_close_at, close_at,
                              status, created_by, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [no, title, `${title} - sample tender`, categoryId, total, extra.open_at || null, extra.close_at || null,
          extra.close_at || null, extra.status || "draft", adminId, published ? adminId : null, published ? new Date() : null]
      );
      await conn.query(
        "INSERT INTO tender_items (tender_id, item_name, grade, unit, quantity, last_rate, base_rate, item_value) VALUES ?",
        [rows.map((r) => [t.insertId, ...r])]
      );
      await conn.query("INSERT INTO tender_status_logs (tender_id, status, admin_id) VALUES (?, 'created', ?)", [t.insertId, adminId]);
      if (published) await conn.query("INSERT INTO tender_status_logs (tender_id, status, admin_id) VALUES (?, 'published', ?)", [t.insertId, adminId]);
      return t.insertId;
    };

    await tender("Factory Scrap Sale - Running", scrap,
      [["MS Scrap", "A", "KG", 5000, 48, 45], ["Stainless Steel Scrap", "A+", "KG", 800, 125, 120], ["Copper Wire", "B", "KG", 150, 640, 650]],
      { status: "running", open_at: minutes(-5), close_at: minutes(120) });
    const upcoming = await tender("Cutting Waste - Upcoming", fabric,
      [["Cotton Jhut", "A", "KG", 3000, 32, 30], ["Polyester Jhut", "C", "KG", 1200, null, 18]],
      { status: "published", open_at: minutes(30), close_at: minutes(180) });
    // Karim is excluded from the upcoming tender, to show the exclude rule
    await conn.query("INSERT INTO tender_excluded_bidders (tender_id, bidder_id, created_by) VALUES (?, ?, ?)", [upcoming, karim, adminId]);
    await tender("Old Sewing Machines - Draft", machine,
      [["Single Needle Machine", "B", "PCS", 25, 6500, 6000], ["Overlock Machine", "B", "PCS", 10, null, 9000]]);

    console.log(`Seeded: super admin #${superId}, admin #${adminId}, 3 bidders, 3 categories, 3 tenders, 4 document types.`);
  });
  await pool.end();
})().catch(async (err) => {
  console.error("Seed failed:", err.message);
  await pool.end();
  process.exit(1);
});
