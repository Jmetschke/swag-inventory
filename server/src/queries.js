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

function entryKey(entry) {
  return [
    entry.pulledDate,
    entry.itemId,
    entry.qty,
    entry.pulledBy || "",
    entry.purpose,
    entry.notes || ""
  ].join("\u001f");
}

function listEntries(limit = 1000) {
  return all(`
    SELECT
      p.id,
      p.pulled_date AS date,
      i.name AS itemPulled,
      p.qty,
      p.pulled_by AS pulledBy,
      p.purpose,
      p.notes,
      p.source_ref AS sourceRef
    FROM inventory_pulls p
    JOIN items i ON i.id = p.item_id
    ORDER BY p.pulled_date DESC, p.id DESC
    LIMIT ?
  `, [limit]);
}

async function importPullEntries(entries) {
  const items = await listItems();
  const itemByName = new Map(items.map(item => [item.name, item]));
  const missingItems = [...new Set(entries.map(entry => entry.item).filter(item => !itemByName.has(item)))];
  if (missingItems.length) {
    const err = new Error(`Missing item(s): ${missingItems.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const normalized = entries.map(entry => ({
    ...entry,
    itemId: itemByName.get(entry.item).id,
    qty: Number(entry.qty)
  }));

  const existingRefs = new Set(
    (await all("SELECT source_ref AS sourceRef FROM inventory_pulls WHERE source_ref IS NOT NULL"))
      .map(row => row.sourceRef)
  );
  const existingRows = await all(`
    SELECT
      p.pulled_date AS pulledDate,
      p.item_id AS itemId,
      p.qty,
      p.pulled_by AS pulledBy,
      p.purpose,
      p.notes
    FROM inventory_pulls p
  `);
  const existingKeys = new Set(existingRows.map(entryKey));
  const seenKeys = new Set();
  const skipped = [];
  const newEntries = [];

  for (const entry of normalized) {
    const key = entryKey(entry);
    if (existingRefs.has(entry.sourceRef) || existingKeys.has(key) || seenKeys.has(key)) {
      skipped.push(entry);
      continue;
    }
    seenKeys.add(key);
    newEntries.push(entry);
  }

  if (newEntries.length) {
    await runBatch(newEntries.map(entry => ({
      sql: `INSERT INTO inventory_pulls
        (item_id, qty, pulled_date, pulled_by, purpose, notes, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.itemId,
        entry.qty,
        entry.pulledDate,
        entry.pulledBy || null,
        entry.purpose,
        entry.notes || null,
        entry.sourceRef
      ]
    })));
  }

  const dates = normalized.map(entry => entry.pulledDate).sort();
  return {
    inserted: newEntries.length,
    skipped: skipped.length,
    total: entries.length,
    startDate: dates[0] || null,
    endDate: dates[dates.length - 1] || null,
    missingItems
  };
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

function createAuditSession({ countedDate, countedBy, notes }) {
  return run(`INSERT INTO audit_sessions (counted_date, counted_by, notes)
    VALUES (?, ?, ?)`, [countedDate, countedBy || null, notes || null]);
}

