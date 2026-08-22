const { all, run, runBatch } = require("./db");
const { getWeekStart, getWeekEnd } = require("./inventoryMath");

function listItems() {
  return all(`
    SELECT
      i.id, i.name, i.sku, i.active, i.reorder_level, i.starting_quantity, i.starting_date, i.image_url,
      i.canonical_item_id AS canonicalItemId,
      i.canonical_mapped_at AS canonicalMappedAt,
      c.name AS canonicalName,
      COALESCE(children.mappedItemCount, 0) AS mappedItemCount
    FROM items i
    LEFT JOIN items c ON c.id = i.canonical_item_id
    LEFT JOIN (
      SELECT canonical_item_id, COUNT(*) AS mappedItemCount
      FROM items WHERE canonical_item_id IS NOT NULL GROUP BY canonical_item_id
    ) children ON children.canonical_item_id = i.id
    ORDER BY i.active DESC, i.name
  `);
}

function listItemsWithStats() {
  return all(`
    SELECT
      i.id, i.name, i.sku, i.active, i.reorder_level, i.starting_quantity, i.starting_date, i.image_url,
      i.canonical_item_id AS canonicalItemId,
      i.canonical_mapped_at AS canonicalMappedAt,
      c.name AS canonicalName,
      COALESCE(children.mappedItemCount, 0) AS mappedItemCount,
      COALESCE(usage.historicalUsed, 0) AS historicalUsed,
      COALESCE(receiving.historicalReceived, 0) AS historicalReceived,
      COALESCE(audits.historicalAuditCount, 0) AS historicalAuditCount,
      COALESCE(counts.historicalPhysicalCount, 0) AS historicalPhysicalCount
    FROM items i
    LEFT JOIN items c ON c.id = i.canonical_item_id
    LEFT JOIN (SELECT canonical_item_id, COUNT(*) AS mappedItemCount FROM items WHERE canonical_item_id IS NOT NULL GROUP BY canonical_item_id) children ON children.canonical_item_id = i.id
    LEFT JOIN (SELECT item_id, SUM(qty) AS historicalUsed FROM inventory_pulls GROUP BY item_id) usage ON usage.item_id = i.id
    LEFT JOIN (SELECT item_id, SUM(qty) AS historicalReceived FROM inventory_receipts GROUP BY item_id) receiving ON receiving.item_id = i.id
    LEFT JOIN (SELECT item_id, COUNT(*) AS historicalAuditCount FROM audit_items GROUP BY item_id) audits ON audits.item_id = i.id
    LEFT JOIN (SELECT item_id, COUNT(*) AS historicalPhysicalCount FROM physical_counts GROUP BY item_id) counts ON counts.item_id = i.id
    ORDER BY i.active DESC, i.name
  `);
}

function findItemByName(name, excludeId = 0) {
  return all("SELECT id, name FROM items WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id != ? LIMIT 1", [name, excludeId]);
}

function getItemForEdit(id) {
  return all(`SELECT i.*,
    COALESCE((SELECT SUM(p.qty) FROM inventory_pulls p WHERE p.item_id = i.id), 0) AS historicalUsed,
    COALESCE((SELECT SUM(r.qty) FROM inventory_receipts r WHERE r.item_id = i.id), 0) AS historicalReceived,
    (SELECT COUNT(*) FROM audit_items ai WHERE ai.item_id = i.id) AS historicalAuditCount,
    (SELECT COUNT(*) FROM physical_counts pc WHERE pc.item_id = i.id) AS historicalPhysicalCount
    FROM items i WHERE i.id = ?`, [id]);
}

