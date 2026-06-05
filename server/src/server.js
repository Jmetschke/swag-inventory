require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initDb } = require("./db");
const q = require("./queries");
const { getWeekStart, getWeekEnd } = require("./inventoryMath");

initDb();
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

app.get("/api/items", (req, res) => res.json(q.listItems()));

app.post("/api/pulls", (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "qty", "pulledDate", "purpose"]);
    const result = q.createPull(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.post("/api/receipts", (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "qty", "receivedDate"]);
    const result = q.createReceipt(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.post("/api/physical-counts", (req, res, next) => {
  try {
    requireFields(req.body, ["itemId", "countedQty", "countedDate"]);
    const result = q.createPhysicalCount(req.body);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { next(err); }
});

app.get("/api/inventory", (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  res.json(q.getCurrentInventory(asOf));
});

app.get("/api/reports/weekly-usage", (req, res) => {
  const startDate = req.query.startDate || getWeekStart(new Date().toISOString().slice(0, 10));
  const endDate = req.query.endDate || getWeekEnd(startDate);
  res.json({ startDate, endDate, rows: q.getWeeklyUsage({ startDate, endDate }) });
});

app.get("/api/reports/purpose-summary", (req, res) => {
  const startDate = req.query.startDate || getWeekStart(new Date().toISOString().slice(0, 10));
  const endDate = req.query.endDate || getWeekEnd(startDate);
  res.json({ startDate, endDate, rows: q.getPurposeSummary({ startDate, endDate }) });
});

app.get("/api/reports/ytd", (req, res) => {
  const startDate = req.query.startDate || "2026-03-09";
  const endDate = req.query.endDate || new Date().toISOString().slice(0, 10);
  res.json({ startDate, endDate, rows: q.getYtdUsage({ startDate, endDate }) });
});

app.get("/api/logs/pulls", (req, res) => res.json(q.getPullLog(Number(req.query.limit || 500))));

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Swag inventory app running on http://localhost:${port}`));
