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

## Run locally

Create a `.env` file with your Turso connection values:

```bash
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_DATABASE_TOKEN=your-token
```

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

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
- `POST /api/pulls`
- `POST /api/receipts`
- `POST /api/physical-counts`
- `GET /api/inventory?asOf=YYYY-MM-DD`
- `GET /api/reports/weekly-usage?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET /api/reports/purpose-summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET /api/reports/ytd?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
