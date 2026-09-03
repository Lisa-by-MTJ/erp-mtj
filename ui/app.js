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
  t.textContent = msg; t.classList.toggle('err', !!err); t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 4200);
}
const badge = s => `<span class="badge b-${String(s).replace(/\s/g,'_')}">${String(s).replace(/_/g,' ')}</span>`;
const opt = (list, valKey, lbl) => list.map(x => `<option value="${x[valKey]}">${lbl(x)}</option>`).join('');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const emptyState = (ico, msg) => `<div class="empty"><div class="ico">${ico}</div><div>${msg}</div></div>`;
const kpiCard = (l, v, cls, jump, sub) =>
  `<div class="kpi${jump ? ' jump' : ''}"${jump ? ` onclick="go('${jump}')"` : ''}>
    <div class="lbl">${l}</div><div class="val ${cls || ''}">${v}</div>
    ${sub ? `<div class="ksub">${sub}</div>` : ''}</div>`;

let PRODUCTS = [], PARTNERS = [], WAREHOUSES = [], PROJECTS = [];
// historical ASJ invoice PDFs: doc_no -> filename (fetch once; enables clickable 📄 in CRM/Docs)
window.INVOICE_PDFS = {};
fetch('/invoices.json').then(r => r.ok ? r.json() : {}).then(j => { window.INVOICE_PDFS = j || {}; })
  .catch(() => { /* offline: invoice numbers render plain */ });

// ---- collapsible sidebar (v3) ----
window.sideToggle = () => {
  const collapsed = document.body.classList.toggle('side-collapsed');
  try { localStorage.setItem('side_collapsed', collapsed ? '1' : '0'); } catch (e) { /* private mode */ }
  $('#side-toggle').textContent = collapsed ? '⟩' : '⟨';
};
try { if (localStorage.getItem('side_collapsed') === '1') document.addEventListener('DOMContentLoaded', () => window.sideToggle()); } catch (e) { /* ignore */ }

// ---------------- views ----------------
const views = {};

