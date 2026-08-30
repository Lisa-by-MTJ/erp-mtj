// MTJ Channel Manager — Database + Engines (Blueprint V2.0)
// ONE DATABASE -> ONE TRANSACTION ENGINE -> FULL TRACEABILITY
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.MTJ_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'mtj_erp.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------- SCHEMA (docs/DATA_MODEL.blueprint.md) ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, is_active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS business_partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('CUSTOMER','SUPPLIER')),
  code TEXT NOT NULL, name TEXT NOT NULL, customer_type TEXT, pic TEXT, phone TEXT, email TEXT,
  npwp TEXT, pkp_status TEXT DEFAULT 'NON_PPN', payment_term_days INTEGER DEFAULT 0,
  credit_limit REAL DEFAULT 0, currency TEXT DEFAULT 'IDR', address TEXT, city TEXT, province TEXT,
  country TEXT DEFAULT 'Indonesia', status TEXT DEFAULT 'ACTIVE', lead_time_days INTEGER,
  warranty_policy TEXT, is_active INTEGER DEFAULT 1,
  UNIQUE(kind, code), UNIQUE(kind, name));
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('MAIN','PROJECT','SERVICE','TRANSIT')), address TEXT, is_active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS wh_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  zone TEXT, rack TEXT, shelf TEXT, bin TEXT);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, barcode TEXT UNIQUE,
  name TEXT NOT NULL, brand TEXT, model TEXT,
  type TEXT NOT NULL CHECK(type IN ('FINISHED_GOODS','SPAREPART','MATERIAL','ACCESSORIES','ASSET')),
  category TEXT, subcategory TEXT, description TEXT, spec TEXT, uom TEXT DEFAULT 'PCS',
  serial_policy TEXT NOT NULL DEFAULT 'NONE' CHECK(serial_policy IN ('NONE','REQUIRED','BATCH')),
  warranty_months INTEGER DEFAULT 12, cost_price REAL DEFAULT 0, last_cost REAL DEFAULT 0,
  retail_price REAL DEFAULT 0, project_price REAL DEFAULT 0, min_stock INTEGER DEFAULT 0,
  reorder_point INTEGER DEFAULT 0, default_supplier_id INTEGER, datasheet_url TEXT,
  photo_url TEXT, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, currency TEXT NOT NULL, rate_to_idr REAL NOT NULL, rate_date TEXT NOT NULL);
-- §48 Document Numbering Engine
CREATE TABLE IF NOT EXISTS doc_sequences (
  prefix TEXT NOT NULL, yr INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(prefix, yr));
-- §11 Approval lifecycle mixin on every document
CREATE TABLE IF NOT EXISTS purchase_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, pr_date TEXT NOT NULL, supplier_id INTEGER, requester_note TEXT,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS purchase_request_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, po_date TEXT NOT NULL, supplier_id INTEGER NOT NULL REFERENCES business_partners(id),
  po_type TEXT NOT NULL CHECK(po_type IN ('LOCAL_PURCHASE','IMPORT_PURCHASE')), currency TEXT DEFAULT 'IDR',
  fx_rate REAL DEFAULT 1, expected_date TEXT, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  goods_value REAL DEFAULT 0, freight REAL DEFAULT 0, insurance REAL DEFAULT 0, duty_customs REAL DEFAULT 0,
  ppn_import REAL DEFAULT 0, forwarder REAL DEFAULT 0, handling REAL DEFAULT 0, port_charges REAL DEFAULT 0,
  bank_charges REAL DEFAULT 0, other_cost REAL DEFAULT 0, landed_cost_total REAL DEFAULT 0,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL,
  unit_price REAL NOT NULL, discount_pct REAL DEFAULT 0, line_total REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS receivings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, receiving_type TEXT NOT NULL CHECK(receiving_type IN ('LOCAL_PURCHASE','IMPORT_PURCHASE','CUSTOMER_RETURN','PROJECT_RETURN','WAREHOUSE_TRANSFER','SERVICE_RETURN','ADJUSTMENT','OTHER')),
  receive_date TEXT NOT NULL, purchase_order_id INTEGER REFERENCES purchase_orders(id),
  partner_id INTEGER REFERENCES business_partners(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  received_by INTEGER, condition_check INTEGER DEFAULT 1, qc_notes TEXT,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS receiving_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, receiving_id INTEGER NOT NULL REFERENCES receivings(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, unit_cost REAL DEFAULT 0,
  serials TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS serial_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
  serial TEXT NOT NULL, batch_no TEXT,
  status TEXT NOT NULL DEFAULT 'IN_STOCK' CHECK(status IN ('IN_STOCK','RESERVED','SOLD_DELIVERED','IN_SERVICE','WARRANTY_CLAIM','RETURNED','SCRAPPED')),
  current_warehouse_id INTEGER REFERENCES warehouses(id), current_partner_id INTEGER REFERENCES business_partners(id),
  purchase_order_id INTEGER REFERENCES purchase_orders(id), warranty_start TEXT, warranty_end TEXT,
  UNIQUE(product_id, serial));
CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, quote_date TEXT NOT NULL, valid_until TEXT,
  quotation_kind TEXT NOT NULL CHECK(quotation_kind IN ('RETAIL','PROJECT')),
  customer_id INTEGER NOT NULL REFERENCES business_partners(id), salesperson_id INTEGER,
  tax_code TEXT NOT NULL DEFAULT 'PPN', subtotal REAL DEFAULT 0, discount_total REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0, grand_total REAL DEFAULT 0, project_id INTEGER,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS quotation_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), description_override TEXT,
  qty REAL NOT NULL, unit_price REAL NOT NULL, discount_pct REAL DEFAULT 0, line_total REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, project_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'LEAD', name TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES business_partners(id),
  site_location TEXT, salesperson_id INTEGER, project_manager_id INTEGER,
  contract_value REAL DEFAULT 0, start_date TEXT, end_date TEXT,
  billing_terms TEXT, warranty_months INTEGER DEFAULT 12,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS project_billings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, label TEXT NOT NULL, percent REAL DEFAULT 0, amount REAL DEFAULT 0,
  invoice_ref TEXT, due_date TEXT, paid_amount REAL DEFAULT 0, paid_at TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','INVOICED','PARTIAL','PAID')));
CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, so_date TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES business_partners(id),
  salesperson_id INTEGER, source_quotation_id INTEGER REFERENCES quotations(id),
  sales_type TEXT NOT NULL DEFAULT 'RETAIL' CHECK(sales_type IN ('RETAIL','PROJECT')),
  project_id INTEGER REFERENCES projects(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  tax_code TEXT NOT NULL DEFAULT 'PPN', subtotal REAL DEFAULT 0, discount_total REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0, grand_total REAL DEFAULT 0, invoice_ref TEXT, paid_amount REAL DEFAULT 0,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sales_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, unit_price REAL NOT NULL,
  discount_pct REAL DEFAULT 0, reserved_qty REAL DEFAULT 0, delivered_qty REAL DEFAULT 0, line_total REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_no TEXT UNIQUE NOT NULL,
  project_id INTEGER REFERENCES projects(id), sales_order_id INTEGER REFERENCES sales_orders(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), requested_by INTEGER, approved_by INTEGER,
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','ALLOCATED','CONSUMED','RELEASED')),
  reason TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS reservation_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL);
-- §21 Stock Transfer: two-legged inter-warehouse movement (TRANSFER_OUT at source, TRANSFER_IN at destination)
CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, transfer_date TEXT NOT NULL,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, stock_transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, serials TEXT DEFAULT '[]');
-- §20 every inventory change emits a movement; engine-only writes
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, movement_type TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  serial_id INTEGER REFERENCES serial_numbers(id), qty_delta REAL NOT NULL,
  ref_table TEXT, ref_id INTEGER, ref_no TEXT, moved_at TEXT DEFAULT (datetime('now')), by_user INTEGER);
CREATE TABLE IF NOT EXISTS inventory_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), physical REAL NOT NULL DEFAULT 0,
  reserved REAL NOT NULL DEFAULT 0, avg_cost REAL NOT NULL DEFAULT 0,
  UNIQUE(product_id, warehouse_id),
  CHECK(physical >= -0.0001));
CREATE TABLE IF NOT EXISTS delivery_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, surat_jalan_no TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT', version INTEGER DEFAULT 1, do_date TEXT NOT NULL,
  sales_order_id INTEGER REFERENCES sales_orders(id), project_id INTEGER REFERENCES projects(id),
  purpose TEXT NOT NULL DEFAULT 'SALES' CHECK(purpose IN ('SALES','PROJECT','SERVICE','TRANSFER','OTHER')),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), vehicle_info TEXT, driver_name TEXT,
  recipient_name TEXT, copies_note TEXT DEFAULT '3 copies: Customer / MTJ Administration / Warehouse',
  signed_copy_url TEXT, closed_at TEXT,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS delivery_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_order_id INTEGER NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  sales_order_line_id INTEGER, product_id INTEGER NOT NULL REFERENCES products(id),
  serial_id INTEGER REFERENCES serial_numbers(id), qty REAL NOT NULL);
