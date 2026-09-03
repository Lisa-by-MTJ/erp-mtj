// MTJ Channel Manager — API router (Blueprint V2.0)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, audit, totalsForProduct, UPLOAD_DIR } = require('./db.js');
const { transition } = require('./approval.js');
const { post, computeTotals } = require('./posting.js');
const dash = require('./dashboard.js');

const ok = (res, x) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
const bad = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(msg) })); };
const rows = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

// ================= §User Access & Roles =================
// ADMIN: everything, incl. user management · MANAGER: operate + approve/post ·
// STAFF: day-to-day create/read · VIEWER: read-only
const ROLES = ['ADMIN', 'MANAGER', 'STAFF', 'VIEWER'];
const PERMS = {
  ADMIN:   { view: 1, create: 1, workflow: 1, admin: 1 },
  MANAGER: { view: 1, create: 1, workflow: 1, admin: 0 },
  STAFF:   { view: 1, create: 1, workflow: 0, admin: 0 },
  VIEWER:  { view: 1, create: 0, workflow: 0, admin: 0 },
};
function permOf(c) {
  const role = (c.user && c.user.role) || 'ADMIN'; // unauthenticated context (scripts) = admin
  return PERMS[ROLES.includes(role) ? role : 'VIEWER'] || PERMS.VIEWER;
}
function requirePerm(c, key) {
  if (!permOf(c)[key]) {
    bad(c.res, 403, `Forbidden: your role (${(c.user && c.user.role) || '?'}) lacks '${key}' permission`);
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// ---- generic helpers used by the doc creation endpoints ----
function docNumber(prefix) { const { nextDocNo } = require('./db.js'); return nextDocNo(prefix); }
function calcAndStoreTotals(table, id, lines, taxCode) {
  const ls = lines.map(l => ({ ...l, line_total: Math.round(l.qty * l.unit_price * (1 - (l.discount_pct || 0) / 100) * 100) / 100 }));
  const t = computeTotals(ls, taxCode);
  run(`UPDATE ${table} SET subtotal=?, discount_total=?, tax_amount=?, grand_total=? WHERE id=?`,
      t.subtotal, t.discount_total, t.tax_amount, t.grand_total, id);
  return t;
}
function insertLines(lcTable, fkCol, id, lines) {
  for (const l of lines) {
    run(`INSERT INTO ${lcTable}(${fkCol},product_id,qty,unit_price,discount_pct,line_total)
         VALUES(?,?,?,?,?,?)`,
        id, l.product_id, l.qty, l.unit_price, l.discount_pct || 0,
        Math.round(l.qty * l.unit_price * (1 - (l.discount_pct || 0) / 100) * 100) / 100);
    if (l.serials && l.serials.length) {
      // bound parameters only — serials come from user input, never interpolate (P0-1)
      const lineId = one(`SELECT MAX(id) mid FROM ${lcTable}`).mid;
      run(`UPDATE ${lcTable} SET serials=? WHERE id=?`, JSON.stringify(l.serials), lineId);
    }
    void lcTable;
  }
}

// ---------- route table ----------
const ROUTES = [];
function route(method, pattern, fn) { ROUTES.push({ method, pattern, fn }); }

// ================= USER ACCESS ADMIN (ADMIN only) =================
route('GET', '/api/users', (c) => {
  if (!requirePerm(c, 'admin')) return;
  return ok(c.res, rows(`SELECT id, username, full_name, role, is_active,
    '••••••' AS password_masked FROM users ORDER BY id`));
});
route('POST', '/api/users', async (c) => {
  if (!requirePerm(c, 'admin')) return;
  const b = await readBody(c.req);
  const username = String(b.username || '').trim();
  if (!username || !b.full_name || !b.password)
    return bad(c.res, 400, 'username, full_name and password required');
  if (String(b.password).length < 6) return bad(c.res, 400, 'Password must be at least 6 characters');
  if (!ROLES.includes(b.role)) return bad(c.res, 400, `role must be one of ${ROLES.join(', ')}`);
  if (one(`SELECT id FROM users WHERE username=?`, username))
    return bad(c.res, 409, 'Duplicate username');
  const { hashPassword } = require('./db.js');
  const info = run(`INSERT INTO users(username,full_name,role,password_hash,is_active) VALUES(?,?,?,?,1)`,
      username, String(b.full_name).trim(), b.role, hashPassword(b.password));
  audit((c.user && c.user.id) || 1, 'users', 'CREATE',
    { entity: Number(info.lastInsertRowid), newv: `${username} (${b.role})` });
  return ok(c.res, { id: Number(info.lastInsertRowid), username, role: b.role });
});
route('POST', '/api/users/:id', async (c) => {
  if (!requirePerm(c, 'admin')) return;
  const id = Number(c.params.id);
  const u = one(`SELECT * FROM users WHERE id=?`, id);
  if (!u) return bad(c.res, 404, 'User not found');
  const b = await readBody(c.req);
  const me = c.user || {};
  const changes = [];
  if (b.full_name !== undefined && b.full_name !== u.full_name) changes.push(['full_name', String(b.full_name).trim()]);
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return bad(c.res, 400, `role must be one of ${ROLES.join(', ')}`);
    if (u.username === me.username && b.role !== 'ADMIN')
      return bad(c.res, 422, 'You cannot demote your own ADMIN role');
    changes.push(['role', b.role]);
  }
  if (b.is_active !== undefined) {
    const act = b.is_active ? 1 : 0;
    if (u.username === me.username && !act)
      return bad(c.res, 422, 'You cannot deactivate your own account');
    changes.push(['is_active', act]);
  }
  let pwChanged = false;
  if (b.password) {
    const { hashPassword } = require('./db.js');
    run(`UPDATE users SET password_hash=? WHERE id=?`, hashPassword(b.password), id);
    pwChanged = true;
  }
  for (const [f, v] of changes)
    run(`UPDATE users SET ${f}=? WHERE id=?`, v, id);
  audit((me.id) || 1, 'users', 'UPDATE', { entity: id,
    newv: changes.map(([f, v]) => `${f}=${v}`).join(', ') + (pwChanged ? ', password=***' : '') });
  return ok(c.res, one(`SELECT id, username, full_name, role, is_active FROM users WHERE id=?`, id));
});
route('POST', '/api/users/:id/delete', async (c) => {
  if (!requirePerm(c, 'admin')) return;
  const id = Number(c.params.id);
  const u = one(`SELECT * FROM users WHERE id=?`, id);
  if (!u) return bad(c.res, 404, 'User not found');
  const me = c.user || {};
  if (u.username === me.username) return bad(c.res, 422, 'You cannot delete your own account');
  const admins = one(`SELECT COUNT(*) n FROM users WHERE role='ADMIN' AND is_active=1 AND id<>?`, id).n;
  if (u.role === 'ADMIN' && admins === 0)
    return bad(c.res, 422, 'Cannot delete the last active ADMIN');
  run(`DELETE FROM users WHERE id=?`, id);
  audit(me.id || 1, 'users', 'DELETE', { entity: id, old: `${u.username} (${u.role})` });
  return ok(c.res, { deleted: id });
});
route('POST', '/api/me/password', async (c) => {
  const b = await readBody(c.req);
  if (!b.old_password || !b.new_password) return bad(c.res, 400, 'old_password and new_password required');
  if (String(b.new_password).length < 6) return bad(c.res, 400, 'New password must be at least 6 characters');
  const { verifyPassword, hashPassword } = require('./db.js');
  const me = c.user || {};
  const u = one(`SELECT * FROM users WHERE username=? AND is_active=1`, me.username || '');
  if (!u) return bad(c.res, 403, 'Session user not found in user database — sign in again');
  if (!verifyPassword(b.old_password, u.password_hash))
    return bad(c.res, 403, 'Old password incorrect');
  run(`UPDATE users SET password_hash=? WHERE id=?`, hashPassword(b.new_password), u.id);
  audit(u.id, 'users', 'PASSWORD_CHANGE', { entity: u.id });
  return ok(c.res, { changed: true });
});

// ================= MASTER DATA (§4-§10) =================
route('GET', '/api/products', (c) => ok(c.res,
  rows(`SELECT * FROM products WHERE is_active=1 ORDER BY code`)));
route('GET', '/api/products/:id', (c) => ok(c.res, one(`SELECT * FROM products WHERE id=?`, c.params.id)));
route('POST', '/api/products', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  if (!b.code || !b.name) return bad(c.res, 400, 'code and name required');
  const dup = one(`SELECT id FROM products WHERE code=?`, b.code);
  if (dup) return bad(c.res, 409, 'Duplicate SKU (§55)');
  const info = run(`INSERT INTO products(code,barcode,name,brand,model,type,category,uom,serial_policy,warranty_months,cost_price,retail_price,project_price,min_stock,reorder_point)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.code, b.barcode || null, b.name, b.brand || null, b.model || null,
    b.type || 'FINISHED_GOODS', b.category || null, b.uom || 'PCS',
    b.serial_policy || 'NONE', b.warranty_months ?? 12, b.cost_price || 0,
    b.retail_price || 0, b.project_price || 0, b.min_stock || 0, b.reorder_point || 0);
  audit((c.user && c.user.id) || 1, 'products', 'CREATE', { entity: Number(info.lastInsertRowid), newv: b.code });
  return ok(c.res, { id: Number(info.lastInsertRowid) });
});
route('GET', '/api/partners', (c) => ok(c.res,
  rows(`SELECT * FROM business_partners WHERE is_active=1 ORDER BY kind,name`)));
route('POST', '/api/partners', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  if (!b.kind || !b.name) return bad(c.res, 400, 'kind and name required');
  const info = run(`INSERT INTO business_partners(kind,code,name,customer_type,pic,phone,email,npwp,pkp_status,payment_term_days,address,city)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.kind, b.code || nextCodeVal(b.kind), b.name, b.customer_type || 'RETAIL', b.pic || null,
    b.phone || null, b.email || null, b.npwp || null, b.pkp_status || 'NON_PPN',
    b.payment_term_days || 0, b.address || null, b.city || null);
  audit((c.user && c.user.id) || 1, 'business_partners', 'CREATE', { entity: Number(info.lastInsertRowid), newv: b.name });
  return ok(c.res, { id: Number(info.lastInsertRowid) });
});
function nextCodeVal(kind) {
  const n = one(`SELECT COUNT(*) n FROM business_partners WHERE kind=?`, kind).n + 1;
  return (kind === 'CUSTOMER' ? 'C' : 'S') + String(n).padStart(4, '0');
}
route('GET', '/api/warehouses', (c) => ok(c.res, rows(`SELECT * FROM warehouses WHERE is_active=1`)));

