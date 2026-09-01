// Import ASJ historical invoices into ERP sales_orders; unmatched -> BUCKET-ASJ.
// node import_invoices.js [--commit]   (default: dry-run)
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const DATA = process.env.MTJ_DATA_DIR || '/app/data';
const db = new DatabaseSync(DATA + '/mtj_erp.db');
const COMMIT = process.argv.includes('--commit');

const parsed = JSON.parse(fs.readFileSync('/app/inv_parsed.json', 'utf8')).filter(r => r.ok);

// deterministic date: parsed ISO if valid, else Roman month from invoice number
const ROMAN = { I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10, XI:11, XII:12 };
function invDate(r) {
  const dd = (r.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dd) return dd[0];
  const m = r.inv_num.match(/^(\d+)-INV-([IVX]+|\d+)-(\d{2})$/);
  if (m) {
    const mon = ROMAN[m[2]] || (parseInt(m[2], 10) || 6);
    return `${2000 + parseInt(m[3], 10)}-${String(mon).padStart(2, '0')}-15`;
  }
  return `${2000 + parseInt(r.inv_num.slice(-2), 10)}-06-15`;
}

// ---- customer matching against ERP business_partners ----
function fix(s) {
  return s.replace(/\bKOMPUTER\b/g, 'COMPUTER').replace(/\bMUSIK\b/g, 'MUSIC')
          .replace(/\bTEHNIK\b/g, 'TECHNIK').replace(/\bTEKHNIK\b/g, 'TECHNIK');
}
function toks(s) {
  s = fix((s || '').toUpperCase().replace(/\b(BAPAK|BPK|BU|IBU|PT|CV|PD|TOKO|AND|THE|DAN)\b/g, ' '));
  return new Set(s.split(/[^A-Z0-9]+/).filter(t => t.length > 1));
}
function norm(s) { return fix((s || '').toUpperCase()).replace(/[^A-Z0-9]+/g, ''); }
const masters = db.prepare("SELECT id,name FROM business_partners WHERE kind='CUSTOMER' AND is_active=1")
  .all().map(p => ({ id: p.id, name: p.name, norm: norm(p.name), toks: toks(p.name) }));
if (!masters.length) { console.error('FATAL: no CUSTOMER partners in this DB — wrong snapshot?'); process.exit(1); }
function matchCustomer(cust) {
  const n = norm(cust), t = toks(cust);
  let best = null, bs = 0;
  for (const m of masters) {
    if (m.name === 'BUCKET - ASJ Historical Invoices (review)') continue;
    let s = 0;
    if (m.norm && n && (m.norm.includes(n) || n.includes(m.norm))) s = Math.min(m.toks.size, t.size) * 2 + 2;
    else { const inter = [...m.toks].filter(x => t.has(x)).length; if (inter >= 2) s = inter; }
    if (s > bs) { bs = s; best = m; }
  }
  return bs >= 3 ? best : null;
}

// ---- dedupe same inv_num keeping highest .RevN ----
const byNum = new Map();
for (const r of parsed) {
  const prev = byNum.get(r.inv_num);
  if (!prev) { byNum.set(r.inv_num, r); continue; }
  const rev = x => { const m = (x.file || '').match(/\.Rev(\d)/i); return m ? +m[1] : 0; };
  if (rev(r) > rev(prev)) byNum.set(r.inv_num, r);
}
const rows = [...byNum.values()].sort((a, b) => parseInt(a.inv_num) - parseInt(b.inv_num) || a.inv_num.localeCompare(b.inv_num));
const cnt = {}; rows.forEach(r => { cnt[r.inv_num] = (cnt[r.inv_num] || 0) + 1; });
// shared real numbers -> second copy gets -B suffix so UNIQUE(doc_no) holds
const used = new Set();
for (const r of rows) {
  r.doc_no = r.inv_num;
  if (used.has(r.doc_no)) r.doc_no = r.inv_num + '-B';
  used.add(r.doc_no);
}
const maxNum = Math.max(...rows.map(r => parseInt(r.inv_num)));

let bucket = db.prepare("SELECT id FROM business_partners WHERE kind='CUSTOMER' AND code='BUCKET-ASJ'").get();
if (COMMIT && !bucket) {
  const info = db.prepare(`INSERT INTO business_partners(kind,code,name,customer_type,address)
    VALUES('CUSTOMER','BUCKET-ASJ','BUCKET - ASJ Historical Invoices (review)','REVIEW',
      '[Import ASJ invoice archive 01-09-2026] Unmatched historical invoices: open each document note and reassign to the real customer in CRM.')`).run();
  bucket = { id: Number(info.lastInsertRowid) };
}

if (!COMMIT) {
  let matched = 0, bucketed = 0, sumM = 0, sumB = 0;
  for (const r of rows) {
    const m = matchCustomer(r.customer || '');
    if (m) { matched++; sumM += r.total || 0; } else { bucketed++; sumB += r.total || 0; }
  }
  console.log(`DRY-RUN | partners in db: ${masters.length} | docs ${rows.length} | matched ${matched} (Rp ${sumM.toLocaleString('id')}) | bucket ${bucketed} (Rp ${sumB.toLocaleString('id')}) | max# ${maxNum} | dup doc_no groups ${Object.values(cnt).filter(v => v > 1).length}`);
  process.exit(0);
}

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
// 20 columns / 14 placeholders, explicit order
const insSO = db.prepare(`INSERT INTO sales_orders(
  doc_no,status,version,so_date,customer_id,sales_type,warehouse_id,tax_code,
  subtotal,discount_total,tax_amount,grand_total,invoice_ref,paid_amount,note,
  created_by,approved_by,posted_at,created_at,updated_at)
  VALUES(?, 'POSTED', 1, ?, ?, 'RETAIL', 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`);
let n = 0, matched = 0, bucketed = 0;
db.exec('BEGIN');
for (const r of rows) {
  const m = matchCustomer(r.customer || '');
  const cid = m ? m.id : bucket.id;
  if (m) matched++; else bucketed++;
  const note = `ASJ-${r.inv_num} | billed to: "${r.customer || '?'}"` +
    (cnt[r.inv_num] > 1 ? ' [shared number]' : '') + (r.up ? ` | UP: ${r.up}` : '') + ` | file: ${r.file}`;
  insSO.run(r.doc_no, invDate(r), cid, r.ppn ? 'PPN' : 'NON_PPN',
    r.subtotal || 0, r.discount || 0, r.ppn || 0, r.total || 0,
    r.inv_num, r.total || 0, note,
    invDate(r) + ' 00:00:00', now, now);
  n++;
}
db.exec('COMMIT');
db.prepare(`INSERT INTO doc_sequences(prefix,yr,seq) VALUES('SO',?,?) ON CONFLICT(prefix,yr) DO UPDATE SET seq=max(seq,excluded.seq)`).run(new Date().getFullYear(), maxNum);
try {
  db.prepare(`INSERT INTO audit_trail(user_id,at,module,action,entity,reason) VALUES(1,?,'sales_orders','IMPORT','bulk',?)`)
    .run(now, `ASJ historical invoice import: ${n} docs (matched ${matched}, bucket ${bucketed}) from Drive 01. Quotation & Invoice 2023-2026`);
} catch (e) { console.log('audit insert skipped:', e.message); }
console.log(`COMMITTED ${n} | matched ${matched} | bucket ${bucketed} | SO seq ${new Date().getFullYear()} = ${maxNum}`);
