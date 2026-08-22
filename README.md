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
