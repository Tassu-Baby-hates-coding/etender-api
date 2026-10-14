// In-memory sliding window, same rule as the live system: max 20 bids per bidder per tender per minute.
const hits = new Map();

function isRateLimited(key, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > limit;
}

module.exports = { isRateLimited };