// ================= STOCK / INVENTORY (§18-§21) =================
// GET /api/stock/export — CSV export of stock data (must be before :productId)
route('GET', '/api/stock/export', (c) => {
  const headers = ['Code','Name','Brand','EAN','Warehouse','Physical','Reserved','Available','AvgCost','Value','ReorderPoint'];
  const rs = rows(`
    SELECT p.code, p.name, p.brand, p.barcode, w.name wh_name,
           ib.physical, ib.reserved, (ib.physical - ib.reserved) available, ib.avg_cost,
           (ib.physical * ib.avg_cost) stock_value, p.reorder_point
    FROM inventory_balances ib JOIN products p ON p.id=ib.product_id JOIN warehouses w ON w.id=ib.warehouse_id
    ORDER BY p.code`);
  let csv = headers.join(',') + '\n';
  for (const r of rs) {
    csv += [r.code, r.name, r.brand, r.barcode, r.wh_name, r.physical, r.reserved, r.available, r.avg_cost, r.stock_value, r.reorder_point].map(csvEscape).join(',') + '\n';
  }
  c.res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': 'attachment; filename="stock_export.csv"'
  });
  c.res.end(csv);
});
// GET /api/stock/aging — stock aging report (must be before :productId)
route('GET', '/api/stock/aging', (c) => ok(c.res, ext.stockAging()));

route('GET', '/api/stock', (c) => ok(c.res, rows(`
  SELECT ib.product_id, p.code, p.name, p.brand, p.barcode, p.photo_url, w.code wh_code, w.name wh_name,
         ib.physical, ib.reserved, (ib.physical - ib.reserved) available, ib.avg_cost,
         (ib.physical*ib.avg_cost) stock_value, p.reorder_point
  FROM inventory_balances ib JOIN products p ON p.id=ib.product_id JOIN warehouses w ON w.id=ib.warehouse_id
  ORDER BY p.code`)));
route('GET', '/api/stock/:productId', (c) => ok(c.res, totalsForProduct(Number(c.params.productId))));