async function createPhysicalCounts({ auditId, counts, countedDate, countedBy, notes }) {
  return runBatch(counts.map(count => ({
    sql: `INSERT INTO physical_counts (audit_id, item_id, counted_qty, counted_date, counted_by, notes)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [auditId || null, count.itemId, count.countedQty, countedDate, countedBy || null, notes || null]
  })));
}

async function createAuditItems({ auditId, counts }) {
  return runBatch(counts.map(count => ({
    sql: "INSERT INTO audit_items (audit_id, item_id, counted_qty) VALUES (?, ?, ?)",
    args: [auditId, count.itemId, count.countedQty]
  })));
}

async function createAudit({ counts, countedDate, countedBy, notes }) {
  const audit = await createAuditSession({ countedDate, countedBy, notes });
  const auditId = audit.lastInsertRowid;
  const auditItemResults = counts.length
    ? await createAuditItems({ auditId, counts })
    : [];
  const physicalCounts = counts.filter(count => count.countedQty >= 0);
  const countResults = physicalCounts.length
    ? await createPhysicalCounts({ auditId, counts: physicalCounts, countedDate, countedBy, notes })
    : [];
  return { auditId, auditItemResults, countResults };
}

function listAudits() {
  return all(`
    SELECT
      a.id,
      a.counted_date AS countedDate,
      a.counted_by AS countedBy,
      a.notes,
      a.created_at AS createdAt,
      COUNT(ai.id) AS itemCount
    FROM audit_sessions a
    LEFT JOIN audit_items ai ON ai.audit_id = a.id
    GROUP BY a.id, a.counted_date, a.counted_by, a.notes, a.created_at
    ORDER BY a.counted_date DESC, a.id DESC
  `);
}

function getAuditDetails(id) {
  return all(`
    SELECT
      a.id,
      a.counted_date AS countedDate,
      a.counted_by AS countedBy,
      a.notes,
      a.created_at AS createdAt,
      i.name AS item,
      ai.counted_qty AS countedQty
    FROM audit_sessions a
    LEFT JOIN audit_items ai ON ai.audit_id = a.id
    LEFT JOIN items i ON i.id = ai.item_id
    WHERE a.id = ?
    ORDER BY i.name
  `, [id]);
}

function getCurrentInventory(asOfDate, startDate, endDate) {
  return all(`
    SELECT
      i.id,
      i.name,
      i.starting_quantity AS startingQuantity,
      COALESCE((SELECT SUM(r.qty) FROM inventory_receipts r WHERE r.item_id = i.id AND r.received_date <= ?), 0) AS totalReceived,
      COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date <= ?), 0) AS totalPulled,
      COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?), 0) AS pulledInRange,
      (SELECT pc.counted_qty FROM physical_counts pc WHERE pc.item_id = i.id AND pc.counted_date <= ? ORDER BY pc.counted_date DESC, pc.id DESC LIMIT 1) AS lastCountedQty,
      (SELECT pc.counted_date FROM physical_counts pc WHERE pc.item_id = i.id AND pc.counted_date <= ? ORDER BY pc.counted_date DESC, pc.id DESC LIMIT 1) AS lastCountedDate,
      COALESCE((SELECT pc.counted_qty FROM physical_counts pc WHERE pc.item_id = i.id AND pc.counted_date <= ? ORDER BY pc.counted_date DESC, pc.id DESC LIMIT 1), i.starting_quantity)
        + COALESCE((
          SELECT SUM(r.qty)
          FROM inventory_receipts r
          WHERE r.item_id = i.id
            AND r.received_date <= ?
            AND r.received_date > COALESCE((SELECT pc.counted_date FROM physical_counts pc WHERE pc.item_id = i.id AND pc.counted_date <= ? ORDER BY pc.counted_date DESC, pc.id DESC LIMIT 1), '0000-00-00')
        ), 0)
        - COALESCE((
          SELECT SUM(p.qty)
          FROM inventory_pulls p
          WHERE p.item_id = i.id
            AND p.pulled_date <= ?
            AND p.pulled_date > COALESCE((SELECT pc.counted_date FROM physical_counts pc WHERE pc.item_id = i.id AND pc.counted_date <= ? ORDER BY pc.counted_date DESC, pc.id DESC LIMIT 1), '0000-00-00')
        ), 0) AS calculatedOnHand
    FROM items i
    WHERE i.active = 1
    ORDER BY i.name
  `, [asOfDate, asOfDate, startDate, endDate, asOfDate, asOfDate, asOfDate, asOfDate, asOfDate, asOfDate, asOfDate]);
}

function getWeeklyUsage({ startDate, endDate }) {
  // Spreadsheet equivalent of End of week use totals SUMIFS by item and date range.
  const start = startDate || getWeekStart(new Date().toISOString().slice(0, 10));
  const end = endDate || getWeekEnd(start);
  return all(`
    SELECT i.id, i.name, SUM(p.qty) AS usedQty
    FROM items i
    JOIN inventory_pulls p ON p.item_id = i.id AND p.pulled_date BETWEEN ? AND ?
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

module.exports = { listItems, createItem, createPull, createPulls, listEntries, importPullEntries, createReceipt, createReceipts, createPhysicalCount, createPhysicalCounts, createAudit, listAudits, getAuditDetails, getCurrentInventory, getWeeklyUsage, getPurposeSummary, getYtdUsage, getPullLog };
