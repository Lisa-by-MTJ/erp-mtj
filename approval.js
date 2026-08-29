// §11 Approval Engine — DRAFT -> SUBMITTED -> APPROVED -> POSTED(LOCKED); REJECT returns to DRAFT
'use strict';
const { db, audit } = require('./db.js');

const PREFIX = { purchase_requests: 'PR', purchase_orders: 'PO', receivings: 'GRN',
                 quotations: 'QT', sales_orders: 'SO', delivery_orders: 'DO',
                 stock_transfers: 'TRF' };

function doc(table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!row) throw new Error(`${table} #${id} not found`);
  return row;
}

function ensureLines(table, id) {
  const lc = { purchase_requests: 'purchase_request_lines', purchase_orders: 'purchase_order_lines',
               receivings: 'receiving_lines', quotations: 'quotation_lines', sales_orders: 'sales_order_lines',
               delivery_orders: 'delivery_order_lines', stock_transfers: 'stock_transfer_lines' }[table];
  if (!lc) return;
  const n = db.prepare(`SELECT COUNT(*) n FROM ${lc} WHERE ${table === 'stock_transfers' ? 'stock_transfer' : singular(table)}_id=?`).get(id).n;
  if (n === 0) throw new Error('Document has no lines');
}

function singular(table) {
  return table.replace(/s$/, '').replace(/_/, '_'); // purchase_requests -> purchase_request
}

function transition(table, id, action, userId) {
  const d = doc(table, id);
  switch (action) {
    case 'submit': {
      if (d.status !== 'DRAFT') throw new Error(`Cannot submit from ${d.status}`);
      ensureLines(table, id);
      if (table === 'receivings') {
        if (!d.purchase_order_id) throw new Error('Receiving requires a PO reference (§15)');
        const po = doc('purchase_orders', d.purchase_order_id);
        if (!['APPROVED', 'POSTED'].includes(po.status)) throw new Error('PO must be approved/posted before receiving (§13)');
      }
      if (table === 'stock_transfers') {
        if (d.from_warehouse_id === d.to_warehouse_id) throw new Error('Transfer source and destination must differ');
        const dups = db.prepare(`SELECT product_id, COUNT(*) n FROM stock_transfer_lines
          WHERE stock_transfer_id=? GROUP BY product_id HAVING n>1`).all(id);
        if (dups.length) throw new Error('Duplicate product on transfer lines — merge into one line');
      }
      db.prepare(`UPDATE ${table} SET status='SUBMITTED', updated_at=datetime('now') WHERE id=?`).run(id);
      audit(userId, table, 'SUBMIT', { docNo: d.doc_no, entity: id });
      break;
    }
    case 'approve': {
      if (d.status !== 'SUBMITTED') throw new Error(`Cannot approve from ${d.status}`);
      db.prepare(`UPDATE ${table} SET status='APPROVED', approved_by=?, updated_at=datetime('now') WHERE id=?`).run(userId, id);
      audit(userId, table, 'APPROVE', { docNo: d.doc_no, entity: id, approvalRef: (PREFIX[table] || 'DOC') + '-approval' });
      // POs materialize on approval (§13 flow: Approval → receiving happens against a live PO)
      if (table === 'purchase_orders') require('./posting.js').post(table, id, userId);
      break;
    }
    case 'reject': {
      if (d.status !== 'SUBMITTED') throw new Error(`Cannot reject from ${d.status}`);
      db.prepare(`UPDATE ${table} SET status='DRAFT', updated_at=datetime('now') WHERE id=?`).run(id);
      audit(userId, table, 'REJECT', { docNo: d.doc_no, entity: id });
      break;
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
  return doc(table, id);
}

module.exports = { transition, doc };
