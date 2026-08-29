// §2.2 Transaction Engine — all business effects flow through post*() functions.
// Nothing else may write inventory_balances / stock_movements.
'use strict';
const { db, audit, nextDocNo, totalsForProduct, moveStock } = require('./db.js');
const { doc } = require('./approval.js');

const RECEIVE_MOVE = { LOCAL_PURCHASE: 'PURCHASE_IN', IMPORT_PURCHASE: 'PURCHASE_IN',
  CUSTOMER_RETURN: 'RETURN_IN', PROJECT_RETURN: 'RETURN_IN', WAREHOUSE_TRANSFER: 'TRANSFER_IN',
  SERVICE_RETURN: 'RETURN_IN', ADJUSTMENT: 'ADJUSTMENT', OTHER: 'ADJUSTMENT' };

const DO_MOVE = { SALES: 'SALES_OUT', PROJECT: 'PROJECT_DELIVERY_OUT', SERVICE: 'SERVICE_ISSUE',
  TRANSFER: 'TRANSFER_OUT', OTHER: 'ADJUSTMENT' };

function setPosted(table, id, userId) {
  db.prepare(`UPDATE ${table} SET status='POSTED', posted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(id);
  const d = doc(table, id);
  audit(userId, table, 'POST', { docNo: d.doc_no, entity: id });
  return d;
}

// ---------------- Warranty Engine (§29) — certificates born from deliveries ----------------
function birthWarranty({ customerId, productId, serialId = null, sourceType, sourceDocNo,
                         purchaseDate, deliveryDate, months }) {
  if (!months || months <= 0) return null;
  const start = deliveryDate || purchaseDate;
  const endD = new Date(start);
  endD.setMonth(endD.getMonth() + months);
  const no = nextDocNo('WAR');
  db.prepare(`INSERT INTO warranties(warranty_no,customer_id,product_id,serial_id,source_type,source_doc_no,
              purchase_date,delivery_date,warranty_start,warranty_end,months,status)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,'ACTIVE')`)
    .run(no, customerId, productId, serialId, sourceType, sourceDocNo, purchaseDate, deliveryDate,
         start, endD.toISOString().slice(0, 10), months);
  return no;
}

// ---------------- Receiving (§15) — stock exists only after CONFIRMED ----------------
function postReceiving(id, userId) {
  const r = doc('receivings', id);
  if (r.status !== 'APPROVED') throw new Error('Only APPROVED receivings can be posted');
  const lines = db.prepare(`SELECT rl.*, p.serial_policy, p.code pcode FROM receiving_lines rl
    JOIN products p ON p.id=rl.product_id WHERE rl.receiving_id=?`).all(id);
  const mv = RECEIVE_MOVE[r.receiving_type] || 'ADJUSTMENT';
  for (const l of lines) {
    let cost = l.unit_cost;
    if (!cost && r.purchase_order_id) { // default landed-unit cost from PO line
      const pol = db.prepare(`SELECT unit_price FROM purchase_order_lines WHERE purchase_order_id=? AND product_id=?`)
        .get(r.purchase_order_id, l.product_id);
      if (pol) cost = pol.unit_price;
    }
    moveStock({ productId: l.product_id, warehouseId: r.warehouse_id, qtyDelta: l.qty,
                type: mv, refTable: 'receivings', refId: id, refNo: r.doc_no, userId, avgCost: cost });
    // Serial Number Engine (§5): register scanned serials, unique per product
    const serials = JSON.parse(l.serials || '[]');
    if (l.serial_policy === 'REQUIRED' && serials.length !== Math.round(l.qty))
      throw new Error(`${l.pcode}: serial-required product needs ${Math.round(l.qty)} serials, got ${serials.length}`);
    for (const s of serials) {
      const dup = db.prepare(`SELECT id FROM serial_numbers WHERE product_id=? AND serial=?`).get(l.product_id, s);
      if (dup) throw new Error(`DUPLICATE_SERIAL ${s} (§55)`);
      db.prepare(`INSERT INTO serial_numbers(product_id,serial,batch_no,status,current_warehouse_id,purchase_order_id)
                  VALUES(?,?,?,'IN_STOCK',?,?)`)
        .run(l.product_id, s, null, r.warehouse_id, r.purchase_order_id);
    }
  }
  audit(userId, 'receivings', 'STOCK_IN', { docNo: r.doc_no, entity: id,
    newv: `${lines.length} lines -> ${mv}` });
  return setPosted('receivings', id, userId);
}

// ---------------- Sales Order (§23) posting = confirmation + reservation ----------------
function postSalesOrder(id, userId) {
  const so = doc('sales_orders', id);
  if (so.status !== 'APPROVED') throw new Error('Only APPROVED sales orders can be posted');
  const lines = db.prepare(`SELECT * FROM sales_order_lines WHERE sales_order_id=?`).all(id);
  // Reservation engine (§19): reserve full quantity at posting
  const { createReservation } = require('./db.js');
  createReservation({
    salesOrderId: id, warehouseId: so.warehouse_id, requestedBy: userId,
    reason: `SO ${so.doc_no}`,
    lines: lines.map(l => ({ product_id: l.product_id, qty: l.qty })),
  });
  db.prepare(`UPDATE sales_order_lines SET reserved_qty=qty WHERE sales_order_id=?`).run(id);
  return setPosted('sales_orders', id, userId);
}

// ---------------- Delivery Order + Surat Jalan (§28) — stock OUT + warranty ----------------
function postDeliveryOrder(id, userId) {
  const d = doc('delivery_orders', id);
  if (d.status !== 'APPROVED') throw new Error('Only APPROVED delivery orders can be posted');
  const lines = db.prepare(`SELECT dol.*, p.serial_policy, p.warranty_months, p.name pname
                            FROM delivery_order_lines dol JOIN products p ON p.id=dol.product_id
                            WHERE dol.delivery_order_id=?`).all(id);
  const mvType = DO_MOVE[d.purpose] || 'ADJUSTMENT';
  let so = d.sales_order_id ? doc('sales_orders', d.sales_order_id) : null;
  for (const l of lines) {
    // stock OUT with negative-stock guard inside engine (§20/§55)
    moveStock({ productId: l.product_id, warehouseId: d.warehouse_id, qtyDelta: -l.qty,
                type: mvType, refTable: 'delivery_orders', refId: id, refNo: d.doc_no, userId });
    // consume reservation: reserved decreases with the goods leaving
    db.prepare(`UPDATE inventory_balances SET reserved = MAX(0, reserved - ?)
                WHERE product_id=? AND warehouse_id=?`).run(l.qty, l.product_id, d.warehouse_id);
    if (so && l.sales_order_line_id) {
      db.prepare(`UPDATE sales_order_lines SET delivered_qty = delivered_qty + ?, reserved_qty = MAX(0, reserved_qty - ?)
                  WHERE id=?`).run(l.qty, l.qty, l.sales_order_line_id);
    }
    // Serial Number Engine handoff to customer (§5)
    if (l.serial_id) {
      const sn = db.prepare(`SELECT * FROM serial_numbers WHERE id=?`).get(l.serial_id);
      if (!sn) throw new Error(`Serial #${l.serial_id} not found`);
      if (!['IN_STOCK', 'RESERVED'].includes(sn.status)) throw new Error(`SN ${sn.serial} not deliverable (${sn.status})`);
      const holder = so ? so.customer_id : (d.project_id ? doc('projects', d.project_id).customer_id : null);
      db.prepare(`UPDATE serial_numbers SET status='SOLD_DELIVERED', current_warehouse_id=NULL,
                  current_partner_id=? WHERE id=?`).run(holder, l.serial_id);
    }
    // Warranty Engine (§29): certificate per delivered line with warranty period
    if ((so || d.project_id) && l.warranty_months > 0) {
      const customer = so ? so.customer_id :
        doc('projects', d.project_id).customer_id;
      birthWarranty({ customerId: customer, productId: l.product_id, serialId: l.serial_id,
        sourceType: d.purpose === 'PROJECT' ? 'PROJECT_DELIVERY' : 'RETAIL_SALES',
        sourceDocNo: d.surat_jalan_no || d.doc_no, purchaseDate: d.do_date,
        deliveryDate: d.do_date, months: l.warranty_months });
    }
  }
  return setPosted('delivery_orders', id, userId);
}