// ---- Item detail (§18): master + per-warehouse balances + movements + serials ----
route('GET', '/api/products/lookup/:ean', (c) => {
  const p = one(`SELECT * FROM products WHERE barcode=? AND is_active=1`, c.params.ean);
  if (!p) return bad(c.res, 404, `No product with EAN ${c.params.ean}`);
  return ok(c.res, { ...p, stock: totalsForProduct(p.id) });
});
route('GET', '/api/products/:id/detail', (c) => {
  const id = Number(c.params.id);
  const product = one(`SELECT * FROM products WHERE id=?`, id);
  if (!product) return bad(c.res, 404, 'Product not found');
  return ok(c.res, {
    product,
    by_warehouse: rows(`SELECT ib.*, w.code wh_code, w.name wh_name,
        (ib.physical-ib.reserved) available, (ib.physical*ib.avg_cost) stock_value
      FROM inventory_balances ib JOIN warehouses w ON w.id=ib.warehouse_id
      WHERE ib.product_id=? ORDER BY w.code`, id),
    totals: totalsForProduct(id),
    movements: rows(`SELECT m.*, w.name wh_name FROM stock_movements m
      JOIN warehouses w ON w.id=m.warehouse_id WHERE m.product_id=? ORDER BY m.id DESC LIMIT 50`, id),
    serials: rows(`SELECT sn.*, w.name wh_name FROM serial_numbers sn
      LEFT JOIN warehouses w ON w.id=sn.current_warehouse_id WHERE sn.product_id=? ORDER BY sn.id DESC LIMIT 200`, id)
  });
});
route('POST', '/api/products/:id', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  const id = Number(c.params.id);
  const p = one(`SELECT * FROM products WHERE id=?`, id);
  if (!p) return bad(c.res, 404, 'Product not found');
  if (b.barcode !== undefined) {
    if (b.barcode) {
      const dup = one(`SELECT id FROM products WHERE barcode=? AND id<>?`, b.barcode, id);
      if (dup) return bad(c.res, 409, 'EAN already used by another product');
    }
    run(`UPDATE products SET barcode=? WHERE id=?`, b.barcode || null, id);
    audit((c.user && c.user.id) || 1, 'products', 'UPDATE', { entity: id, field: 'barcode', old: p.barcode, newv: b.barcode || null });
  }
  return ok(c.res, one(`SELECT * FROM products WHERE id=?`, id));
});
route('POST', '/api/products/:id/photo', (c) => new Promise(resolve => {
  const id = Number(c.params.id);
  if (!one(`SELECT id FROM products WHERE id=?`, id)) { bad(c.res, 404, 'Product not found'); return resolve(); }
  const mime = String(c.req.headers['content-type'] || '').split(';')[0];
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) { bad(c.res, 415, 'Only png/jpeg/gif/webp allowed'); return resolve(); }
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
  const chunks = []; let size = 0, dead = false;
  c.req.on('data', ch => {
    size += ch.length;
    if (size > 5 * 1024 * 1024) { dead = true; c.req.destroy(); resolve(); return; }
    chunks.push(ch);
  });
  c.req.on('end', () => {
    if (dead) return;
    try {
      const dir = path.join(UPLOAD_DIR, 'products');
      fs.mkdirSync(dir, { recursive: true });
      const name = `p${id}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
      const urlPath = `/uploads/products/${name}`;
      run(`UPDATE products SET photo_url=? WHERE id=?`, urlPath, id);
      audit((c.user && c.user.id) || 1, 'products', 'PHOTO_UPLOAD', { entity: id, newv: urlPath });
      ok(c.res, { photo_url: urlPath });
    } catch (e) { bad(c.res, 500, e.message); }
    resolve();
  });
  c.req.on('error', () => { if (!dead) { bad(c.res, 500, 'upload failed'); resolve(); } });
}));
route('POST', '/api/warehouses', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  if (!b.code || !b.name) return bad(c.res, 400, 'code and name required');
  const info = run(`INSERT INTO warehouses(code,name,type,address) VALUES(?,?,?,?)`,
      b.code, b.name, b.type || 'MAIN', b.address || null);
  audit((c.user && c.user.id) || 1, 'warehouses', 'CREATE', { entity: Number(info.lastInsertRowid), newv: b.name });
  return ok(c.res, { id: Number(info.lastInsertRowid) });
});
route('GET', '/api/movements', (c) => ok(c.res, rows(`
  SELECT m.*, p.code pcode, p.name pname, w.name wh_name FROM stock_movements m
  JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id
  ORDER BY m.id DESC LIMIT 200`)));
route('GET', '/api/serials/:id/trail', (c) => ok(c.res, require('./db.js').snTrail(Number(c.params.id))));
route('GET', '/api/reservations', (c) => ok(c.res, rows(`
  SELECT r.*, p.project_code, s.doc_no so_no FROM reservations r
  LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN sales_orders s ON s.id=r.sales_order_id
  ORDER BY r.id DESC`)));
route('POST', '/api/reservations', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const { createReservation } = require('./db.js');
    const r = createReservation({ projectId: b.project_id || null, salesOrderId: b.sales_order_id || null,
      warehouseId: b.warehouse_id, requestedBy: 1, lines: b.lines, reason: b.reason || '' });
    return ok(c.res, r);
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/reservations/:id/release', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const { releaseReservation } = require('./db.js');
  releaseReservation(Number(c.params.id), 1);
  return ok(c.res, { released: true });
});

// ================= STOCK TRANSFERS (§21) =================
route('GET', '/api/stock-transfers', (c) => ok(c.res, rows(`
  SELECT t.*, wf.code from_code, wf.name from_name, wt.code to_code, wt.name to_name
  FROM stock_transfers t
  JOIN warehouses wf ON wf.id=t.from_warehouse_id
  JOIN warehouses wt ON wt.id=t.to_warehouse_id ORDER BY t.id DESC`)));
route('POST', '/api/stock-transfers', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    if (!b.from_warehouse_id || !b.to_warehouse_id) return bad(c.res, 400, 'from_warehouse_id and to_warehouse_id required');
    if (b.from_warehouse_id === b.to_warehouse_id) return bad(c.res, 422, 'Source and destination must differ');
    const no = docNumber('TRF');
    const info = run(`INSERT INTO stock_transfers(doc_no,transfer_date,from_warehouse_id,to_warehouse_id,note)
      VALUES(?,COALESCE(?,date('now')),?,?,?)`,
      no, b.transfer_date || null, b.from_warehouse_id, b.to_warehouse_id, b.note || null);
    const id = Number(info.lastInsertRowid);
    for (const l of (b.lines || [])) {
      run(`INSERT INTO stock_transfer_lines(stock_transfer_id,product_id,qty,serials) VALUES(?,?,?,?)`,
          id, l.product_id, l.qty, JSON.stringify(l.serials || []));
    }
    audit((c.user && c.user.id) || 1, 'stock_transfers', 'CREATE', { docNo: no, entity: id });
    return ok(c.res, { id, doc_no: no });
  } catch (e) { return bad(c.res, 422, e.message); }
});

// ================= DOCUMENT WORKFLOW =================
const DOC_DEFS = {
  purchase_requests: { prefix: 'PR', lc: 'purchase_request_lines', fk: 'purchase_request_id' },
  purchase_orders:   { prefix: 'PO', lc: 'purchase_order_lines', fk: 'purchase_order_id' },
  receivings:        { prefix: 'GRN', lc: 'receiving_lines', fk: 'receiving_id' },
  quotations:        { prefix: 'QT', lc: 'quotation_lines', fk: 'quotation_id' },
  sales_orders:      { prefix: 'SO', lc: 'sales_order_lines', fk: 'sales_order_id' },
  delivery_orders:   { prefix: 'DO', lc: 'delivery_order_lines', fk: 'delivery_order_id' },
  stock_transfers:   { prefix: 'TRF', lc: 'stock_transfer_lines', fk: 'stock_transfer_id' },
};
// column holding the business partner per doc table (NULL = no partner on the doc)
const DOC_PARTNER_COL = {
  purchase_requests: 'supplier_id', purchase_orders: 'supplier_id',
  receivings: 'partner_id', delivery_orders: null,
  quotations: 'customer_id', sales_orders: 'customer_id',
};
route('GET', '/api/docs/:table', (c) => {
  if (!DOC_DEFS[c.params.table]) return bad(c.res, 404, 'Unknown doc type');
  if (c.params.table === 'stock_transfers') return ok(c.res, rows(`
    SELECT t.*, wf.name from_name, wt.name to_name, NULL partner_name FROM stock_transfers t
    JOIN warehouses wf ON wf.id=t.from_warehouse_id JOIN warehouses wt ON wt.id=t.to_warehouse_id
    ORDER BY t.id DESC`));
  const col = DOC_PARTNER_COL[c.params.table];
  const att = `(SELECT COUNT(*) FROM doc_attachments da WHERE da.table_name='${c.params.table}' AND da.doc_id=d.id)`;
  return ok(c.res, rows(col
    ? `SELECT d.*, bp.name partner_name, ${att} attachments_n FROM ${c.params.table} d
       LEFT JOIN business_partners bp ON bp.id=d.${col} ORDER BY d.id DESC`
    : `SELECT d.*, NULL partner_name, ${att} attachments_n FROM ${c.params.table} d ORDER BY d.id DESC`));
});
// ---- scanned PDF attachments on documents ----
const MAX_PDF = 10 * 1024 * 1024;
route('POST', '/api/docs/:table/:id/attachment', (c) => new Promise(resolve => {
  if (!requirePerm(c, 'create')) { bad(c.res, 403, 'Forbidden'); return resolve(); }
  const t = c.params.table, id = Number(c.params.id);
  if (!DOC_DEFS[t]) { bad(c.res, 404, 'Unknown doc type'); return resolve(); }
  if (!one(`SELECT id FROM ${t} WHERE id=?`, id)) { bad(c.res, 404, 'Document not found'); return resolve(); }
  const mime = String(c.req.headers['content-type'] || '').split(';')[0];
  if (mime !== 'application/pdf') { bad(c.res, 415, 'Only PDF attachments allowed'); return resolve(); }
  const chunks = []; let size = 0, dead = false;
  c.req.on('data', ch => {
    size += ch.length;
    if (size > MAX_PDF) { dead = true; c.req.destroy(); resolve(); return; }
    chunks.push(ch);
  });
  c.req.on('end', () => {
    if (dead) return;
    try {
      const buf = Buffer.concat(chunks);
      if (buf.slice(0, 4).toString('latin1') !== '%PDF') { bad(c.res, 422, 'File is not a valid PDF'); return resolve(); }
      const dir = path.join(UPLOAD_DIR, 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const clean = String(c.req.headers['x-filename'] || 'scan.pdf').replace(/[^\w.\- ]/g, '_').slice(-80) || 'scan.pdf';
      const name = `${t}-${id}-${Date.now()}-${clean}`;
      fs.writeFileSync(path.join(dir, name), buf);
      const urlPath = `/uploads/attachments/${name}`;
      const info = run(`INSERT INTO doc_attachments(table_name,doc_id,filename,stored_path,size_bytes,uploaded_by)
        VALUES(?,?,?,?,?,?)`, t, id, clean, urlPath, buf.length, (c.user && c.user.id) || 1);
      audit((c.user && c.user.id) || 1, t, 'ATTACH', { entity: id, newv: clean });
      ok(c.res, { id: Number(info.lastInsertRowid), url: urlPath, filename: clean });
    } catch (e) { bad(c.res, 500, e.message); }
    resolve();
  });
  c.req.on('error', () => { if (!dead) { bad(c.res, 500, 'upload failed'); resolve(); } });
}));
route('GET', '/api/docs/:table/:id/attachments', (c) => {
  const t = c.params.table, id = Number(c.params.id);
  if (!DOC_DEFS[t]) return bad(c.res, 404, 'Unknown doc type');
  return ok(c.res, rows(`SELECT a.id,a.filename,a.stored_path,a.size_bytes,a.created_at,u.full_name uploaded_by_name
    FROM doc_attachments a LEFT JOIN users u ON u.id=a.uploaded_by
    WHERE a.table_name=? AND a.doc_id=? ORDER BY a.id DESC`, t, id));
});
route('DELETE', '/api/docs/:table/:id/attachment/:attId', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const t = c.params.table;
  const a = one(`SELECT * FROM doc_attachments WHERE table_name=? AND doc_id=? AND id=?`, t, Number(c.params.id), Number(c.params.attId));
  if (!a) return bad(c.res, 404, 'Attachment not found');
  try { fs.unlinkSync(path.join(UPLOAD_DIR, 'attachments', path.basename(a.stored_path))); } catch (e) { /* file already gone */ }
  run(`DELETE FROM doc_attachments WHERE id=?`, a.id);
  audit((c.user && c.user.id) || 1, t, 'ATTACH_DELETE', { entity: a.doc_id, old: a.filename });
  ok(c.res, { deleted: a.id });
});
route('POST', '/api/purchase-orders', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('PO');
    const goods = (b.lines || []).reduce((s, l) => s + l.qty * l.unit_price, 0);
    const info = run(`INSERT INTO purchase_orders(doc_no,status,po_date,supplier_id,po_type,currency,fx_rate,warehouse_id,goods_value,freight,insurance,duty_customs,ppn_import,forwarder,handling,port_charges,bank_charges,other_cost)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
      no, 'DRAFT', b.po_date || new Date().toISOString().slice(0,10),
      b.supplier_id, b.po_type || 'LOCAL_PURCHASE', b.currency || 'IDR', b.fx_rate || 1,
      b.warehouse_id, goods,
      b.freight || 0, b.insurance || 0, b.duty_customs || 0,
      b.forwarder || 0, b.handling || 0, b.port_charges || 0, b.bank_charges || 0,
      b.other_cost || 0);
    const id = Number(info.lastInsertRowid);
    for (const l of (b.lines || [])) {
      run(`INSERT INTO purchase_order_lines(purchase_order_id,product_id,qty,unit_price,discount_pct,line_total)
        VALUES(?,?,?,?,?,?)`, id, l.product_id, l.qty, l.unit_price, l.discount_pct||0,
        Math.round(l.qty*l.unit_price*(1-(l.discount_pct||0)/100)*100)/100);
    }
    audit((c.user && c.user.id) || 1, 'purchase_orders', 'CREATE', { docNo: no, entity: id });
    return ok(c.res, { id, doc_no: no });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/receivings', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('GRN');
    const info = run(`INSERT INTO receivings(doc_no,receiving_type,receive_date,purchase_order_id,partner_id,warehouse_id,received_by,condition_check)
      VALUES(?,?,?,?,?,?,1,1)`,
      no, b.receiving_type || 'LOCAL_PURCHASE', b.receive_date || new Date().toISOString().slice(0,10),
      b.purchase_order_id || null, b.partner_id || null, b.warehouse_id);
    const id = Number(info.lastInsertRowid);
    for (const l of (b.lines || [])) {
      run(`INSERT INTO receiving_lines(receiving_id,product_id,qty,unit_cost,serials) VALUES(?,?,?,?,?)`,
        id, l.product_id, l.qty, l.unit_cost||0, JSON.stringify(l.serials||[]));
    }
    audit((c.user && c.user.id) || 1, 'receivings', 'CREATE', { docNo: no, entity: id });
    return ok(c.res, { id, doc_no: no });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/quotations', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('QT');
    const info = run(`INSERT INTO quotations(doc_no,quote_date,valid_until,quotation_kind,customer_id,tax_code)
      VALUES(?,?,?,?,?,?)`,
      no, b.quote_date || new Date().toISOString().slice(0,10), b.valid_until || null,
      b.quotation_kind || 'RETAIL', b.customer_id, b.tax_code || 'PPN');
    const id = Number(info.lastInsertRowid);
    insertLines('quotation_lines', 'quotation_id', id, b.lines || []);
    calcAndStoreTotals('quotations', id, b.lines || [], b.tax_code || 'PPN');
    audit((c.user && c.user.id) || 1, 'quotations', 'CREATE', { docNo: no, entity: id });
    return ok(c.res, { id, doc_no: no, totals: one(`SELECT subtotal,tax_amount,grand_total FROM quotations WHERE id=?`, id) });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/sales-orders', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('SO');
    const info = run(`INSERT INTO sales_orders(doc_no,so_date,customer_id,sales_type,project_id,source_quotation_id,warehouse_id,tax_code,paid_amount)
      VALUES(?,?,?,?,?,?,?,?,0)`,
      no, b.so_date || new Date().toISOString().slice(0,10), b.customer_id, b.sales_type || 'RETAIL',
      b.project_id || null, b.source_quotation_id || null, b.warehouse_id, b.tax_code || 'PPN');
    const id = Number(info.lastInsertRowid);
    insertLines('sales_order_lines', 'sales_order_id', id, b.lines || []);
    calcAndStoreTotals('sales_orders', id, b.lines || [], b.tax_code || 'PPN');
    audit((c.user && c.user.id) || 1, 'sales_orders', 'CREATE', { docNo: no, entity: id });
    return ok(c.res, { id, doc_no: no });
  } catch (e) { return bad(c.res, 422, e.message); }
});

// workflow actions: /api/docs/<table>/<id>/submit|approve|reject|post
route('POST', '/api/docs/:table/:id/:action', async (c) => {
  const t = c.params.table, id = Number(c.params.id), action = c.params.action;
  if (!DOC_DEFS[t]) return bad(c.res, 404, 'Unknown doc type');
  if (!requirePerm(c, 'workflow')) return;
  try {
    if (['submit','approve','reject'].includes(action)) {
      const d = transition(t, id, action, 1);
      return ok(c.res, d);
    }
    if (action === 'post') return ok(c.res, post(t, id, 1));
    return bad(c.res, 400, 'Unknown action');
  } catch (e) { return bad(c.res, 422, e.message); }
});

// ================= DELIVERY ORDERS + SURAT JALAN (§28) =================
route('GET', '/api/delivery-orders', (c) => ok(c.res, rows(`
  SELECT d.*, s.doc_no so_no, p.project_code, b.name customer_name,
    (SELECT COUNT(*) FROM delivery_order_lines l WHERE l.delivery_order_id=d.id) lines,
    (SELECT a.stored_path FROM doc_attachments a WHERE a.table_name='delivery_orders' AND a.doc_id=d.id
      ORDER BY a.id LIMIT 1) pdf_url,
    (SELECT COUNT(*) FROM doc_attachments a WHERE a.table_name='delivery_orders' AND a.doc_id=d.id) atts
  FROM delivery_orders d
  LEFT JOIN sales_orders s ON s.id=d.sales_order_id
  LEFT JOIN projects p ON p.id=d.project_id
  LEFT JOIN business_partners b ON b.id=COALESCE(d.customer_id, s.customer_id)
  ORDER BY d.do_date DESC, d.id DESC`)));
route('POST', '/api/delivery-orders', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('DO');
    const sj = docNumber('SJ');
    const soCust = b.sales_order_id
      ? (one(`SELECT customer_id FROM sales_orders WHERE id=?`, b.sales_order_id) || {}).customer_id || null : null;
    const info = run(`INSERT INTO delivery_orders(doc_no,surat_jalan_no,status,do_date,sales_order_id,customer_id,project_id,purpose,warehouse_id,vehicle_info,driver_name,recipient_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      no, sj, 'DRAFT', b.do_date || null, b.sales_order_id || null, b.customer_id || soCust, b.project_id || null,
      b.purpose || 'SALES', b.warehouse_id, b.vehicle_info || null, b.driver_name || null, b.recipient_name || null);
    const id = Number(info.lastInsertRowid);
    for (const l of (b.lines || [])) {
      run(`INSERT INTO delivery_order_lines(delivery_order_id,sales_order_line_id,product_id,serial_id,qty)
        VALUES(?,?,?,?,?)`, id, l.sales_order_line_id || null, l.product_id, l.serial_id || null, l.qty);
    }
    audit((c.user && c.user.id) || 1, 'delivery_orders', 'CREATE', { docNo: no + ' / ' + sj, entity: id });
    return ok(c.res, { id, doc_no: no, surat_jalan_no: sj });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/delivery-orders/:id/close-signed', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const b = await readBody(c.req);
  run(`UPDATE delivery_orders SET signed_copy_url=?, closed_at=datetime('now'), status='LOCKED' WHERE id=? AND status='POSTED'`,
      b.signed_copy_url || 'uploaded', Number(c.params.id));
  audit((c.user && c.user.id) || 1, 'delivery_orders', 'CLOSE_SIGNED', { entity: Number(c.params.id) });
  return ok(c.res, { closed: true });
});

// ================= PROJECTS (§24-§27) =================
route('GET', '/api/projects', (c) => ok(c.res, rows(`
  SELECT p.*, bp.name customer_name,
    COALESCE((SELECT SUM(amount) FROM project_billings b WHERE b.project_id=p.id),0) billing_total,
    COALESCE((SELECT SUM(amount-b.paid_amount) FROM project_billings b WHERE b.project_id=p.id AND b.status IN ('PLANNED','INVOICED','PARTIAL')),0) outstanding,
    COALESCE((SELECT SUM(amount) FROM project_costs pc WHERE pc.project_id=p.id),0) cost_total
  FROM projects p JOIN business_partners bp ON bp.id=p.customer_id ORDER BY p.id DESC`)));
route('GET', '/api/projects/:id', (c) => {
  const id = Number(c.params.id);
  const proj = one(`SELECT p.*, bp.name customer_name FROM projects p JOIN business_partners bp ON bp.id=p.customer_id WHERE p.id=?`, id);
  if (!proj) return bad(c.res, 404, 'Project not found');
  // §27 Project Control Tower
  return ok(c.res, { project: proj,
    billings: rows(`SELECT * FROM project_billings WHERE project_id=? ORDER BY seq`, id),
    costs: rows(`SELECT * FROM project_costs WHERE project_id=? ORDER BY cost_date`, id),
    reservations: rows(`SELECT * FROM reservations WHERE project_id=?`, id),
    deliveries: rows(`SELECT doc_no,surat_jalan_no,status,do_date FROM delivery_orders WHERE project_id=?`, id),
    work_orders: rows(`SELECT doc_no,status,scheduled_date FROM work_orders WHERE project_id=?`, id),
    warranty: rows(`SELECT warranty_no,status,warranty_end FROM warranties w JOIN delivery_orders d ON d.doc_no=w.source_doc_no WHERE d.project_id=?`, id)
  });
});
route('POST', '/api/projects', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const code = b.project_code || ('PRJ' + String(one(`SELECT COUNT(*) n FROM projects`).n + 1).padStart(3,'0'));
    const no = docNumber('PRJ');
    const info = run(`INSERT INTO projects(doc_no,project_code,name,customer_id,site_location,contract_value,start_date,end_date,billing_terms,warranty_months,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      no, code, b.name, b.customer_id, b.site_location || null, b.contract_value || 0,
      b.start_date || new Date().toISOString().slice(0,10), b.end_date || null,
      JSON.stringify(b.billing_terms || [{seq:0,label:'DP',percent:30},{seq:1,label:'Progress 1',percent:40},{seq:2,label:'Retention',percent:30}]),
      b.warranty_months ?? 12, 'CONTRACTED');
    const pid = Number(info.lastInsertRowid);
    const terms = b.billing_terms || [
      { label: 'DP', percent: 30 }, { label: 'Progress 1', percent: 40 }, { label: 'Retention', percent: 30 }];
    terms.forEach((t, i) => run(`INSERT INTO project_billings(project_id,seq,label,percent,amount) VALUES(?,?,?,?,?)`,
      pid, i, t.label, t.percent, Math.round((b.contract_value||0) * (t.percent/100))));
    audit((c.user && c.user.id) || 1, 'projects', 'CREATE', { docNo: code, entity: pid });
    return ok(c.res, { id: pid, project_code: code });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/projects/:id/billings/:bid/pay', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  run(`UPDATE project_billings SET status='PAID', paid_amount=amount, paid_at=date('now') WHERE id=? AND project_id=?`,
      Number(c.params.bid), Number(c.params.id));
  audit((c.user && c.user.id) || 1, 'projects', 'BILLING_PAID', { entity: Number(c.params.id) });
  return ok(c.res, one(`SELECT * FROM project_billings WHERE id=?`, Number(c.params.bid)));
});
route('POST', '/api/projects/:id/costs', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  run(`INSERT INTO project_costs(project_id,category,description,amount,ref_no) VALUES(?,?,?,?,?)`,
      Number(c.params.id), b.category || 'OTHER', b.description || null, b.amount || 0, b.ref_no || null);
  return ok(c.res, { added: true });
});

