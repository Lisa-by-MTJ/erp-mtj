# MTJ Channel Manager

ERP for **PT Monalisa Tunggal Jaya** — pro-AV lighting, sound & LED integrator (est. 1980), Jakarta Barat.
Built on the *Channel Manager Master System Blueprint V2.0*: one database → one transaction engine → full traceability.

**Live at [erp.ptmtj.com](https://erp.ptmtj.com)** · Managed by Lisa (Hermes Agent) for [Lisa-by-MTJ](https://github.com/Lisa-by-MTJ)

---

## Stack

- **Node.js** (zero npm dependencies — stdlib only, `node:sqlite`)
- **SQLite** with WAL, persisted at `data/` (bind-mounted into the container)
- **Rootless Podman** container + systemd **user** unit (`mtj-erp.service`), port `9121`, auto-start via linger
- **Session auth** (cookie, HMAC-signed, 7-day TTL) + HTTP Basic kept for scripts/curl
- Cloudflare Tunnel ingress: `erp.ptmtj.com → 127.0.0.1:9121`

## Modules

| Module | What it does |
|---|---|
| 📊 Dashboard | Sales / stock / purchase / service / warranty / project KPIs, live |
| 📦 Stock & Inventory | Multi-warehouse balances, physical vs reserved vs available, avg cost, stock value |
| 🔁 **Transfer Gudang** | Inter-warehouse transfer docs (`TRF`), two-legged posting, serial handoff |
| 🧾 Purchase & Sales Docs | PO → GRN receiving; Quotation → SO → DO/Surat Jalan; approval lifecycle |
| 🏗️ Projects | Contract, milestone billing (DP/progress/retention), costs, Control Tower, profitability |
| 🚚 Delivery | Surat Jalan (3 copies), signed-copy close, warranty auto-born on delivery |
| 🛡️ Warranty & Service | Certificates per serial, claims, service orders, field work orders |
| 🔐 Audit Trail | Every write: user · date · module · doc · action · old → new |

## Inventory Engine (§18–§21)

- **Single stock writer:** only `moveStock()` touches `inventory_balances` — everything else emits `stock_movements` (append-only ledger)
- **Negative-stock guard** — stock can never go below zero (§55)
- **Reservation engine** — free-to-reserve checks; SO posting auto-reserves; DO posting consumes
- **Moving-average cost** per product+warehouse; cost travels with inter-warehouse transfers
- **Serial number engine** — `REQUIRED` policy enforces serial capture at receiving; full trail: receiving → delivery → warranty → service
- **Warranty engine** — certificates born automatically from delivery postings

### Stock Transfer (§21)

```
TRF doc: DRAFT → SUBMITTED → APPROVED → POSTED (locked)
posting: TRANSFER_OUT (source) + TRANSFER_IN (destination, avg cost carried)
serials: must be in source warehouse, status IN_STOCK/RESERVED → moves to destination
guards:  source ≠ destination · no duplicate lines · negative-stock guard at post
```

### Item Master extras

- **EAN/barcode** per product + duplicate guard + scanner-ready lookup:
  `GET /api/products/lookup/<EAN>` → product + live stock totals
- **Product photos:** upload via item detail page (png/jpg/gif/webp, ≤5 MB) → `data/uploads/products/`, served at `/uploads/*`

## Document Lifecycle (§11)

All documents share the same approval engine:

```
DRAFT → SUBMITTED → APPROVED → POSTED (LOCKED)
              ↓ reject ↑
```

Doc numbering (`doc_sequences`): `PREFIX-YYYY-00000`, atomic under a process-wide mutex (§48).

## API

REST-ish JSON under `/api/*` — see [`api.js`](api.js) for the route table
(`GET /api/stock`, `POST /api/stock-transfers`, `GET /api/products/:id/detail`, …).
All mutations are audit-logged.

## Running locally

```bash
cp .env.example .env          # set MTJ_USER / MTJ_PASS
podman build -t localhost/mtj-erp .
podman run -d --name mtj-erp -p 127.0.0.1:9121:9121 \
  -v ./data:/app/data:Z --env-file .env localhost/mtj-erp
```

## Tests (§62)

```bash
MTJ_DATA_DIR=$(mktemp -d) MTJ_USER=t MTJ_PASS=t node seed.js
MTJ_DATA_DIR=$TMPD MTJ_USER=t MTJ_PASS=t node test.js
```

9 regression checks: receiving math, duplicate-serial rejection, reservations,
over-reservation guard, retail SO→DO flow with warranty birth, negative-stock guard,
doc numbering, dashboard consistency, and the full stock-transfer chain.

## Ops

- **Migrate / redeploy:** [`MIGRATE.md`](MIGRATE.md)
- **Auto commit+push:** `erp-mtj-autopush.service` (user unit) — commits stable working trees with
  `auto(<modules>): <files> — <stat>` messages, rebases then pushes to `origin/main`
- **Data:** SQLite lives in `data/` (gitignored) — back it up, it *is* the company ledger
- **Secrets:** `.env` only (gitignored); never commit credentials

---
*Your Potential. Our Passion.* — PT Monalisa Tunggal Jaya
