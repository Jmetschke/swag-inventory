require("dotenv").config();

const counts = require("../src/inventory-counts-2026-05-11.json");
const { initDb, all, runBatch } = require("../src/db");

const STARTING_DATE = "2026-05-11";

async function main() {
  await initDb();

  const existingItems = await all("SELECT id, name FROM items");
  const existingByName = new Map(existingItems.map(item => [item.name, item]));
  const countNames = new Set(counts.map(item => item.name));

  const statements = counts.map(item => {
    const existing = existingByName.get(item.name);
    if (existing) {
      return {
        sql: "UPDATE items SET starting_quantity = ?, starting_date = ?, active = 1 WHERE id = ?",
        args: [item.count, STARTING_DATE, existing.id]
      };
    }

    return {
      sql: "INSERT INTO items (name, starting_quantity, starting_date) VALUES (?, ?, ?)",
      args: [item.name, item.count, STARTING_DATE]
    };
  });

  await runBatch(statements);

  const notInSpreadsheet = existingItems
    .filter(item => !countNames.has(item.name))
    .map(item => item.name);

  console.log(`Applied ${counts.length} inventory counts from ${STARTING_DATE}.`);
  if (notInSpreadsheet.length) {
    console.log("Existing items not found in spreadsheet:");
    for (const name of notInSpreadsheet) console.log(`- ${name}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