CREATE TABLE IF NOT EXISTS warranties (
  id INTEGER PRIMARY KEY AUTOINCREMENT, warranty_no TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES business_partners(id),
  product_id INTEGER NOT NULL REFERENCES products(id), serial_id INTEGER REFERENCES serial_numbers(id),
  source_type TEXT NOT NULL CHECK(source_type IN ('RETAIL_SALES','PROJECT_DELIVERY')), source_doc_no TEXT,
  purchase_date TEXT, delivery_date TEXT, warranty_start TEXT NOT NULL, warranty_end TEXT NOT NULL,
  months INTEGER, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','EXPIRED','CLAIMED','SERVICE','REPLACED','CLOSED')));
CREATE TABLE IF NOT EXISTS warranty_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT, claim_no TEXT UNIQUE NOT NULL, warranty_id INTEGER NOT NULL REFERENCES warranties(id),
  reported_at TEXT DEFAULT (date('now')), problem TEXT, diagnosis TEXT, resolution TEXT,
  repair_cost REAL DEFAULT 0, supplier_claim_ref TEXT, technician_id INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DIAGNOSED','IN_REPAIR','RESOLVED','CLOSED','REJECTED')));
CREATE TABLE IF NOT EXISTS service_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'RECEIVED',
  customer_id INTEGER NOT NULL REFERENCES business_partners(id), product_id INTEGER NOT NULL REFERENCES products(id),
  serial_id INTEGER REFERENCES serial_numbers(id), complaint TEXT, condition_in TEXT, accessories_in TEXT,
  diagnosis TEXT, technician_id INTEGER, parts_used TEXT, labor_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0,
  target_date TEXT, completed_at TEXT, result TEXT, qc_passed INTEGER, cust_confirmed INTEGER,
  rating INTEGER, received_at TEXT DEFAULT (datetime('now')), warranty_status_at_receiving TEXT,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT, version INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  project_id INTEGER REFERENCES projects(id), customer_id INTEGER REFERENCES business_partners(id),
  location TEXT, scheduled_date TEXT, checkin_at TEXT, checkout_at TEXT,
  technicians TEXT, supervisor_id INTEGER, work_description TEXT, materials_used TEXT,
  problems TEXT, solutions TEXT, photo_before TEXT, photo_during TEXT, photo_after TEXT,
  customer_signature TEXT, rating INTEGER,
  created_by INTEGER, approved_by INTEGER, posted_at TEXT, note TEXT, version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS project_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('MATERIAL','PURCHASE','TECHNICIAN','INSTALLATION','TRANSPORT','ACCOMMODATION','OTHER')),
  description TEXT, amount REAL NOT NULL DEFAULT 0, cost_date TEXT DEFAULT (date('now')), ref_no TEXT);
-- §12 Audit Trail: user/date/module/doc/action/old/new/reason/approver
CREATE TABLE IF NOT EXISTS audit_trail (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, at TEXT DEFAULT (datetime('now')),
  module TEXT NOT NULL, doc_no TEXT, action TEXT NOT NULL, entity INTEGER, field TEXT,
  old_value TEXT, new_value TEXT, reason TEXT DEFAULT '', approval_ref TEXT);
-- §17 one shared Attachment Engine for all modules
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_table TEXT NOT NULL, entity_id INTEGER NOT NULL,
  att_type TEXT NOT NULL, file_name TEXT NOT NULL, mime TEXT, storage_url TEXT NOT NULL,
  uploaded_by INTEGER, uploaded_at TEXT DEFAULT (datetime('now')), description TEXT);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
