require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");

const { pool } = require("./config/db");
const { initSocket } = require("./socket");
const { UPLOAD_DIR } = require("./middleware/upload");
const errorHandler = require("./middleware/errorHandler");
const { asyncHandler } = require("./utils/http");
const { startTenderScheduler } = require("./jobs/tenderScheduler");

for (const key of ["JWT_SECRET", "PASSWORD_SECRET"]) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env (copy .env.example to .env)`);
    process.exit(1);
  }
}

const origins = (process.env.CLIENT_ORIGINS || "http://localhost:5173,http://localhost:5174").split(",").map((s) => s.trim());
const app = express();
const server = http.createServer(app);
initSocket(server, origins);

app.use(cors({ origin: origins }));
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/api/health", asyncHandler(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, time: new Date() });
}));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/categories", require("./routes/categories"));
app.use("/api/admins", require("./routes/admins"));
app.use("/api/bidders", require("./routes/bidders"));
app.use("/api/tenders", require("./routes/tenders"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api", (req, res) => res.status(404).json({ message: "API route not found" }));
app.use(errorHandler);

const PORT = Number(process.env.PORT || 5050);

pool
  .query("SELECT 1")
  .then(() => {
    server.listen(PORT, () => console.log(`E-Tender API running on http://localhost:${PORT}`));
    startTenderScheduler();
  })
  .catch((err) => {
    console.error("Cannot connect to MySQL. Is XAMPP MySQL running and did you run `npm run db:init`?\n", err.message);
    process.exit(1);
  });