// ================= WARRANTY + SERVICE + WORK ORDERS (§29-§33) =================
route('GET', '/api/warranties', (c) => ok(c.res, rows(`
  SELECT w.*, p.name product_name, sn.serial, bp.name customer_name FROM warranties w
  JOIN products p ON p.id=w.product_id JOIN business_partners bp ON bp.id=w.customer_id
  LEFT JOIN serial_numbers sn ON sn.id=w.serial_id ORDER BY w.id DESC`)));
route('POST', '/api/warranty-claims', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('WCL');
    run(`INSERT INTO warranty_claims(claim_no,warranty_id,problem,technician_id,status) VALUES(?,?,?,?,'OPEN')`,
        no, b.warranty_id, b.problem || '', b.technician_id || null);
    run(`UPDATE warranties SET status='CLAIMED' WHERE id=?`, b.warranty_id);
    audit((c.user && c.user.id) || 1, 'warranty_claims', 'CREATE', { docNo: no });
    return ok(c.res, { claim_no: no });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/warranty-claims/:id/resolve', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const b = await readBody(c.req);
  run(`UPDATE warranty_claims SET status='RESOLVED', diagnosis=?, resolution=?, repair_cost=?, supplier_claim_ref=? WHERE id=?`,
      b.diagnosis || null, b.resolution || null, b.repair_cost || 0, b.supplier_claim_ref || null, Number(c.params.id));
  run(`UPDATE warranties SET status='ACTIVE' WHERE id=(SELECT warranty_id FROM warranty_claims WHERE id=?)`, Number(c.params.id));
  return ok(c.res, { resolved: true });
});
route('GET', '/api/service-orders', (c) => ok(c.res, rows(`
  SELECT s.doc_no,s.status,s.complaint,s.received_at,s.completed_at,p.name product_name,bp.name customer_name
  FROM service_orders s JOIN products p ON p.id=s.product_id JOIN business_partners bp ON bp.id=s.customer_id
  ORDER BY s.id DESC`)));
