// MTJ Channel Manager — SPA logic
'use strict';
const $ = s => document.querySelector(s);
const main = $('#main');
const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.style.borderColor = err ? '#f87171' : '#2dd4bf'; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 4200);
}
const badge = s => `<span class="badge b-${String(s).replace(/\s/g,'_')}">${String(s).replace(/_/g,' ')}</span>`;
const opt = (list, valKey, lbl) => list.map(x => `<option value="${x[valKey]}">${lbl(x)}</option>`).join('');

let PRODUCTS = [], PARTNERS = [], WAREHOUSES = [], PROJECTS = [];

// ---------------- views ----------------
const views = {};

views.dash = async () => {
  const d = await api('/dashboard');
  const kpi = (l, v, cls) => `<div class="kpi"><div class="lbl">${l}</div><div class="val ${cls||''}">${v}</div></div>`;
  main.innerHTML = `
  <h1>Management Dashboard</h1><div class="sub">§47 — one screen: sales, stock, projects, warranty, service, KPI</div>
  <h2>Sales</h2><div class="grid">
    ${kpi('Sales This Month', fmt(d.sales_this_month), 'teal')}
    ${kpi('Sales This Year', fmt(d.sales_this_year), 'teal')}
    ${kpi('Retail Sales (Yr)', fmt(d.retail_sales))}
    ${kpi('Project Sales (Yr)', fmt(d.project_sales))}
    ${kpi('PPN Sales (Yr)', fmt(d.ppn_sales))}
    ${kpi('Non-PPN Sales (Yr)', fmt(d.non_ppn_sales))}
    ${kpi('Outstanding Project Billing', fmt(d.outstanding_billing), 'amber')}
  </div>
  <h2>Stock</h2><div class="grid">
    ${kpi('Stock Value (avg cost)', fmt(d.stock_value))}
    ${kpi('Reserved Stock', d.reserved_stock)}
    ${kpi('Available Stock', d.available_stock)}
    ${kpi('Low Stock Items', d.low_stock, d.low_stock > 0 ? 'amber' : '')}
  </div>
  <h2>Purchasing</h2><div class="grid">
    ${kpi('Purchase Value', fmt(d.purchase_value))}
    ${kpi('Local Purchase', fmt(d.local_purchase))}
    ${kpi('Import Purchase', fmt(d.import_purchase))}
  </div>
  <h2>Service · Warranty · Field</h2><div class="grid">
    ${kpi('Open Service', d.open_service)}
    ${kpi('Completed Service', d.completed_service)}
    ${kpi('Active Warranty', d.active_warranty)}
    ${kpi('Warranty Claims', d.warranty_claims)}
    ${kpi('Open Work Orders', d.open_work_orders)}
    ${kpi('Active Projects', d.active_projects)}
  </div>`;
};

views.stock = async () => {
  const rows = await api('/stock');
  main.innerHTML = `<h1>Stock &amp; Inventory</h1>
  <div class="sub">§18 Available = Physical − Reserved · §20 every change is a stock movement</div>
  <table><tr><th>Code</th><th>Product</th><th>Warehouse</th><th class="money">Physical</th>
  <th class="money">Reserved</th><th class="money">Available</th><th class="money">Value</th></tr>
  ${rows.map(r => `<tr><td>${r.code}</td><td>${r.name} <span class="mut">${r.brand||''}</span></td><td>${r.wh_name}</td>
    <td class="money">${r.physical}</td><td class="money">${r.reserved}</td>
    <td class="money"><b style="color:${r.available<=0?'#f87171':'#4ade80'}">${r.available}</b></td>
    <td class="money">${fmt(r.stock_value)}</td></tr>`).join('')}</table>
  <h2>Recent Movements (§20)</h2>
  <table><tr><th>ID</th><th>Type</th><th>Product</th><th>Wh</th><th class="money">ΔQty</th><th>Ref</th></tr>
  ${(await api('/movements')).slice(0,15).map(m => `<tr><td>${m.id}</td><td>${m.movement_type}</td>
    <td>${m.pcode}</td><td>${m.wh_name}</td><td class="money" style="color:${m.qty_delta<0?'#f87171':'#4ade80'}">${m.qty_delta}</td>
    <td class="mut">${m.ref_no||''}</td></tr>`).join('')}</table>`;
};

