// Import ASJ historical Delivery Orders (Drive '02. Delivery Order & Goods Return')
// into ERP delivery_orders + delivery_order_lines. node import_do.js [--commit]
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const DATA = process.env.MTJ_DATA_DIR || '/app/data';
const db = new DatabaseSync(DATA + '/mtj_erp.db');
const COMMIT = process.argv.includes('--commit');

const parsed = JSON.parse(fs.readFileSync(process.env.DO_PARSED || '/app/do_parsed.json', 'utf8')).filter(r => r.ok);
const parents = parsed.filter(r => r.doc_kind === 'DELIVERY_ORDER');
const snPages = parsed.filter(r => r.doc_kind === 'SN_ATTACHMENT');

// ---------- customer matching (same tokenizer as invoice import) ----------
function fix(s) {
  return s.replace(/\bKOMPUTER\b/g, 'COMPUTER').replace(/\bMUSIK\b/g, 'MUSIC')
          .replace(/\bTEHNIK\b/g, 'TECHNIK').replace(/\bTEKHNIK\b/g, 'TECHNIK');
}
function toks(s) {
  s = fix((s || '').toUpperCase().replace(/\b(BAPAK|BPK|BU|IBU|PT|CV|PD|TOKO|AND|THE|DAN|GROUP|JAYA|ABADI)\b/g, ' '));
  return new Set(s.split(/[^A-Z0-9]+/).filter(t => t.length > 1));
}
function norm(s) { return fix((s || '').toUpperCase()).replace(/[^A-Z0-9]+/g, ''); }
const masters = db.prepare("SELECT id,name FROM business_partners WHERE kind='CUSTOMER' AND is_active=1")
  .all().map(p => ({ id: p.id, name: p.name, norm: norm(p.name), toks: toks(p.name) }));
if (!masters.length) { console.error('FATAL: no CUSTOMER partners'); process.exit(1); }
function matchCustomer(cust) {
  const n = norm(cust), t = toks(cust);
  if (!n) return null;
  let best = null, bs = 0;
  for (const m of masters) {
    if (m.name.startsWith('BUCKET')) continue;
    let s = 0;
    if (m.norm && (m.norm.includes(n) || n.includes(m.norm))) s = Math.min(m.toks.size, t.size) * 2 + 2;
    else { const inter = [...m.toks].filter(x => t.has(x)).length; if (inter >= 2) s = inter; }
    if (s > bs) { bs = s; best = m; }
  }
  if (bs >= 3) return best;
  // abbreviation: consecutive first-letters of master tokens found in candidate words
  for (const m of masters) {
    if (m.name.startsWith('BUCKET')) continue;
    const words = fix(m.name.toUpperCase()).split(/[^A-Z0-9]+/).filter(w => w.length > 1);
    if (words.length < 2 || words.length > 6) continue;
    const cw = [...t];
    let hit = false;
    for (let i = 0; i + words.length <= cw.length && !hit; i++) {
      hit = words.every((w, k) => cw[i + k] && cw[i + k][0] === w[0] && cw[i + k].length >= 2);
    }
    if (hit) return m;
  }
  return null;
}

// customer: try linked SO's customer first (invoice # -> sales_orders), then text candidates
const soByInv = new Map();
for (const row of db.prepare("SELECT id, doc_no, customer_id FROM sales_orders").all())
  soByInv.set(row.doc_no, row);

function custOf(r) {
  // 1. via invoice link
  if (r.invoice && soByInv.has(r.invoice)) {
    const so = soByInv.get(r.invoice);
    const m = db.prepare('SELECT name FROM business_partners WHERE id=?').get(so.customer_id);
    if (m && !m.name.startsWith('BUCKET')) return { id: so.customer_id, name: m.name, via: 'invoice-SO', so_id: so.id };
    return { so_id: so.id, via: 'invoice-SO-bucket' };
  }
  // 2. direct text match over candidates
  for (const c of (r.cust_all || [])) {
    const m = matchCustomer(c);
    if (m) return { id: m.id, name: m.name, via: 'text:' + c };
  }
  return null;
}