route('POST', '/api/service-orders', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('SRV');
    let wstat = 'NON_WARRANTY';
    if (b.serial_text) {
      const w = one(`SELECT w.warranty_end FROM warranties w JOIN serial_numbers sn ON sn.id=w.serial_id WHERE sn.serial=? ORDER BY w.warranty_end DESC`, b.serial_text);
      if (w) wstat = w.warranty_end >= new Date().toISOString().slice(0,10) ? 'IN_WARRANTY' : 'WARRANTY_EXPIRED';
    }
    run(`INSERT INTO service_orders(doc_no,customer_id,product_id,complaint,warranty_status_at_receiving)
         VALUES(?,?,?,?,?)`, no, b.customer_id, b.product_id, b.complaint || '', wstat);
    audit((c.user && c.user.id) || 1, 'service_orders', 'RECEIVE', { docNo: no });
    return ok(c.res, { doc_no: no, warranty_status: wstat });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('GET', '/api/work-orders', (c) => ok(c.res, rows(`
  SELECT w.*, p.project_code FROM work_orders w LEFT JOIN projects p ON p.id=w.project_id ORDER BY w.id DESC`)));
route('POST', '/api/work-orders', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  try {
    const no = docNumber('WO');
    run(`INSERT INTO work_orders(doc_no,project_id,customer_id,location,scheduled_date,work_description,technicians,status)
         VALUES(?,?,?,?,?,?,?,?)`,
      no, b.project_id || null, b.customer_id || null, b.location || null,
      b.scheduled_date || new Date().toISOString().slice(0,10), b.work_description || '',
      JSON.stringify(b.technicians || []), 'DRAFT');
    audit((c.user && c.user.id) || 1, 'work_orders', 'CREATE', { docNo: no });
    return ok(c.res, { doc_no: no });
  } catch (e) { return bad(c.res, 422, e.message); }
});
route('POST', '/api/work-orders/:id/complete', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const b = await readBody(c.req);
  run(`UPDATE work_orders SET status='POSTED', checkin_at=COALESCE(checkin_at,datetime('now')),
       checkout_at=datetime('now'), solutions=?, rating=? WHERE id=?`,
      b.solutions || null, b.rating || null, Number(c.params.id));
  return ok(c.res, one(`SELECT * FROM work_orders WHERE id=?`, Number(c.params.id)));
});