views.docs = async () => {
  const kinds = [['purchase_orders','Purchase Orders'],['receivings','Warehouse Receiving'],
                 ['quotations','Quotations'],['sales_orders','Sales Orders']];
  let html = `<h1>Purchase &amp; Sales Documents</h1><div class="sub">§11 lifecycle: DRAFT → SUBMITTED → APPROVED → POSTED (locked)</div>`;
  for (const [t, label] of kinds) {
    const list = await api('/docs/' + t);
    html += `<h2>${label}</h2><table><tr><th>Doc No</th><th>Partner</th><th>Date</th>
      <th class="money">Total</th><th>Status</th><th>Actions</th></tr>` +
      list.slice(0, 12).map(d => `<tr><td><b>${d.doc_no}</b></td><td>${d.partner_name||'—'}</td><td>${d.po_date||d.receive_date||d.quote_date||d.so_date||''}</td>
        <td class="money">${fmt(d.grand_total || d.goods_value)}</td><td>${badge(d.status)}</td>
        <td>${wfBtns(t, d)}</td></tr>`).join('') + '</table>';
  }
  main.innerHTML = html;
};
const wfBtns = (t, d) => ['SUBMITTED','DRAFT','APPROVED'].filter(s => d.status === s).map(s =>
  ({ DRAFT: `<button class="btn sm gray" onclick="act('${t}',${d.id},'submit')">Submit</button>`,
     SUBMITTED: `<button class="btn sm" onclick="act('${t}',${d.id},'approve')">Approve</button>
       <button class="btn sm warn" onclick="act('${t}',${d.id},'reject')">Reject</button>`,
     APPROVED: `<button class="btn sm" onclick="act('${t}',${d.id},'post')">Post</button>` }[s])
).join('');
window.act = async (t, id, action) => {
  try { const r = await api(`/docs/${t}/${id}/${action}`, { method: 'POST' });
    toast(`${r.doc_no} → ${action.toUpperCase()} OK`); go(current); }
  catch (e) { toast(e.message, true); }
};