`);

const PPN_RATE = 0.11; // §9

// ---------------- §User Access: password hashing (scrypt) ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const cand = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return cand.length === want.length && crypto.timingSafeEqual(cand, want);
}
// Bootstrap: if the users table is empty, seed the env admin as role ADMIN so
// the owner can never be locked out of user management.
(function ensureBootstrapAdmin() {
  const n = db.prepare(`SELECT COUNT(*) n FROM users`).get().n;
  if (n === 0 && process.env.MTJ_USER && process.env.MTJ_PASS) {
    db.prepare(`INSERT INTO users(username,full_name,role,password_hash,is_active)
                VALUES(?,?, 'ADMIN', ?, 1)`)
      .run(process.env.MTJ_USER, 'Administrator (bootstrap)', hashPassword(process.env.MTJ_PASS));
    console.log('[MTJ-ERP] bootstrapped admin user from MTJ_USER env');
  }
})();

// ---------------- §48 Document Numbering Engine ----------------
function nextDocNo(prefix) {
  const yr = new Date().getFullYear();
  runExclusive(() => {
    db.prepare(`INSERT INTO doc_sequences(prefix,yr,seq) VALUES(?,?,0)
                ON CONFLICT(prefix,yr) DO NOTHING`).run(prefix, yr);
    db.prepare(`UPDATE doc_sequences SET seq = seq + 1 WHERE prefix=? AND yr=?`).run(prefix, yr);
  });
  const row = db.prepare(`SELECT seq FROM doc_sequences WHERE prefix=? AND yr=?`).get(prefix, yr);
  return `${prefix}-${yr}-${String(row.seq).padStart(5, '0')}`;
}
// coarse mutex keeps numbering atomic within the single-process server
const _lock = { held: false, q: [] };
function runExclusive(fn) {
  if (_lock.held) { _lock.q.push(fn); return; }
  _lock.held = true;
  try { fn(); } finally {
    _lock.held = false;
    const n = _lock.q.shift(); if (n) runExclusive(n);
  }
}

// ---------------- §12 Audit Engine ----------------
function audit(userId, module_, action, opts = {}) {
  db.prepare(`INSERT INTO audit_trail(user_id,module,doc_no,action,entity,field,old_value,new_value,reason,approval_ref)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(userId ?? null, module_, opts.docNo ?? null, action, opts.entity ?? null,
         opts.field ?? null, opts.old != null ? String(opts.old) : null,
         opts.newv != null ? String(opts.newv) : null, opts.reason ?? '', opts.approvalRef ?? null);
}

// ---------------- Inventory helpers (§18) ----------------
function getBalance(productId, warehouseId) {
  let b = db.prepare(`SELECT * FROM inventory_balances WHERE product_id=? AND warehouse_id=?`)
            .get(productId, warehouseId);
  if (!b) {
    db.prepare(`INSERT INTO inventory_balances(product_id,warehouse_id,physical,reserved,avg_cost)
                VALUES(?,?,0,0,0)`).run(productId, warehouseId);
    b = db.prepare(`SELECT * FROM inventory_balances WHERE product_id=? AND warehouse_id=?`)
          .get(productId, warehouseId);
  }
  return b;
}
function totalsForProduct(productId, warehouseId = null) {
  const rows = warehouseId
    ? db.prepare(`SELECT physical,reserved FROM inventory_balances WHERE product_id=? AND warehouse_id=?`)
        .all(productId, warehouseId)
    : db.prepare(`SELECT physical,reserved FROM inventory_balances WHERE product_id=?`).all(productId);
  const physical = rows.reduce((s, r) => s + r.physical, 0);
  const reserved = rows.reduce((s, r) => s + r.reserved, 0);
  return { physical, reserved, available: physical - reserved };
}