function setItemActive(id, active) {
  return run("UPDATE items SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
}

async function mapItems(sourceIds, canonicalId) {
  const uniqueIds = [...new Set(sourceIds.map(Number))];
  const ids = [...uniqueIds, Number(canonicalId)];
  const placeholders = ids.map(() => "?").join(", ");
  const found = await all(`
    SELECT id, name, canonical_item_id AS canonicalItemId, canonical_mapped_at AS canonicalMappedAt,
      (SELECT COUNT(*) FROM items child WHERE child.canonical_item_id = items.id) AS mappedItemCount
    FROM items WHERE id IN (${placeholders})
  `, ids);
  const byId = new Map(found.map(item => [Number(item.id), item]));
  const canonical = byId.get(Number(canonicalId));
  if (!canonical) throw Object.assign(new Error("Canonical SKU not found"), { status: 404 });
  if (canonical.canonicalItemId) throw Object.assign(new Error("Choose a root SKU as the canonical SKU; mapped SKUs cannot be targets"), { status: 400 });
  if (uniqueIds.some(id => id === Number(canonicalId))) throw Object.assign(new Error("A SKU cannot be mapped to itself"), { status: 400 });
  if (uniqueIds.some(id => !byId.has(id))) throw Object.assign(new Error("One or more source SKUs were not found"), { status: 404 });
  if (uniqueIds.some(id => Number(byId.get(id).mappedItemCount) > 0)) {
    throw Object.assign(new Error("A SKU that already has mapped children cannot be mapped under another SKU"), { status: 400 });
  }
  const mappedSources = uniqueIds.map(id => byId.get(id)).filter(item => item.canonicalItemId);
  for (const source of mappedSources) {
    const priorReset = await all(`SELECT id FROM physical_counts
      WHERE item_id = ? AND created_at >= ? LIMIT 1`, [source.canonicalItemId, source.canonicalMappedAt]);
    if (priorReset.length) {
      throw Object.assign(new Error(`${source.name} cannot be remapped because its current canonical group has already had a consolidated audit`), { status: 400 });
    }
  }
  const existingChildren = found.filter(item => Number(item.id) === Number(canonicalId))[0].mappedItemCount;
  if (Number(existingChildren) > 0) {
    const [{ firstMappedAt }] = await all("SELECT MIN(canonical_mapped_at) AS firstMappedAt FROM items WHERE canonical_item_id = ?", [canonicalId]);
    const resets = await all("SELECT id FROM physical_counts WHERE item_id = ? AND created_at >= ? LIMIT 1", [canonicalId, firstMappedAt]);
    if (resets.length) {
      throw Object.assign(new Error("New SKUs cannot be added to this canonical group after a consolidated audit"), { status: 400 });
    }
  }
  await runBatch([
    { sql: "UPDATE items SET active = 1, canonical_item_id = NULL, canonical_mapped_at = NULL WHERE id = ?", args: [canonicalId] },
    ...uniqueIds.map(id => ({
      sql: "UPDATE items SET active = 0, canonical_item_id = ?, canonical_mapped_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [canonicalId, id]
    }))
  ]);
  return { sourceIds: uniqueIds, canonicalId: Number(canonicalId) };
}

async function unmapItem(id) {
  const [item] = await all("SELECT id, name, canonical_item_id AS canonicalItemId, canonical_mapped_at AS canonicalMappedAt FROM items WHERE id = ?", [id]);
  if (!item || !item.canonicalItemId) return { rowsAffected: 0 };
  const reset = await all("SELECT id FROM physical_counts WHERE item_id = ? AND created_at >= ? LIMIT 1", [item.canonicalItemId, item.canonicalMappedAt]);
  if (reset.length) {
    throw Object.assign(new Error("This mapping cannot be removed after a consolidated audit because doing so could double-count inventory"), { status: 400 });
  }
  return run("UPDATE items SET canonical_item_id = NULL, canonical_mapped_at = NULL, active = 1 WHERE id = ?", [id]);
}

async function findInactiveItemIds(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await all(`SELECT id FROM items WHERE id IN (${placeholders}) AND active = 0`, ids);
  return rows.map(row => row.id);
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

function updateItem(id, { name, sku, reorderLevel }) {
  return run(`UPDATE items SET name = ?, sku = ?, reorder_level = ? WHERE id = ?`, [
    name.trim(),
    sku ? sku.trim() : null,
    Number(reorderLevel || 0),
    id
  ]);
}

function getItemImage(id) {
  return all("SELECT id, name, image_url AS imageUrl, image_public_id AS imagePublicId FROM items WHERE id = ?", [id]);
}

function setItemImage(id, imageUrl, imagePublicId) {
  return run("UPDATE items SET image_url = ?, image_public_id = ? WHERE id = ?", [imageUrl, imagePublicId, id]);
}

function clearItemImage(id) {
  return run("UPDATE items SET image_url = NULL, image_public_id = NULL WHERE id = ?", [id]);
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
      c.name AS canonicalItem,
      i.image_url AS imageUrl,
      p.qty,
      p.pulled_by AS pulledBy,
      p.purpose,
      p.notes,
      p.source_ref AS sourceRef
    FROM inventory_pulls p
    JOIN items i ON i.id = p.item_id
    LEFT JOIN items c ON c.id = i.canonical_item_id
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
  const unavailableItems = [...new Set(entries.map(entry => itemByName.get(entry.item)).filter(item => item && !item.active).map(item => item.name))];
  if (unavailableItems.length) {
    const err = new Error(`Legacy or inactive item(s) cannot be used for new entries: ${unavailableItems.join(", ")}`);
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
      c.name AS canonicalItem,
      ai.counted_qty AS countedQty
    FROM audit_sessions a
    LEFT JOIN audit_items ai ON ai.audit_id = a.id
    LEFT JOIN items i ON i.id = ai.item_id
    LEFT JOIN items c ON c.id = i.canonical_item_id
    WHERE a.id = ?
    ORDER BY i.name
  `, [id]);
}

async function getCurrentInventory(asOfDate, startDate, endDate, includeInactive = false) {
  const pullThrough = endDate > asOfDate ? endDate : asOfDate;
  const [itemRows, receipts, pulls, counts] = await Promise.all([
    listItems(),
    all(`SELECT item_id AS itemId, SUM(qty) AS qty, received_date AS date
      FROM inventory_receipts WHERE received_date <= ? GROUP BY item_id, received_date`, [asOfDate]),
    all(`SELECT item_id AS itemId, SUM(qty) AS qty, pulled_date AS date
      FROM inventory_pulls WHERE pulled_date <= ? GROUP BY item_id, pulled_date`, [pullThrough]),
    all(`SELECT id, item_id AS itemId, counted_qty AS qty, counted_date AS date, created_at AS createdAt
      FROM physical_counts WHERE counted_date <= ? ORDER BY counted_date DESC, id DESC`, [asOfDate])
  ]);
  const roots = itemRows.filter(item => !item.canonicalItemId && (includeInactive || item.active));
  const membersByRoot = new Map(roots.map(root => [Number(root.id), []]));
  for (const item of itemRows) {
    const rootId = Number(item.canonicalItemId || item.id);
    if (membersByRoot.has(rootId)) membersByRoot.get(rootId).push(item);
  }
  const sum = rows => rows.reduce((total, row) => total + Number(row.qty), 0);
  const groupByItem = rows => {
    const grouped = new Map();
    for (const row of rows) {
      const itemId = Number(row.itemId);
      if (!grouped.has(itemId)) grouped.set(itemId, []);
      grouped.get(itemId).push(row);
    }
    return grouped;
  };
  const receiptsByItem = groupByItem(receipts);
  const pullsByItem = groupByItem(pulls);
  const countsByItem = groupByItem(counts);
  const latestCountFor = itemId => (countsByItem.get(Number(itemId)) || [])[0];

  return roots.map(root => {
    const members = membersByRoot.get(Number(root.id));
    const groupReceipts = members.flatMap(item => receiptsByItem.get(Number(item.id)) || []);
    const groupPulls = members.flatMap(item => pullsByItem.get(Number(item.id)) || []);
    const mappedChildren = members.filter(item => Number(item.id) !== Number(root.id));
    const latestMappedAt = mappedChildren.map(item => item.canonicalMappedAt).filter(Boolean).sort().at(-1);
    const groupReset = latestMappedAt
      ? (countsByItem.get(Number(root.id)) || []).find(count => count.createdAt >= latestMappedAt)
      : null;

    let calculatedOnHand;
    let lastCountedQty;
    let lastCountedDate;
    if (groupReset) {
      calculatedOnHand = Number(groupReset.qty)
        + sum(groupReceipts.filter(row => row.date > groupReset.date))
        - sum(groupPulls.filter(row => row.date <= asOfDate && row.date > groupReset.date));
      lastCountedQty = Number(groupReset.qty);
      lastCountedDate = groupReset.date;
    } else {
      calculatedOnHand = members.reduce((groupTotal, member) => {
        const lastCount = latestCountFor(member.id);
        const baseline = lastCount ? Number(lastCount.qty) : Number(member.starting_quantity);
        const after = lastCount ? lastCount.date : "0000-00-00";
        return groupTotal + baseline
          + sum(groupReceipts.filter(row => Number(row.itemId) === Number(member.id) && row.date > after))
          - sum(groupPulls.filter(row => Number(row.itemId) === Number(member.id) && row.date <= asOfDate && row.date > after));
      }, 0);
      const latestMemberCount = members.map(item => latestCountFor(item.id)).filter(Boolean)
        .sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id))[0];
      lastCountedQty = latestMemberCount ? Number(latestMemberCount.qty) : null;
      lastCountedDate = latestMemberCount ? latestMemberCount.date : null;
    }

    return {
      id: Number(root.id),
      name: root.name,
      sku: root.sku,
      imageUrl: root.image_url,
      active: Number(root.active),
      reorderLevel: Number(root.reorder_level),
      startingQuantity: members.reduce((total, item) => total + Number(item.starting_quantity), 0),
      totalReceived: sum(groupReceipts),
      totalPulled: sum(groupPulls.filter(row => row.date <= asOfDate)),
      pulledInRange: sum(groupPulls.filter(row => row.date >= startDate && row.date <= endDate)),
      lastCountedQty,
      lastCountedDate,
      calculatedOnHand,
      componentCount: members.length,
      components: members.map(item => ({ id: Number(item.id), name: item.name }))
    };
  }).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

function getWeeklyUsage({ startDate, endDate }) {
  // Spreadsheet equivalent of End of week use totals SUMIFS by item and date range.
  const start = startDate || getWeekStart(new Date().toISOString().slice(0, 10));
  const end = endDate || getWeekEnd(start);
  return all(`
    SELECT root.id, root.name, root.image_url AS imageUrl, SUM(p.qty) AS usedQty
    FROM inventory_pulls p
    JOIN items source ON source.id = p.item_id
    JOIN items root ON root.id = COALESCE(source.canonical_item_id, source.id)
    WHERE p.pulled_date BETWEEN ? AND ?
    GROUP BY root.id, root.name, root.image_url
    ORDER BY root.name
  `, [start, end]);
}

function getPurposeSummary({ startDate, endDate }) {
  // Spreadsheet equivalent of reporting sheet SUMIFS by item + purpose + selected date range.
  return all(`
    SELECT root.name AS item, p.purpose, SUM(p.qty) AS totalQty
    FROM inventory_pulls p
    JOIN items source ON source.id = p.item_id
    JOIN items root ON root.id = COALESCE(source.canonical_item_id, source.id)
    WHERE p.pulled_date BETWEEN ? AND ?
    GROUP BY root.id, root.name, p.purpose
    ORDER BY root.name, p.purpose
  `, [startDate, endDate]);
}

function getYtdUsage({ startDate, endDate }) {
  return all(`
    SELECT root.id, root.name, COALESCE(SUM(p.qty), 0) AS ytdUsedQty
    FROM items root
    LEFT JOIN items source ON COALESCE(source.canonical_item_id, source.id) = root.id
    LEFT JOIN inventory_pulls p ON p.item_id = source.id AND p.pulled_date BETWEEN ? AND ?
    WHERE root.active = 1 AND root.canonical_item_id IS NULL
    GROUP BY root.id, root.name
    ORDER BY root.name
  `, [startDate, endDate]);
}

function getPullLog(limit = 500) {
  return all(`
    SELECT p.id, p.pulled_date AS date, i.name AS item, c.name AS canonicalItem,
      p.qty, p.pulled_by AS pulledBy, p.purpose, p.notes
    FROM inventory_pulls p
    JOIN items i ON i.id = p.item_id
    LEFT JOIN items c ON c.id = i.canonical_item_id
    ORDER BY p.pulled_date DESC, p.id DESC
    LIMIT ?
  `, [limit]);
}

function getUsageAnalysis(itemIds = []) {
  const ids = itemIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  const where = ids.length ? `WHERE root.id IN (${ids.map(() => "?").join(", ")})` : "";
  return all(`
    SELECT
      root.id AS itemId,
      root.name AS item,
      p.pulled_date AS date,
      SUM(p.qty) AS qty
    FROM inventory_pulls p
    JOIN items source ON source.id = p.item_id
    JOIN items root ON root.id = COALESCE(source.canonical_item_id, source.id)
    ${where}
    GROUP BY root.id, root.name, p.pulled_date
    ORDER BY p.pulled_date, root.name
  `, ids);
}

module.exports = { listItems, listItemsWithStats, findItemByName, getItemForEdit, setItemActive, mapItems, unmapItem, findInactiveItemIds, createItem, updateItem, getItemImage, setItemImage, clearItemImage, createPull, createPulls, listEntries, importPullEntries, createReceipt, createReceipts, createPhysicalCount, createPhysicalCounts, createAudit, listAudits, getAuditDetails, getCurrentInventory, getWeeklyUsage, getPurposeSummary, getYtdUsage, getPullLog, getUsageAnalysis };
