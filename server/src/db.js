const { createClient } = require("@libsql/client");
const seedItems = require("./seed-items.json");

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_DATABASE_TOKEN;

if (!url || !authToken) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_DATABASE_TOKEN environment variable");
}

const db = createClient({ url, authToken });

function normalizeValue(value) {
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

async function all(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows.map(normalizeRow);
}

async function run(sql, args = []) {
  const result = await db.execute({ sql, args });
  return {
    lastInsertRowid: normalizeValue(result.lastInsertRowid),
    rowsAffected: normalizeValue(result.rowsAffected)
  };
}

async function runBatch(statements) {
  const results = await db.batch(statements, "write");
  return results.map(result => ({
    lastInsertRowid: normalizeValue(result.lastInsertRowid),
    rowsAffected: normalizeValue(result.rowsAffected)
  }));
}

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sku TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      reorder_level INTEGER NOT NULL DEFAULT 0,
      starting_quantity INTEGER NOT NULL DEFAULT 0,
      starting_date TEXT NOT NULL DEFAULT '2026-03-09'
    );

    CREATE TABLE IF NOT EXISTS inventory_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      qty INTEGER NOT NULL CHECK(qty >= 0),
      received_date TEXT NOT NULL,
      received_by TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_pulls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      qty INTEGER NOT NULL CHECK(qty > 0),
      pulled_date TEXT NOT NULL,
      pulled_by TEXT,
      purpose TEXT NOT NULL CHECK(purpose IN ('Event/Promo','Delivery/Client','Employee','Other')),
      notes TEXT,
      source_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      counted_date TEXT NOT NULL,
      counted_by TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id INTEGER NOT NULL REFERENCES audit_sessions(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      counted_qty INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS physical_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id INTEGER REFERENCES audit_sessions(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      counted_qty INTEGER NOT NULL CHECK(counted_qty >= 0),
      counted_date TEXT NOT NULL,
      counted_by TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const physicalCountColumns = await all("PRAGMA table_info(physical_counts)");
  if (!physicalCountColumns.some(column => column.name === "audit_id")) {
    await run("ALTER TABLE physical_counts ADD COLUMN audit_id INTEGER REFERENCES audit_sessions(id)");
  }

  const pullColumns = await all("PRAGMA table_info(inventory_pulls)");
  if (!pullColumns.some(column => column.name === "source_ref")) {
    await run("ALTER TABLE inventory_pulls ADD COLUMN source_ref TEXT");
  }

  const [{ count: existing }] = await all("SELECT COUNT(*) AS count FROM items");
  if (existing === 0) {
    for (const item of seedItems) {
      await run("INSERT INTO items (name, starting_quantity) VALUES (?, ?)", [
        item.name,
        item.startingQuantity || 0
      ]);
    }
  }
}

module.exports = { db, initDb, all, run, runBatch };