views.newdoc = async () => {
  if (!PRODUCTS.length) {
    PRODUCTS = await api('/products'); PARTNERS = await api('/partners');
    WAREHOUSES = await api('/warehouses'); PROJECTS = await api('/projects');
  }
  const cOpts = opt(PARTNERS.filter(p => p.kind === 'CUSTOMER'), 'id', p => p.name);
  const sOpts = opt(PARTNERS.filter(p => p.kind === 'SUPPLIER'), 'id', p => p.name);
  const wOpts = opt(WAREHOUSES, 'id', w => w.name);
  const pOpts = PRODUCTS.map(p => `<option value="${p.id}" data-price="${p.retail_price}">${p.code} — ${p.name}</option>`).join('');
  main.innerHTML = `
  <h1>New Document</h1><div class="sub">Create Quotation / Sales Order / Purchase Order / Receiving</div>
  <div class="formbox"><h2 style="margin-top:0">Quotation or Sales Order</h2>
   <div class="row">
    <div style="flex:2"><label>Customer</label><select id="nd-cust">${cOpts}</select></div>
    <div><label>Type</label><select id="nd-kind"><option value="QT">Quotation</option><option value="SO">Sales Order</option></select></div>
    <div><label>Tax</label><select id="nd-tax"><option>PPN</option><option>NON_PPN</option></select></div>
    <div style="flex:1"><label>Warehouse (SO)</label><select id="nd-wh">${wOpts}</select></div>
    <div style="align-self:flex-end"><button class="btn" onclick="mkSale()">Create</button></div>
   </div>
   <table id="nd-lines"></table>
   <button class="btn gray sm" onclick="addLine()">+ Add line</button>
   <div id="nd-total" class="mut" style="margin-top:8px"></div>
  </div>
  <div class="formbox"><h2 style="margin-top:0">Purchase Order</h2>
   <div class="row">
    <div style="flex:2"><label>Supplier</label><select id="po-sup">${sOpts}</select></div>
    <div><label>Type</label><select id="po-type"><option>LOCAL_PURCHASE</option><option>IMPORT_PURCHASE</option></select></div>
    <div style="flex:1"><label>Destination WH</label><select id="po-wh">${wOpts}</select></div>
    <div style="align-self:flex-end"><button class="btn" onclick="mkPO()">Create PO (first line below)</button></div>
   </div>
  </div>
  <div class="formbox"><h2 style="margin-top:0">Warehouse Receiving (§15)</h2>
   <div class="row">
    <div><label>Against PO id</label><input id="rc-po" placeholder="PO id"></div>
    <div style="flex:1"><label>WH</label><select id="rc-wh">${wOpts}</select></div>
    <div style="align-self:flex-end"><button class="btn" onclick="mkRCV()">Create GRN (first line below)</button></div>
   </div>
  </div>`;
  window.ndLines = [];
  addLine();
};
function lineRow(i) {
  return `<tr><td style="width:45%"><select onchange="ndLines[${i}].pid=+this.value;updTotal()" id="nl-p${i}">
    ${PRODUCTS.map(p => `<option value="${p.id}" data-rl="${p.retail_price}">${p.code} — ${p.name}</option>`).join('')}</select></td>
    <td><input type="number" id="nl-q${i}" value="1" min="1" oninput="ndLines[${i}].qty=+this.value;updTotal()"></td>
    <td><input type="number" id="nl-pr${i}" value="${PRODUCTS[0] ? PRODUCTS[0].retail_price : 0}" oninput="ndLines[${i}].price=+this.value;updTotal()"></td>
    <td><input type="number" id="nl-d${i}" value="0" min="0" max="100" oninput="ndLines[${i}].disc=+this.value;updTotal()"></td></tr>`;
}
window.addLine = () => {
  const i = window.ndLines.length;
  window.ndLines.push({ pid: PRODUCTS[0] ? PRODUCTS[0].id : null, qty: 1,
    price: PRODUCTS[0] ? PRODUCTS[0].retail_price : 0, disc: 0 });
  $('#nd-lines').insertAdjacentHTML('beforeend', lineRow(i));
  $('#nd-lines').previousElementSibling === null && $('#nd-lines').insertAdjacentHTML('beforebegin',
    '<tr><th style="width:45%">Product</th><th>Qty</th><th>Unit Price</th><th>Disc %</th></tr>');
};
window.updTotal = () => {
  const t = window.ndLines.reduce((s, l) => s + l.qty * l.price * (1 - l.disc / 100), 0);
  $('#nd-total').textContent = 'Subtotal: ' + fmt(t) + (t > 0 ? '  ·  PPN 11%: ' + fmt(t * 0.11) + '  ·  Grand: ' + fmt(t * 1.11) : '');
};
window.mkSale = async () => {
  const kind = $('#nd-kind').value;
  const payload = {
    customer_id: +$('#nd-cust').value, tax_code: $('#nd-tax').value,
    warehouse_id: +$('#nd-wh').value,
    lines: window.ndLines.map(l => ({ product_id: l.pid, qty: l.qty, unit_price: l.price, discount_pct: l.disc })),
  };
  try {
    const r = await api(kind === 'QT' ? '/quotations' : '/sales-orders', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    toast(`Created ${r.doc_no}`); go('docs');
  } catch (e) { toast(e.message, true); }
};
window.mkPO = async () => {
  const payload = { supplier_id: +$('#nd-sup').value || +$('#po-sup').value,
    po_type: $('#po-type').value, warehouse_id: +$('#po-wh').value,
    lines: window.ndLines.map(l => ({ product_id: l.pid, qty: l.qty, unit_price: l.price })) };
  try {
    const r = await api('/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    toast(`Created ${r.doc_no}`); go('docs');
  } catch (e) { toast(e.message, true); }
};
window.mkRCV = async () => {
  const payload = { purchase_order_id: +$('#rc-po').value || null, warehouse_id: +$('#rc-wh').value,
    receiving_type: $('#rc-po').value ? 'LOCAL_PURCHASE' : 'OTHER',
    lines: window.ndLines.map(l => ({ product_id: l.pid, qty: l.qty, unit_cost: l.price, serials: [] })) };
  try {
    const r = await api('/receivings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    toast(`Created ${r.doc_no} — submit/approve/post to move stock`);
    go('docs');
  } catch (e) { toast(e.message, true); }
};

views.projects = async () => {
  const list = await api('/projects');
  main.innerHTML = `<h1>Projects</h1><div class="sub">§24-§27 · billing ≠ delivery · Control Tower per project</div>
  <table><tr><th>Code</th><th>Project</th><th>Customer</th><th class="money">Contract</th>
  <th class="money">Billed</th><th class="money">Outstanding</th><th class="money">Cost</th><th>Status</th><th></th></tr>
  ${list.map(p => `<tr><td><b>${p.project_code}</b></td><td>${p.name}</td><td>${p.customer_name}</td>
   <td class="money">${fmt(p.contract_value)}</td><td class="money">${fmt(p.billing_total)}</td>
   <td class="money" style="color:${p.outstanding>0?'#f59e0b':'#4ade80'}">${fmt(p.outstanding)}</td>
   <td class="money">${fmt(p.cost_total)}</td><td>${badge(p.status)}</td>
   <td><button class="btn sm gray" onclick="tower(${p.id})">Tower</button></td></tr>`).join('')}</table>`;
};
window.tower = async id => {
  const t = await api('/projects/' + id);
  const p = t.project;
  main.innerHTML = `<h1>🔦 Project Control Tower — ${p.project_code}</h1>
  <div class="sub">${p.name} · ${p.customer_name} · site: ${p.site_location||'—'}</div>
  <div class="grid">
    <div class="kpi"><div class="lbl">Contract Value</div><div class="val teal">${fmt(p.contract_value)}</div></div>
    <div class="kpi"><div class="lbl">Billed</div><div class="val">${fmt(t.billings.reduce((s,b)=>s+b.amount,0))}</div></div>
    <div class="kpi"><div class="lbl">Paid In</div><div class="val">${fmt(t.billings.reduce((s,b)=>s+(b.paid_amount||0),0))}</div></div>
    <div class="kpi"><div class="lbl">Cost (§35)</div><div class="val amber">${fmt(t.costs.reduce((s,c)=>s+c.amount,0))}</div></div>
  </div>
  <h2>Billing Milestones (§25)</h2>
  <table><tr><th>#</th><th>Milestone</th><th class="money">Amount</th><th>Status</th><th>Action</th></tr>
  ${t.billings.map(b => `<tr><td>${b.seq}</td><td>${b.label} (${b.percent}%)</td><td class="money">${fmt(b.amount)}</td>
   <td>${badge(b.status)}</td><td>${b.status!=='PAID'?`<button class="btn sm" onclick="payBill(${p.id},${b.id})">Mark Paid</button>`:''}</td></tr>`).join('')}</table>
  <h2>Deliveries / Surat Jalan</h2>
  <table><tr><th>DO</th><th>Surat Jalan</th><th>Date</th><th>Status</th></tr>
  ${t.deliveries.map(d => `<tr><td>${d.doc_no}</td><td>${d.surat_jalan_no}</td><td>${d.do_date}</td><td>${badge(d.status)}</td></tr>`).join('') || '<tr><td colspan=4 class=mut>none yet</td></tr>'}</table>
  <button class="btn gray" onclick="go('projects')" style="margin-top:14px">← Back</button>`;
};
window.payBill = async (pid, bid) => {
  try { await api(`/projects/${pid}/billings/${bid}/pay`, { method: 'POST' }); toast('Billing paid'); tower(pid); }
  catch (e) { toast(e.message, true); }
};
views.profit = async () => {
  const list = await api('/profitability');
  main.innerHTML = `<h1>Project Profitability (§35)</h1>
  <div class="sub">Gross Profit = Revenue − Project Cost · Margin = GP ÷ Revenue × 100%</div>
  <table><tr><th>Project</th><th class="money">Revenue</th><th class="money">Cost</th>
  <th class="money">Gross Profit</th><th class="money">Margin %</th><th>Status</th></tr>
  ${list.map(r => { const neg = r.gross_profit < 0;
    return `<tr><td><b>${r.project_code}</b> ${r.name}</td><td class="money">${fmt(r.revenue)}</td>
    <td class="money">${fmt(r.cost)}</td><td class="money" style="color:${neg?'#f87171':'#4ade80'}">${fmt(r.gross_profit)}</td>
    <td class="money">${r.gross_margin_pct}%</td><td>${badge(r.status)}</td></tr>`; }).join('')}</table>`;
};
views.delivery = async () => {
  if (!WAREHOUSES.length) { PRODUCTS = await api('/products'); PARTNERS = await api('/partners'); WAREHOUSES = await api('/warehouses'); PROJECTS = await api('/projects'); }
  const list = await api('/delivery-orders');
  const sos = await api('/docs/sales_orders');
  const postedSOs = sos.filter(s => s.status === 'POSTED');
  main.innerHTML = `<h1>Delivery Orders &amp; Surat Jalan</h1>
  <div class="sub">§28 · 3 copies: Customer / MTJ Administration / Warehouse · signed copy closes the DO</div>
  <div class="formbox"><h2 style="margin-top:0">New Delivery from posted SO</h2>
   <div class="row">
    <div style="flex:2"><label>Sales Order</label><select id="do-so">
      ${postedSOs.map(s => `<option value="${s.id}" data-cust="${s.customer_id}" data-wh="${s.warehouse_id}">${s.doc_no}</option>`).join('')}
    </select></div>
    <div style="align-self:flex-end"><button class="btn" onclick="mkDO()">Create DO + SJ</button></div>
   </div></div>
  <table><tr><th>DO No</th><th>Surat Jalan</th><th>SO</th><th>Date</th><th>Status</th></tr>
  ${list.map(d => `<tr><td><b>${d.doc_no}</b></td><td>${d.surat_jalan_no}</td><td>${d.so_no||''}</td>
   <td>${d.do_date}</td><td>${badge(d.status)}</td></tr>`).join('')}</table>`;
};
window.mkDO = async () => {
  const sel = $('#do-so'); const soId = +sel.value;
  try {
    const lines = [{ product_id: null, qty: 0 }]; // placeholder replaced below
    // pull SO lines to deliver everything still undelivered
    const soDocs = await api('/docs/sales_orders');
    void soDocs;
    const payload = { sales_order_id: soId, purpose: 'SALES', warehouse_id: +sel.selectedOptions[0].dataset.wh,
      recipient_name: 'customer', lines: window.__soLines && window.__soLines[soId] ? window.__soLines[soId] : [] };
    const r = await api('/delivery-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    toast(`Created ${r.doc_no} / SJ ${r.surat_jalan_no}`);
    go('delivery');
  } catch (e) { toast(e.message, true); }
};
views.warranty = async () => {
  const [warr, serv, wos] = await Promise.all([api('/warranties'), api('/service-orders'), api('/work-orders')]);
  main.innerHTML = `<h1>Warranty &amp; Service Center</h1>
  <div class="sub">§29-§33 · warranty born from deliveries · service tracks status until customer pickup</div>
  <h2>Warranty Certificates</h2>
  <table><tr><th>No</th><th>Customer</th><th>Product</th><th>Serial</th><th>Start</th><th>End</th><th>Status</th></tr>
  ${warr.map(w => `<tr><td><b>${w.warranty_no}</b></td><td>${w.customer_name}</td><td>${w.product_name}</td>
   <td class="mut">${w.serial||'—'}</td><td>${w.warranty_start}</td><td>${w.warranty_end}</td><td>${badge(w.status)}</td></tr>`).join('')}</table>
  <h2>Service Orders</h2>
  <table><tr><th>No</th><th>Customer</th><th>Product</th><th>Complaint</th><th>Status</th></tr>
  ${serv.map(s => `<tr><td><b>${s.doc_no}</b></td><td>${s.customer_name}</td><td>${s.product_name}</td>
   <td>${(s.complaint||'').slice(0,40)}</td><td>${badge(s.status)}</td></tr>`).join('')}</table>
  <h2>Field Work Orders (§33)</h2>
  <table><tr><th>No</th><th>Project</th><th>Location</th><th>Date</th><th>Status</th></tr>
  ${wos.map(w => `<tr><td><b>${w.doc_no}</b></td><td>${w.project_code||''}</td><td>${w.location||''}</td>
   <td>${w.scheduled_date||''}</td><td>${badge(w.status)}</td></tr>`).join('')}</table>`;
};
views.audit = async () => {
  const rowsL = await api('/audit');
  main.innerHTML = `<h1>Audit Trail (§12)</h1>
  <div class="sub">Every change: user · date · module · doc · action · old → new</div>
  <table><tr><th>When</th><th>Module</th><th>Doc</th><th>Action</th></tr>
  ${rowsL.map(a => `<tr><td class="mut">${a.at}</td><td>${a.module}</td><td>${a.doc_no||''}</td><td><b>${a.action}</b></td></tr>`).join('')}</table>`;
};

// ---------------- router ----------------
let current = 'dash';
window.go = async v => {
  current = v;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.v === v));
  try { await views[v](); } catch (e) { main.innerHTML = `<h1>Error</h1><pre>${e.message}</pre>`; }
};
document.querySelectorAll('nav a').forEach(a => a.onclick = () => go(a.dataset.v));
go('dash');
