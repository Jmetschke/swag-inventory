const { all, run, runBatch } = require("./db");
const { getWeekStart, getWeekEnd } = require("./inventoryMath");

function listItems() {
  return all("SELECT * FROM items WHERE active = 1 ORDER BY name");
}

function createItem({ name, sku, reorderLevel, startingQuantity, startingDate }) {
  return run(`INSERT INTO items (name, sku, reorder_level, starting_quantity, starting_date)
    VALUES (?, ?, ?, ?, ?)`, [
    name.trim(),
    sku || null,
    Number(reorderLevel || 0),
    Number(startingQuantity || 0),
    startingDate || "2026-03-09"
  ]);
}

function createPull({ itemId, qty, pulledDate, pulledBy, purpose, notes }) {
  return run(`INSERT INTO inventory_pulls (item_id, qty, pulled_date, pulled_by, purpose, notes)
    VALUES (?, ?, ?, ?, ?, ?)`, [itemId, qty, pulledDate, pulledBy || null, purpose, notes || null]);
}

async function createPulls({ items, pulledDate, pulledBy, purpose, notes }) {
  return runBatch(items.map(item => ({
    sql: `INSERT INTO inventory_pulls (item_id, qty, pulled_date, pulled_by, purpose, notes)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [item.itemId, item.qty, pulledDate, pulledBy || null, purpose, notes || null]
  })));
}

function createReceipt({ itemId, qty, receivedDate, receivedBy, notes }) {
  return run(`INSERT INTO inventory_receipts (item_id, qty, received_date, received_by, notes)
    VALUES (?, ?, ?, ?, ?)`, [itemId, qty, receivedDate, receivedBy || null, notes || null]);
}

async function createReceipts({ items, receivedDate, receivedBy, notes }) {
  return runBatch(items.map(item => ({
    sql: `INSERT INTO inventory_receipts (item_id, qty, received_date, received_by, notes)
      VALUES (?, ?, ?, ?, ?)`,
    args: [item.itemId, item.qty, receivedDate, receivedBy || null, notes || null]
  })));
}

function createPhysicalCount({ itemId, countedQty, countedDate, countedBy, notes }) {
  return run(`INSERT INTO physical_counts (item_id, counted_qty, counted_date, counted_by, notes)
    VALUES (?, ?, ?, ?, ?)`, [itemId, countedQty, countedDate, countedBy || null, notes || null]);
}

function getCurrentInventory(asOfDate, startDate, endDate) {
  // Spreadsheet equivalent of: calculated count = prior count + items received - end-of-week use totals.
  return all(`
    SELECT
      i.id,
      i.name,
      i.starting_quantity AS startingQuantity,
      COALESCE((SELECT SUM(r.qty) FROM inventory_receipts r WHERE r.item_id = i.id AND r.received_date <= ?), 0) AS totalReceived,
      COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date <= ?), 0) AS totalPulled,
      COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?), 0) AS pulledInRange,
      i.starting_quantity
        + COALESCE((SELECT SUM(r.qty) FROM inventory_receipts r WHERE r.item_id = i.id AND r.received_date <= ?), 0)
        - COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date <= ?), 0) AS calculatedOnHand
    FROM items i
    WHERE i.active = 1
    ORDER BY i.name
  `, [asOfDate, asOfDate, startDate, endDate, asOfDate, asOfDate]);
}

function getWeeklyUsage({ startDate, endDate }) {
  // Spreadsheet equivalent of End of week use totals SUMIFS by item and date range.
  const start = startDate || getWeekStart(new Date().toISOString().slice(0, 10));
  const end = endDate || getWeekEnd(start);
  return all(`
    SELECT i.id, i.name, COALESCE(SUM(p.qty), 0) AS usedQty
    FROM items i
    LEFT JOIN inventory_pulls p ON p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?
    WHERE i.active = 1
    GROUP BY i.id, i.name
    ORDER BY i.name
  `, [start, end]);
}

function getPurposeSummary({ startDate, endDate }) {
  // Spreadsheet equivalent of reporting sheet SUMIFS by item + purpose + selected date range.
  return all(`
    SELECT i.name AS item, p.purpose, SUM(p.qty) AS totalQty
    FROM inventory_pulls p
    JOIN items i ON i.id = p.item_id
    WHERE p.pulled_date BETWEEN ? AND ?
    GROUP BY i.name, p.purpose
    ORDER BY i.name, p.purpose
  `, [startDate, endDate]);
}

function getYtdUsage({ startDate, endDate }) {
  return all(`
    SELECT i.id, i.name, COALESCE(SUM(p.qty), 0) AS ytdUsedQty
    FROM items i
    LEFT JOIN inventory_pulls p ON p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?
    WHERE i.active = 1
    GROUP BY i.id, i.name
    ORDER BY i.name
  `, [startDate, endDate]);
}

function getPullLog(limit = 500) {
  return all(`
    SELECT p.id, p.pulled_date AS date, i.name AS item, p.qty, p.pulled_by AS pulledBy, p.purpose, p.notes
    FROM inventory_pulls p JOIN items i ON i.id = p.item_id
    ORDER BY p.pulled_date DESC, p.id DESC
    LIMIT ?
  `, [limit]);
}

module.exports = { listItems, createItem, createPull, createPulls, createReceipt, createReceipts, createPhysicalCount, getCurrentInventory, getWeeklyUsage, getPurposeSummary, getYtdUsage, getPullLog };
