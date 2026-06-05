require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initDb } = require("./db");
const q = require("./queries");
const { getWeekStart, getWeekEnd } = require("./inventoryMath");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

function requireFields(body, fields) {
  const missing = fields.filter(f => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

function normalizeLineItems(body) {
  const items = Array.isArray(body.items) ? body.items : [{ itemId: body.itemId, qty: body.qty }];
  const normalized = items
    .map(item => ({ itemId: Number(item.itemId), qty: Number(item.qty) }))
    .filter(item => Number.isFinite(item.itemId) || Number.isFinite(item.qty));

  if (!normalized.length) {
    const err = new Error("At least one item is required");
    err.status = 400;
    throw err;
  }

  const invalid = normalized.find(item => !Number.isInteger(item.itemId) || item.itemId <= 0 || !Number.isFinite(item.qty));
  if (invalid) {
    const err = new Error("Each item must include a valid itemId and qty");
    err.status = 400;
    throw err;
  }

  return normalized;
}

app.get("/api/items", async (req, res, next) => {
  try {
    res.json(await q.listItems());
  } catch (err) { next(err); }
});

app.post("/api/items", async (req, res, next) => {
  try {
    requireFields(req.body, ["name"]);
    const startingQuantity = Number(req.body.startingQuantity || 0);
    const reorderLevel = Number(req.body.reorderLevel || 0);
    if (!Number.isFinite(startingQuantity) || startingQuantity < 0 || !Number.isFinite(reorderLevel) || reorderLevel < 0) {
      const err = new Error("Starting quantity and reorder level must be non-negative numbers");
      err.status = 400;
      throw err;
    }
    const result = await q.createItem({ ...req.body, startingQuantity, reorderLevel });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.post("/api/pulls", async (req, res, next) => {
  try {
    requireFields(req.body, ["pulledDate", "purpose"]);
    const items = normalizeLineItems(req.body);
    const invalid = items.find(item => item.qty <= 0);
    if (invalid) {
      const err = new Error("Pulled quantities must be greater than 0");
      err.status = 400;
      throw err;
    }
    const results = await q.createPulls({ ...req.body, items });
    res.status(201).json({ ids: results.map(result => result.lastInsertRowid) });
  } catch (err) { next(err); }
});

app.post("/api/receipts", async (req, res, next) => {
  try {
    requireFields(req.body, ["receivedDate"]);
    const items = normalizeLineItems(req.body);
    const invalid = items.find(item => item.qty < 0);
    if (invalid) {
      const err = new Error("Received quantities cannot be negative");
      err.status = 400;
      throw err;
    }
    const results = await q.createReceipts({ ...req.body, items });
    res.status(201).json({ ids: results.map(result => result.lastInsertRowid) });
  } catch (err) { next(err); }
});

app.post("/api/physical-counts", async (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "countedQty", "countedDate"]);
    const result = await q.createPhysicalCount(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.get("/api/audits", async (req, res, next) => {
  try {
    res.json(await q.listAudits());
  } catch (err) { next(err); }
});

app.get("/api/audits/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      const err = new Error("Invalid audit id");
      err.status = 400;
      throw err;
    }
    const rows = await q.getAuditDetails(id);
    if (!rows.length) {
      const err = new Error("Audit not found");
      err.status = 404;
      throw err;
    }
    const first = rows[0];
    res.json({
      id: first.id,
      countedDate: first.countedDate,
      countedBy: first.countedBy,
      notes: first.notes,
      createdAt: first.createdAt,
      rows: rows.filter(row => row.item).map(row => ({
        item: row.item,
        countedQty: row.countedQty
      }))
    });
  } catch (err) { next(err); }
});

app.post("/api/audits", async (req, res, next) => {
  try {
    requireFields(req.body, ["countedDate"]);
    const counts = Array.isArray(req.body.counts) ? req.body.counts : [];
    const normalized = counts.map(count => ({
      itemId: Number(count.itemId),
      countedQty: Number(count.countedQty)
    }));
    const invalid = normalized.find(count =>
      !Number.isInteger(count.itemId) ||
      count.itemId <= 0 ||
      !Number.isInteger(count.countedQty)
    );
    if (invalid) {
      const err = new Error("Audit counts must include a valid itemId and countedQty");
      err.status = 400;
      throw err;
    }
    const result = await q.createAudit({ ...req.body, counts: normalized });
    res.status(201).json({
      id: result.auditId,
      ids: result.countResults.map(count => count.lastInsertRowid)
    });
  } catch (err) { next(err); }
});

app.get("/api/inventory", async (req, res, next) => {
  try {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
    const startDate = req.query.startDate || asOf;
    const endDate = req.query.endDate || asOf;
    res.json(await q.getCurrentInventory(asOf, startDate, endDate));
  } catch (err) { next(err); }
});

app.get("/api/reports/weekly-usage", async (req, res, next) => {
  try {
    const startDate = req.query.startDate || getWeekStart(new Date().toISOString().slice(0, 10));
    const endDate = req.query.endDate || getWeekEnd(startDate);
    res.json({ startDate, endDate, rows: await q.getWeeklyUsage({ startDate, endDate }) });
  } catch (err) { next(err); }
});

app.get("/api/reports/purpose-summary", async (req, res, next) => {
  try {
    const startDate = req.query.startDate || getWeekStart(new Date().toISOString().slice(0, 10));
    const endDate = req.query.endDate || getWeekEnd(startDate);
    res.json({ startDate, endDate, rows: await q.getPurposeSummary({ startDate, endDate }) });
  } catch (err) { next(err); }
});

app.get("/api/reports/ytd", async (req, res, next) => {
  try {
    const startDate = req.query.startDate || "2026-03-09";
    const endDate = req.query.endDate || new Date().toISOString().slice(0, 10);
    res.json({ startDate, endDate, rows: await q.getYtdUsage({ startDate, endDate }) });
  } catch (err) { next(err); }
});

app.get("/api/logs/pulls", async (req, res, next) => {
  try {
    res.json(await q.getPullLog(Number(req.query.limit || 500)));
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const port = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(port, () => console.log(`Swag inventory app running on http://localhost:${port}`));
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
