# Swag Inventory App Skeleton

This app skeleton converts the uploaded spreadsheet logic into a small Node/Express + SQLite inventory tracker.

## Spreadsheet logic represented

- **General Inventory** → `items.starting_quantity` plus calculated on-hand inventory.
- **items received** → `inventory_receipts`, added to inventory totals by item/date.
- **reporting sheet** → `inventory_pulls`, a transaction log of date, item, qty, pulled by, purpose, and notes.
- **End of week use totals** → `/api/reports/weekly-usage`, which sums pulled qty by item between start/end dates.
- **Purpose totals** → `/api/reports/purpose-summary`, which acts like the spreadsheet `SUMIFS` by item + purpose + date range.
- **YTD totals** → `/api/reports/ytd`, which sums item usage from a selected start date through an end date.
- **Calculated count formula** → `starting_quantity + totalReceived - totalPulled`.

## SKU consolidation

SKUs can be consolidated non-destructively from the **SKU Management** tab. The migration adds nullable `items.canonical_item_id` and `items.canonical_mapped_at` columns; it does not delete items or update historical transaction foreign keys.

- New pulls, deliveries, and audits accept active canonical SKUs only.
- Inventory and aggregate usage reports group legacy transactions under the canonical SKU once.
- Entries and audit history retain the original SKU and also display its current canonical SKU.
- Mappings are direct-to-root, so self-mappings, circular mappings, and nested mapping chains are rejected.
- A mapping can be corrected before the canonical group receives a consolidated physical audit. After that baseline exists, unsafe regrouping is rejected to prevent double-counting.

## Run locally

Create a `.env` file with your Turso connection values:

```bash
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_DATABASE_TOKEN=your-token
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Product images

Product images are stored in Cloudinary under `swag-inventory/products`; the app stores only `image_url` and `image_public_id` on the existing `items` row. The database migration runs automatically at startup and leaves existing items and all transaction history intact.

To enable images:

1. Create or use a Cloudinary account and copy its cloud name, API key, and API secret.
2. Add the three `CLOUDINARY_*` values to `.env` locally.
3. Add the same three secret environment variables to the Render service and redeploy.

No unsigned upload preset is required because uploads are authenticated by the server. If Cloudinary is not configured, all non-image inventory features continue to work and image requests return a configuration error.

## Apply 2026-05-11 spreadsheet counts

The baseline item counts from `5_11_26 inventory.xlsx` are stored in `server/src/inventory-counts-2026-05-11.json` and reflected in `server/src/seed-items.json`.

To apply those counts to an existing Turso database, set `TURSO_DATABASE_URL` and `TURSO_DATABASE_TOKEN`, then run:

```bash
npm run sync:inventory-counts
```

## Backfill reporting sheet pulls

The pull rows from `swag inventory working 2 (1).xlsx` are stored in `server/src/reporting-pulls-backfill.json`.

To backfill those pulled-item records into an existing Turso database, set `TURSO_DATABASE_URL` and `TURSO_DATABASE_TOKEN`, then run:

```bash
npm run backfill:reporting-pulls
```

The backfill uses spreadsheet row source references so it can be run again without duplicating the same rows.

## Suggested next refinements

1. Add user login/roles.
2. Add edit/delete buttons for pulls and receipts.
3. Add printable weekly report and inventory count pages.
4. Add low-stock/reorder alerts.
5. Add import/export tools for one-time inventory migrations.

## Main API routes

- `GET /api/items`
- `POST /api/items`
- `POST /api/items/:id/image`
- `DELETE /api/items/:id/image`
- `POST /api/pulls`
- `POST /api/receipts`
- `POST /api/physical-counts`
- `GET /api/inventory?asOf=YYYY-MM-DD`
- `GET /api/reports/weekly-usage?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET /api/reports/purpose-summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET /api/reports/ytd?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

## Event giveaway tallies

The **Event Giveaways** tab records items physically handed out after inventory has
already been pulled. Its `giveaway_forms`, `giveaway_items`, and
`giveaway_operations` tables are separate from inventory accounting: tallying
never creates pulls, adjusts on-hand counts, or reconciles inventory.

Enter an employee name, event name, and date, then open/create the form. Add
inventory items and use **+1**, **−1**, or **Add** with a quantity. Matching employee,
event, and date fields reopen the existing form; the saved-form selector also
lets users choose previous dates. Names match without regard to capitalization.

Changes save automatically to the database. Browser local storage retains the
last opened form and unsynced changes through refreshes. Temporary connection
failures retry automatically, when connectivity returns, or with **Sync / Refresh**.
Each change has a unique identifier so retries cannot count it twice. Creating a
new form requires a connection. Keep the browser's site data until pending
changes have synced; opening the application itself still requires connectivity.
Database tables are created automatically when the server starts.

The **Giveaway Reports** tab automatically reads saved tallies into event cards,
with a separate card for each event date. Cards list employees, their item names,
and quantities. Event, employee, and item searches accept partial names and can
be combined. Filtered cards show the matching quantity and the full event total.
Reports refresh when opened, after tallies sync in the same page, and every 30
seconds while visible. Unsynced browser changes appear after they are saved.

Run giveaway report checks with `node --test tests/giveaway-reports.test.js`.
These checks use a temporary database and do not access production data.

## Audit shortage pulls

New audits compare each physical count with calculated inventory on the audit
date. A decrease creates an inventory pull for the difference, dated to the
audit, attributed to the auditor, with purpose `Other` and notes `audit`.
For example, counting 5 when inventory shows 11 records a pull of 6. The physical
count remains the baseline, so the shortage is not deducted twice. Equal or
higher counts do not create pulls. Audit records, shortage pulls, and physical
counts save in one transaction. Existing audits are not backfilled.

Run the audit checks with `node --test tests/audit-pulls.test.js`.

## Audit history totals

Open **Audit → Audit History → View** to review an audit's date, auditor,
starting and ending quantities, removed quantities, added quantities, and net
change, both overall and per item. Totals cover only the audited items. Starting
counts are now saved with each audit and do not change when later audits occur.
For older audits, linked audit shortage pulls can recover individual starting
counts. Missing starting counts are shown as **Not recorded**; complete starting
and change totals remain unavailable when any item lacks its historical start.
Ending counts remain visible for those audits.

Run history checks with `node --test tests/audit-history.test.js`.
