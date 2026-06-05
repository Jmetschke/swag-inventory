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

app.get("/api/items", async (req, res, next) => {
  try {
    res.json(await q.listItems());
  } catch (err) { next(err); }
});

app.post("/api/pulls", async (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "qty", "pulledDate", "purpose"]);
    const result = await q.createPull(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.post("/api/receipts", async (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "qty", "receivedDate"]);
    const result = await q.createReceipt(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.post("/api/physical-counts", async (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "countedQty", "countedDate"]);
    const result = await q.createPhysicalCount(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.get("/api/inventory", async (req, res, next) => {
  try {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
    res.json(await q.getCurrentInventory(asOf));
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