// ---------------- §20 Stock Movement Engine (THE only stock writer) ----------------
function moveStock({ productId, warehouseId, qtyDelta, type, refTable, refId, refNo, userId, serialId = null, avgCost = null }) {
  if (!Number.isFinite(qtyDelta)) throw new Error('qtyDelta must be numeric');
  const b = getBalance(productId, warehouseId);
  if (avgCost != null && avgCost > 0) {
    // moving average cost on inbound
    const newPhys = b.physical + qtyDelta;
    const newAvg = newPhys > 0 ? (b.physical * b.avg_cost + Math.max(qtyDelta,0) * avgCost) / newPhys : b.avg_cost;
    db.prepare(`UPDATE inventory_balances SET physical=?, avg_cost=? WHERE id=?`).run(newPhys, newAvg, b.id);
  } else {
    const newPhys = b.physical + qtyDelta;
    if (newPhys < -0.0001) throw new Error(`NEGATIVE_STOCK_GUARD: would make stock ${newPhys} for product #${productId} in warehouse #${warehouseId} (§55)`);
    db.prepare(`UPDATE inventory_balances SET physical=? WHERE id=?`).run(newPhys, b.id);
  }
  db.prepare(`INSERT INTO stock_movements(movement_type,product_id,warehouse_id,serial_id,qty_delta,ref_table,ref_id,ref_no,by_user)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(type, productId, warehouseId, serialId, qtyDelta, refTable ?? null, refId ?? null, refNo ?? null, userId ?? null);
}

// ---------------- §19 Reservation Engine ----------------
function createReservation({ projectId = null, salesOrderId = null, warehouseId, requestedBy, lines, reason = '' }) {
  // lines: [{product_id, qty}]
  for (const l of lines) {
    const t = totalsForProduct(l.product_id, warehouseId);
    const already = db.prepare(`SELECT COALESCE(SUM(rl.qty),0) used FROM reservation_lines rl
      JOIN reservations r ON r.id=rl.reservation_id
      WHERE rl.product_id=? AND r.warehouse_id=? AND r.status IN ('RESERVED','ALLOCATED')`).get(l.product_id, warehouseId).used;
    if (l.qty > t.physical - already)
      throw new Error(`RESERVATION_EXCEEDS_STOCK: product #${l.product_id} requested ${l.qty}, free-to-reserve ${t.physical - already} (sales may only use Available)`);
  }
  const no = nextDocNo('RSV');
  const info = db.prepare(`INSERT INTO reservations(reservation_no,project_id,sales_order_id,warehouse_id,requested_by,status,reason)
                           VALUES(?,?,?,?,?,'RESERVED',?)`)
                 .run(no, projectId, salesOrderId, warehouseId, requestedBy, reason);
  const rid = Number(info.lastInsertRowid);
  for (const l of lines) {
    db.prepare(`INSERT INTO reservation_lines(reservation_id,product_id,qty) VALUES(?,?,?)`).run(rid, l.product_id, l.qty);
    db.prepare(`UPDATE inventory_balances SET reserved = reserved + ? WHERE product_id=? AND warehouse_id=?`)
      .run(l.qty, l.product_id, warehouseId);
  }
  audit(requestedBy, 'RESERVATION', 'CREATE', { docNo: no, entity: rid });
  return { id: rid, reservation_no: no };
}
function releaseReservation(reservationId, userId) {
  const r = db.prepare(`SELECT * FROM reservations WHERE id=?`).get(reservationId);
  if (!r || !['RESERVED','ALLOCATED'].includes(r.status)) throw new Error('Reservation not releasable');
  const lines = db.prepare(`SELECT * FROM reservation_lines WHERE reservation_id=?`).all(reservationId);
  for (const l of lines)
    db.prepare(`UPDATE inventory_balances SET reserved = MAX(0, reserved - ?) WHERE product_id=? AND warehouse_id=?`)
      .run(l.qty, l.product_id, r.warehouse_id);
  db.prepare(`UPDATE reservations SET status='RELEASED' WHERE id=?`).run(reservationId);
  audit(userId, 'RESERVATION', 'RELEASE', { docNo: r.reservation_no, entity: reservationId });
}

// ---------------- §5 Serial Number Engine ----------------
function registerSerialsAtReceiving({ productId, warehouseId, serials, batchNo = null, purchaseOrderId = null }) {
  const out = [];
  for (const s of serials) {
    const dup = db.prepare(`SELECT id FROM serial_numbers WHERE product_id=? AND serial=?`).get(productId, s);
    if (dup) throw new Error(`DUPLICATE_SERIAL: ${s} already exists for this product (§55)`);
    const info = db.prepare(`INSERT INTO serial_numbers(product_id,serial,batch_no,status,current_warehouse_id,purchase_order_id)
                             VALUES(?,?,?,'IN_STOCK',?,?)`).run(productId, s, batchNo, warehouseId, purchaseOrderId);
    out.push(Number(info.lastInsertRowid));
  }
  return out;
}
function snTrail(serialId) { // full traceability §56
  const sn = db.prepare(`SELECT sn.*, p.name product_name, p.code product_code, p.brand
                         FROM serial_numbers sn JOIN products p ON p.id=sn.product_id WHERE sn.id=?`).get(serialId);
  if (!sn) return null;
  sn.movements = db.prepare(`SELECT m.*, w.name warehouse_name FROM stock_movements m
    LEFT JOIN warehouses w ON w.id=m.warehouse_id WHERE m.serial_id=? ORDER BY m.id`).all(serialId);
  sn.warranty = db.prepare(`SELECT * FROM warranties WHERE serial_id=?`).all(serialId);
  sn.service = db.prepare(`SELECT doc_no,status FROM service_orders WHERE serial_id=?`).all(serialId);
  return sn;
}

module.exports = { db, DB_PATH, UPLOAD_DIR, PPN_RATE, nextDocNo, audit, getBalance, totalsForProduct,
                   moveStock, createReservation, releaseReservation, registerSerialsAtReceiving,
                   snTrail, runExclusive, hashPassword, verifyPassword };