// ================= AUDIT / DASHBOARD =================
route('GET', '/api/audit', (c) => ok(c.res, rows(`SELECT * FROM audit_trail ORDER BY id DESC LIMIT 200`)));
route('GET', '/api/dashboard', (c) => ok(c.res, dash.snapshot()));

// ---- Dashboard v2: snapshot + widgets (P0-P2), 30s cache to spare the ~20 sequential queries ----
const ext = require('./dashboard_ext.js');
let DASH2_CACHE = { at: 0, data: null, period: null };
route('GET', '/api/dashboard2', (c) => {
  const period = ['month', 'quarter', 'ytd', '30d'].includes(c.url.searchParams.get('period'))
    ? c.url.searchParams.get('period') : 'ytd';
  const nowMs = Date.now();
  if (DASH2_CACHE.data && DASH2_CACHE.period === period && nowMs - DASH2_CACHE.at < 30000)
    return ok(c.res, DASH2_CACHE.data);
  const data = {
    snapshot: dash.snapshot(),
    action_items: ext.actionItems(),
    activity: ext.activity(10),
    low_stock: ext.lowStock(8),
    trend: ext.trend(),
    top_products: ext.topProducts(period),
    top_customers: ext.topCustomers(period),
    sales_period: ext.salesByPeriod(period),
    sales_compare: ext.salesComparison(period),
    billing_aging: ext.billingAging(),
    warehouse_summary: ext.warehouseSummary(),
    crm: crmMod.summary(),
    period,
  };
  DASH2_CACHE = { at: nowMs, data, period };
  return ok(c.res, data);
});

// ---- Lisa in-ERP assistant (auth-gated; stateless; 30 req/min per user) ----
const lisa = require('./lisa_chat.js');
const LISA_BURST = {};
route('POST', '/api/lisa', async (c) => {
  const uname = (c.user && c.user.username) || 'anon';
  const nowMin = Math.floor(Date.now() / 60000);
  if (!LISA_BURST[uname] || LISA_BURST[uname].min !== nowMin) LISA_BURST[uname] = { min: nowMin, n: 0 };
  if (++LISA_BURST[uname].n > 30) return bad(c.res, 429, 'Terlalu banyak pesan — pelan-pelan ya 🙂');
  const body = await readBody(c.req);
  const out = await lisa.reply(String(body.message || ''));
  return ok(c.res, out);
});

