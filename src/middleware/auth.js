const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");
const { HttpError } = require("../utils/http");

// Two account tables (like the live system): admins and bidders.
// The token carries which one: { id, type: 'admin' | 'bidder' }.

function signToken(type, id) {
  return jwt.sign({ id, type }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "1d" });
}

/** Loads the account behind a token payload; null if gone or switched off. */
async function loadAccount({ id, type }) {
  if (type === "admin") {
    const [[a]] = await pool.query("SELECT id, name, email, phone, role, status FROM admins WHERE id = ?", [id]);
    return a && a.status === "active" ? { ...a, type: "admin" } : null;
  }
  if (type === "bidder") {
    const [[b]] = await pool.query(
      `SELECT id, company_name, contact_name AS name, email, phone, status, is_active
         FROM bidders WHERE id = ?`,
      [id]
    );
    return b && b.is_active ? { ...b, type: "bidder", role: "bidder" } : null;
  }
  return null;
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw new HttpError(401, "Login required");

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      throw new HttpError(401, "Session expired, please login again");
    }
    const account = await loadAccount(payload);
    if (!account) throw new HttpError(401, "Account is inactive");
    req.user = account;
    next();
  } catch (err) {
    next(err);
  }
}

/** requireAdmin() = any admin; requireAdmin('super_admin') = super admin only. */
const requireAdmin = (role) => (req, res, next) => {
  if (req.user.type !== "admin") return next(new HttpError(403, "Admins only"));
  if (role === "super_admin" && req.user.role !== "super_admin") return next(new HttpError(403, "Super admin only"));
  next();
};

/** Bidder must be approved by an admin before bidding. */
function requireApprovedBidder(req, res, next) {
  if (req.user.type !== "bidder") return next(new HttpError(403, "Only bidders can do this"));
  if (req.user.status !== "approved") return next(new HttpError(403, "Your account is not approved yet"));
  next();
}

const isAdmin = (user) => user.type === "admin";

module.exports = { signToken, loadAccount, authenticate, requireAdmin, requireApprovedBidder, isAdmin };
