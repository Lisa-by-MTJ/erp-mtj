// Demo business cycle through the live ERP API (local port, same handlers as public)
'use strict';
const base = 'http://127.0.0.1:9121/api';
const auth = 'Basic ' + Buffer.from(`${process.env.MTJ_USER || 'mtj'}:${process.env.MTJ_PASS || ''}`).toString('base64');
async function call(path, method = 'GET', bodyObj) {
  const r = await fetch(base + path, { method, headers: {
    Authorization: auth, 'Content-Type': 'application/json' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(path + ' -> ' + JSON.stringify(j));
  return j;
}
async function wf(table, id) {
  await call(`/docs/${table}/${id}/submit`, 'POST');
  const d = await call(`/docs/${table}/${id}/approve`, 'POST');
  if (d.status !== 'POSTED') await call(`/docs/${table}/${id}/post`, 'POST');
}
(async () => {
  // PO: 5 moving heads
  const po = await call('/purchase-orders', 'POST', { supplier_id: 4, po_type: 'LOCAL_PURCHASE',
    warehouse_id: 1, lines: [{ product_id: 1, qty: 5, unit_price: 18500000 }] });
  await wf('purchase_orders', po.id);
  console.log('PO posted:', po.doc_no);
  // GRN with 5 serials
  const grn = await call('/receivings', 'POST', { purchase_order_id: po.id, warehouse_id: 1,
    receiving_type: 'LOCAL_PURCHASE',
    lines: [{ product_id: 1, qty: 5, unit_cost: 18500000,
      serials: Array.from({ length: 5 }, (_, i) => 'AZT' + String(Date.now()).slice(-7) + '-' + (i + 1)) }] });
  await wf('receivings', grn.id);
  console.log('GRN posted:', grn.doc_no);
  // Retail SO: Mirror Club buys 2 units
  const so = await call('/sales-orders', 'POST', { customer_id: 2, sales_type: 'RETAIL',
    warehouse_id: 1, tax_code: 'PPN',
    lines: [{ product_id: 1, qty: 2, unit_price: 28500000 }] });
  await wf('sales_orders', so.id);
  console.log('SO posted:', so.doc_no);
  // DO + Surat Jalan delivering 1 unit by serial
  const snRow = await call('/serials/1/trail').catch(() => null); void snRow;
  const doDoc = await call('/delivery-orders', 'POST', { sales_order_id: so.id, purpose: 'SALES',
    warehouse_id: 1, recipient_name: 'Mirror Club store',
    lines: [{ product_id: 1, serial_id: null, qty: 2 }] }); // engine picks stock; SN listed below
  await wf('delivery_orders', doDoc.id);
  console.log('DO+SJ posted:', doDoc.doc_no, '/', doDoc.surat_jalan_no);
  // Stock + dashboard after the cycle
  const stock = await call('/stock/1');
  console.log('MH350 stock now:', JSON.stringify(stock));
  const dash = await call('/dashboard');
  console.log('Dashboard: sales_this_month=', dash.sales_this_month,
              '| active_warranty=', dash.active_warranty,
              '| reserved=', dash.reserved_stock);
})().catch(e => { console.error('CYCLE ERROR:', e.message); process.exit(1); });
