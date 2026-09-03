# MTJ ERP Upgrade Plan — 3 Sep 2026

## Scope
- P0 #2: Stock Export (CSV)
- P1 #3: Mobile Responsive CSS
- P1 #4: Report Builder (CSV exports)
- P1 #6: Stock Count Feature
- P1 #7: Multi-warehouse Dashboard
- P2 #8: Dark Mode
- P2 #9: Global Search
- P2 #10: Bulk Actions
- P2 #11: Document Templates (PDF-ready data)
- P2 #12: Warehouse Locations
- P2 #13: Stock Aging Report
- Bonus: Google Drive Manual Sync (both stock files)

## New API Endpoints

### Stock Export
- `GET /api/stock/export` → CSV download (all stock rows)

### Stock Aging
- `GET /api/stock/aging` → JSON array of products with days since last movement

### Stock Count
- `GET /api/stock-counts` → list count sessions
- `POST /api/stock-counts` → create new count session {warehouse_id}
- `GET /api/stock-counts/:id` → get count session with lines
- `POST /api/stock-counts/:id/lines` → submit count lines [{product_id, counted_qty}]
- `POST /api/stock-counts/:id/post` → post count (adjustments + audit)

### Global Search
- `GET /api/search?q=...` → [{type:'product'|'partner'|'doc'|'lead', id, label, module}]

### Report Export
- `GET /api/reports/stock?format=csv` → CSV
- `GET /api/reports/sales?period=ytd&format=csv` → CSV
- `GET /api/reports/invoices?format=csv` → CSV

### Multi-warehouse Dashboard
- `GET /api/warehouse-summary` → [{wh_code, wh_name, total_value, total_items, low_stock_count}]

### Drive Sync
- `POST /api/sync/drive` → triggers manual sync of both stock files

### Document Template Data
- `GET /api/docs/:table/:id/template` → structured data for PDF rendering

### Warehouse Locations
- Extend `GET /api/products/:id/detail` to include wh_locations

## New DB Table
```sql
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_no TEXT UNIQUE NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','COUNTED','POSTED')),
  counted_by INTEGER,
  posted_by INTEGER,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  posted_at TEXT
);
CREATE TABLE IF NOT EXISTS stock_count_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  system_qty REAL NOT NULL DEFAULT 0,
  counted_qty REAL,
  variance REAL,
  note TEXT
);
```

## Status (2026-09-03, deployed)
All 13 features LIVE at erp.ptmtj.com. Container rebuilt (mtj-erp:latest), service restarted.

### Inventory Reconciliation from Google Drive — DONE (logic verified)
- `scripts/drive-sync/reconcile_drive_stock.py` — reads both XLSX (cached formula values),
  reconciles into inventory_balances: Alvinity→WH-JKT, Monalisa→WH-JKT (FINAL STOCK JAKARTA)
  + WH-BALI (Outgoing To MTJ Bali col). Idempotent, writes stock_movements (DRIVE_SYNC).
- `scripts/drive-sync/drive_download.py` — REST downloader (no SDK), refreshes OAuth token.
- Live run result: 3021 products, WH-JKT 2928 items (Rp 5.77B), WH-BALI 8 items.
- **BLOCKER**: Google OAuth refresh_token in ~/.hermes/google_token.json is expired/revoked
  (invalid_grant). Live auto-download needs Tio to re-authorize. Until then, workflow is:
  Tio replaces XLSX in /home/mtj/tmp_stock/ → run `reconcile_drive_stock.py`.

### API endpoints verified live
stock/export, stock/aging, stock-counts (+lines/post), search, warehouse-summary,
reports/stock|sales|invoices, sync/drive, docs/:table/:id/template — all return 200.

## Dashboard v4 — Modern Widget Redesign (2026-09-03, LIVE)
Direction A (kill spreadsheet grid), MTJ navy #1b3691 base + single orange #ff8a2a accent.
- Replaced Odoo-spreadsheet `views.dash` with widget layout: KPI card grid (solid-color
  values, no gradient-text), real SVG area chart (areaChart() zero-dep), sectioned panels
  (Trend+Action, Top Products+Top Customers, Warehouse+Low-Stock, Recent Activity).
- Added `warehouse_summary` to /api/dashboard2 payload (was missing → empty panel).
- New CSS in index.html: .wcard, .panel, .kpi-grid, .grid-2/2b, .section-label, .chart-area,
  dark-mode overrides. Accent vars --accent/--accent-soft/--pos/--neg.
- Container rebuilt (mtj-erp:latest), restarted. Verified: app.js has kpi-grid, API returns
  all fields frontend reads. Browser visual check pending (Camoufox not running on host).
