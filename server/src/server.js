require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { initDb } = require("./db");
const q = require("./queries");
const { getWeekStart, getWeekEnd } = require("./inventoryMath");
const { parseReportingWorkbook, createEntryTemplate } = require("./reportingWorkbook");
const { uploadProductImage, deleteProductImage } = require("./cloudinary");

const app = express();
let dbReady = false;
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      callback(null, true);
      return;
    }
    const err = new Error("Product images must be JPEG, PNG, or WEBP files");
    err.status = 400;
    callback(err);
  }
});

app.use("/api", (req, res, next) => {
  if (!dbReady) {
    res.status(503).json({ error: "Database is still initializing. Try again shortly." });
    return;
  }
  next();
});

function requireFields(body, fields) {
  const missing = fields.filter(f => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

function requireValidItemId(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid item id" });
    return;
  }
  req.itemId = id;
  next();
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
    res.json(await (req.query.includeStats === "true" ? q.listItemsWithStats() : q.listItems()));
  } catch (err) { next(err); }
});

app.post("/api/items", async (req, res, next) => {
  try {
    requireFields(req.body, ["name"]);
    const normalizedName = String(req.body.name).trim();
    if (!normalizedName) {
      const err = new Error("Item name is required");
      err.status = 400;
      throw err;
    }
    const [duplicate] = await q.findItemByName(normalizedName);
    if (duplicate) {
      const err = new Error(`A SKU named '${duplicate.name}' already exists`);
      err.status = 409;
      throw err;
    }
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

app.patch("/api/items/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    requireFields(req.body, ["name"]);
    const reorderLevel = Number(req.body.reorderLevel || 0);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(reorderLevel) || reorderLevel < 0) {
      const err = new Error("A valid item id and non-negative reorder level are required");
      err.status = 400;
      throw err;
    }
    const normalizedName = String(req.body.name).trim();
    const [[item], [duplicate]] = await Promise.all([
      q.getItemForEdit(id),
      q.findItemByName(normalizedName, id)
    ]);
    if (!item) {
      const err = new Error("Item not found");
      err.status = 404;
      throw err;
    }
    if (!normalizedName) {
      const err = new Error("Item name is required");
      err.status = 400;
      throw err;
    }
    const hasHistory = Number(item.historicalUsed) > 0 || Number(item.historicalReceived) > 0 ||
      Number(item.historicalAuditCount) > 0 || Number(item.historicalPhysicalCount) > 0;
    if (hasHistory && normalizedName !== item.name) {
      const err = new Error("This item has historical activity, so its name cannot be changed. Create or map to a canonical SKU instead.");
      err.status = 409;
      throw err;
    }
    if (duplicate) {
      const err = new Error(`A SKU named '${duplicate.name}' already exists`);
      err.status = 409;
      throw err;
    }
    const result = await q.updateItem(id, { ...req.body, name: normalizedName, reorderLevel });
    res.json({ id, rowsAffected: result.rowsAffected });
  } catch (err) { next(err); }
});

app.post("/api/items/:id/image", requireValidItemId, productImageUpload.single("image"), async (req, res, next) => {
  try {
    const id = req.itemId;
    if (!req.file) {
      const err = new Error("Choose a product image to upload");
      err.status = 400;
      throw err;
    }
    const [item] = await q.getItemImage(id);
    if (!item) {
      const err = new Error("Item not found");
      err.status = 404;
      throw err;
    }

    let uploaded;
    try {
      uploaded = await uploadProductImage(req.file.buffer, id);
    } catch (cause) {
      const err = new Error("Cloudinary could not upload the product image. Try again later.");
      err.status = 502;
      err.cause = cause;
      throw err;
    }

    try {
      await q.setItemImage(id, uploaded.secure_url, uploaded.public_id);
    } catch (cause) {
      try { await deleteProductImage(uploaded.public_id); } catch (_) { /* best-effort rollback */ }
      const err = new Error("The image uploaded, but the item could not be updated. No inventory data was changed.");
      err.status = 500;
      err.cause = cause;
      throw err;
    }

    let cleanupWarning = null;
    if (item.imagePublicId && item.imagePublicId !== uploaded.public_id) {
      try {
        await deleteProductImage(item.imagePublicId);
      } catch (_) {
        cleanupWarning = "The new image was saved, but the previous Cloudinary asset could not be removed.";
      }
    }
    res.json({ id, imageUrl: uploaded.secure_url, imagePublicId: uploaded.public_id, cleanupWarning });
  } catch (err) { next(err); }
});

app.delete("/api/items/:id/image", requireValidItemId, async (req, res, next) => {
  try {
    const id = req.itemId;
    const [item] = await q.getItemImage(id);
    if (!item) {
      const err = new Error("Item not found");
      err.status = 404;
      throw err;
    }
    if (!item.imagePublicId) {
      await q.clearItemImage(id);
      res.json({ id, imageUrl: null, removed: false });
      return;
    }
    try {
      await deleteProductImage(item.imagePublicId);
    } catch (cause) {
      const err = new Error("Cloudinary could not remove the product image. The item was left unchanged.");
      err.status = 502;
      err.cause = cause;
      throw err;
    }
    await q.clearItemImage(id);
    res.json({ id, imageUrl: null, removed: true });
  } catch (err) { next(err); }
});