const POSTERS = { receivings: postReceiving, sales_orders: postSalesOrder, delivery_orders: postDeliveryOrder,
                  stock_transfers: postStockTransfer };

// ---------------- Stock Transfer (§21) — TRANSFER_OUT at source, TRANSFER_IN at destination ----------------
function postStockTransfer(id, userId) {
  const t = doc('stock_transfers', id);
  if (t.status !== 'APPROVED') throw new Error('Only APPROVED transfers can be posted');
  if (t.from_warehouse_id === t.to_warehouse_id) throw new Error('Transfer source and destination must differ');
  const lines = db.prepare(`SELECT tl.*, p.serial_policy, p.code pcode FROM stock_transfer_lines tl
    JOIN products p ON p.id=tl.product_id WHERE tl.stock_transfer_id=?`).all(id);
  for (const l of lines) {
    // OUT leg at source
    moveStock({ productId: l.product_id, warehouseId: t.from_warehouse_id, qtyDelta: -l.qty,
                type: 'TRANSFER_OUT', refTable: 'stock_transfers', refId: id, refNo: t.doc_no, userId });
    // IN leg at destination (cost travels with the goods — avg_cost from source balance)
    const srcBal = db.prepare(`SELECT avg_cost FROM inventory_balances WHERE product_id=? AND warehouse_id=?`)
      .get(l.product_id, t.from_warehouse_id);
    moveStock({ productId: l.product_id, warehouseId: t.to_warehouse_id, qtyDelta: l.qty,
                type: 'TRANSFER_IN', refTable: 'stock_transfers', refId: id, refNo: t.doc_no, userId,
                avgCost: srcBal ? srcBal.avg_cost : null });
    // Serial handoff: move listed serials to destination warehouse
    for (const s of JSON.parse(l.serials || '[]')) {
      const sn = db.prepare(`SELECT * FROM serial_numbers WHERE product_id=? AND serial=?`).get(l.product_id, s);
      if (!sn) throw new Error(`${l.pcode}: serial ${s} not registered`);
      if (sn.current_warehouse_id !== t.from_warehouse_id)
        throw new Error(`${l.pcode}: serial ${s} is not in the source warehouse`);
      if (!['IN_STOCK', 'RESERVED'].includes(sn.status))
        throw new Error(`${l.pcode}: serial ${s} not transferable (${sn.status})`);
      db.prepare(`UPDATE serial_numbers SET current_warehouse_id=? WHERE id=?`).run(t.to_warehouse_id, sn.id);
    }
  }
  audit(userId, 'stock_transfers', 'STOCK_MOVED', { docNo: t.doc_no, entity: id,
    newv: `${lines.length} lines: wh#${t.from_warehouse_id} -> wh#${t.to_warehouse_id}` });
  return setPosted('stock_transfers', id, userId);
}

// Generic POST gate — approved docs only; unknown tables just get stamped (quotations etc.)
function post(table, id, userId) {
  const poster = POSTERS[table];
  if (poster) return poster(id, userId);
  const d = doc(table, id);
  if (d.status !== 'APPROVED') throw new Error('Only APPROVED documents can be posted');
  return setPosted(table, id, userId);
}

// Quotation totals (§22/§23 detail): Product Qty Unit Price Discount Tax Total
function computeLineTotal(qty, price, discPct) {
  return Math.round(qty * price * (1 - (discPct || 0) / 100) * 100) / 100;
}
function computeTotals(lines, taxCode) {
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const discount_total = lines.reduce((s, l) =>
    s + Math.round(l.qty * l.unit_price * ((l.discount_pct || 0) / 100) * 100) / 100, 0);
  const taxable = subtotal;
  const tax_amount = taxCode === 'PPN' ? Math.round(taxable * 0.11 * 100) / 100 : 0;
  return { subtotal, discount_total, tax_amount, grand_total: subtotal + tax_amount };
}

module.exports = { post, birthWarranty, computeLineTotal, computeTotals, setPosted };