// ---------- product matching: brand+model against products ----------
function normModel(s) { return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
const prods = db.prepare("SELECT id, code, name, brand, model FROM products").all()
  .map(p => ({ ...p, nb: normModel(p.brand || ''), nm: normModel(p.model || ''), nn: normModel(p.name) }));
function matchProduct(brand, model, desc) {
  const nm = normModel(model);
  if (!nm) return null;
  const nb = normModel(brand || '');
  // exact model (+brand when known) wins
  let cands = prods.filter(p => p.nm === nm);
  if (nb && cands.length > 1) { const f = cands.filter(p => p.nb === nb); if (f.length) cands = f; }
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) {
    // disambiguate via desc words
    const nd = normModel(desc || '');
    const scored = cands.map(p => ({ p, s: nd && p.nn && (nd.includes(p.nn) || p.nn.includes(nd)) ? 2 : 0 }));
    scored.sort((a, b) => b.s - a.s);
    if (scored[0].s > 0) return scored[0].p;
    return cands[0]; // model unique-ish; take first
  }
  // model may contain trailing junk tokens; try prefix match of first token
  const first = nm.slice(0, Math.min(nm.length, 6));
  const pre = prods.filter(p => p.nm.startsWith(nm) || nm.startsWith(p.nm) && p.nm.length >= 4);
  if (pre.length === 1) return pre[0];
  return null;
}

// ---------- dedupe parents by do_no ----------
// Same do_no + same invoice + same date -> reprint, keep the richer one.
// Same do_no but different invoice/date -> distinct docs; keep both (2nd gets -B).
const byNo = new Map();   // key -> [variants]
for (const r of parents) {
  let placed = false;
  for (const [key, group] of byNo) {
    if (key !== r.do_no) continue;
    const same = group.find(g => (g.invoice || '') === (r.invoice || '') && (g.date || '').slice(0, 7) === (r.date || '').slice(0, 7));
    if (same) {
      const score = x => (x.items ? x.items.length : 0) + (x.invoice ? 1 : 0);
      if (score(r) > score(same)) group[group.indexOf(same)] = r;
    } else group.push(r);
    placed = true; break;
  }
  if (!placed) byNo.set(r.do_no, [r]);
}
const rows = [];
for (const [no, group] of byNo) {
  group.sort((a, b) => (b.items || []).length - (a.items || []).length);
  group.forEach((r, i) => { r.doc_key = i === 0 ? r.do_no : r.do_no + '-B' + i; rows.push(r); });
}
rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

// SN pages attach to parent by do_no
const snByNo = new Map();
for (const s of snPages) if (!snByNo.has(s.do_no)) snByNo.set(s.do_no, s);

// ---------- PDF attachment helpers ----------
const PDFS = process.env.DO_PDFS || '';
const fsX = require('fs'), pathX = require('path');
const ATT_DIR = pathX.join(DATA, 'uploads', 'attachments');
function attachPdf(docId, fileName, urlOut) {
  // fileName = original parsed file name (pre2026__/y2026__ stripped at parse time is stored in r.file)
  if (!PDFS) return null;
  let src = null;
  for (const pre of fsX.readdirSync(PDFS)) {
    if (pre.endsWith('__' + fileName)) { src = pathX.join(PDFS, pre); break; }
  }
  if (!src) return null;
  const clean = fileName.replace(/[^\w.\- ]/g, '_').slice(-80);
  const stored = `delivery_orders-${docId}-${Date.now()}-${clean}`;
  fsX.copyFileSync(src, pathX.join(ATT_DIR, stored));
  const size = fsX.statSync(pathX.join(ATT_DIR, stored)).size;
  const url = '/uploads/attachments/' + stored;
  db.prepare(`INSERT INTO doc_attachments(table_name,doc_id,filename,stored_path,size_bytes,mime,uploaded_by)
    VALUES('delivery_orders',?,?,?,?, 'application/pdf', 1)`).run(docId, clean, url, size);
  return url;
}
if (PDFS) fsX.mkdirSync(ATT_DIR, { recursive: true });

// ---------- report / commit ----------
let stat = { matched: 0, bucket: 0, soLink: 0, withItems: 0, prodMatched: 0, prodMiss: 0, snAttach: 0 };
const missProds = new Map();
for (const r of rows) {
  const c = custOf(r);
  r._cust = c;
  if (c && c.id) stat.matched++; else stat.bucket++;
  if (c && c.so_id) stat.soLink++;
  if (r.items && r.items.length) stat.withItems++;
  for (const it of (r.items || [])) {
    const p = matchProduct(it.brand, it.model, it.desc);
    it._pid = p ? p.id : null;
    if (p) stat.prodMatched++; else { stat.prodMiss++; missProds.set((it.brand || '?') + ' ' + it.model, (missProds.get((it.brand || '?') + ' ' + it.model) || 0) + 1); }
  }
  if (snByNo.has(r.do_no)) stat.snAttach++;
}

let bucket = db.prepare("SELECT id FROM business_partners WHERE kind='CUSTOMER' AND code='BUCKET-ASJ'").get();

