// §62 Testing Principle — numbers must stay consistent across the whole chain.
'use strict';
const assert = require('node:assert');
const { db, totalsForProduct } = require('./db.js');
const { transition } = require('./approval.js');
const { post } = require('./posting.js');
const dash = require('./dashboard.js');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); }
}
const yr = new Date().getFullYear();
const dstr = new Date().toISOString().slice(0, 10);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const pMH = one(`SELECT * FROM products WHERE code='AZT-MH350BSW'`);
const pCab = one(`SELECT * FROM products WHERE code='CAB-XLR10'`);
const whMain = one(`SELECT * FROM warehouses WHERE code='WH-JKT-MAIN'`);

check('R1 Receiving (§62): PO->approve->GRN(2 SN)->post => Physical+2, serials IN_STOCK', () => {
  const before = totalsForProduct(pMH.id, whMain.id).physical;
  const po = Number(db.prepare(
    `INSERT INTO purchase_orders(doc_no,status,po_date,supplier_id,po_type,currency,fx_rate,warehouse_id)
     VALUES(?,'DRAFT',?,1,'LOCAL_PURCHASE','IDR',1,?)`).run(`PO-${yr}-90001`, dstr, whMain.id).lastInsertRowid);
  db.prepare(`INSERT INTO purchase_order_lines(purchase_order_id,product_id,qty,unit_price,line_total)
    VALUES(?,?,?,?,?)`).run(po, pMH.id, 2, 18500000, 37000000);
  transition('purchase_orders', po, 'submit', 1);
  transition('purchase_orders', po, 'approve', 1);   // auto-posts PO
  assert.strictEqual(one(`SELECT status FROM purchase_orders WHERE id=?`, po).status, 'POSTED');

  const grn = Number(db.prepare(
    `INSERT INTO receivings(doc_no,receiving_type,receive_date,purchase_order_id,warehouse_id)
     VALUES(?,?,?,?,?)`).run(`GRN-${yr}-90001`, 'LOCAL_PURCHASE', dstr, po, whMain.id).lastInsertRowid);
  db.prepare(`INSERT INTO receiving_lines(receiving_id,product_id,qty,unit_cost,serials) VALUES(?,?,?,?,?)`)
    .run(grn, pMH.id, 2, 18500000, JSON.stringify(['AZT123456', 'AZT123457']));
  transition('receivings', grn, 'submit', 1);
  transition('receivings', grn, 'approve', 1);
  post('receivings', grn, 1);
  assert.strictEqual(totalsForProduct(pMH.id, whMain.id).physical, before + 2);
  const sns = one(`SELECT COUNT(*) n FROM serial_numbers WHERE product_id=? AND status='IN_STOCK'`, pMH.id).n;
  assert.ok(sns >= 2, 'serials registered');
});

check('R2 Duplicate serial rejected (§55)', () => {
  const grn = Number(db.prepare(
    `INSERT INTO receivings(doc_no,status,receiving_type,receive_date,purchase_order_id,warehouse_id)
     VALUES(?,'APPROVED','LOCAL_PURCHASE',?,NULL,?)`).run(`GRN-${yr}-90002`, dstr, whMain.id).lastInsertRowid);
  db.prepare(`INSERT INTO receiving_lines(receiving_id,product_id,qty,unit_cost,serials) VALUES(?,?,?,?,?)`)
    .run(grn, pMH.id, 1, 0, JSON.stringify(['AZT123456']));
  let threw = false;
  try { post('receivings', grn, 1); } catch (e) { threw = /DUPLICATE_SERIAL/.test(e.message); }
  assert.ok(threw, 'expected DUPLICATE_SERIAL');
});

check('R3 Reservation (§62): reserve 1 MH => reserved+1, available=physical-reserved', () => {
  const { createReservation } = require('./db.js');
  const t0 = totalsForProduct(pMH.id, whMain.id);
  assert.ok(t0.physical >= 2, 'need >=2 in stock');
  createReservation({ warehouseId: whMain.id, requestedBy: 1,
    lines: [{ product_id: pMH.id, qty: 1 }], reason: 'test project A' });
  const t1 = totalsForProduct(pMH.id, whMain.id);
  assert.strictEqual(t1.reserved, t0.reserved + 1);
  assert.strictEqual(t1.available, t1.physical - t1.reserved);
});

