// Dashboard widgets v2 — action items, activity feed, low stock, trend, tops, aging, period sales
'use strict';
const { db } = require('./db.js');
const rows = (sql, ...p) => db.prepare(sql).all(...p);

// ---- P0: docs waiting on a human (DRAFT→SUBMITTED→APPROVED lifecycle) ----
function actionItems() {
  const defs = [
    ['quotations', 'Quotation', 'quote_date', 'grand_total'],
    ['sales_orders', 'Sales Order', 'so_date', 'grand_total'],
    ['purchase_orders', 'Purchase Order', 'po_date', 'goods_value'],
    ['receivings', 'Receiving', 'receive_date', null],
    ['stock_transfers', 'Stock Transfer', 'transfer_date', null],
  ];
  const out = [];
  for (const [table, label, dateCol, amtCol] of defs) {
    const amt = amtCol ? `, ${amtCol} amt` : ', NULL amt';
    for (const r of rows(`SELECT id, doc_no, status, ${dateCol} d${amt}
        FROM ${table} WHERE status IN ('DRAFT','SUBMITTED','APPROVED')
        ORDER BY id DESC LIMIT 50`))
      out.push({ table, label, id: r.id, doc_no: r.doc_no, status: r.status, date: r.d, amount: r.amt });
  }
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 12);
}

// ---- P0: recent activity feed from audit trail ----
function activity(limit) {
  return rows(`SELECT a.at, a.module, a.doc_no, a.action, a.new_value, u.username
    FROM audit_trail a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?`, limit || 10);
}

// ---- P1: low stock watchlist ----
function lowStock(limit) {
  return rows(`SELECT p.id, p.code, p.name, p.brand, w.name wh_name,
      (ib.physical - ib.reserved) available, p.reorder_point
    FROM inventory_balances ib JOIN products p ON p.id = ib.product_id
    JOIN warehouses w ON w.id = ib.warehouse_id
    WHERE p.reorder_point > 0 AND (ib.physical - ib.reserved) <= p.reorder_point
    ORDER BY (ib.physical - ib.reserved) ASC LIMIT ?`, limit || 8);
}

// ---- P1: 12-month posted-sales trend (gaps filled with zeros) ----
function trend() {
  const raw = rows(`SELECT strftime('%Y-%m', so_date) ym, SUM(grand_total) s, COUNT(*) c
    FROM sales_orders WHERE status = 'POSTED'
      AND so_date >= date('now', '-11 months', 'start of month')
    GROUP BY ym ORDER BY ym`);
  const map = Object.fromEntries(raw.map(r => [r.ym, r]));
  const out = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const r = map[ym] || {};
    out.push({ ym, label: d.toLocaleString('en', { month: 'short' }), sales: r.s || 0, orders: r.c || 0 });
  }
  return out;
}

