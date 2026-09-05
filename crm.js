// CRM module — leads pipeline, follow-ups/activities, customer 360 (Blueprint extension)
'use strict';
const { db, audit, nextDocNo } = require('./db.js');

const rows = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const STAGES = ['NEW', 'CONTACTED', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'];

// owner must be a real users row (Basic-auth principal id=1 may not exist -> fall back to NULL)
function validOwner(uid) {
  if (!uid) return null;
  return one(`SELECT id FROM users WHERE id = ?`, uid) ? uid : null;
}

function createLead(user, b) {
  const company = String(b.company || '').trim();
  if (!company) throw new Error('Company name is required');
  const stage = STAGES.includes(b.stage) ? b.stage : 'NEW';
  const leadNo = nextDocNo('LEAD');
  const info = run(`INSERT INTO crm_leads(lead_no, company, pic_name, phone, email, address, source,
      stage, est_value, interest, owner_id, next_followup, note, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    leadNo, company, b.pic_name || null, b.phone || null, b.email || null, b.address || null,
    b.source || null, stage, Number(b.est_value) || 0, b.interest || null,
    validOwner(b.owner_id) ?? validOwner(user.id), b.next_followup || null, b.note || null, user.id);
  const id = Number(info.lastInsertRowid);
  audit(user.id, 'crm', 'CREATE', { docNo: leadNo, entity: id, newv: company });
  return one(`SELECT * FROM crm_leads WHERE id = ?`, id);
}

function updateLead(user, id, b) {
  const cur = one(`SELECT * FROM crm_leads WHERE id = ?`, id);
  if (!cur) throw new Error('Lead not found');
  const F = ['company', 'pic_name', 'phone', 'email', 'address', 'source', 'stage',
    'interest', 'next_followup', 'lost_reason', 'note'];
  const sets = [], vals = [];
  for (const f of F) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
  if (b.est_value !== undefined) { sets.push('est_value = ?'); vals.push(Number(b.est_value) || 0); }
  if (b.owner_id !== undefined) { sets.push('owner_id = ?'); vals.push(b.owner_id || null); }
  if (!sets.length) return cur;
  sets.push(`updated_at = datetime('now')`);
  run(`UPDATE crm_leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  if (b.stage && b.stage !== cur.stage)
    audit(user.id, 'crm', 'STAGE', { docNo: cur.lead_no, entity: id, old: cur.stage, new: b.stage });
  else audit(user.id, 'crm', 'UPDATE', { docNo: cur.lead_no, entity: id });
  return one(`SELECT * FROM crm_leads WHERE id = ?`, id);
}

// ---- lead -> customer conversion (WON flow) ----
function convertLead(user, id, b) {
  const l = one(`SELECT * FROM crm_leads WHERE id = ?`, id);
  if (!l) throw new Error('Lead not found');
  if (l.customer_id) return { customer_id: l.customer_id, converted: true };
  if (!b || !b.kind || !['CUSTOMER', 'SUPPLIER'].includes(b.kind)) b = { kind: 'CUSTOMER' };
  const code = String(b.code || ('CUST-' + String(l.id).padStart(4, '0'))).trim().toUpperCase();
  const dup = one(`SELECT id FROM business_partners WHERE kind = ? AND name = ?`, b.kind, l.company);
  if (dup) {
    run(`UPDATE crm_leads SET customer_id = ?, stage = 'WON', updated_at = datetime('now') WHERE id = ?`, dup.id, id);
    audit(user.id, 'crm', 'CONVERT', { docNo: l.lead_no, entity: id, new: 'customer#' + dup.id });
    return { customer_id: dup.id, converted: true, existing: true };
  }
  const info = run(`INSERT INTO business_partners(kind, code, name, pic, phone, email, address)
    VALUES(?,?,?,?,?,?,?)`,
    b.kind, code, l.company, l.pic_name, l.phone, l.email, l.address);
  const cid = Number(info.lastInsertRowid);
  run(`UPDATE crm_leads SET customer_id = ?, stage = 'WON', updated_at = datetime('now') WHERE id = ?`, cid, id);
  audit(user.id, 'crm', 'CONVERT', { docNo: l.lead_no, entity: id, new: 'customer#' + cid });
  return { customer_id: cid, converted: true };
}

function listLeads(stage) {
  const where = stage && STAGES.includes(stage) ? `WHERE l.stage = ?` : '';
  return rows(`SELECT l.*, u.username owner_name, bp.name customer_name
    FROM crm_leads l LEFT JOIN users u ON u.id = l.owner_id
    LEFT JOIN business_partners bp ON bp.id = l.customer_id
    ${where} ORDER BY CASE l.stage WHEN 'WON' THEN 1 WHEN 'LOST' THEN 2 ELSE 0 END, l.id DESC`,
    ...(where ? [stage] : []));
}

// ---- follow-ups / activities (lead OR customer) ----
function addActivity(user, b) {
  if (!b.lead_id && !b.customer_id) throw new Error('activity needs lead_id or customer_id');
  const TYPES = ['CALL', 'VISIT', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER'];
  const type = TYPES.includes(b.activity_type) ? b.activity_type : 'OTHER';
  const summary = String(b.summary || '').trim();
  if (!summary) throw new Error('summary is required');
  const info = run(`INSERT INTO crm_activities(lead_id, customer_id, activity_type, summary, result, due_date, done_at, done_by)
    VALUES(?,?,?,?,?,?,NULL,?)`,
    b.lead_id || null, b.customer_id || null, type, summary, b.result || null,
    b.due_date || null, validOwner(user.id));
  return one(`SELECT * FROM crm_activities WHERE id = ?`, Number(info.lastInsertRowid));
}

function listActivities(leadId, customerId) {
  if (leadId) return rows(`SELECT a.*, u.username done_by_name FROM crm_activities a
    LEFT JOIN users u ON u.id = a.done_by WHERE a.lead_id = ? ORDER BY a.id DESC LIMIT 100`, leadId);
  if (customerId) return rows(`SELECT a.*, u.username done_by_name FROM crm_activities a
    LEFT JOIN users u ON u.id = a.done_by WHERE a.customer_id = ? ORDER BY a.id DESC LIMIT 100`, customerId);
  return rows(`SELECT a.*, u.username done_by_name FROM crm_activities a
    LEFT JOIN users u ON u.id = a.done_by ORDER BY a.id DESC LIMIT 100`);
}

function followupsDue(days) {
  return rows(`SELECT a.*, u.username done_by_name,
      CASE WHEN a.lead_id IS NOT NULL THEN (SELECT company FROM crm_leads WHERE id = a.lead_id)
           ELSE (SELECT name FROM business_partners WHERE id = a.customer_id) END target,
      a.lead_id, a.customer_id
    FROM crm_activities a LEFT JOIN users u ON u.id = a.done_by
    WHERE a.done_at IS NULL AND a.due_date IS NOT NULL
      AND a.due_date <= date('now', '+' || ? || ' days')
    ORDER BY a.due_date LIMIT 20`, days || 7);
}

function completeActivity(user, id, result) {
  const a = one(`SELECT * FROM crm_activities WHERE id = ?`, id);
  if (!a) throw new Error('Activity not found');
  run(`UPDATE crm_activities SET done_at = datetime('now'), result = COALESCE(?, result) WHERE id = ?`,
    result || null, id);
  audit(user.id, 'crm', 'FOLLOWUP_DONE', { entity: id, docNo: a.summary ? String(a.summary).slice(0, 40) : null });
  return one(`SELECT * FROM crm_activities WHERE id = ?`, id);
}

// ---- customer 360: master + every document that touched them ----
function customer360(id) {
  const c = one(`SELECT * FROM business_partners WHERE id = ?`, id);
  if (!c) return null;
  return {
    customer: c,
    leads: rows(`SELECT * FROM crm_leads WHERE customer_id = ? ORDER BY id DESC`, id),
    quotations: rows(`SELECT id, doc_no, status, quote_date, grand_total FROM quotations WHERE customer_id = ? ORDER BY id DESC LIMIT 25`, id),
    sales_orders: rows(`SELECT id, doc_no, status, so_date, sales_type, grand_total, paid_amount FROM sales_orders WHERE customer_id = ? ORDER BY id DESC LIMIT 25`, id),
    projects: rows(`SELECT id, project_code, name, status, contract_value FROM projects WHERE customer_id = ? ORDER BY id DESC`, id),
    warranties: rows(`SELECT id, warranty_no, status, warranty_start, warranty_end FROM warranties WHERE customer_id = ? ORDER BY id DESC`, id),
    service_orders: rows(`SELECT id, doc_no, status, received_at, complaint FROM service_orders WHERE customer_id = ? ORDER BY id DESC LIMIT 25`, id),
    activities: listActivities(null, id),
    totals: {
      orders: one(`SELECT COUNT(*) n, COALESCE(SUM(grand_total),0) v FROM sales_orders WHERE customer_id = ? AND status = 'POSTED'`, id),
      outstanding: one(`SELECT COALESCE(SUM(grand_total - COALESCE(paid_amount,0)),0) v FROM sales_orders WHERE customer_id = ? AND status = 'POSTED'`, id),
      // AR outstanding from invoices table (matches by customer name)
      ar_outstanding: one(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE customer_name LIKE ? AND status != 'PAID'`,
        `%${c.name}%`),
      ar_overdue: one(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE customer_name LIKE ? AND (status = 'OVERDUE' OR (due_date < date('now') AND status = 'UNPAID'))`,
        `%${c.name}%`),
      invoices: rows(`SELECT invoice_no, amount, status, due_date, invoice_date FROM invoices WHERE customer_name LIKE ? ORDER BY invoice_date DESC LIMIT 10`,
        `%${c.name}%`),
    },
  };
}

// ---- CRM aggregates for dashboard2 + Lisa ----
function summary() {
  const byStage = {};
  for (const s of STAGES) byStage[s] = { n: 0, value: 0 };
  for (const r of rows(`SELECT stage, COUNT(*) n, COALESCE(SUM(est_value),0) v FROM crm_leads GROUP BY stage`)) {
    if (byStage[r.stage]) byStage[r.stage] = { n: r.n, value: r.v };
  }
  return {
    by_stage: byStage,
    open_leads: byStage.NEW.n + byStage.CONTACTED.n + byStage.QUOTED.n + byStage.NEGOTIATION.n,
    open_value: byStage.NEW.value + byStage.CONTACTED.value + byStage.QUOTED.value + byStage.NEGOTIATION.value,
    won: byStage.WON.n,
    lost: byStage.LOST.n,
    followups_due: followupsDue(7).length,
    recent_activities: listActivities(null, null).slice(0, 5),
  };
}

module.exports = { STAGES, createLead, updateLead, convertLead, listLeads, addActivity,
  listActivities, followupsDue, completeActivity, customer360, summary };



