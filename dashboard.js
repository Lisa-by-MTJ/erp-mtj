// §47 Management Dashboard aggregation
'use strict';
const { db } = require('./db.js');
const one = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r || {}; };
const sum = (sql, ...p) => one(sql, ...p).s || 0;
const cnt = (sql, ...p) => one(sql, ...p).c || 0;

function snapshot() {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const yrStart = new Date().getFullYear() + '-01-01';
  const postedSales = (from, type, tax) => {
    let q = `SELECT COALESCE(SUM(grand_total),0) s, COUNT(*) c FROM sales_orders WHERE status='POSTED' AND so_date>=?`;
    const v = [from];
    if (type) { q += ` AND sales_type=?`; v.push(type); }
    if (tax) { q += ` AND tax_code=?`; v.push(tax); }
    return one(q, ...v);
  };
  const m = postedSales(monthStart);
  return {
    sales_this_month: m.s, sales_count_month: m.c,
    sales_this_year: postedSales(yrStart).s,
    retail_sales: sum(`SELECT COALESCE(SUM(grand_total),0) s FROM sales_orders WHERE status='POSTED' AND sales_type='RETAIL' AND so_date>=?`, yrStart),
    project_sales: sum(`SELECT COALESCE(SUM(grand_total),0) s FROM sales_orders WHERE status='POSTED' AND sales_type='PROJECT' AND so_date>=?`, yrStart),
    ppn_sales: sum(`SELECT COALESCE(SUM(grand_total),0) s FROM sales_orders WHERE status='POSTED' AND tax_code='PPN' AND so_date>=?`, yrStart),
    non_ppn_sales: sum(`SELECT COALESCE(SUM(grand_total),0) s FROM sales_orders WHERE status='POSTED' AND tax_code!='PPN' AND so_date>=?`, yrStart),
    contract_value_active: sum(`SELECT COALESCE(SUM(contract_value),0) s FROM projects WHERE status IN ('CONTRACTED','IN_PROGRESS','DELIVERED','BILLING')`),
    billed: sum(`SELECT COALESCE(SUM(b.amount),0) s FROM project_billings b JOIN projects p ON p.id=b.project_id WHERE b.status IN ('INVOICED','PARTIAL','PAID') AND p.status!='CANCELLED'`),
    outstanding_billing: sum(`SELECT COALESCE(SUM(b.amount-b.paid_amount),0) s FROM project_billings b JOIN projects p ON p.id=b.project_id WHERE b.status IN ('PLANNED','INVOICED','PARTIAL') AND p.status NOT IN ('CLOSED','CANCELLED')`),
    stock_value: sum(`SELECT COALESCE(SUM(physical*avg_cost),0) s FROM inventory_balances`),
    reserved_stock: sum(`SELECT COALESCE(SUM(reserved),0) s FROM inventory_balances`),
    available_stock: sum(`SELECT COALESCE(SUM(physical-reserved),0) s FROM inventory_balances`),
    low_stock: cnt(`SELECT COUNT(*) c FROM inventory_balances ib JOIN products p ON p.id=ib.product_id WHERE (ib.physical-ib.reserved)<=p.reorder_point AND p.reorder_point>0`),
    purchase_value: sum(`SELECT COALESCE(SUM(goods_value+freight+insurance+duty_customs+forwarder+handling+port_charges+bank_charges+other_cost),0) s FROM purchase_orders WHERE status IN ('APPROVED','POSTED')`),
    local_purchase: sum(`SELECT COALESCE(SUM(goods_value),0) s FROM purchase_orders WHERE po_type='LOCAL_PURCHASE' AND status IN ('APPROVED','POSTED')`),
    import_purchase: sum(`SELECT COALESCE(SUM(goods_value),0) s FROM purchase_orders WHERE po_type='IMPORT_PURCHASE' AND status IN ('APPROVED','POSTED')`),
    open_service: cnt(`SELECT COUNT(*) c FROM service_orders WHERE status NOT IN ('CLOSED','DELIVERED','COMPLETED')`),
    completed_service: cnt(`SELECT COUNT(*) c FROM service_orders WHERE status IN ('COMPLETED','DELIVERED','CLOSED')`),
    active_warranty: cnt(`SELECT COUNT(*) c FROM warranties WHERE status='ACTIVE' AND warranty_end>=date('now')`),
    warranty_claims: cnt(`SELECT COUNT(*) c FROM warranty_claims WHERE status NOT IN ('CLOSED','REJECTED')`),
    open_work_orders: cnt(`SELECT COUNT(*) c FROM work_orders WHERE status NOT IN ('POSTED','REJECTED')`),
    active_projects: cnt(`SELECT COUNT(*) c FROM projects WHERE status IN ('CONTRACTED','IN_PROGRESS','DELIVERED','BILLING')`)
  };
}

function profitability() {
  return rows_safe(`
    SELECT p.id, p.project_code, p.name, p.contract_value revenue,
      COALESCE((SELECT SUM(amount) FROM project_costs pc WHERE pc.project_id=p.id),0) cost,
      p.status
    FROM projects p WHERE p.status != 'CANCELLED' ORDER BY p.id DESC LIMIT 50`);
}
function rows_safe(sql) { return db.prepare(sql).all(); }

module.exports = { snapshot, profitability, rows_safe };