if (!COMMIT) {
  console.log(`DRY-RUN parents ${rows.length} | cust matched ${stat.matched} bucket ${stat.bucket} | SO-linked ${stat.soLink} | withItems ${stat.withItems} | lines prod ${stat.prodMatched}/${stat.prodMatched + stat.prodMiss} | SN pages attachable ${stat.snAttach} (${snPages.length} total)`);
  const top = [...missProds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('top unmatched models:', JSON.stringify(top));
  const nb = rows.filter(r => !r._cust || !r._cust.id).slice(0, 20).map(r => r.do_no + ' <- ' + (r.cust_all && r.cust_all[0] || '?'));
  console.log('bucket sample:', nb.join(' | '));
  process.exit(0);
}

if (!bucket) {
  const info = db.prepare(`INSERT INTO business_partners(kind,code,name,customer_type,address)
    VALUES('CUSTOMER','BUCKET-ASJ','BUCKET - ASJ Historical Invoices (review)','REVIEW',
      '[Import DO archive 01-09-2026] Unmatched historical docs: open each note and reassign to the real customer in CRM.')`).run();
  bucket = { id: Number(info.lastInsertRowid) };
}

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const insDO = db.prepare(`INSERT INTO delivery_orders(
  doc_no,status,version,do_date,sales_order_id,purpose,warehouse_id,recipient_name,note,signed_copy_url,
  created_by,approved_by,posted_at,closed_at,created_at,updated_at)
  VALUES(?, 'LOCKED', 1, ?, ?, ?, 1, ?, ?, ?, 1, 1, ?, ?, ?, ?)`);
const insLine = db.prepare(`INSERT INTO delivery_order_lines(delivery_order_id,sales_order_line_id,product_id,qty) VALUES(?,?,?,?)`);

let n = 0, matched = 0, bucketed = 0, linesN = 0, orphanLines = 0, attN = 0;
db.exec('BEGIN');
for (const r of rows) {
  const c = r._cust || {};
  const cid = c.id || bucket.id;
  if (c.id) matched++; else bucketed++;
  const note = `[DO import 01-09-2026] file: ${r.file} | billed: ${r.invoice || '-'}` +
    (r.quotation ? ` | quote: ${r.quotation}` : '') +
    ` | cust: ${c.id ? c.name : 'UNMATCHED "' + ((r.cust_all || []).slice(0, 2).join(' / ')) + '" -> BUCKET-ASJ'}` +
    (c.via ? ` (via ${c.via})` : '') +
    (r.ocr ? ' | parsed via OCR' : '') + (r.date_est ? ' | date estimated from DO#' : '');
  const info = insDO.run(r.doc_key, r.date, c.so_id || null, r.purpose,
    (r.cust_lines && r.cust_lines[0]) || null, note, null,
    r.date + ' 00:00:00', r.date + ' 00:00:00', now, now);
  const id = Number(info.lastInsertRowid);
  for (const it of (r.items || [])) {
    if (it._pid) { insLine.run(id, null, it._pid, it.qty); linesN++; }
    else orphanLines++;
  }
  // attach the DO PDF itself + matching SN attachment page if any
  if (attachPdf(id, r.file, r.tag)) attN++;
  const sn = snByNo.get(r.do_no);
  if (sn && attachPdf(id, sn.file, sn.tag)) { attN++; stat.snAttach++; }
  n++;
}
// doc_sequences for DO/SJ aligned above historical numbering
const maxSeq = Math.max(...rows.map(r => parseInt(r.do_no) || 0));
const yr = new Date().getFullYear();
db.prepare(`INSERT INTO doc_sequences(prefix,yr,seq) VALUES('DO',?,?) ON CONFLICT(prefix,yr) DO UPDATE SET seq=max(seq,excluded.seq)`).run(yr, maxSeq);
db.prepare(`INSERT INTO doc_sequences(prefix,yr,seq) VALUES('SJ',?,?) ON CONFLICT(prefix,yr) DO UPDATE SET seq=max(seq,excluded.seq)`).run(yr, maxSeq);
db.prepare(`INSERT INTO audit_trail(user_id,at,module,action,entity,reason) VALUES(1,?,'delivery_orders','IMPORT','bulk',?)`)
  .run(now, `ASJ historical DO import: ${n} docs (matched ${matched}, bucket ${bucketed}, lines ${linesN}, unmatched-model lines ${orphanLines}) from Drive 02. Delivery Order & Goods Return`);
db.exec('COMMIT');
console.log(`COMMITTED ${n} DOs | matched ${matched} | bucket ${bucketed} | lines ${linesN} (dropped-model lines ${orphanLines}) | seq ${yr} DO/SJ = ${maxSeq}`);