// ---- SVG area chart for dashboard trend (zero-dep) ----
function areaChart(trend) {
  if (!trend || !trend.length) return '<span class="mut">no data</span>';
  const W = 520, H = 200, pad = 8;
  const max = Math.max(...trend.map(t => t.sales), 1);
  const n = trend.length;
  const x = i => pad + i * (W - pad * 2) / (n - 1);
  const y = v => H - pad - (v / max) * (H - pad * 2);
  const curYm = new Date().toISOString().slice(0, 7);
  const pts = trend.map((t, i) => [x(i), y(t.sales)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `M${pts[0][0].toFixed(1)} ${H - pad} ` + pts.map(p => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ` L${pts[n - 1][0].toFixed(1)} ${H - pad} Z`;
  const curIdx = trend.findIndex(t => t.ym === curYm);
  const dot = curIdx >= 0 ? `<circle class="dot" cx="${pts[curIdx][0].toFixed(1)}" cy="${pts[curIdx][1].toFixed(1)}" r="4"/>` : '';
  const labels = trend.map((t, i) => (i % 2 === 0 || i === n - 1) ? `<text x="${x(i).toFixed(1)}" y="${H - 1}" font-size="9" fill="var(--mut)" text-anchor="middle">${t.label}</text>` : '').join('');
  return `<svg class="chart-area" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Sales trend">
    <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(27,54,145,.22)"/><stop offset="100%" stop-color="rgba(27,54,145,0)"/>
    </linearGradient></defs>
    <path class="fill" d="${area}"/><path class="line" d="${line}"/>${dot}${labels}</svg>`;
}

views.dash = async () => {
  const period = window.dashPeriod || 'ytd';
  _activityOffset = 10; // reset for "Load More"
  const d = await api('/dashboard2?period=' + period);
  const s = d.snapshot;
  window.dashPeriod = period;
  const zero = v => Number(v || 0) === 0 ? ' mut0' : '';
  const plabel = { month: 'This Month', quarter: 'This Quarter', ytd: 'Year to Date', alltime: 'All Time' }[period] || 'Year to Date';

  // ---- helpers: spreadsheet cells ----
  const kcell = (label, val, o = {}) => `<div class="kpicell"><div class="klbl">${label}</div>
    <div class="kval${zero(val)}"${o.go ? ` onclick="go('${o.go}')"` : ''}>${val}</div>
    ${o.evo || o.sub ? `<div class="kevo ${o.evo ? o.evo.cls : 'flat'}">${o.evo ? o.evo.txt : o.sub}</div>` : ''}</div>`;
  const gcell = (html, o = {}) => `<div class="gcell${o.cls ? ' ' + o.cls : ''}"${o.span ? ` style="grid-column:span ${o.span}"` : ''}${o.go ? ` onclick="go('${o.go}')"` : ''}>${html}</div>`;
  const sec = t => `<div class="ksec" style="grid-column:2/-1">${t}</div>`;
  const evo = (cur, prev) => {
    if (!prev) return { cls: 'flat', txt: 'no data for previous period' };
    const p = Math.round((cur - prev) / prev * 1000) / 10;
    return { cls: p > 0 ? 'up' : p < 0 ? 'down' : 'flat', txt: `${p > 0 ? '▲' : p < 0 ? '▼' : '■'} ${Math.abs(p)}% vs previous period` };
  };
  const sc = d.sales_compare || {};
  const ordEvo = evo(d.sales_period.c, sc.prev_orders || 0);

  const actBtn = (t, id, st) => st === 'DRAFT'
    ? `<button class="btn sm gray" onclick="act('${t}',${id},'submit')">Submit</button>`
    : st === 'SUBMITTED'
    ? `<button class="btn sm" onclick="act('${t}',${id},'approve')">Approve</button><button class="btn sm warn" onclick="act('${t}',${id},'reject')">Reject</button>`
    : `<button class="btn sm" onclick="act('${t}',${id},'post')">Post</button>`;
  const LINK = { quotations: 'docs', sales_orders: 'docs', purchase_orders: 'docs',
    receivings: 'docs', stock_transfers: 'transfer' };
  const acts = d.action_items.map(a => `<tr>
    <td><a href="#" onclick="go('${LINK[a.table] || 'docs'}');return false" style="color:inherit"><b>${esc(a.doc_no)}</b></a></td>
    <td>${a.label}</td><td class="mut">${a.date || ''}</td><td>${badge(a.status)}</td>
    <td class="money">${a.amount != null ? fmt(a.amount) : '—'}</td>
    <td>${actBtn(a.table, a.id, a.status)}</td></tr>`).join('');
  const feed = d.activity.map(a => `<div class="frow"><span class="fdot"></span>
    <div><b>${esc(a.username || 'system')}</b> <span class="mut">${esc(a.action.toLowerCase())}</span>
    ${a.doc_no ? `<b>${esc(a.doc_no)}</b>` : esc(a.module)} ${a.new_value ? `<span class="mut">→ ${esc(String(a.new_value).slice(0, 40))}</span>` : ''}
    <div class="mut ftime">${esc(a.at)}</div></div></div>`).join('');
  const per = ['month', 'quarter', 'ytd', 'alltime'].map(p =>
    `<button class="btn sm ${p === period ? '' : 'gray'}" onclick="window.dashPeriod='${p}';views.dash()">${{ month: 'Month', quarter: 'Quarter', ytd: 'YTD', alltime: 'All Time' }[p]}</button>`).join('');

  // ---- 12-month mini chart ----
  const max = Math.max(...d.trend.map(x => x.sales), 1);
  const bars = d.trend.map(t => {
    const h = Math.round(t.sales / max * 60) + 2;
    const isCur = t.ym === new Date().toISOString().slice(0, 7);
    return `<div class="bar${isCur ? ' cur' : ''}" style="height:${h}px"><span>${t.sales > 0 ? Math.round(t.sales / 1e6) + 'M' : ''}</span></div><i>${t.label}</i>`;
  }).join('');
  const tops = d.top_products.map(p => `<div>📦 <b>${esc(p.code)}</b> · ${p.qty} pcs — ${fmt(p.revenue)}</div>`).join('') || '<span class="dim">no posted sales yet</span>';
  const custs = d.top_customers.map(c => `<div>🏢 <b>${esc(c.name)}</b> · ${c.orders} SO — ${fmt(c.revenue)}</div>`).join('') || '<span class="dim">no posted sales yet</span>';

  main.innerHTML = `
  <div class="dash">
  <div class="dash-top">
    <div>
      <h1>Management Dashboard</h1>
      <div class="sub" style="margin:0">PT Monalisa Tunggal Jaya · “Your Potential. Our Passion.” · ${plabel}</div>
    </div>
    <div class="period-pill">${per}</div>
  </div>

  <!-- KPI cards -->
  <div class="kpi-grid">
    <div class="wcard accent">
      <span class="ic">💰</span>
      <div class="lbl">Sales ${plabel}</div>
      <div class="val">${fmt(sc.cur ?? d.sales_period.s)}</div>
      <div class="evo ${evo(sc.cur || 0, sc.prev || 0).cls}">${evo(sc.cur || 0, sc.prev || 0).txt}</div>
    </div>
    <div class="wcard"><span class="ic">📄</span><div class="lbl">Posted Orders</div>
      <div class="val nav" onclick="go('docs')">${d.sales_period.c}</div>
      <div class="evo ${ordEvo.cls}">${ordEvo.txt}</div></div>
    <div class="wcard"><span class="ic">🏬</span><div class="lbl">Stock Value</div>
      <div class="val nav" onclick="go('stock')">${fmt(s.stock_value)}</div>
      <div class="evo flat">avg cost basis</div></div>
    ${s.low_stock > 0
      ? `<div class="wcard warn"><span class="ic">⚠️</span><div class="lbl">Low Stock</div>
         <div class="val nav" onclick="go('stock')">${s.low_stock}</div>
         <div class="evo down">▼ below reorder point</div></div>`
      : `<div class="wcard"><span class="ic">✅</span><div class="lbl">Low Stock</div>
         <div class="val">0</div><div class="evo up">▲ all above reorder</div></div>`}
    ${d.action_items.length
      ? `<div class="wcard warn"><span class="ic">🔔</span><div class="lbl">Needs Action</div>
         <div class="val nav" onclick="go('docs')">${d.action_items.length}</div>
         <div class="evo down">▼ docs awaiting you</div></div>`
      : `<div class="wcard"><span class="ic">🎉</span><div class="lbl">Needs Action</div>
         <div class="val">0</div><div class="evo up">▲ queue clean</div></div>`}
    <div class="wcard"><span class="ic">🛡️</span><div class="lbl">Open Service</div>
      <div class="val nav" onclick="go('warranty')">${s.open_service}</div>
      <div class="evo flat">${s.active_warranty} active warranty</div></div>
    <div class="wcard"><span class="ic">🤝</span><div class="lbl">Open Leads</div>
      <div class="val nav" onclick="go('crm')">${d.crm.open_leads}</div>
      <div class="evo flat">${fmt(d.crm.open_value)} pipeline</div></div>
  </div>

  <!-- Trend + Action items -->
  <div class="grid-2">
    <div class="panel">
      <div class="panel-h"><h3>📈 12-Month Sales Trend</h3>
        <span class="tag">${plabel}</span></div>
      <div class="panel-b">
        ${areaChart(d.trend)}
        <div class="chart-legend"><span><i style="background:var(--hi)"></i>Monthly sales</span>
          <span><i style="background:var(--accent)"></i>Current month</span></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>🔔 Action Items</h3>
        <span class="tag">${d.action_items.length}</span></div>
      <div class="panel-b">
        ${d.action_items.length
          ? `<table class="act-table" style="width:100%;border-collapse:collapse"><tr><th>Doc</th><th>Status</th><th class="money">Amount</th></tr>${acts}</table>`
          : `<div class="pill-ok">✓ No documents waiting — queue is clean</div>`}
      </div>
    </div>
  </div>

  <!-- Top products + Top customers -->
  <div class="grid-2b">
    <div class="panel"><div class="panel-h"><h3>📦 Top Products</h3></div>
      <div class="panel-b"><div class="mini-list">${d.top_products.length
        ? d.top_products.map(p => `<div class="row"><span>📦 <b>${esc(p.code)}</b> · ${p.qty} pcs</span><span class="muted">${fmt(p.revenue)}</span></div>`).join('')
        : '<span class="muted">no posted sales yet</span>'}</div></div></div>
    <div class="panel"><div class="panel-h"><h3>🏢 Top Customers</h3></div>
      <div class="panel-b"><div class="mini-list">${d.top_customers.length
        ? d.top_customers.map(c => `<div class="row"><span>🏢 <b>${esc(c.name)}</b> · ${c.orders} SO</span><span class="muted">${fmt(c.revenue)}</span></div>`).join('')
        : '<span class="muted">no posted sales yet</span>'}</div></div></div>
  </div>

  <!-- Warehouses + Low stock watchlist -->
  <div class="section-label">Stock &amp; Warehouse</div>
  <div class="grid-2b">
    <div class="panel"><div class="panel-h"><h3>🏬 Warehouse Summary</h3><span class="tag">${(d.warehouse_summary||[]).length}</span></div>
      <div class="panel-b"><div class="mini-list">${(d.warehouse_summary||[]).map(wh =>
        `<div class="row"><span><b>${esc(wh.wh_name)}</b> · ${wh.total_items||0} items${wh.low_stock_count>0?` <span style="color:var(--neg)">· ${wh.low_stock_count} low</span>`:''}</span><span class="muted">${fmt(wh.total_value||0)}</span></div>`).join('') || '<span class="muted">no warehouse data</span>'}</div></div></div>
    <div class="panel"><div class="panel-h"><h3>⚠️ Low-Stock Watchlist</h3>${d.low_stock.length?`<span class="tag">${d.low_stock.length}</span>`:''}</div>
      <div class="panel-b">${d.low_stock.length
        ? `<table class="act-table" style="width:100%;border-collapse:collapse"><tr><th>Code</th><th>WH</th><th class="money">Avail</th><th class="money">Reorder</th></tr>${d.low_stock.map(r =>
            `<tr><td><a href="#" onclick="go('item-${r.id}');return false" style="color:inherit"><b>${esc(r.code)}</b></a></td><td>${esc(r.wh_name)}</td><td class="money"><b style="color:var(--neg)">${r.available}</b></td><td class="money">${r.reorder_point}</td></tr>`).join('')}</table>`
        : `<div class="pill-ok">✓ All items above reorder point</div>`}</div></div>
  </div>

  <!-- Recent activity -->
  <div class="section-label">Recent Activity</div>
  <div class="panel"><div class="panel-b" id="activity-feed">${feed || '<span class="muted">no activity yet</span>'}</div>
    <div class="panel-f" id="activity-more" style="text-align:center;padding:8px">
      <button class="btn sm gray" onclick="loadMoreActivity()">Load More</button>
    </div>
  </div>
  </div>`;
};

// ---- Load More Activity (dashboard) ----
let _activityOffset = 10;
window.loadMoreActivity = async () => {
  const feed = document.getElementById('activity-feed');
  const btn = document.querySelector('#activity-more button');
  if (!feed || !btn) return;
  btn.textContent = 'Loading…';
  btn.disabled = true;
  try {
    const r = await api(`/activity?offset=${_activityOffset}&limit=10`);
    if (r.items && r.items.length) {
      const html = r.items.map(a => `<div class="frow"><span class="fdot"></span>
        <div><b>${esc(a.username || 'system')}</b> <span class="mut">${esc(a.action.toLowerCase())}</span>
        ${a.doc_no ? `<b>${esc(a.doc_no)}</b>` : esc(a.module)} ${a.new_value ? `<span class="mut">→ ${esc(String(a.new_value).slice(0, 40))}</span>` : ''}
        <div class="mut ftime">${esc(a.at)}</div></div></div>`).join('');
      feed.insertAdjacentHTML('beforeend', html);
      _activityOffset += r.items.length;
    }
    if (!r.has_more) {
      btn.textContent = 'All loaded';
      btn.disabled = true;
      btn.style.opacity = '0.5';
    } else {
      btn.textContent = 'Load More';
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = 'Load More';
    btn.disabled = false;
  }
};

views.stock = async () => {
  const rows = await api('/stock');
  const mv = (await api('/movements')).slice(0, 15);
  const mvHtml = mv.length
    ? `<table><tr><th>ID</th><th>Type</th><th>Product</th><th>Wh</th><th class="money">ΔQty</th><th>Ref</th></tr>
    ${mv.map(m => `<tr><td>${m.id}</td><td>${m.movement_type}</td>
    <td>${esc(m.pcode)}</td><td>${esc(m.wh_name)}</td><td class="money ${m.qty_delta<0?'low':'ok'}">${m.qty_delta}</td>
    <td class="mut">${m.ref_no||''}</td></tr>`).join('')}</table>`
    : emptyState('📭', 'Belum ada pergerakan stok.');
  main.innerHTML = `<div class="viewhead"><h1>Stock &amp; Inventory</h1>
    <div class="vh-actions"><button class="btn gray sm" onclick="exportStock()">📥 Export CSV</button><button class="btn" onclick="const f=document.getElementById('pform');f.classList.toggle('open');if(f.classList.contains('open'))f.querySelector('input').focus()">＋ Tambah Barang</button></div></div>
  <div class="sub">§18 Available = Physical − Reserved · §20 every change is a stock movement · klik kode barang untuk detail</div>
  <div class="bulk-bar" id="bulk-bar"><span class="bulk-count" id="bulk-count">0</span> selected
    <button class="btn sm gray" onclick="exportSelected()">📥 Export Selected</button>
  </div>
  <div class="formbox" id="pform">
    <b>Master Barang Baru</b>
    <form onsubmit="return addProduct(event)">
      <div class="row">
        <div style="flex:1"><label>SKU / Kode *</label><input name="code" required placeholder="AZT-MH350BSW"></div>
        <div style="flex:2"><label>Nama Barang *</label><input name="name" required placeholder="Moving Head Beam 350"></div>
        <div style="flex:1"><label>Merek</label><input name="brand" placeholder="AZTEC"></div>
        <div style="flex:1"><label>Model</label><input name="model"></div>
        <div style="flex:1"><label>EAN / Barcode</label><input name="barcode" placeholder="8991234567890"></div>
      </div>
      <div class="row">
        <div style="flex:1"><label>Tipe</label><select name="type">
          <option value="FINISHED_GOODS">Barang Jadi</option><option value="SPAREPART">Suku Cadang</option>
          <option value="MATERIAL">Bahan Baku</option><option value="ACCESSORIES">Aksesoris</option>
          <option value="ASSET">Aset</option></select></div>
        <div style="flex:1"><label>Kategori</label><input name="category" placeholder="lighting"></div>
        <div style="flex:.6"><label>Satuan</label><input name="uom" value="PCS"></div>
        <div style="flex:1"><label>Kebijakan Serial</label><select name="serial_policy">
          <option value="NONE">Tidak Ada</option><option value="REQUIRED">Wajib</option><option value="BATCH">Per Batch</option></select></div>
        <div style="flex:.7"><label>Garansi (bln)</label><input name="warranty_months" type="number" value="12" min="0"></div>
      </div>
      <div class="row">
        <div style="flex:1"><label>Harga Modal (Rp)</label><input name="cost_price" type="number" min="0" value="0"></div>
        <div style="flex:1"><label>Harga Retail (Rp)</label><input name="retail_price" type="number" min="0" value="0"></div>
        <div style="flex:1"><label>Harga Project (Rp)</label><input name="project_price" type="number" min="0" value="0"></div>
        <div style="flex:.6"><label>Stok Minimum</label><input name="min_stock" type="number" min="0" value="0"></div>
        <div style="flex:.6"><label>Titik Pemesanan</label><input name="reorder_point" type="number" min="0" value="0"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" type="submit">Simpan</button></div>
      </div>
    </form>
    <div class="mut" style="font-size:11px">* wajib. Barang baru belum punya stok — masukkan lewat Purchase Order → Receiving.</div>
  </div>
  <div class="row" style="margin:8px 0">
    <div style="flex:1"><label>Brand</label><select id="st-brand" onchange="renderStock()">
      <option value="">All brands</option></select></div>
    <div style="flex:1"><label>Sort</label><select id="st-sort" onchange="renderStock()">
      <option value="code">Code (default)</option>
      <option value="brand">Brand A→Z</option>
      <option value="val-asc">Value: low → highest</option>
      <option value="val-desc">Value: highest → low</option>
      <option value="qty-desc">Qty: most first</option></select></div>
    <div style="flex:2"><label>Cari</label><input id="st-q" placeholder="code / nama barang…" oninput="renderStock()"></div>
  </div>
  <table><tr><th>Code</th><th>Product</th><th>EAN</th><th>Warehouse</th><th class="money">Physical</th>
  <th class="money">Reserved</th><th class="money">Available</th><th class="money">Value</th></tr>
  <tbody id="st-tbody"></tbody></table>
  <h2>Recent Movements (§20)</h2>
  ${mvHtml}
`;
  const bmap = new Map(); // UPPER key -> display label (prefer the bare brand spelling)
  for (const r of rows) {
    if (!r.brand) continue;
    let k = r.brand.toUpperCase();
    // merge family spellings into one filter: PROEL SOUND/STAGE/EIKON... -> PROEL
    const fam = k.match(/^(PROEL|AZTEC|MARTIN|EIKON|ROBE|CHAUVET|SOROT|OSRAM|HILL AUDIO|CELTO|CORNERED|RESOLUME|MADRIX)(\s|$)/);
    if (fam) k = fam[1];
    const cur = bmap.get(k);
    if (cur) { cur.n++; if (r.brand.toUpperCase() === k && cur.disp !== k) cur.disp = r.brand; }
    else bmap.set(k, { disp: r.brand, n: 1 });
  }
  const brands = [...bmap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  $('#st-brand').innerHTML = '<option value="">All brands</option>' +
    brands.map(([k, v]) => `<option value="${esc(k)}">${esc(v.disp)}</option>`).join('');
  window.__stockRows = rows;
  renderStock();
};
const brandKey = s => {
  const k = (s || '').toUpperCase();
  const fam = k.match(/^(PROEL|AZTEC|MARTIN|EIKON|ROBE|CHAUVET|SOROT|OSRAM|HILL AUDIO|CELTO|CORNERED|RESOLUME|MADRIX)(\s|$)/);
  return fam ? fam[1] : k;
};
window.renderStock = () => {
  const tb = $('#st-tbody'); if (!tb || !window.__stockRows) return;
  const brand = $('#st-brand').value, sort = $('#st-sort').value, q = $('#st-q').value.toLowerCase();
  let list = window.__stockRows.filter(r =>
    (!brand || brandKey(r.brand) === brand) &&
    (!q || (r.code + ' ' + (r.name||'')).toLowerCase().includes(q)));
  const val = r => r.stock_value || 0;
  if (sort === 'val-asc') list.sort((a,b) => val(a) - val(b));
  else if (sort === 'val-desc') list.sort((a,b) => val(b) - val(a));
  else if (sort === 'brand') list.sort((a,b) => (a.brand||'~').localeCompare(b.brand||'~') || a.code.localeCompare(b.code));
  else if (sort === 'qty-desc') list.sort((a,b) => b.physical - a.physical);
  tb.innerHTML = list.slice(0, 500).map(r => { const th = r.photo_url ? r.photo_url.replace('/products/', '/products/_t/') : ''; return `<tr><td><input type="checkbox" class="bulk-cb" data-pid="${r.product_id}" onchange="updateBulkBar()"></td><td><a href="#" onclick="go('item-${r.product_id}');return false" style="color:inherit"><b>${esc(r.code)}</b></a></td><td>${th ? `<img src="${esc(th)}" data-full="${esc(r.photo_url)}" class="st-thumb" loading="lazy" onerror="this.remove()">` : ''}${esc(r.name)} <span class="mut">${esc(r.brand||'')}</span></td><td class="mut">${esc(r.barcode||'—')}</td><td>${esc(r.wh_name)}</td>
    <td class="money">${r.physical}</td><td class="money">${r.reserved}</td>
    <td class="money"><b class="${r.available<=0?'low':'ok'}">${r.available}</b></td>
    <td class="money">${fmt(r.stock_value)}</td></tr>`; }).join('') +
    (list.length > 500 ? `<tr><td colspan="9" class="mut">… ${list.length - 500} baris lagi — persempit filter</td></tr>` : '');
};
// hover-zoom preview for stock thumbnails
(() => {
  const box = document.createElement('div'); box.id = 'imgzoom';
  box.innerHTML = '<img alt=""><div class="cap"></div>';
  document.body.appendChild(box);
  const im = box.querySelector('img'), cap = box.querySelector('.cap');
  const place = ev => {
    const x = Math.min(ev.clientX + 18, innerWidth - 330), y = Math.min(ev.clientY + 18, innerHeight - 350);
    box.style.left = Math.max(6, x) + 'px'; box.style.top = Math.max(6, y) + 'px';
  };
  document.addEventListener('mouseover', ev => {
    const t = ev.target.closest && ev.target.closest('.st-thumb');
    if (!t) return;
    im.src = t.dataset.full || t.src;
    const row = t.closest('tr');
    cap.textContent = row ? (row.cells[1].textContent.trim().slice(0, 60)) : '';
    place(ev); box.style.display = 'block';
  });
  document.addEventListener('mousemove', ev => { if (box.style.display === 'block') place(ev); });
  document.addEventListener('mouseout', ev => {
    const t = ev.target.closest && ev.target.closest('.st-thumb');
    if (t && !(ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('.st-thumb'))) box.style.display = 'none';
  });
  window.addEventListener('scroll', () => { box.style.display = 'none'; }, true);
})();
window.addProduct = async ev => {
  ev.preventDefault();
  const f = ev.target, b = Object.fromEntries(new FormData(f).entries());
  ['warranty_months','cost_price','retail_price','project_price','min_stock','reorder_point']
    .forEach(k => b[k] = Number(b[k] || 0));
  try {
    const r = await api('/products', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b) });
    toast(`Barang baru tersimpan (ID ${r.id}) — masukkan stok via Purchase Order → Receiving`);
    f.reset(); document.getElementById('pform').classList.remove('open');
  } catch (e) { toast(e.message, true); }
  return false;
};

// ---- Bulk Actions helpers ----
window.updateBulkBar = () => {
  const checked = document.querySelectorAll('.bulk-cb:checked');
  const bar = document.getElementById('bulk-bar');
  const count = document.getElementById('bulk-count');
  if (bar && count) {
    count.textContent = checked.length;
    bar.classList.toggle('show', checked.length > 0);
  }
};
window.getSelectedProducts = () => [...document.querySelectorAll('.bulk-cb:checked')].map(cb => cb.dataset.pid);
window.exportSelected = () => {
  const ids = getSelectedProducts();
  if (!ids.length) return;
  window.open('/api/stock/export?ids=' + ids.join(','), '_blank');
};

views.docs = async () => {
  const kinds = [['purchase_orders','Purchase Orders'],['receivings','Warehouse Receiving'],
                 ['stock_transfers','Stock Transfers'],
                 ['quotations','Quotations'],['sales_orders','Sales Orders']];
  let html = `<div class="viewhead"><h1>Purchase &amp; Sales Documents</h1></div><div class="sub">§11 lifecycle: DRAFT → SUBMITTED → APPROVED → POSTED (locked)</div>`;
  for (const [t, label] of kinds) {
    const list = await api('/docs/' + t);
    html += `<h2>${label}</h2><table><tr><th>Doc No</th><th>Partner / Route</th><th>Date</th>
      <th>Status</th><th>Actions</th></tr>` +
      list.slice(0, 12).map(d => `<tr><td><b>${t === 'sales_orders' && window.INVOICE_PDFS && INVOICE_PDFS[d.doc_no]
        ? `<a href="/invoice-pdf/${encodeURIComponent(d.doc_no)}" target="_blank" rel="noopener" title="Open PDF">${esc(d.doc_no)} 📄</a>`
        : esc(d.doc_no)}</b></td><td>${esc(d.partner_name||d.from_name+' → '+d.to_name||'—')}</td><td>${d.po_date||d.receive_date||d.quote_date||d.so_date||d.transfer_date||''}</td>
        <td>${badge(d.status)}</td>
        <td>${wfBtns(t, d)}<button class="btn sm gray" title="Scanned attachments" onclick="attPanel('${t}',${d.id},'${esc(d.doc_no)}')">📎 ${d.attachments_n || ''}</button></td></tr>`).join('') + '</table>';
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
// ---- attachments modal (scanned PDFs on any document) ----
window.attPanel = async (t, id, docNo) => {
  let list = [];
  try { list = await api(`/docs/${t}/${id}/attachments`); } catch (e) { toast(e.message, true); return; }
  let m = $('#attmodal');
  if (!m) {
    m = document.createElement('div'); m.id = 'attmodal';
    m.className = 'modalbox';
    m.innerHTML = '<div class="modalcard"><div id="attbody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', ev => { if (ev.target === m) m.classList.remove('open'); });
  }
  const render = rows => `
    <b>📎 Attachments — ${esc(docNo)}</b>
    ${rows.length ? `<table style="margin-top:8px"><tr><th>File</th><th>By</th><th>When</th><th></th></tr>
      ${rows.map(a => `<tr><td><a href="${a.stored_path}" target="_blank" rel="noopener">${esc(a.filename)}</a> <span class="mut">(${(a.size_bytes / 1024).toFixed(0)} KB)</span></td>
        <td class="mut">${esc(a.uploaded_by_name || '')}</td><td class="mut">${(a.created_at || '').slice(0, 16)}</td>
        <td><button class="btn sm warn" onclick="attDel('${t}',${id},${a.id},'${esc(docNo)}')">✕</button></td></tr>`).join('')}</table>`
      : '<div class="mut" style="margin:8px 0">Belum ada lampiran.</div>'}
    <div style="margin-top:10px">
      <label class="btn sm">⬆ Upload PDF<input type="file" accept="application/pdf,.pdf" style="display:none" onchange="attUpload(event,'${t}',${id},'${esc(docNo)}')"></label>
      <span class="mut" style="font-size:11px"> max 10 MB · PDF only</span>
    </div>`;
  $('#attbody').innerHTML = render(list);
  m.classList.add('open');
};
window.attUpload = async (ev, t, id, docNo) => {
  const f = ev.target.files[0]; if (!f) return;
  if (f.size > 10 * 1024 * 1024) { toast('Maks 10 MB'); return; }
  if (!/pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Hanya PDF'); return; }
  try {
    const r = await fetch(`/api/docs/${t}/${id}/attachment`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-filename': f.name }, body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'upload failed');
    toast('PDF terlampir 📎');
    attPanel(t, id, docNo); // repaint (re-fetches list)
  } catch (e) { toast(e.message, true); }
};
window.attDel = async (t, id, attId, docNo) => {
  if (!confirm('Hapus lampiran ini?')) return;
  try {
    await api(`/docs/${t}/${id}/attachment/${attId}`, { method: 'DELETE' });
    toast('Lampiran dihapus');
    const list = await api(`/docs/${t}/${id}/attachments`);
    attPanel(t, id, docNo); // repaint via fresh fetch
  } catch (e) { toast(e.message, true); }
};

views.newdoc = async () => {
  if (!PRODUCTS.length) {
    PRODUCTS = await api('/products'); PARTNERS = await api('/partners');
    WAREHOUSES = await api('/warehouses'); PROJECTS = await api('/projects');
  }
  const cOpts = opt(PARTNERS.filter(p => p.kind === 'CUSTOMER'), 'id', p => p.name);
  const sOpts = opt(PARTNERS.filter(p => p.kind === 'SUPPLIER'), 'id', p => p.name);
  const wOpts = opt(WAREHOUSES, 'id', w => w.name);
  const pOpts = PRODUCTS.map(p => `<option value="${p.id}" data-price="${p.retail_price}">${esc(p.code)} — ${esc(p.name)}</option>`).join('');
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
    ${PRODUCTS.map(p => `<option value="${p.id}" data-rl="${p.retail_price}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select></td>
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
  main.innerHTML = `<div class="viewhead"><h1>Projects</h1></div><div class="sub">§24-§27 · billing ≠ delivery · Control Tower per project</div>
  <table><tr><th>Code</th><th>Project</th><th>Customer</th><th class="money">Contract</th>
  <th class="money">Billed</th><th class="money">Outstanding</th><th class="money">Cost</th><th>Status</th><th></th></tr>
  ${list.map(p => `<tr><td><b>${esc(p.project_code)}</b></td><td>${esc(p.name)}</td><td>${esc(p.customer_name)}</td>
   <td class="money">${fmt(p.contract_value)}</td><td class="money">${fmt(p.billing_total)}</td>
   <td class="money ${p.outstanding>0?'low':'ok'}">${fmt(p.outstanding)}</td>
   <td class="money">${fmt(p.cost_total)}</td><td>${badge(p.status)}</td>
   <td><button class="btn sm gray" onclick="tower(${p.id})">Tower</button></td></tr>`).join('')}</table>`;
};
window.tower = async id => {
  const t = await api('/projects/' + id);
  const p = t.project;
  main.innerHTML = `<div class="viewhead"><h1>🔦 Project Control Tower — ${esc(p.project_code)}</h1></div>
  <div class="sub">${esc(p.name)} · ${esc(p.customer_name)} · site: ${esc(p.site_location||'—')}</div>
  <div class="grid">
    <div class="kpi"><div class="lbl">Contract Value</div><div class="val teal">${fmt(p.contract_value)}</div></div>
    <div class="kpi"><div class="lbl">Billed</div><div class="val">${fmt(t.billings.reduce((s,b)=>s+b.amount,0))}</div></div>
    <div class="kpi"><div class="lbl">Paid In</div><div class="val">${fmt(t.billings.reduce((s,b)=>s+(b.paid_amount||0),0))}</div></div>
    <div class="kpi"><div class="lbl">Cost (§35)</div><div class="val amber">${fmt(t.costs.reduce((s,c)=>s+c.amount,0))}</div></div>
  </div>
  <h2>Billing Milestones (§25)</h2>
  <table><tr><th>#</th><th>Milestone</th><th class="money">Amount</th><th>Status</th><th>Action</th></tr>
  ${t.billings.map(b => `<tr><td>${b.seq}</td><td>${esc(b.label)} (${b.percent}%)</td><td class="money">${fmt(b.amount)}</td>
   <td>${badge(b.status)}</td><td>${b.status!=='PAID'?`<button class="btn sm" onclick="payBill(${p.id},${b.id})">Mark Paid</button>`:''}</td></tr>`).join('')}</table>
  <h2>Deliveries / Surat Jalan</h2>
  <table><tr><th>DO</th><th>Surat Jalan</th><th>Date</th><th>Status</th></tr>
  ${t.deliveries.map(d => `<tr><td><b>${esc(d.doc_no)}</b></td><td>${esc(d.surat_jalan_no)}</td><td>${d.do_date}</td><td>${badge(d.status)}</td></tr>`).join('') || '<tr><td colspan=4 class=mut>none yet</td></tr>'}</table>
  <button class="btn gray" onclick="go('projects')" style="margin-top:14px">← Back</button>`;
};
window.payBill = async (pid, bid) => {
  try { await api(`/projects/${pid}/billings/${bid}/pay`, { method: 'POST' }); toast('Billing paid'); tower(pid); }
  catch (e) { toast(e.message, true); }
};
views.profit = async () => {
  const list = await api('/profitability');
  main.innerHTML = `<div class="viewhead"><h1>Project Profitability (§35)</h1></div>
  <div class="sub">Gross Profit = Revenue − Project Cost · Margin = GP ÷ Revenue × 100%</div>
  <table><tr><th>Project</th><th class="money">Revenue</th><th class="money">Cost</th>
  <th class="money">Gross Profit</th><th class="money">Margin %</th><th>Status</th></tr>
  ${list.map(r => { const neg = r.gross_profit < 0;
    return `<tr><td><b>${esc(r.project_code)}</b> ${esc(r.name)}</td><td class="money">${fmt(r.revenue)}</td>
    <td class="money" style="color:${neg?'#8a1c1c':'#1b3691'}">${fmt(r.gross_profit)}</td>
    <td class="money">${r.gross_margin_pct}%</td><td>${badge(r.status)}</td></tr>`; }).join('')}</table>`;
};
views.delivery = async () => {
  if (!WAREHOUSES.length) { PRODUCTS = await api('/products'); PARTNERS = await api('/partners'); WAREHOUSES = await api('/warehouses'); PROJECTS = await api('/projects'); }
  const list = await api('/delivery-orders');
  const sos = await api('/docs/sales_orders');
  const postedSOs = sos.filter(s => s.status === 'POSTED');
  main.innerHTML = `<div class="viewhead"><h1>Delivery Orders &amp; Surat Jalan</h1></div>
  <div class="sub">§28 · 3 copies: Customer / MTJ Administration / Warehouse · signed copy closes the DO</div>
  <div class="formbox"><h2 style="margin-top:0">New Delivery from posted SO</h2>
   <div class="row">
    <div style="flex:2"><label>Sales Order</label><select id="do-so">
      ${postedSOs.map(s => `<option value="${s.id}" data-cust="${s.customer_id}" data-wh="${s.warehouse_id}">${esc(s.doc_no)}</option>`).join('')}
    </select></div>
    <div style="align-self:flex-end"><button class="btn" onclick="mkDO()">Create DO + SJ</button></div>
   </div></div>
  <div class="row"><input id="do-q" placeholder="Filter by DO no / customer / date…" style="flex:1" oninput="renderDOs()"></div>
  <table><tr><th>DO No</th><th>Customer</th><th>SO</th><th>Date</th><th>Purpose</th><th>Lines</th><th>Status</th><th></th></tr>
  <tbody id="do-tbody"></tbody></table>`;
  window.__dos = list;
  renderDOs();
};
window.renderDOs = () => {
  const q = ($('#do-q')?.value || '').toLowerCase();
  const tb = $('#do-tbody'); if (!tb) return;
  const list = (window.__dos || []).filter(d => !q || [d.doc_no, d.customer_name, d.do_date].join(' ').toLowerCase().includes(q));
  tb.innerHTML = list.slice(0, 400).map(d => `<tr><td>${d.pdf_url
    ? `<a href="${d.pdf_url}" target="_blank" rel="noopener" title="Open DO PDF"><b>${esc(d.doc_no)}</b> 📄</a>`
    : `<b>${esc(d.doc_no)}</b>`}</td><td>${esc(d.customer_name||'—')}</td><td>${esc(d.so_no||'')}</td>
   <td>${d.do_date}</td><td>${esc(d.purpose)}</td><td>${d.lines ?? ''}</td><td>${badge(d.status)}</td>
   <td>${d.atts ? `<button class="btn sm gray" title="Lampiran PDF" onclick="attPanel('delivery_orders',${d.id},'${esc(d.doc_no)}')">📎 ${d.atts}</button>` : ''}</td></tr>`).join('');
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
  main.innerHTML = `<div class="viewhead"><h1>Warranty &amp; Service Center</h1></div>
  <div class="sub">§29-§33 · warranty born from deliveries · service tracks status until customer pickup</div>
  <h2>Warranty Certificates</h2>
  <table><tr><th>No</th><th>Customer</th><th>Product</th><th>Serial</th><th>Start</th><th>End</th><th>Status</th></tr>
  ${warr.map(w => `<tr><td><b>${esc(w.warranty_no)}</b></td><td>${esc(w.customer_name)}</td><td>${esc(w.product_name)}</td>
   <td class="mut">${esc(w.serial||'—')}</td><td>${w.warranty_start}</td><td>${w.warranty_end}</td><td>${badge(w.status)}</td></tr>`).join('')}</table>
  <h2>Service Orders</h2>
  <table><tr><th>No</th><th>Customer</th><th>Product</th><th>Complaint</th><th>Status</th></tr>
  ${serv.map(s => `<tr><td><b>${esc(s.doc_no)}</b></td><td>${esc(s.customer_name)}</td><td>${esc(s.product_name)}</td>
   <td>${esc((s.complaint||'').slice(0,40))}</td><td>${badge(s.status)}</td></tr>`).join('')}</table>
  <h2>Field Work Orders (§33)</h2>
  <table><tr><th>No</th><th>Project</th><th>Location</th><th>Date</th><th>Status</th></tr>
  ${wos.map(w => `<tr><td><b>${esc(w.doc_no)}</b></td><td>${esc(w.project_code||'')}</td><td>${esc(w.location||'')}</td>
   <td>${w.scheduled_date||''}</td><td>${badge(w.status)}</td></tr>`).join('')}</table>`;
};
views.users = async () => {
  const me = await api('/session');
  if (!['ADMIN'].includes(me.role)) { main.innerHTML = '<h1>403</h1><div class="sub">Admin only.</div>'; return; }
  const list = await api('/users');
  const roleOpts = sel => ['ADMIN','MANAGER','STAFF','VIEWER']
    .map(r => `<option ${r === sel ? 'selected' : ''}>${r}</option>`).join('');
  main.innerHTML = `
  <h1>Users &amp; Access</h1>
  <div class="sub">ADMIN: full control incl. user management · MANAGER: operate + approve/post ·
   STAFF: create/read · VIEWER: read-only</div>
  <div class="formbox"><b>Tambah User</b>
    <form onsubmit="return addUser(event)">
      <div class="row">
        <div style="flex:1"><label>Username *</label><input name="username" required></div>
        <div style="flex:2"><label>Nama Lengkap *</label><input name="full_name" required></div>
        <div style="flex:1"><label>Role</label><select name="role">${roleOpts('STAFF')}</select></div>
        <div style="flex:1"><label>Password *</label><input name="password" type="password" required minlength="6"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" type="submit">Tambah</button></div>
      </div>
    </form>
  </div>
  <table><tr><th>ID</th><th>Username</th><th>Nama</th><th>Role</th><th>Status</th><th>Actions</th></tr>
  ${list.map(u => `<tr><td>${u.id}</td><td><b>${esc(u.username)}</b>${u.username === me.user ? ' <span class="mut">(you)</span>' : ''}</td>
    <td>${esc(u.full_name)}</td>
    <td><select ${u.username === me.user ? 'disabled' : ''} onchange="editUser(${u.id}, {role:this.value})">${roleOpts(u.role)}</select></td>
    <td>${u.is_active ? badge('ACTIVE') : badge('INACTIVE')}</td>
    <td>
      <button class="btn sm gray" onclick="resetPw(${u.id}, '${esc(u.username)}')">Reset PW</button>
      ${u.username === me.user ? '' : (u.is_active
        ? `<button class="btn sm warn" onclick="editUser(${u.id}, {is_active:false})">Disable</button>`
        : `<button class="btn sm" onclick="editUser(${u.id}, {is_active:true})">Enable</button>`)}
      ${u.username === me.user ? '' : `<button class="btn sm warn" onclick="delUser(${u.id}, '${esc(u.username)}')">Delete</button>`}
    </td></tr>`).join('')}</table>
  <h2>Ganti Password Saya</h2>
  <div class="formbox"><form onsubmit="return changeMyPw(event)">
    <div class="row">
      <div style="flex:1"><label>Password Lama</label><input name="old_password" type="password" required></div>
      <div style="flex:1"><label>Password Baru (min 6)</label><input name="new_password" type="password" required minlength="6"></div>
      <div style="display:flex;align-items:flex-end"><button class="btn" type="submit">Ganti</button></div>
    </div>
  </form></div>`;
};
window.addUser = async ev => {
  ev.preventDefault();
  const b = Object.fromEntries(new FormData(ev.target).entries());
  try {
    const r = await api('/users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b) });
    toast(`User ${r.username} dibuat (role ${r.role})`); views.users();
  } catch (e) { toast(e.message, true); }
  return false;
};
window.editUser = async (id, patch) => {
  try {
    await api('/users/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch) });
    toast('User diperbarui'); views.users();
  } catch (e) { toast(e.message, true); views.users(); }
};
window.resetPw = async (id, username) => {
  const pw = prompt(`Password baru untuk ${username} (min 6 karakter):`);
  if (!pw) return;
  if (pw.length < 6) return toast('Minimal 6 karakter', true);
  editUser(id, { password: pw });
};
window.delUser = async (id, username) => {
  if (!confirm(`Hapus user ${username}? Tindakan ini tercatat di audit trail.`)) return;
  try {
    await api(`/users/${id}/delete`, { method: 'POST' });
    toast(`User ${username} dihapus`); views.users();
  } catch (e) { toast(e.message, true); }
};
window.changeMyPw = async ev => {
  ev.preventDefault();
  const b = Object.fromEntries(new FormData(ev.target).entries());
  try {
    await api('/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b) });
    toast('Password diganti'); ev.target.reset();
  } catch (e) { toast(e.message, true); }
  return false;
};

views.audit = async () => {
  const rowsL = await api('/audit');
  main.innerHTML = `<div class="viewhead"><h1>Audit Trail (§12)</h1></div>
  <div class="sub">Every change: user · date · module · doc · action · old → new</div>
  <table><tr><th>When</th><th>Module</th><th>Doc</th><th>Action</th></tr>
  ${rowsL.map(a => `<tr><td class="mut">${a.at}</td><td>${esc(a.module)}</td><td>${esc(a.doc_no||'')}</td><td><b>${esc(a.action)}</b></td></tr>`).join('')}</table>`;
};

// ---------------- Item Detail (§18) + EAN + photo ----------------
views.item = async id => {
  const d = await api('/products/' + id + '/detail');
  const p = d.product;
  main.innerHTML = `
  <button class="btn gray sm" onclick="go('stock')">← Stock</button>
  <div style="display:flex;gap:18px;align-items:flex-start;margin-top:14px">
    <div style="width:170px;flex-shrink:0">
      ${p.photo_url
        ? `<img src="${esc(p.photo_url)}" alt="${esc(p.code)}" style="width:170px;border:1px solid var(--line);border-radius:10px;background:var(--card)">`
        : `<div style="width:170px;height:130px;border:1px dashed var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:12px;background:var(--card)">no photo</div>`}
      <input type="file" id="photo-file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none" onchange="upPhoto(${id})">
      <button class="btn gray sm" style="width:100%;margin-top:6px" onclick="document.getElementById('photo-file').click()">📷 ${p.photo_url ? 'Ganti Foto' : 'Upload Foto'}</button>
    </div>
    <div style="flex:1">
      <h1 style="margin-bottom:2px">${esc(p.code)} — ${esc(p.name)}</h1>
      <div class="sub">${esc(p.brand||'')} ${esc(p.model||'')} · ${p.type} · ${esc(p.category||'—')} · satuan ${esc(p.uom)} · serial: ${p.serial_policy} · garansi ${p.warranty_months} bln</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr));margin-top:10px">
        <div class="kpi"><div class="lbl">Total Physical</div><div class="val">${d.totals.physical}</div></div>
        <div class="kpi"><div class="lbl">Reserved</div><div class="val">${d.totals.reserved}</div></div>
        <div class="kpi"><div class="lbl">Available</div><div class="val">${d.totals.available}</div></div>
        <div class="kpi"><div class="lbl">Harga Retail</div><div class="val" style="font-size:16px">${fmt(p.retail_price)}</div></div>
      </div>
      <div class="formbox" style="margin-top:14px">
        <b>EAN / Barcode</b>
        <div class="row" style="margin-top:8px;align-items:flex-end">
          <div style="flex:2"><input id="ean-input" value="${esc(p.barcode||'')}" placeholder="scan / ketik EAN lalu Enter"></div>
          <div><button class="btn sm" onclick="saveEan(${id})">Simpan EAN</button></div>
        </div>
        <div class="mut" style="font-size:11px">EAN dipakai untuk lookup cepat: <code>/api/products/lookup/&lt;EAN&gt;</code> — siap untuk scanner.</div>
      </div>
    </div>
  </div>
  <h2>Stok per Gudang</h2>
  <table><tr><th>Warehouse</th><th>Location</th><th class="money">Physical</th><th class="money">Reserved</th>
  <th class="money">Available</th><th class="money">Avg Cost</th><th class="money">Value</th></tr>
  ${d.by_warehouse.map(r => { const loc = [r.zone, r.rack, r.shelf, r.bin].filter(Boolean).join(' / '); return `<tr><td>${esc(r.wh_name)}</td><td class="mut">${loc ? esc(loc) : '—'}</td><td class="money">${r.physical}</td><td class="money">${r.reserved}</td>
    <td class="money"><b class="${r.available<=0?'low':'ok'}">${r.available}</b></td>
    <td class="money">${fmt(r.avg_cost)}</td><td class="money">${fmt(r.stock_value)}</td></tr>`; }).join('') || '<tr><td colspan=7 class=mut>belum ada stok</td></tr>'}</table>
  <h2>Serial Numbers</h2>
  <table><tr><th>Serial</th><th>Status</th><th>Warehouse</th><th>Warranty End</th></tr>
  ${d.serials.slice(0,30).map(s => `<tr><td><b>${esc(s.serial)}</b></td><td>${badge(s.status)}</td><td>${esc(s.wh_name||'—')}</td>
    <td class="mut">${s.warranty_end||'—'}</td></tr>`).join('') || '<tr><td colspan=4 class=mut>no serials</td></tr>'}</table>
  ${d.serials.length > 30 ? `<div class="mut" style="font-size:11px">… ${d.serials.length-30} more</div>` : ''}
  <h2>Mutasi Terakhir</h2>
  <table><tr><th>When</th><th>Type</th><th>Warehouse</th><th class="money">ΔQty</th><th>Ref</th></tr>
  ${d.movements.map(m => `<tr><td class="mut">${m.moved_at}</td><td>${m.movement_type}</td><td>${esc(m.wh_name)}</td>
    <td class="money ${m.qty_delta<0?'low':'ok'}">${m.qty_delta}</td><td class="mut">${m.ref_no||''}</td></tr>`).join('') || '<tr><td colspan=5 class=mut>belum ada mutasi</td></tr>'}</table>`;
};
window.saveEan = async id => {
  try {
    await api('/products/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: $('#ean-input').value.trim() || null }) });
    toast('EAN tersimpan');
    views.item(id);
  } catch (e) { toast(e.message, true); }
};
window.upPhoto = async id => {
  const inp = document.getElementById('photo-file');
  if (!inp.files || !inp.files[0]) return;
  try {
    const r = await fetch('/api/products/' + id + '/photo', { method: 'POST', body: inp.files[0],
      headers: { 'Content-Type': inp.files[0].type } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload failed');
    toast('Foto tersimpan');
    views.item(id);
  } catch (e) { toast(e.message, true); }
};

// ---------------- Stock Transfers (§21) ----------------
views.transfer = async () => {
  if (!PRODUCTS.length) {
    PRODUCTS = await api('/products'); WAREHOUSES = await api('/warehouses');
  }
  const list = await api('/stock-transfers');
  const wOpts = opt(WAREHOUSES, 'id', w => w.name);
  main.innerHTML = `
  <h1>Stock Transfer Antar Gudang</h1>
  <div class="sub">§21 · TRANSFER_OUT di gudang asal, TRANSFER_IN di gudang tujuan · serial pindah otomatis</div>
  <div class="formbox">
    <div class="row">
      <div style="flex:2"><label>Dari Gudang *</label><select id="trf-from">${wOpts}</select></div>
      <div style="flex:2"><label>Ke Gudang *</label><select id="trf-to">${wOpts}</select></div>
      <div style="flex:1.5"><label>Tanggal</label><input id="trf-date" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
      <div style="flex:2"><label>Catatan</label><input id="trf-note" placeholder="opsional"></div>
      <div style="align-self:flex-end"><button class="btn" onclick="mkTrf()">Buat TRF</button></div>
    </div>
    <table id="trf-lines"></table>
    <button class="btn gray sm" onclick="addTrfLine()">+ Tambah baris</button>
  </div>
  <h2>Riwayat Transfer</h2>
  <table><tr><th>Doc No</th><th>Tanggal</th><th>Dari</th><th>Ke</th><th>Status</th><th>Actions</th></tr>
  ${list.map(t => `<tr><td><b>${esc(t.doc_no)}</b></td><td>${t.transfer_date}</td><td>${esc(t.from_name)}</td><td>${esc(t.to_name)}</td>
    <td>${badge(t.status)}</td><td>${wfBtns('stock_transfers', t)}</td></tr>`).join('') || '<tr><td colspan=6 class=mut>belum ada transfer</td></tr>'}</table>`;
  window.trfLines = [];
  addTrfLine();
};
window.addTrfLine = () => {
  const i = window.trfLines.length;
  window.trfLines.push({ pid: PRODUCTS[0] ? PRODUCTS[0].id : null, qty: 1, serials: '' });
  $('#trf-lines').insertAdjacentHTML('beforeend', `
    <tr><td style="width:50%"><select onchange="trfLines[${i}].pid=+this.value">
      ${PRODUCTS.map(p => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select></td>
    <td><input type="number" min="1" value="1" oninput="trfLines[${i}].qty=+this.value"></td>
    <td><input placeholder="serials (koma)" oninput="trfLines[${i}].serials=this.value"></td></tr>`);
  if (i === 0) $('#trf-lines').insertAdjacentHTML('beforebegin',
    '<tr><th style="width:50%">Product</th><th>Qty</th><th>Serial (opsional)</th></tr>');
};
window.mkTrf = async () => {
  const from = +$('#trf-from').value, to = +$('#trf-to').value;
  if (from === to) return toast('Gudang asal dan tujuan harus berbeda', true);
  const payload = { from_warehouse_id: from, to_warehouse_id: to,
    transfer_date: $('#trf-date').value || null, note: $('#trf-note').value || null,
    lines: window.trfLines.filter(l => l.pid).map(l => ({ product_id: l.pid, qty: l.qty,
      serials: l.serials ? l.serials.split(',').map(s => s.trim()).filter(Boolean) : [] })) };
  if (!payload.lines.length) return toast('Minimal satu baris barang', true);
  try {
    const r = await api('/stock-transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    toast(`Created ${r.doc_no} — submit → approve → post untuk memindahkan stok`);
    views.transfer();
  } catch (e) { toast(e.message, true); }
};

// ---------------- CRM (leads / follow-ups) ----------------
const CRM_STAGES = ['NEW', 'CONTACTED', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'];
views.crm = async () => {
  const [leads, fus, partners, sos] = await Promise.all([api('/crm/leads'), api('/crm/followups?days=7'),
    api('/partners'), api('/docs/sales_orders')]);
  const cust = partners.filter(p => p.kind === 'CUSTOMER').sort((a, b) => a.name.localeCompare(b.name));
  const agg = {};
  for (const s of sos) { const a = agg[s.customer_id] = agg[s.customer_id] || { n: 0, v: 0 }; a.n++; a.v += s.grand_total || 0; }
  const crows = cust.map(c => { const a = agg[c.id]; return `<tr data-n="${esc((c.name + ' ' + (c.pic || '') + ' ' + (c.city || '') + ' ' + (c.code || '')).toLowerCase())}">
    <td><b><a href="#" onclick="go('crm-${c.id}');return false" style="color:inherit">${esc(c.name)}</a></b>${c.code === 'BUCKET-ASJ' ? ' <span class="badge b-review">review</span>' : ''}</td>
    <td>${esc(c.pic || '—')}</td><td>${esc(c.phone || '—')}</td><td>${esc(c.city || '—')}</td>
    <td class="money">${a ? a.n : 0}</td><td class="money">${a ? 'Rp ' + a.v.toLocaleString('id-ID') : '—'}</td></tr>`; }).join('');
  const open = leads.filter(l => !['WON', 'LOST'].includes(l.stage));
  const closed = leads.filter(l => ['WON', 'LOST'].includes(l.stage));
  const leadCard = l => `<div class="leadcard">
    <div class="ltop"><b>${esc(l.company)}</b><span class="mut">${rp2(l.est_value)}</span></div>
    <div class="mut lpic">${esc(l.pic_name || '—')}${l.phone ? ' · ' + esc(l.phone) : ''}</div>
    ${l.interest ? `<div class="mut" style="font-size:11px">🎯 ${esc(l.interest)}</div>` : ''}
    ${l.next_followup ? `<div class="mut" style="font-size:11px">⏰ follow-up: ${esc(l.next_followup)}</div>` : ''}
    <div class="lacts">
      ${!['WON', 'LOST'].includes(l.stage) ? CRM_STAGES.slice(0, 4).filter(s => s !== l.stage)
        .map(s => `<button class="btn sm gray" onclick="crmStage(${l.id},'${s}')">${s.charAt(0) + s.slice(1).toLowerCase()}</button>`).join('') : ''}
      ${l.stage !== 'WON' ? `<button class="btn sm" onclick="crmConvert(${l.id})">🏆 Won→Customer</button>` : ''}
      ${l.stage !== 'LOST' ? `<button class="btn sm warn" onclick="crmLost(${l.id})">Lost</button>` : ''}
      ${l.customer_id ? `<button class="btn sm gray" onclick="go('crm-${l.customer_id}')">360</button>` : ''}
    </div></div>`;
  main.innerHTML = `
  <h1>CRM — Customers · Leads · Follow-ups</h1>
  <div class="sub">${cust.length} customer master · pipeline prospek · klik nama untuk Customer 360</div>
  <input id="custq" placeholder="🔍 Filter customer / PIC / kota…" style="width:320px;margin:8px 0" oninput="crmFilter(this.value)">
  <table id="custtbl"><tr><th>Customer</th><th>PIC</th><th>Phone</th><th>City</th><th class="money">Invoices</th><th class="money">Total Value</th></tr>
  ${crows}</table>
  <button class="btn" onclick="document.getElementById('leadform').classList.toggle('open')">＋ Tambah Lead</button>
  <div class="formbox" id="leadform">
    <b>Lead Baru</b>
    <form onsubmit="return crmAddLead(event)">
      <div class="row">
        <div style="flex:2"><label>Perusahaan *</label><input name="company" required></div>
        <div style="flex:1"><label>PIC</label><input name="pic_name"></div>
        <div style="flex:1"><label>Telepon</label><input name="phone"></div>
        <div style="flex:1"><label>Email</label><input name="email" type="email"></div>
      </div>
      <div class="row">
        <div style="flex:1"><label>Source</label><input name="source" placeholder="IG / referral / pameran"></div>
        <div style="flex:1.4"><label>Minat</label><input name="interest" placeholder="sound system untuk club"></div>
        <div style="flex:1"><label>Est. Value (Rp)</label><input name="est_value" type="number" min="0" value="0"></div>
        <div style="flex:1"><label>Next Follow-up</label><input name="next_followup" type="date"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" type="submit">Simpan</button></div>
      </div>
    </form>
  </div>
  <h2>⏰ Follow-ups Due (7 hari)</h2>
  ${fus.length ? `<table><tr><th>Target</th><th>Type</th><th>Summary</th><th>Due</th><th>By</th><th></th></tr>
    ${fus.map(f => `<tr><td><b>${esc(f.target || '—')}</b></td><td>${f.activity_type}</td>
      <td>${esc(f.summary)}</td><td class="mut">${f.due_date}</td><td class="mut">${esc(f.done_by_name || '')}</td>
      <td><button class="btn sm" onclick="crmDone(${f.id})">✓ Done</button></td></tr>`).join('')}</table>`
    : '<div class="mut">Tidak ada follow-up jatuh tempo. ✅</div>'}
  <h2>Pipeline — Open (${open.length})</h2>
  <div class="pipeline">${CRM_STAGES.filter(s => !['WON', 'LOST'].includes(s)).map(s => {
    const items = open.filter(l => l.stage === s);
    return `<div class="pcol"><div class="phead">${s} <span class="mut">${items.length}</span></div>
      ${items.map(leadCard).join('') || '<div class="mut pempty">—</div>'}</div>`;
  }).join('')}</div>
  <h2>Won / Lost (${closed.length})</h2>
  <table><tr><th>Company</th><th>Stage</th><th>Est. Value</th><th>Customer</th><th>Lost reason</th></tr>
  ${closed.map(l => `<tr><td><b>${esc(l.company)}</b></td><td>${badge(l.stage)}</td>
    <td class="money">${rp2(l.est_value)}</td>
    <td>${l.customer_id ? `<a href="#" onclick="go('crm-${l.customer_id}');return false" style="color:inherit">${esc(l.customer_name || '#' + l.customer_id)}</a>` : '—'}</td>
    <td class="mut">${esc(l.lost_reason || '')}</td></tr>`).join('') || '<tr><td colspan=5 class=mut>belum ada</td></tr>'}</table>`;
};
const rp2 = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
window.crmFilter = q => {
  q = q.toLowerCase().trim();
  document.querySelectorAll('#custtbl tr[data-n]').forEach(tr => {
    tr.style.display = !q || tr.dataset.n.includes(q) ? '' : 'none';
  });
};
window.crmAddLead = async ev => {
  ev.preventDefault();
  const b = Object.fromEntries(new FormData(ev.target).entries());
  b.est_value = Number(b.est_value || 0);
  try { await api('/crm/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    toast('Lead tersimpan'); views.crm(); } catch (e) { toast(e.message, true); }
  return false;
};
window.crmStage = async (id, stage) => {
  try { await api('/crm/leads/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }) }); views.crm(); } catch (e) { toast(e.message, true); }
};
window.crmConvert = async id => {
  try { const r = await api(`/crm/leads/${id}/convert`, { method: 'POST' });
    toast('Lead → customer #' + r.customer_id); go('crm-' + r.customer_id); }
  catch (e) { toast(e.message, true); }
};
window.crmLost = async id => {
  const reason = prompt('Alasan lost (opsional):');
  if (reason === null) return;
  try { await api('/crm/leads/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'LOST', lost_reason: reason }) }); views.crm(); }
  catch (e) { toast(e.message, true); }
};
window.crmDone = async id => {
  try { await api(`/crm/activities/${id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}) }); toast('Follow-up selesai'); views.crm(); } catch (e) { toast(e.message, true); }
};
// ---------------- Customer 360 ----------------
views.crm360 = async id => {
  const d = await api('/crm/360/' + id);
  const c = d.customer;
  const ino = r => (r.doc_no && /INV/.test(r.doc_no) && window.INVOICE_PDFS && INVOICE_PDFS[r.doc_no])
    ? `<a href="/invoice-pdf/${encodeURIComponent(r.doc_no)}" target="_blank" rel="noopener" title="Open PDF"><b>${esc(r.doc_no)}</b> 📄</a>`
    : `<b>${esc(r.doc_no)}</b>`;
  const tbl = (title, rowsL, cols) => `<h2>${title}</h2>
    <table><tr>${cols.map(x => `<th>${x[0]}</th>`).join('')}</tr>
    ${rowsL.map(r => `<tr>${cols.map(x => `<td>${x[1](r)}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${cols.length}" class="mut">none</td></tr>`}</table>`;
  main.innerHTML = `
  <button class="btn gray sm" onclick="go('crm')">← CRM</button>
  <h1 style="margin-top:10px">${esc(c.name)}</h1>
  <div class="sub">${c.kind} · PIC ${esc(c.pic || '—')}${c.phone ? ' · ☎ ' + esc(c.phone) : ''}${c.email ? ' · ✉ ' + esc(c.email) : ''}${c.city ? ' · ' + esc(c.city) : ''} · payment term ${c.payment_term_days}d · credit limit ${rp2(c.credit_limit)}</div>
  <div class="grid" style="grid-template-columns:repeat(3,1fr)">
    ${kpiCard('Posted Orders', d.totals.orders.n, '', null, rp2(d.totals.orders.v))}
    ${kpiCard('Outstanding (SO)', rp2(d.totals.outstanding.v), d.totals.outstanding.v > 0 ? 'amber' : '')}
    ${kpiCard('Projects', d.projects.length)}
  </div>
  ${tbl('Quotations', d.quotations, [['Doc', ino], ['Date', r => r.quote_date], ['Total', r => rp2(r.grand_total)], ['Status', r => badge(r.status)]])}
  ${tbl('Sales Orders', d.sales_orders, [['Doc', ino], ['Date', r => r.so_date], ['Type', r => r.sales_type], ['Total', r => rp2(r.grand_total)], ['Paid', r => rp2(r.paid_amount)], ['Status', r => badge(r.status)]])}
  ${tbl('Projects', d.projects, [['Code', r => `<b>${esc(r.project_code)}</b>`], ['Name', r => esc(r.name)], ['Contract', r => rp2(r.contract_value)], ['Status', r => badge(r.status)]])}
  ${tbl('Warranties', d.warranties, [['No', r => `<b>${esc(r.warranty_no)}</b>`], ['Start', r => r.warranty_start], ['End', r => r.warranty_end], ['Status', r => badge(r.status)]])}
  ${tbl('Service Orders', d.service_orders, [['Doc', r => `<b>${esc(r.doc_no)}</b>`], ['Received', r => r.received_at], ['Complaint', r => esc((r.complaint || '').slice(0, 40))], ['Status', r => badge(r.status)]])}
  <h2>Activities / Follow-ups</h2>
  <table><tr><th>When</th><th>Type</th><th>Summary</th><th>Result</th><th>By</th></tr>
  ${d.activities.map(a => `<tr><td class="mut">${a.done_at || ''}</td><td>${a.activity_type}</td>
    <td>${esc(a.summary)}</td><td class="mut">${esc(a.result || '')}</td><td class="mut">${esc(a.done_by_name || '')}</td></tr>`).join('')
    || '<tr><td colspan=5 class="mut">belum ada aktivitas</td></tr>'}</table>
  <div class="formbox" style="margin-top:14px"><b>Catat Aktivitas Baru</b>
    <form onsubmit="return crmAddAct(event, ${c.id})">
      <div class="row">
        <div style="flex:1"><label>Type</label><select name="activity_type">
          <option>CALL</option><option>VISIT</option><option>WHATSAPP</option><option>EMAIL</option><option>MEETING</option><option>OTHER</option></select></div>
        <div style="flex:2"><label>Summary *</label><input name="summary" required placeholder="telpon PIC — tanya timeline pengadaan"></div>
        <div style="flex:1"><label>Follow-up due</label><input name="due_date" type="date"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" type="submit">Simpan</button></div>
      </div>
    </form></div>`;
};
window.crmAddAct = async (ev, customerId) => {
  ev.preventDefault();
  const b = Object.fromEntries(new FormData(ev.target).entries());
  b.customer_id = customerId;
  try { await api('/crm/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b) }); toast('Aktivitas tercatat'); views.crm360(customerId); }
  catch (e) { toast(e.message, true); }
  return false;
};
// __CRM_VIEWS__


let current = 'dash';
window.go = async v => {
  current = v;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.v === v || (a.dataset.v === 'crm' && v.startsWith('crm-'))));
  try {
    const m = v.match(/^item-(\d+)$/);
    if (m) return await views.item(Number(m[1]));
    const cm = v.match(/^crm-(\d+)$/);
    if (cm) return await views.crm360(Number(cm[1]));
    await views[v]();
  } catch (e) { main.innerHTML = `<h1>Error</h1><pre>${e.message}</pre>`; }
};
// session header (user + role + logout) — injected above every view
(async () => {
  try {
    const s = await api('/session');
    const h = document.createElement('div');
    h.id = 'whoami';
    const initials = esc(String(s.user || '?').slice(0, 2));
    h.innerHTML = `<span class="avatar">${initials}</span>Signed in as <b>${esc(s.user)}</b>` +
      `<span class="rolebadge">${esc(s.role)}</span>` +
      `<button id="logout" onclick="location.href='/logout'">Log out</button>`;
    const tb = $('#topbar');
    tb.innerHTML = '';
    tb.appendChild(h);
    tb.classList.add('show');
    if (s.role === 'ADMIN') {
      const usersLink = document.querySelector('nav a[data-v="users"]');
      if (usersLink) usersLink.style.display = '';
    }
  } catch (e) { /* not logged in — /login will handle */ }
})();
document.querySelectorAll('nav a').forEach(a => a.onclick = () => go(a.dataset.v));
// ---------------- Warehouses / Gudang (§18 per-warehouse view) ----------------
views.warehouses = async () => {
  const [whs, stock] = await Promise.all([api('/warehouses'), api('/stock')]);
  const byWh = {};
  for (const r of stock) (byWh[r.wh_code] = byWh[r.wh_code] || []).push(r);
  const typeBadge = t => badge(t);
  let html = `<div class="viewhead"><h1>Warehouses / Gudang</h1></div>
  <div class="sub">§18 · stok per gudang — klik kartu gudang untuk fokus · nilai stok = physical × avg cost</div>
  <div class="grid">` +
  whs.map(w => {
    const items = byWh[w.code] || [];
    const qty = items.reduce((s, r) => s + r.physical, 0);
    const val = items.reduce((s, r) => s + r.stock_value, 0);
    return `<div class="kpi" style="cursor:pointer" onclick="document.getElementById('wh-${w.id}').scrollIntoView({behavior:'smooth'})">
      <div class="lbl">${esc(w.code)} · ${typeBadge(w.type)}</div>
      <div class="val" style="font-size:15px">${esc(w.name)}</div>
      <div class="mut" style="font-size:11.5px;margin-top:5px">${items.length} barang · ${qty} pcs · ${fmt(val)}</div>
    </div>`;
  }).join('') + `</div>
  <button class="btn" onclick="document.getElementById('whform').classList.toggle('open')">＋ Tambah Gudang</button>
  <div class="formbox" id="whform">
    <b>Gudang Baru</b>
    <form onsubmit="return addWarehouse(event)">
      <div class="row">
        <div style="flex:1"><label>Kode *</label><input name="code" required placeholder="WH-BALI"></div>
        <div style="flex:2"><label>Nama Gudang *</label><input name="name" required placeholder="Gudang Bali"></div>
        <div style="flex:1"><label>Tipe</label><select name="type">
          <option value="MAIN">MAIN</option><option value="PROJECT">PROJECT</option>
          <option value="SERVICE">SERVICE</option><option value="TRANSIT">TRANSIT</option></select></div>
        <div style="flex:2"><label>Alamat</label><input name="address" placeholder="opsional"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" type="submit">Simpan</button></div>
      </div>
    </form>
  </div>` +
  whs.map(w => {
    const items = byWh[w.code] || [];
    return `<h2 id="wh-${w.id}">🏬 ${esc(w.name)} <span class="mut" style="text-transform:none;letter-spacing:0">(${esc(w.code)} · ${w.type}${w.address ? ' · ' + esc(w.address) : ''})</span></h2>
    <table><tr><th>Code</th><th>Product</th><th>EAN</th><th class="money">Physical</th><th class="money">Reserved</th>
    <th class="money">Available</th><th class="money">Value</th></tr>
    ${items.map(r => `<tr><td><a href="#" onclick="go('item-${r.product_id}');return false" style="color:inherit"><b>${esc(r.code)}</b></a></td>
      <td>${esc(r.name)} <span class="mut">${esc(r.brand||'')}</span></td><td class="mut">${esc(r.barcode||'—')}</td>
      <td class="money">${r.physical}</td><td class="money">${r.reserved}</td>
      <td class="money"><b class="${r.available<=0?'low':'ok'}">${r.available}</b></td>
      <td class="money">${fmt(r.stock_value)}</td></tr>`).join('') ||
      '<tr><td colspan=7 class="mut">belum ada barang di gudang ini — masukkan via Purchase Order → Receiving atau Transfer Gudang</td></tr>'}</table>`;
  }).join('');
  main.innerHTML = html;
};
window.addWarehouse = async ev => {
  ev.preventDefault();
  const b = Object.fromEntries(new FormData(ev.target).entries());
  try {
    const r = await api('/warehouses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b) });
    toast(`Gudang ${b.name} tersimpan (ID ${r.id})`);
    views.warehouses();
  } catch (e) { toast(e.message, true); }
  return false;
};

// ---------------- Lisa chat (in-page only; ends on logout/reload) ----------------
const LISA_HISTORY = []; // intentionally NOT persisted — session ends with logout
window.lisaToggle = () => {
  const box = $('#lisa-box');
  box.classList.toggle('open');
  if (box.classList.contains('open')) {
    if (!LISA_HISTORY.length) lisaBot('Halo! 👋 Aku Lisa. Tanya apa hari ini — stok, harga, sales, atau approval?');
    $('#lisa-q').focus();
  }
};
window.lisaQuick = t => { $('#lisa-q').value = t; lisaSend(); };
const lisaMd = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/\*(.+?)\*/g, '<i>$1</i>');
function lisaPush(cls, html) {
  const log = $('#lisa-log');
  log.insertAdjacentHTML('beforeend', `<div class="lisa-msg ${cls}">${html}</div>`);
  log.scrollTop = log.scrollHeight;
}
function lisaBot(text, goto) {
  lisaPush('bot', lisaMd(text));
  if (goto) {
    const [v, label] = goto;
    const btn = document.createElement('div');
    btn.className = 'lisa-goto';
    btn.innerHTML = `<button onclick="go('${v}');$('#lisa-box').classList.remove('open')">Buka ${esc(label)} →</button>`;
    $('#lisa-log').appendChild(btn);
    $('#lisa-log').scrollTop = $('#lisa-log').scrollHeight;
  }
}
window.lisaSend = async () => {
  const inp = $('#lisa-q');
  const q = inp.value.trim();
  if (!q) return;
  inp.value = '';
  lisaPush('user', esc(q));
  LISA_HISTORY.push({ who: 'user', text: q });
  lisaPush('bot', '<span class="mut">…</span>');
  try {
    const r = await api('/lisa', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q }) });
    const log = $('#lisa-log');
    log.lastElementChild.remove(); // drop the typing dots
    lisaBot(r.text, r.goto);
    LISA_HISTORY.push({ who: 'bot', text: r.text });
  } catch (e) {
    const log = $('#lisa-log');
    log.lastElementChild.remove();
    lisaBot('Ups — ' + e.message);
  }
};
$('#lisa-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') lisaSend(); });

// ---- Dark Mode ----
(() => {
  const toggle = document.createElement('button');
  toggle.id = 'dark-toggle';
  toggle.textContent = '🌙';
  toggle.title = 'Toggle dark mode';
  toggle.onclick = () => {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    toggle.textContent = isDark ? '☀️' : '🌙';
    try { localStorage.setItem('dark_mode', isDark ? '1' : '0'); } catch(e) {}
  };
  document.addEventListener('DOMContentLoaded', () => {
    const tb = document.getElementById('topbar');
    if (tb) tb.appendChild(toggle);
    try { if (localStorage.getItem('dark_mode') === '1') { document.body.classList.add('dark'); toggle.textContent = '☀️'; } } catch(e) {}
  });
})();

// ---- Global Search Bar ----
(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const wrap = document.createElement('div');
    wrap.id = 'gsearch-wrap';
    wrap.innerHTML = '<input id="gsearch" placeholder="🔍 Search…">';
    const results = document.createElement('div');
    results.id = 'search-results';
    wrap.appendChild(results);
    nav.appendChild(wrap);

    let debounce = null;
    const inp = document.getElementById('gsearch');
    inp.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = inp.value.trim();
      if (!q) { results.style.display = 'none'; return; }
      debounce = setTimeout(async () => {
        try {
          const data = await api('/search?q=' + encodeURIComponent(q));
          if (!data.length) { results.innerHTML = '<div class="sr-item mut" style="text-align:center">No results</div>'; results.style.display = 'block'; return; }
          results.innerHTML = data.map(r =>
            `<div class="sr-item" onclick="go('${r.view}');document.getElementById('search-results').style.display='none';document.getElementById('gsearch').value=''">
              <div class="sr-type">${esc(r.type)}</div>
              <div>${esc(r.label)}</div>
            </div>`
          ).join('');
          results.style.display = 'block';
        } catch (e) { results.style.display = 'none'; }
      }, 300);
    });
    inp.addEventListener('blur', () => setTimeout(() => results.style.display = 'none', 200));
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { results.style.display = 'none'; inp.blur(); }
    });
  });
})();

// ---- Stock Export ----
window.exportStock = () => { window.open('/api/stock/export', '_blank'); };

// ---- Stock Count View ----
views.stockcount = async () => {
  let sessions = [];
  try { sessions = await api('/stock-counts'); } catch(e) { /* empty */ }
  const warehouses = WAREHOUSES.length ? WAREHOUSES : (await api('/warehouses'));
  const whOpts = opt(warehouses, 'id', w => w.name);
  main.innerHTML = `
  <div class="viewhead"><h1>Stock Count</h1></div>
  <div class="sub">Physical count vs system qty — variance highlights discrepancies</div>
  <div class="formbox"><b>New Count Session</b>
    <form onsubmit="return createStockCount(event)">
      <div class="row">
        <div style="flex:2"><label>Warehouse</label><select id="sc-wh">${whOpts}</select></div>
        <div style="align-self:flex-end"><button class="btn" type="submit">Start Count</button></div>
      </div>
    </form>
  </div>
  <h2>Count Sessions</h2>
  ${sessions.length ? `<table><tr><th>ID</th><th>Warehouse</th><th>Date</th><th>Status</th><th>Lines</th><th></th></tr>
  ${sessions.map(s => `<tr><td><b>#${s.id}</b></td><td>${esc(s.wh_name||'')}</td><td>${s.count_date||''}</td>
    <td>${badge(s.status)}</td><td>${s.line_count||0}</td>
    <td>${s.status==='DRAFT'?`<button class="btn sm" onclick="openStockCount(${s.id})">Open</button>`:''}
        ${s.status==='DRAFT'?`<button class="btn sm" onclick="postStockCount(${s.id})">Post</button>`:''}</td></tr>`).join('')}</table>`
  : emptyState('📋', 'No count sessions yet. Create one above.')}
  <div id="sc-lines"></div>`;
};
window.createStockCount = async ev => {
  ev.preventDefault();
  try {
    const r = await api('/stock-counts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warehouse_id: +$('#sc-wh').value }) });
    toast(`Count #${r.id} created`);
    openStockCount(r.id);
  } catch (e) { toast(e.message, true); }
  return false;
};
window.openStockCount = async id => {
  try {
    const data = await api('/stock-counts/' + id);
    const lines = data.lines || [];
    const html = `<h2>Count #${id} — ${esc(data.wh_name||'')}</h2>
    <table><tr><th>Code</th><th>Product</th><th class="money">System Qty</th><th>Counted</th><th class="money">Variance</th></tr>
    ${lines.map(l => `<tr><td><b>${esc(l.code)}</b></td><td>${esc(l.product_name)}</td>
      <td class="money">${l.system_qty}</td>
      <td><input type="number" min="0" value="${l.counted_qty ?? ''}" style="width:70px" onchange="updateCountLine(${id},${l.id},this.value)"></td>
      <td class="money ${l.variance > 0 ? 'ok' : l.variance < 0 ? 'low' : ''}">${l.variance ?? '—'}</td></tr>`).join('')}
    </table>`;
    $('#sc-lines').innerHTML = html;
  } catch (e) { toast(e.message, true); }
};
window.updateCountLine = async (sessionId, lineId, qty) => {
  try {
    await api(`/stock-counts/${sessionId}/lines/${lineId}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ counted_qty: Number(qty) }) });
    openStockCount(sessionId);
  } catch (e) { toast(e.message, true); }
};
window.postStockCount = async id => {
  if (!confirm('Post this count? Variance will create stock movements.')) return;
  try {
    await api(`/stock-counts/${id}/post`, { method: 'POST' });
    toast('Count posted');
    views.stockcount();
  } catch (e) { toast(e.message, true); }
};

// ---- Stock Aging View ----
views.stockaging = async () => {
  let data = [];
  try { data = await api('/stock/aging'); } catch(e) { /* empty */ }
  const colorClass = days => {
    if (days < 30) return 'ok';
    if (days < 90) return '';
    if (days < 180) return '';
    return 'low';
  };
  const colorStyle = days => {
    if (days < 30) return 'color:#1b7a3d';
    if (days < 90) return 'color:#b26a00';
    if (days < 180) return 'color:#d47600';
    return 'color:#8a1c1c;font-weight:700';
  };
  main.innerHTML = `
  <div class="viewhead"><h1>Stock Aging Report</h1></div>
  <div class="sub">Products sorted by days since last movement · Green &lt;30d · Yellow 30-90d · Orange 90-180d · Red &gt;180d</div>
  ${data.length ? `<table><tr><th>Code</th><th>Product</th><th>Warehouse</th><th class="money">Qty</th>
    <th class="money">Value</th><th class="money">Idle Days</th><th>Last Movement</th></tr>
  ${data.map(r => {
    const days = r.idle_days ?? r.days_since_last ?? 0;
    return `<tr><td><a href="#" onclick="go('item-${r.product_id}');return false" style="color:inherit"><b>${esc(r.code)}</b></a></td>
      <td>${esc(r.product_name||r.name)} <span class="mut">${esc(r.brand||'')}</span></td>
      <td>${esc(r.wh_name)}</td>
      <td class="money">${r.qty ?? r.physical ?? 0}</td>
      <td class="money">${fmt(r.stock_value ?? r.value ?? 0)}</td>
      <td class="money" style="${colorStyle(days)}">${days}d</td>
      <td class="mut">${r.last_movement || r.last_moved || '—'}</td></tr>`;
  }).join('')}</table>`
  : emptyState('📈', 'No aging data available. Requires stock movements to calculate idle days.')}`;
};

// ---- Reports View ----
views.reports = async () => {
  main.innerHTML = `
  <div class="viewhead"><h1>Reports &amp; Exports</h1></div>
  <div class="sub">Download CSV reports for stock, sales, and invoices</div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
    <div class="kpi jump" onclick="window.open('/api/stock/export','_blank')" style="cursor:pointer">
      <div class="lbl">📦 Stock Report</div>
      <div class="val" style="font-size:16px">Export CSV</div>
      <div class="ksub">Full stock list with qty, value, warehouse breakdown</div>
    </div>
    <div class="kpi jump" onclick="window.open('/api/reports/sales/export','_blank')" style="cursor:pointer">
      <div class="lbl">💰 Sales Report</div>
      <div class="val" style="font-size:16px">Export CSV</div>
      <div class="ksub">Sales orders with revenue, customer, date range</div>
    </div>
    <div class="kpi jump" onclick="window.open('/api/reports/invoices/export','_blank')" style="cursor:pointer">
      <div class="lbl">🧾 Invoice Report</div>
      <div class="val" style="font-size:16px">Export CSV</div>
      <div class="ksub">Invoice list with amounts, payment status</div>
    </div>
  </div>`;
};

// ---- Global Search View ----
views.search = async () => { go('dash'); };

go('dash');