app.patch("/api/items/:id/active", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || typeof req.body.active !== "boolean") {
      const err = new Error("A valid item id and boolean active value are required");
      err.status = 400;
      throw err;
    }
    const item = (await q.listItems()).find(candidate => Number(candidate.id) === id);
    if (!item) {
      const err = new Error("Item not found");
      err.status = 404;
      throw err;
    }
    if (req.body.active && item.canonicalItemId) {
      const err = new Error("Mapped legacy SKUs cannot be activated; remove the mapping first");
      err.status = 400;
      throw err;
    }
    const result = await q.setItemActive(id, req.body.active);
    if (!result.rowsAffected) {
      const err = new Error("Item not found");
      err.status = 404;
      throw err;
    }
    res.json({ id, active: req.body.active });
  } catch (err) { next(err); }
});

app.post("/api/items/map", async (req, res, next) => {
  try {
    const sourceIds = Array.isArray(req.body.sourceIds) ? req.body.sourceIds.map(Number) : [];
    const canonicalId = Number(req.body.canonicalId);
    if (!sourceIds.length || sourceIds.some(id => !Number.isInteger(id) || id <= 0) || !Number.isInteger(canonicalId) || canonicalId <= 0) {
      const err = new Error("Select at least one valid source SKU and one canonical SKU");
      err.status = 400;
      throw err;
    }
    res.json(await q.mapItems(sourceIds, canonicalId));
  } catch (err) { next(err); }
});

app.delete("/api/items/:id/mapping", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      const err = new Error("Invalid SKU id");
      err.status = 400;
      throw err;
    }
    const result = await q.unmapItem(id);
    if (!result.rowsAffected) {
      const err = new Error("Mapped SKU not found");
      err.status = 404;
      throw err;
    }
    res.json({ id, mapped: false, active: true });
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
    const inactiveIds = await q.findInactiveItemIds(items.map(item => item.itemId));
    if (inactiveIds.length) {
      const err = new Error("Deactivated items cannot be pulled");
      err.status = 400;
      throw err;
    }
    const results = await q.createPulls({ ...req.body, items });
    res.status(201).json({ ids: results.map(result => result.lastInsertRowid) });
  } catch (err) { next(err); }
});

app.get("/api/entries", async (req, res, next) => {
  try {
    res.json(await q.listEntries(Number(req.query.limit || 1000)));
  } catch (err) { next(err); }
});

app.get("/api/entries/template", async (req, res, next) => {
  try {
    const activeItems = (await q.listItems()).filter(item => item.active);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="entry-upload-template.xlsx"',
      "Cache-Control": "no-store"
    });
    res.send(createEntryTemplate(activeItems));
  } catch (err) { next(err); }
});

app.post("/api/entries/upload", express.raw({
  type: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream"
  ],
  limit: "10mb"
}), async (req, res, next) => {
  try {
    if (!req.body || !req.body.length) {
      const err = new Error("Upload an .xlsx file");
      err.status = 400;
      throw err;
    }
    const fileName = req.get("x-file-name") || "uploaded reporting table.xlsx";
    const entries = parseReportingWorkbook(req.body, fileName);
    const invalidPurpose = entries.find(entry => !["Event/Promo", "Delivery/Client", "Employee", "Other"].includes(entry.purpose));
    if (invalidPurpose) {
      const err = new Error(`Unsupported purpose '${invalidPurpose.purpose}' on row ${invalidPurpose.sourceRow}`);
      err.status = 400;
      throw err;
    }
    const result = await q.importPullEntries(entries);
    res.status(201).json(result);
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
    const inactiveIds = await q.findInactiveItemIds(items.map(item => item.itemId));
    if (inactiveIds.length) {
      const err = new Error("Legacy or inactive items cannot be used for new deliveries");
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
    const inactiveIds = await q.findInactiveItemIds([Number(req.body.itemId)]);
    if (inactiveIds.length) {
      const err = new Error("Legacy or inactive items cannot receive new physical counts");
      err.status = 400;
      throw err;
    }
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
        canonicalItem: row.canonicalItem,
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
    const inactiveIds = await q.findInactiveItemIds(normalized.map(count => count.itemId));
    if (inactiveIds.length) {
      const err = new Error("Legacy or inactive items cannot be included in a new audit");
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
    const includeInactive = req.query.includeInactive === "true";
    res.json(await q.getCurrentInventory(asOf, startDate, endDate, includeInactive));
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

app.get("/api/reports/usage-analysis", async (req, res, next) => {
  try {
    const rawIds = req.query.itemIds ? String(req.query.itemIds).split(",") : [];
    const itemIds = rawIds.map(Number);
    if (itemIds.some(id => !Number.isInteger(id) || id <= 0)) {
      const err = new Error("itemIds must be a comma-separated list of valid item ids");
      err.status = 400;
      throw err;
    }
    res.json({ rows: await q.getUsageAnalysis(itemIds) });
  } catch (err) { next(err); }
});

app.get("/api/logs/pulls", async (req, res, next) => {
  try {
    res.json(await q.getPullLog(Number(req.query.limit || 500)));
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "Product images must be 5 MB or smaller" });
    return;
  }
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: "The product image upload was invalid" });
    return;
  }
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Swag inventory app running on port ${port}`);
  initDb()
    .then(() => {
      dbReady = true;
      console.log("Database initialized");
    })
    .catch(err => {
      console.error("Failed to initialize database:", err);
      process.exit(1);
    });
});
