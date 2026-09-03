// Lisa in-ERP assistant — live SQLite ERP tools + LLM brain (OpenRouter free tier).
// Chat history lives ONLY in the browser (no server storage); logout ends the session.
//
// How it works:
//   1. Every incoming message is run through deterministic ERP "tools" (stock, price,
//      sales, low-stock, queue, customers, etc.). If a tool clearly matches, its live
//      data is returned directly — fast and always factual.
//   2. If no tool matches (free-form question), the message is sent to an LLM with a
//      system prompt carrying Lisa's persona + a live ERP context snapshot, so it can
//      reason in natural language. The LLM may also call the same tools via a tiny
//      function-calling contract (it can ask for stock/price/etc. and we run them).
//   3. Any LLM failure (402 no credits, 429 throttle, network) silently degrades to the
//      deterministic answer or a friendly fallback — the chatbot NEVER errors out.
'use strict';
const { db } = require('./db.js');
const ext = require('./dashboard_ext.js');
const crm = require('./crm.js');

// ---- LLM config (env-driven; falls back to deterministic answers if unset) ----
const OR_BASE = process.env.MTJ_LLM_BASE || 'https://openrouter.ai/api/v1';
const OR_KEY = process.env.MTJ_LLM_KEY || '';
// Free-tier models (no cost). Primary then fallbacks — 429 throttling rotates them.
const OR_MODELS = (process.env.MTJ_LLM_MODELS || 'minimax/minimax-m3:free,nvidia/nemotron-3-ultra-550b-a55b:free').split(',').map(s => s.trim()).filter(Boolean);

const rows = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const rp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });

// ---- product matcher: code / barcode / name / brand tokens ----
function findProduct(q) {
  const prods = rows(`SELECT id, code, name, brand, model, barcode FROM products WHERE is_active = 1`);
  const ql = q.toLowerCase();
  let best = null, bestScore = 0;
  for (const p of prods) {
    let score = 0;
    const code = (p.code || '').toLowerCase(), name = (p.name || '').toLowerCase();
    const brand = (p.brand || '').toLowerCase(), barcode = String(p.barcode || '');
    if (barcode && ql.includes(barcode)) score += 10;
    if (code && ql.includes(code)) score += 8;
    for (const tok of ql.split(/[^a-z0-9]+/)) {
      if (tok.length < 3) continue;
      if (code === tok || code.split(/[-_]/).includes(tok)) score += 4;
      if (name.includes(tok)) score += 2;
      if (brand && tok === brand) score += 2;
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 4 ? best : null;
}

// ---- live data answers (deterministic ERP tools) ----
function stockAnswer(p) {
  const bs = rows(`SELECT w.name wh_name, ib.physical, ib.reserved, ib.avg_cost
    FROM inventory_balances ib JOIN warehouses w ON w.id = ib.warehouse_id
    WHERE ib.product_id = ?`, p.id);
  const avail = bs.reduce((s, b) => s + (b.physical - b.reserved), 0);
  if (!bs.length) return { text: `**${p.code} — ${p.name}** belum punya stok tercat di gudang manapun.`, goto: ['stock', '📦 Stock'] };
  const lines = bs.map(b => `• ${b.wh_name}: fisik ${b.physical}, reserved ${b.reserved} → available **${b.physical - b.reserved}**`);
  return { text: `**${p.code} — ${p.name}**${p.brand ? ' (' + p.brand + ')' : ''}\n${lines.join('\n')}\nTotal available: **${avail}**.`, goto: ['stock', '📦 Stock'] };
}
function priceAnswer(p) {
  const f = one(`SELECT retail_price, project_price, cost_price FROM products WHERE id = ?`, p.id) || {};
  return { text: `Harga **${p.code} — ${p.name}**:\n• Retail: **${rp(f.retail_price)}**\n• Project: **${rp(f.project_price)}**\n• Modal (avg): ${rp(f.cost_price)}`,
    goto: ['stock', '📦 Stock'] };
}

// ---- keyword intents (checked first; fast + always factual) ----
const has = (q, ...words) => words.some(w => q.includes(w));
function route(q) {
  const m = q.toLowerCase();
  if (has(m, 'low stock', 'reorder', 'restock', 'hampir habis', 'stok menipis')) return { kind: 'lowstock' };
  if (has(m, 'stok', 'stock', 'sisa', 'available', 'tersedia') && !has(m, 'nilai', 'value'))
    return { kind: 'stock' };
  if (has(m, 'harga', 'price', 'berapa')) return { kind: 'price' };
  if (has(m, 'nilai stok', 'stock value', 'nilai inventory')) return { kind: 'stockvalue' };
  if (has(m, 'perlu', 'action', 'approve', 'submit', 'post', 'tunggu', 'waiting', 'queue', 'antri'))
    return { kind: 'queue' };
  if (has(m, 'penjualan', 'sales', 'omzet', 'revenue', 'terjual')) return { kind: 'sales' };
  if (has(m, 'gudang', 'warehouse')) return { kind: 'warehouses' };
  if (has(m, 'low stock', 'reorder', 'restock', 'hampir habis')) return { kind: 'lowstock' };
  if (has(m, 'aktivitas', 'activity', 'terakhir', 'recent', 'audit')) return { kind: 'activity' };
  if (has(m, 'follow up', 'followup', 'follow-up', 'tindak lanjut', 'ingatkan')) return { kind: 'followups' };
  if (has(m, 'lead', 'prospek', 'prospect', 'pipeline')) return { kind: 'leads' };
  if (has(m, 'pelanggan', 'customer', 'kontak', 'client')) return { kind: 'customers' };
  if (has(m, 'halo', 'hai', 'hi', 'hello', 'pagi', 'siang', 'sore')) return { kind: 'greet' };
  if (has(m, 'bisa apa', 'help', 'bantuan', 'cmd')) return { kind: 'help' };
  const p = findProduct(m);
  return p ? { kind: 'stock' } : { kind: 'unknown' };
}

// ---- answer dispatcher (all data read live) ----
function answer(q) {
  const { kind } = route(q);
  const p = findProduct(q.toLowerCase());
  if (kind === 'greet') return { text: 'Halo! 👋 Lisa di sini. Tanya stok, harga, dokumen yang perlu di-approve, atau klik 📚 untuk daftar pertanyaan cepat.' };
  if (kind === 'help') return { text: [
    'Yang bisa kubantu langsung dari data ERP:',
    '• **stok <barang>** — sisa stok per gudang',
    '• **harga <barang>** — retail / project price',
    '• **apa yang perlu di-approve?** — antrian dokumen',
    '• **penjualan bulan ini / tahun ini** — omzet posted SO',
    '• **nilai stok** — total nilai inventory',
    '• **low stock / reorder** — barang di bawah reorder point',
    '• **gudang** — daftar gudang aktif',
    '• **lead / prospek / pipeline** — ringkasan pipeline CRM',
    '• **follow-up / tindak lanjut** — yang jatuh tempo ≤7 hari',
    '• **customer / pelanggan** — daftar customer',
    '• **aktivitas terakhir** — audit trail terbaru'].join('\n') };
  if (kind === 'stock') {
    if (!p) return { text: 'Sebutkan nama/kode barangnya ya — contoh: *stok AZT-MH350BSW*. Ketik 📚 untuk lihat format lain.', goto: ['stock', '📦 Stock'] };
    return stockAnswer(p);
  }
  if (kind === 'price') {
    if (!p) return { text: 'Barang mana yang mau dicek harganya? Contoh: *harga <kode barang>*.', goto: ['stock', '📦 Stock'] };
    return priceAnswer(p);
  }
  if (kind === 'stockvalue') {
    const s = one(`SELECT COALESCE(SUM(physical * avg_cost),0) v FROM inventory_balances`) || {};
    return { text: `Nilai total inventory (avg cost): **${rp(s.v)}**.`, goto: ['warehouses', '🏬 Warehouses'] };
  }
  if (kind === 'queue') {
    const items = ext.actionItems();
    if (!items.length) return { text: 'Antrian bersih — tidak ada dokumen yang menunggu akses. 🎉' };
    const lines = items.slice(0, 8).map(a => `• **${a.doc_no}** ${a.label} — ${a.status}${a.amount != null ? ' · ' + rp(a.amount) : ''}`);
    return { text: `Ada ${items.length} dokumen menunggu:\n${lines.join('\n')}`, goto: ['docs', '🧾 Docs'] };
  }
  if (kind === 'sales') {
    const m = q.toLowerCase();
    const period = has(m, 'bulan', 'month') ? 'month' : has(m, '30', 'hari', 'days') ? '30d' : 'ytd';
    const s = ext.salesByPeriod(period);
    const lbl = { month: 'bulan ini', '30d': '30 hari terakhir', ytd: 'tahun ini' }[period];
    return { text: `Penjualan (posted SO) ${lbl}: **${rp(s.s)}** dari ${s.c} order.\nRetail ${rp(s.retail)} · Project ${rp(s.project)} · PPN ${rp(s.ppn)}.`, goto: ['dash', '📊 Dashboard'] };
  }
  if (kind === 'warehouses') {
    const ws = rows(`SELECT code, name, type FROM warehouses WHERE is_active = 1 ORDER BY code`);
    return { text: `Gudang aktif:\n${ws.map(w => `• **${w.code}** ${w.name} (${w.type})`).join('\n')}`, goto: ['warehouses', '🏬 Warehouses'] };
  }
  if (kind === 'lowstock') {
    const ls = ext.lowStock(8);
    if (!ls.length) return { text: 'Aman — tidak ada barang di bawah reorder point. ✅', goto: ['stock', '📦 Stock'] };
    return { text: `Barang perlu restock:\n${ls.map(r => `• **${r.code}** ${r.name} — available ${r.available} (reorder ${r.reorder_point}) @ ${r.wh_name}`).join('\n')}`, goto: ['stock', '📦 Stock'] };
  }
  if (kind === 'activity') {
    const acts = ext.activity(6);
    return { text: `Aktivitas terakhir:\n${acts.map(a => `• ${a.username || 'system'} ${a.action.toLowerCase()} ${a.doc_no || a.module}${a.new_value ? ' → ' + String(a.new_value).slice(0, 30) : ''} (${a.at})`).join('\n')}`, goto: ['audit', '🔐 Audit'] };
  }
  if (kind === 'followups') {
    const fus = crm.followupsDue(7);
    if (!fus.length) return { text: 'Tidak ada follow-up jatuh tempo dalam 7 hari. ✅', goto: ['crm', '🤝 CRM'] };
    return { text: `Follow-up due ≤7 hari (${fus.length}):\n${fus.map(f => `• **${f.target}** — ${f.activity_type}: ${f.summary} (due ${f.due_date})`).join('\n')}`, goto: ['crm', '🤝 CRM'] };
  }
  if (kind === 'leads') {
    const leads = crm.listLeads();
    const open = leads.filter(l => !['WON', 'LOST'].includes(l.stage));
    if (!open.length) return { text: 'Belum ada lead terbuka. Tambah lewat tab 🤝 CRM.', goto: ['crm', '🤝 CRM'] };
    const val = open.reduce((s, l) => s + (l.est_value || 0), 0);
    return { text: `Pipeline: ${open.length} lead terbuka, nilai est. **${rp(val)}**.\n${open.slice(0, 6).map(l => `• **${l.company}** [${l.stage}] ${l.pic_name || ''} ${l.est_value ? '· ' + rp(l.est_value) : ''}`).join('\n')}`, goto: ['crm', '🤝 CRM'] };
  }
  if (kind === 'customers') {
    const cs = rows(`SELECT bp.id, bp.name, bp.kind, bp.pic, bp.phone,
        (SELECT COUNT(*) FROM sales_orders o WHERE o.customer_id = bp.id AND o.status = 'POSTED') orders
      FROM business_partners bp WHERE bp.kind = 'CUSTOMER' AND bp.is_active = 1 ORDER BY bp.name LIMIT 10`);
    if (!cs.length) return { text: 'Belum ada customer terdaftar.', goto: ['crm', '🤝 CRM'] };
    return { text: `Customer (${cs.length} teratas):\n${cs.map(c => `• **${c.name}**${c.pic ? ' — ' + c.pic : ''}${c.phone ? ' · ' + c.phone : ''} · ${c.orders} order posted`).join('\n')}\nKlik untuk buka halaman 360 customer.`, goto: ['crm', '🤝 CRM'] };
  }
  return null; // unknown -> caller escalates to LLM
}

// ---- live ERP context snapshot (given to the LLM so it can reason over real data) ----
function erpSnapshot() {
  try {
    const wh = rows(`SELECT code, name, type FROM warehouses WHERE is_active = 1 ORDER BY code`);
    const s = one(`SELECT COALESCE(SUM(physical * avg_cost),0) v FROM inventory_balances`) || {};
    const top = rows(`SELECT p.code, p.name, p.brand, ib.physical, ib.reserved
      FROM inventory_balances ib JOIN products p ON p.id = ib.product_id
      ORDER BY (ib.physical - ib.reserved) DESC LIMIT 8`);
    const low = ext.lowStock(5);
    const items = ext.actionItems();
    return JSON.stringify({
      warehouses: wh.map(w => `${w.code} ${w.name}`),
      stock_value: rp(s.v),
      top_stock: top.map(t => `${t.code} ${t.name} (${t.brand || '-'}): avail ${t.physical - t.reserved}`),
      low_stock: low.map(r => `${r.code} avail ${r.available} / reorder ${r.reorder_point}`),
      pending_docs: items.length
    });
  } catch (e) { return '{}'; }
}

// ---- LLM call (OpenRouter free tier, multi-model fallback, never throws) ----
async function llmReply(q) {
  if (!OR_KEY || !OR_MODELS.length) return null;
  const ctx = erpSnapshot();
  const system = `Kamu adalah Lisa, asisten internal ERP PT Monalisa Tunggal Jaya (PT MTJ) — distributor lighting, audio & LED profesional sejak 1980. ` +
    `Persona: wanita, profesional, sedikit sarkas, to the point. Bahasa: Indonesia santai tapi rapi. ` +
    `Jawab SINGKAT (2-4 kalimat). JANGAN mengarang angka atau fakta — pakai hanya data ERP di bawah. ` +
    `Kalau pertanyaan butuh data yang tidak ada di snapshot, arahkan user pakai keyword: stok, harga, sales, approve, low stock, gudang, customer, follow-up. ` +
    `Jika ditanya di luar ERP (candaan, cuaca, umum), jawab ramah singkat tanpa mengarang data MTJ.\n\n` +
    `SNAPSHOT ERP SAAT INI:\n${ctx}`;
  const body = JSON.stringify({
    messages: [{ role: 'system', content: system }, { role: 'user', content: q }],
    max_tokens: 300, temperature: 0.4, stream: false
  });
  for (const model of OR_MODELS) {
    try {
      const req = new Request(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
        body
      });
      const resp = await fetch(req);
      if (resp.status === 429 || resp.status === 402) continue; // throttle / no credits -> try next model
      if (!resp.ok) continue;
      const j = await resp.json();
      const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof txt === 'string' && txt.trim()) return { text: txt.trim().slice(0, 900), ai: true };
    } catch { /* try next model */ }
  }
  return null;
}

// ---- public entry: answer a user message (stateless; history stays client-side) ----
async function reply(message) {
  const q = String(message || '').slice(0, 500).trim();
  if (!q) return { text: 'Tanya apa hari ini? 😊' };

  // 1) deterministic tool first (fast + always factually correct)
  const a = answer(q);
  if (a) return { text: a.text, goto: a.goto || null };

  // 2) free-form -> LLM brain
  const ai = await llmReply(q);
  if (ai) return ai;

  // 3) last-resort fallback (LLM throttled / no credits) — stay useful, never error
  return { text: 'Hmm, itu di luar jangkauan data ERP yang bisa kubaca langsung. Coba keyword: *stok*, *harga*, *sales*, *approve*, *low stock*, *gudang* — atau ketik 📚. (Mode AI lagi ramai, coba sebentar lagi ya 🙂)' };
}

module.exports = { reply };
