const { db } = require("./db");
const { getWeekStart, getWeekEnd } = require("./inventoryMath");

function listItems() {
  return db.prepare("SELECT * FROM items WHERE active = 1 ORDER BY name").all();
}

function createPull({ itemId, qty, pulledDate, pulledBy, purpose, notes }) {
  return db.prepare(`INSERT INTO inventory_pulls (item_id, qty, pulled_date, pulled_by, purpose, notes)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(itemId, qty, pulledDate, pulledBy || null, purpose, notes || null);
}

function createReceipt({ itemId, qty, receivedDate, receivedBy, notes }) {
  return db.prepare(`INSERT INTO inventory_receipts (item_id, qty, received_date, received_by, notes)
    VALUES (?, ?, ?, ?, ?)`)
    .run(itemId, qty, receivedDate, receivedBy || null, notes || null);
}

function createPhysicalCount({ itemId, countedQty, countedDate, countedBy, notes }) {
  return db.prepare(`INSERT INTO physical_counts (item_id, counted_qty, counted_date, counted_by, notes)
    VALUES (?, ?, ?, ?, ?)`)
    .run(itemId, countedQty, countedDate, countedBy || null, notes || null);
}

function getCurrentInventory(asOfDate) {
  // Spreadsheet equivalent of: calculated count = prior count + items received - end-of-week use totals.
  return db.prepare(`
    SELECT
      i.id,
      i.name,
      i.starting_quantity AS startingQuantity,
      COALESCE((SELECT SUM(r.qty) FROM inventory_receipts r WHERE r.item_id = i.id AND r.received_date <= ?), 0) AS totalReceived,
      COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date <= ?), 0) AS totalPulled,
      i.starting_quantity
        + COALESCE((SELECT SUM(r.qty) FROM inventory_receipts r WHERE r.item_id = i.id AND r.received_date <= ?), 0)
        - COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date <= ?), 0) AS calculatedOnHand
    FROM items i
    WHERE i.active = 1
    ORDER BY i.name
  `).all(asOfDate, asOfDate, asOfDate, asOfDate);
}

function getWeeklyUsage({ startDate, endDate }) {
  // Spreadsheet equivalent of End of week use totals SUMIFS by item and date range.
  const start = startDate || getWeekStart(new Date().toISOString().slice(0, 10));
  const end = endDate || getWeekEnd(start);
  return db.prepare(`
    SELECT i.id, i.name, COALESCE(SUM(p.qty), 0) AS usedQty
    FROM items i
    LEFT JOIN inventory_pulls p ON p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?
    WHERE i.active = 1
    GROUP BY i.id, i.name
    ORDER BY i.name
  `).all(start, end);
}

function getPurposeSummary({ startDate, endDate }) {
  // Spreadsheet equivalent of reporting sheet SUMIFS by item + purpose + selected date range.
  return db.prepare(`
    SELECT i.name AS item, p.purpose, SUM(p.qty) AS totalQty
    FROM inventory_pulls p
    JOIN items i ON i.id = p.item_id
    WHERE p.pulled_date BETWEEN ? AND ?
    GROUP BY i.name, p.purpose
    ORDER BY i.name, p.purpose
  `).all(startDate, endDate);
}

function getYtdUsage({ startDate, endDate }) {
  return db.prepare(`
    SELECT i.id, i.name, COALESCE(SUM(p.qty), 0) AS ytdUsedQty
    FROM items i
    LEFT JOIN inventory_pulls p ON p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?
    WHERE i.active = 1
    GROUP BY i.id, i.name
    ORDER BY i.name
  `).all(startDate, endDate);
}

function getPullLog(limit = 500) {
  return db.prepare(`
    SELECT p.id, p.pulled_date AS date, i.name AS item, p.qty, p.pulled_by AS pulledBy, p.purpose, p.notes
    FROM inventory_pulls p JOIN items i ON i.id = p.item_id
    ORDER BY p.pulled_date DESC, p.id DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { listItems, createPull, createReceipt, createPhysicalCount, getCurrentInventory, getWeeklyUsage, getPurposeSummary, getYtdUsage, getPullLog };
