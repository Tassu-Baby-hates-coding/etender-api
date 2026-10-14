/**
 * Next tender number for today: YYYYMMDD + 3-digit serial (e.g. 20261007001).
 * Call inside a transaction; the UNIQUE index on tender_no rejects a rare duplicate
 * and the caller retries.
 */
async function nextTenderNo(conn, date = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const prefix = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const [[row]] = await conn.query(
    "SELECT MAX(tender_no) AS last FROM tenders WHERE tender_no LIKE ? FOR UPDATE",
    [`${prefix}%`]
  );
  const serial = row.last ? Number(row.last.slice(8)) + 1 : 1;
  return `${prefix}${pad(serial, 3)}`;
}

module.exports = { nextTenderNo };
