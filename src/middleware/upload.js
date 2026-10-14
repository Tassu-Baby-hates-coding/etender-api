const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { HttpError } = require("../utils/http");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".xls", ".xlsx"];

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // random name: never trust the client's file name on disk
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new HttpError(400, `Only ${ALLOWED.join(", ")} files are allowed`), ok);
  },
});

const fileUrl = (file) => (file ? `/uploads/${file.filename}` : null);

module.exports = { upload, fileUrl, UPLOAD_DIR };