// ================= CRM (leads / follow-ups / 360) =================
const crmMod = require('./crm.js');
route('GET', '/api/crm/summary', (c) => ok(c.res, crmMod.summary()));
route('GET', '/api/crm/leads', (c) => ok(c.res, crmMod.listLeads(c.url.searchParams.get('stage'))));
route('POST', '/api/crm/leads', async (c) => {
  if (!requirePerm(c, 'create')) return;
  return ok(c.res, crmMod.createLead(c.user, await readBody(c.req)));
});
route('POST', '/api/crm/leads/:id', async (c) => {
  if (!requirePerm(c, 'create')) return;
  return ok(c.res, crmMod.updateLead(c.user, Number(c.params.id), await readBody(c.req)));
});
route('POST', '/api/crm/leads/:id/convert', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  return ok(c.res, crmMod.convertLead(c.user, Number(c.params.id), await readBody(c.req)));
});
route('GET', '/api/crm/followups', (c) => ok(c.res, crmMod.followupsDue(Number(c.url.searchParams.get('days')) || 7)));
route('GET', '/api/crm/activities', (c) => {
  const lead = c.url.searchParams.get('lead'), cust = c.url.searchParams.get('customer');
  return ok(c.res, crmMod.listActivities(lead ? Number(lead) : null, cust ? Number(cust) : null));
});
route('POST', '/api/crm/activities', async (c) => {
  if (!requirePerm(c, 'create')) return;
  return ok(c.res, crmMod.addActivity(c.user, await readBody(c.req)));
});
route('POST', '/api/crm/activities/:id/complete', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const b = await readBody(c.req);
  return ok(c.res, crmMod.completeActivity(c.user, Number(c.params.id), b.result));
});
route('GET', '/api/crm/360/:id', (c) => {
  const d = crmMod.customer360(Number(c.params.id));
  if (!d) return bad(c.res, 404, 'Customer not found');
  return ok(c.res, d);
});
route('GET', '/api/profitability', (c) => {
  const list = dash.profitability().map(r => ({ ...r,
    gross_profit: r.revenue - r.cost,
    gross_margin_pct: r.revenue > 0 ? Math.round((r.revenue - r.cost) / r.revenue * 1000) / 10 : 0 }));
  return ok(c.res, list);
});

// ================= STOCK EXPORT / AGING / SEARCH / REPORTS =================

// ---- CSV helper ----
function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// GET /api/stock-counts — list all count sessions
route('GET', '/api/stock-counts', (c) => ok(c.res, rows(
  "SELECT sc.*, w.name warehouse_name FROM stock_counts sc JOIN warehouses w ON w.id = sc.warehouse_id ORDER BY sc.id DESC")));

// POST /api/stock-counts — create a new count session
route('POST', '/api/stock-counts', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const b = await readBody(c.req);
  if (!b.warehouse_id) return bad(c.res, 400, 'warehouse_id required');
  try {
    const no = docNumber('CTR');
    const info = run(
      `INSERT INTO stock_counts(count_no, warehouse_id, note) VALUES(?,?,?)`,
      no, b.warehouse_id, b.note || null);
    const id = Number(info.lastInsertRowid);
    // Insert all products with stock in this warehouse
    const products = rows(
      `SELECT ib.product_id, ib.physical FROM inventory_balances ib
       WHERE ib.warehouse_id = ? AND ib.physical > 0`, b.warehouse_id);
    for (const p of products) {
      run(
        `INSERT INTO stock_count_lines(stock_count_id, product_id, system_qty) VALUES(?,?,?)`,
        id, p.product_id, p.physical);
    }
    audit((c.user && c.user.id) || 1, 'stock_counts', 'CREATE', { docNo: no, entity: id });
    return ok(c.res, { id, count_no: no, lines: products.length });
  } catch (e) { return bad(c.res, 422, e.message); }
});

// GET /api/stock-counts/:id — get count session with lines
route('GET', '/api/stock-counts/:id', (c) => {
  const id = Number(c.params.id);
  const sc = one(`SELECT sc.*, w.name warehouse_name FROM stock_counts sc JOIN warehouses w ON w.id = sc.warehouse_id WHERE sc.id=?`, id);
  if (!sc) return bad(c.res, 404, 'Stock count not found');
  sc.lines = rows(
    `SELECT scl.*, p.code product_code, p.name product_name, p.brand product_brand
     FROM stock_count_lines scl JOIN products p ON p.id = scl.product_id
     WHERE scl.stock_count_id = ?`, id);
  return ok(c.res, sc);
});

// POST /api/stock-counts/:id/lines — update counted quantities
route('POST', '/api/stock-counts/:id/lines', async (c) => {
  if (!requirePerm(c, 'create')) return;
  const id = Number(c.params.id);
  const sc = one(`SELECT * FROM stock_counts WHERE id=?`, id);
  if (!sc) return bad(c.res, 404, 'Stock count not found');
  if (sc.status === 'POSTED') return bad(c.res, 422, 'Cannot modify posted count');
  const b = await readBody(c.req);
  if (!b.lines || !Array.isArray(b.lines)) return bad(c.res, 400, 'lines array required');
  for (const l of b.lines) {
    const variance = l.counted_qty != null ? l.counted_qty - l.system_qty : null;
    run(
      `UPDATE stock_count_lines SET counted_qty = ?, variance = ?, note = ?
       WHERE stock_count_id = ? AND product_id = ?`,
      l.counted_qty, variance, l.note || null, id, l.product_id);
  }
  run(`UPDATE stock_counts SET status = 'COUNTED' WHERE id = ? AND status = 'OPEN'`, id);
  audit((c.user && c.user.id) || 1, 'stock_counts', 'UPDATE_LINES', { entity: id });
  return ok(c.res, { updated: b.lines.length });
});

// POST /api/stock-counts/:id/post — post the count, apply adjustments
route('POST', '/api/stock-counts/:id/post', async (c) => {
  if (!requirePerm(c, 'workflow')) return;
  const id = Number(c.params.id);
  const sc = one(`SELECT * FROM stock_counts WHERE id=?`, id);
  if (!sc) return bad(c.res, 404, 'Stock count not found');
  if (sc.status === 'POSTED') return bad(c.res, 422, 'Already posted');
  const lines = rows(`SELECT * FROM stock_count_lines WHERE stock_count_id = ? AND variance IS NOT NULL AND variance != 0`, id);
  for (const l of lines) {
    moveStock({
      productId: l.product_id,
      warehouseId: sc.warehouse_id,
      qtyDelta: l.variance,
      type: 'ADJUSTMENT',
      refTable: 'stock_counts',
      refId: id,
      refNo: sc.count_no,
      userId: (c.user && c.user.id) || 1
    });
  }
  run(`UPDATE stock_counts SET status = 'POSTED', posted_by = ?, posted_at = datetime('now') WHERE id = ?`,
      (c.user && c.user.id) || 1, id);
  audit((c.user && c.user.id) || 1, 'stock_counts', 'POST', { docNo: sc.count_no, entity: id });
  return ok(c.res, { posted: true, adjustments: lines.length });
});