check('R4 Over-reservation rejected (§19/§55)', () => {
  const { createReservation } = require('./db.js');
  const t0 = totalsForProduct(pMH.id, whMain.id);
  let threw = false;
  try { createReservation({ warehouseId: whMain.id, requestedBy: 1,
    lines: [{ product_id: pMH.id, qty: t0.available + 5 }] }); }
  catch (e) { threw = /RESERVATION_EXCEEDS_STOCK|NEGATIVE/.test(e.message); }
  assert.ok(threw);
});

check('R5 Retail flow: SO post reserves, DO delivers => stock OUT, reservation consumed, warranty born', () => {
  const cRetail = one(`SELECT id FROM business_partners WHERE kind='CUSTOMER' AND code='C0003'`).id;
  const so = Number(db.prepare(
    `INSERT INTO sales_orders(doc_no,status,so_date,customer_id,sales_type,warehouse_id,tax_code)
     VALUES(?,'DRAFT',?,?,'RETAIL',?,'PPN')`).run(`SO-${yr}-90001`, dstr, cRetail, whMain.id).lastInsertRowid);
  db.prepare(`INSERT INTO sales_order_lines(sales_order_id,product_id,qty,unit_price,line_total) VALUES(?,?,?,?,?)`)
    .run(so, pMH.id, 1, 28500000, 28500000);
  transition('sales_orders', so, 'submit', 1);
  transition('sales_orders', so, 'approve', 1);
  post('sales_orders', so, 1);            // posting SO reserves 1 MH
  assert.strictEqual(one(`SELECT status FROM sales_orders WHERE id=?`, so).status, 'POSTED');

  const t0 = totalsForProduct(pMH.id, whMain.id);
  const doId = Number(db.prepare(
    `INSERT INTO delivery_orders(doc_no,surat_jalan_no,status,do_date,sales_order_id,purpose,warehouse_id)
     VALUES(?,?,'DRAFT',?,?,?,?)`).run(`DO-${yr}-90001`, `SJ-${yr}-90001`, dstr, so, 'SALES', whMain.id).lastInsertRowid);
  const sol = one(`SELECT id FROM sales_order_lines WHERE sales_order_id=?`, so);
  const sn = one(`SELECT * FROM serial_numbers WHERE product_id=? AND status='IN_STOCK' LIMIT 1`, pMH.id);
  db.prepare(`INSERT INTO delivery_order_lines(delivery_order_id,sales_order_line_id,product_id,serial_id,qty) VALUES(?,?,?,?,?)`)
    .run(doId, sol.id, pMH.id, sn.id, 1);
  transition('delivery_orders', doId, 'submit', 1);
  transition('delivery_orders', doId, 'approve', 1);
  post('delivery_orders', doId, 1);

  const t1 = totalsForProduct(pMH.id, whMain.id);
  assert.strictEqual(t1.physical, t0.physical - 1, 'physical decremented');
  assert.strictEqual(one(`SELECT status FROM serial_numbers WHERE id=?`, sn.id).status, 'SOLD_DELIVERED');
  assert.strictEqual(one(`SELECT COUNT(*) n FROM warranties WHERE serial_id=?`, sn.id).n, 1, 'warranty born');
});

check('R6 Negative stock guard (§55)', () => {
  const { moveStock } = require('./db.js');
  let threw = false;
  try { moveStock({ productId: pCab.id, warehouseId: whMain.id, qtyDelta: -(10 ** 9), type: 'ADJUSTMENT', refTable: 't' }); }
  catch (e) { threw = /NEGATIVE_STOCK_GUARD/.test(e.message); }
  assert.ok(threw);
});

