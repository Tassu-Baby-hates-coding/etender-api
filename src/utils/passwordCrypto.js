// Same algorithm as the reference e-tender system: TripleDES, ECB mode, PKCS7 padding,
// key = MD5(secret). It is reversible on purpose so an admin can reveal a bidder's
// password and a super admin can reveal an admin's password.
// The secret comes from .env (PASSWORD_SECRET), never hardcoded.
const CryptoJS = require("crypto-js");

const OPTIONS = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 };

function key() {
  const secret = process.env.PASSWORD_SECRET;
  if (!secret) throw new Error("PASSWORD_SECRET is not set in .env");
  return CryptoJS.enc.Hex.parse(CryptoJS.MD5(secret).toString());
}

function encryptPassword(plain) {
  return CryptoJS.TripleDES.encrypt(CryptoJS.enc.Utf8.parse(String(plain)), key(), OPTIONS).toString();
}

function decryptPassword(cipherText) {
  return CryptoJS.TripleDES.decrypt(cipherText, key(), OPTIONS).toString(CryptoJS.enc.Utf8);
}

/** ECB is deterministic, so login compares the encrypted input with the stored value. */
function passwordMatches(plain, stored) {
  return encryptPassword(plain) === stored;
}

module.exports = { encryptPassword, decryptPassword, passwordMatches };