// GET /api/search?q=... — global search
route('GET', '/api/search', (c) => {
  const q = c.url.searchParams.get('q');
  if (!q || q.length < 2) return bad(c.res, 400, 'q parameter must be at least 2 characters');
  const pattern = '%' + q + '%';
  const results = [];
  // Products
  const prods = rows(`SELECT id, code, name, brand FROM products WHERE code LIKE ? OR name LIKE ? OR brand LIKE ? LIMIT 10`, pattern, pattern, pattern);
  for (const p of prods) results.push({ type: 'product', id: p.id, label: `${p.code} — ${p.name}${p.brand ? ' (' + p.brand + ')' : ''}`, module: 'products' });
  // Business partners
  const parts = rows(`SELECT id, code, name FROM business_partners WHERE name LIKE ? OR code LIKE ? LIMIT 10`, pattern, pattern);
  for (const bp of parts) results.push({ type: 'partner', id: bp.id, label: `${bp.code} — ${bp.name}`, module: 'business_partners' });
  // CRM leads
  const leads = rows(`SELECT id, lead_no, company FROM crm_leads WHERE company LIKE ? OR lead_no LIKE ? LIMIT 5`, pattern, pattern);
  for (const l of leads) results.push({ type: 'lead', id: l.id, label: `${l.lead_no || ''} — ${l.company}`, module: 'crm_leads' });
  // Sales orders
  const sos = rows(`SELECT id, doc_no FROM sales_orders WHERE doc_no LIKE ? LIMIT 5`, pattern);
  for (const s of sos) results.push({ type: 'sales_order', id: s.id, label: s.doc_no, module: 'sales_orders' });
  // Quotations
  const qts = rows(`SELECT id, doc_no FROM quotations WHERE doc_no LIKE ? LIMIT 5`, pattern);
  for (const q of qts) results.push({ type: 'quotation', id: q.id, label: q.doc_no, module: 'quotations' });
  // Purchase orders
  const pos = rows(`SELECT id, doc_no FROM purchase_orders WHERE doc_no LIKE ? LIMIT 5`, pattern);
  for (const p of pos) results.push({ type: 'purchase_order', id: p.id, label: p.doc_no, module: 'purchase_orders' });
  return ok(c.res, results.slice(0, 20));
});

// GET /api/warehouse-summary — per-warehouse summary
route('GET', '/api/warehouse-summary', (c) => ok(c.res, ext.warehouseSummary()));

// GET /api/reports/:type — CSV reports
route('GET', '/api/reports/:type', (c) => {
  const type = c.params.type;
  if (!['stock', 'sales', 'invoices'].includes(type)) return bad(c.res, 400, 'type must be stock, sales, or invoices');
  let headers, data;
  if (type === 'stock') {
    headers = ['Code','Name','Brand','EAN','Warehouse','Physical','Reserved','Available','AvgCost','Value','ReorderPoint'];
    data = rows(
      `SELECT p.code, p.name, p.brand, p.barcode, w.name wh_name,
              ib.physical, ib.reserved, (ib.physical - ib.reserved) available, ib.avg_cost,
              (ib.physical * ib.avg_cost) stock_value, p.reorder_point
       FROM inventory_balances ib JOIN products p ON p.id = ib.product_id JOIN warehouses w ON w.id = ib.warehouse_id
       ORDER BY p.code`);
    data = data.map(r => [r.code, r.name, r.brand, r.barcode, r.wh_name, r.physical, r.reserved, r.available, r.avg_cost, r.stock_value, r.reorder_point]);
  } else if (type === 'sales') {
    headers = ['DocNo','Date','Customer','Type','Tax','Subtotal','TaxAmount','GrandTotal','Status','PaidAmount'];
    data = rows(
      `SELECT d.doc_no, d.so_date, bp.name customer, d.sales_type, d.tax_code,
              d.subtotal, d.tax_amount, d.grand_total, d.status, d.paid_amount
       FROM sales_orders d LEFT JOIN business_partners bp ON bp.id = d.customer_id
       ORDER BY d.so_date DESC`);
    data = data.map(r => [r.doc_no, r.date, r.customer, r.type, r.tax_code, r.subtotal, r.tax_amount, r.grand_total, r.status, r.paid_amount]);
  } else {
    headers = ['DocNo','Date','Customer','InvoiceRef','GrandTotal','Status'];
    data = rows(
      `SELECT d.doc_no, d.so_date, bp.name customer, d.invoice_ref, d.grand_total, d.status
       FROM sales_orders d LEFT JOIN business_partners bp ON bp.id = d.customer_id
       WHERE d.invoice_ref IS NOT NULL
       ORDER BY d.so_date DESC`);
    data = data.map(r => [r.doc_no, r.date, r.customer, r.invoice_ref, r.grand_total, r.status]);
  }
  let csv = headers.join(',') + '\n';
  for (const row of data) csv += row.map(csvEscape).join(',') + '\n';
  c.res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': 'attachment; filename="' + type + '_report.csv"'
  });
  c.res.end(csv);
});

// GET /api/docs/:table/:id/template — structured document data for PDF generation
route('GET', '/api/docs/:table/:id/template', (c) => {
  const t = c.params.table, id = Number(c.params.id);
  const company = {
    name: 'PT Monalisa Tunggal Jaya',
    address: 'Jl. Gajah Mada No.156, Keagungan, Taman Sari, Jakarta Barat 11520',
    phone: '+62 21 6290170',
    website: 'ptmtj.com'
  };
  if (t === 'quotations') {
    const doc = one(`SELECT q.*, bp.name customer_name, bp.address customer_address, bp.phone customer_phone
      FROM quotations q JOIN business_partners bp ON bp.id = q.customer_id WHERE q.id=?`, id);
    if (!doc) return bad(c.res, 404, 'Not found');
    const lines = rows(
      `SELECT ql.*, p.code product_code, p.name product_name, p.brand product_brand
       FROM quotation_lines ql JOIN products p ON p.id = ql.product_id WHERE ql.quotation_id=?`, id);
    return ok(c.res, { company, document: doc, lines, type: 'quotation' });
  }
  if (t === 'sales_orders') {
    const doc = one(`SELECT so.*, bp.name customer_name, bp.address customer_address, bp.phone customer_phone
      FROM sales_orders so JOIN business_partners bp ON bp.id = so.customer_id WHERE so.id=?`, id);
    if (!doc) return bad(c.res, 404, 'Not found');
    const lines = rows(
      `SELECT sl.*, p.code product_code, p.name product_name, p.brand product_brand
       FROM sales_order_lines sl JOIN products p ON p.id = sl.product_id WHERE sl.sales_order_id=?`, id);
    return ok(c.res, { company, document: doc, lines, type: 'sales_order' });
  }
  if (t === 'delivery_orders') {
    const doc = one(`SELECT d.*, bp.name customer_name, bp.address customer_address, bp.phone customer_phone,
           s.doc_no so_doc_no
      FROM delivery_orders d
      LEFT JOIN sales_orders s ON s.id = d.sales_order_id
      LEFT JOIN business_partners bp ON bp.id = COALESCE(d.customer_id, s.customer_id)
      WHERE d.id=?`, id);
    if (!doc) return bad(c.res, 404, 'Not found');
    const lines = rows(
      `SELECT dl.*, p.code product_code, p.name product_name, p.brand product_brand
       FROM delivery_order_lines dl JOIN products p ON p.id = dl.product_id WHERE dl.delivery_order_id=?`, id);
    return ok(c.res, { company, document: doc, lines, type: 'delivery_order' });
  }
  return bad(c.res, 400, 'table must be quotations, sales_orders, or delivery_orders');
});

// POST /api/sync/drive — trigger drive stock sync (placeholder)
route('POST', '/api/sync/drive', (c) => ok(c.res, { status: 'ok', message: 'Sync triggered. Check /api/stock for updated data.' }));


// ---------- dispatcher ----------
async function handle(req, res, url, user) {
  const pathParts = url.pathname.split('/').filter(Boolean).slice(1); // strip 'api'
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    const pat = r.pattern.split('/').filter(Boolean).slice(1);
    if (pat.length !== pathParts.length) continue;
    const params = {}; let hit = true;
    pat.forEach((seg, i) => {
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(pathParts[i]);
      else if (seg !== pathParts[i]) hit = false;
    });
    if (hit) { try { await r.fn({ req, res, params, url, user }); } catch (e) { bad(res, 500, e.message); } return; }
  }
  bad(res, 404, `No route ${req.method} ${url.pathname}`);
}
module.exports = { handle };