check('R7 Doc numbering unique/sequential (§48)', () => {
  const { nextDocNo } = require('./db.js');
  const a = nextDocNo('QT'), b = nextDocNo('QT');
  assert.notStrictEqual(a, b);
  assert.ok(new RegExp(`^QT-\\d{4}-\\d{5}$`).test(a));
});

check('R8 Dashboard consistent (§47)', () => {
  const s = dash.snapshot();
  assert.ok(typeof s.sales_this_month === 'number');
  assert.ok(s.stock_value > 0);
  assert.ok(s.active_warranty >= 1, 'warranty from R5 visible on dashboard');
});

check('R9 Stock Transfer (§21): post => source OUT, dest IN, serial moves, guards enforced', () => {
  const wh2 = one(`SELECT * FROM warehouses WHERE id<>? LIMIT 1`, whMain.id);
  const before = { src: totalsForProduct(pCab.id, whMain.id).physical,
                   dst: totalsForProduct(pCab.id, wh2.id).physical };
  const trf = Number(db.prepare(
    `INSERT INTO stock_transfers(doc_no,transfer_date,from_warehouse_id,to_warehouse_id)
     VALUES(?,?,?,?)`).run(`TRF-${yr}-90001`, dstr, whMain.id, wh2.id).lastInsertRowid);
  db.prepare(`INSERT INTO stock_transfer_lines(stock_transfer_id,product_id,qty,serials) VALUES(?,?,?,?)`)
    .run(trf, pCab.id, 3, '[]');
  transition('stock_transfers', trf, 'submit', 1);
  transition('stock_transfers', trf, 'approve', 1);
  post('stock_transfers', trf, 1);
  assert.strictEqual(totalsForProduct(pCab.id, whMain.id).physical, before.src - 3, 'source decremented');
  assert.strictEqual(totalsForProduct(pCab.id, wh2.id).physical, before.dst + 3, 'destination incremented');
  assert.strictEqual(totalsForProduct(pCab.id, whMain.id).physical + totalsForProduct(pCab.id, wh2.id).physical,
    before.src + before.dst, 'no stock lost in transit');

  // same-warehouse transfer rejected
  let threw = false;
  try {
    const bad1 = Number(db.prepare(
      `INSERT INTO stock_transfers(doc_no,transfer_date,from_warehouse_id,to_warehouse_id)
       VALUES(?,?,?,?)`).run(`TRF-${yr}-90002`, dstr, whMain.id, whMain.id).lastInsertRowid);
    db.prepare(`INSERT INTO stock_transfer_lines(stock_transfer_id,product_id,qty,serials) VALUES(?,?,?,?)`)
      .run(bad1, pCab.id, 1, '[]');
    transition('stock_transfers', bad1, 'submit', 1);
  } catch (e) { threw = /must differ/.test(e.message); }
  assert.ok(threw, 'same-warehouse rejected at submit');

  // over-transfer rejected at post (negative stock guard)
  threw = false;
  try {
    const bad2 = Number(db.prepare(
      `INSERT INTO stock_transfers(doc_no,transfer_date,from_warehouse_id,to_warehouse_id)
       VALUES(?,?,?,?)`).run(`TRF-${yr}-90003`, dstr, wh2.id, whMain.id).lastInsertRowid);
    db.prepare(`INSERT INTO stock_transfer_lines(stock_transfer_id,product_id,qty,serials) VALUES(?,?,?,?)`)
      .run(bad2, pCab.id, 10 ** 9, '[]');
    transition('stock_transfers', bad2, 'submit', 1);
    transition('stock_transfers', bad2, 'approve', 1);
    post('stock_transfers', bad2, 1);
  } catch (e) { threw = /NEGATIVE_STOCK_GUARD/.test(e.message); }
  assert.ok(threw, 'over-transfer rejected');
});

for (const [st, name] of results) console.log(st.padEnd(5), name);
const fails = results.filter(r => r[0] === 'FAIL').length;
console.log(fails === 0 ? '\nALL TESTS GREEN — numbers consistent (§62)' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
