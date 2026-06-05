const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const seedItems = require("./seed-items.json");

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "swag-inventory.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS physical_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      counted_qty INTEGER NOT NULL CHECK(counted_qty >= 0),
      counted_date TEXT NOT NULL,
      counted_by TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const existing = db.prepare("SELECT COUNT(*) AS count FROM items").get().count;
  if (existing === 0) {
    const insert = db.prepare("INSERT INTO items (name, starting_quantity) VALUES (?, ?)");
    const tx = db.transaction(() => seedItems.forEach(i => insert.run(i.name, i.startingQuantity || 0)));
    tx();
  }
}

module.exports = { db, initDb };
