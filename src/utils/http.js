/** Error with an HTTP status; thrown from handlers and turned into JSON by errorHandler. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Wraps an async route handler so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Throws 400 if any of the fields is missing/blank in obj. */
function requireFields(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === "");
  if (missing.length) throw new HttpError(400, `Required: ${missing.join(", ")}`);
}

module.exports = { HttpError, asyncHandler, requireFields };
