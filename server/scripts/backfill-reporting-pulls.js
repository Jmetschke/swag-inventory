require("dotenv").config();

const pulls = require("../src/reporting-pulls-backfill.json");
const { initDb, all, runBatch } = require("../src/db");

async function main() {
  await initDb();

  const items = await all("SELECT id, name FROM items WHERE active = 1");
  const itemByName = new Map(items.map(item => [item.name, item]));
  const missingItems = [...new Set(pulls.map(pull => pull.item).filter(item => !itemByName.has(item)))];

  if (missingItems.length) {
    throw new Error(`Missing item(s): ${missingItems.join(", ")}`);
  }

  const existingRefs = new Set(
    (await all("SELECT source_ref AS sourceRef FROM inventory_pulls WHERE source_ref IS NOT NULL"))
      .map(row => row.sourceRef)
  );

  const newPulls = pulls.filter(pull => !existingRefs.has(pull.sourceRef));
  if (!newPulls.length) {
    console.log("No reporting sheet pulls to backfill.");
    return;
  }

  await runBatch(newPulls.map(pull => ({
    sql: `INSERT INTO inventory_pulls
      (item_id, qty, pulled_date, pulled_by, purpose, notes, source_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      itemByName.get(pull.item).id,
      pull.qty,
      pull.pulledDate,
      pull.pulledBy || null,
      pull.purpose,
      pull.notes || null,
      pull.sourceRef
    ]
  })));

  console.log(`Backfilled ${newPulls.length} reporting sheet pulls.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