// ---- P1: top products / customers from posted SOs since a date ----
function periodStart(period) {
  const now = new Date();
  if (period === 'month') return now.toISOString().slice(0, 7) + '-01';
  if (period === 'quarter') { const q = Math.floor(now.getMonth() / 3) * 3;
    return now.getFullYear() + '-' + String(q + 1).padStart(2, '0') + '-01'; }
  if (period === '30d') return new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10);
  return now.getFullYear() + '-01-01'; // ytd (default)
}
function topProducts(period) {
  // Primary: posted SO line items (normal ERP flow).
  const fromLines = rows(`SELECT p.id, p.code, p.name, SUM(l.qty) qty, SUM(l.line_total) revenue
    FROM sales_order_lines l JOIN sales_orders o ON o.id = l.sales_order_id
    JOIN products p ON p.id = l.product_id
    WHERE o.status = 'POSTED' AND o.so_date >= ?
    GROUP BY p.id ORDER BY revenue DESC LIMIT 5`, periodStart(period));
  if (fromLines.length) return fromLines;
  // Fallback: historical ASJ SOs were imported as totals with NO line items, so
  // derive top movers from shipped DO lines (they carry product + qty) instead of
  // showing the misleading "no posted sales yet".
  return rows(`SELECT p.id, p.code, p.name, SUM(dl.qty) qty, 0 revenue
    FROM delivery_order_lines dl
    JOIN delivery_orders d ON d.id = dl.delivery_order_id
    JOIN sales_orders o ON o.id = d.sales_order_id
    JOIN products p ON p.id = dl.product_id
    WHERE o.status = 'POSTED' AND d.do_date >= ?
    GROUP BY p.id ORDER BY qty DESC LIMIT 5`, periodStart(period));
}
function topCustomers(period) {
  return rows(`SELECT bp.id, bp.name, COUNT(*) orders, SUM(o.grand_total) revenue
    FROM sales_orders o JOIN business_partners bp ON bp.id = o.customer_id
    WHERE o.status = 'POSTED' AND o.so_date >= ?
    GROUP BY bp.id ORDER BY revenue DESC LIMIT 5`, periodStart(period));
}
function salesByPeriod(period) {
  const from = periodStart(period);
  return rows(`SELECT COALESCE(SUM(grand_total),0) s, COUNT(*) c,
    COALESCE(SUM(CASE WHEN sales_type='RETAIL' THEN grand_total ELSE 0 END),0) retail,
    COALESCE(SUM(CASE WHEN sales_type='PROJECT' THEN grand_total ELSE 0 END),0) project,
    COALESCE(SUM(CASE WHEN tax_code='PPN' THEN grand_total ELSE 0 END),0) ppn
    FROM sales_orders WHERE status = 'POSTED' AND so_date >= ?`, from)[0];
}

// ---- KPI evolution vs the previous comparable period (dashboard v3) ----
function prevPeriodStart(period) {
  const now = new Date();
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  if (period === 'quarter') {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return new Date(now.getFullYear(), q - 3, 1).toISOString().slice(0, 10);
  }
  if (period === '30d') return new Date(now.getTime() - 60 * 864e5).toISOString().slice(0, 10);
  return (now.getFullYear() - 1) + '-01-01';
}
function salesComparison(period) {
  const from = periodStart(period), pfrom = prevPeriodStart(period);
  const prev = rows(`SELECT COALESCE(SUM(grand_total),0) s, COUNT(*) c
    FROM sales_orders WHERE status='POSTED' AND so_date >= ? AND so_date < ?`, pfrom, from)[0];
  const cur = salesByPeriod(period);
  const delta = prev.s > 0
    ? Math.round((cur.s - prev.s) / prev.s * 1000) / 10
    : (cur.s > 0 ? 100 : 0);
  return { cur: cur.s, prev: prev.s, prev_orders: prev.c, delta_pct: delta };
}

// ---- P2: project billing aging buckets (days past due) ----
function billingAging() {
  const buckets = [{ k: 'cur', label: 'Not due', min: -99999, max: 0 },
    { k: 'd30', label: '1–30 days', min: 1, max: 30 },
    { k: 'd60', label: '31–60 days', min: 31, max: 60 },
    { k: 'd90', label: '60+ days', min: 61, max: 99999 }];
  const res = { total: 0, buckets: {} };
  for (const r of rows(`SELECT b.amount, b.paid_amount, b.due_date
      FROM project_billings b JOIN projects p ON p.id = b.project_id
      WHERE b.status IN ('PLANNED','INVOICED','PARTIAL') AND p.status NOT IN ('CLOSED','CANCELLED')`)) {
    const amt = (r.amount || 0) - (r.paid_amount || 0);
    if (amt <= 0) continue;
    res.total += amt;
    const days = r.due_date
      ? Math.floor((Date.now() - new Date(r.due_date).getTime()) / 864e5)
      : -99999;
    const b = buckets.find(x => days >= x.min && days <= x.max);
    res.buckets[b.k] = (res.buckets[b.k] || 0) + amt;
  }
  res.buckets = buckets.map(x => ({ k: x.k, label: x.label, amount: res.buckets[x.k] || 0 }));
  return res;
}
module.exports = { actionItems, activity, lowStock, trend, topProducts, topCustomers, salesByPeriod, salesComparison, billingAging, periodStart };

