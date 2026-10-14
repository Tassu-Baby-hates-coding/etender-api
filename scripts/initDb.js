// Creates etender_db from ../database/schema.sql (drops it first if it exists).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    multipleStatements: true,
  });
  await conn.query(sql);
  const [tables] = await conn.query("SHOW TABLES FROM etender_db");
  await conn.end();
  console.log(`Database etender_db created with ${tables.length} tables.`);
})().catch((err) => {
  console.error("DB init failed. Is XAMPP MySQL running?\n", err.message);
  process.exit(1);
});
