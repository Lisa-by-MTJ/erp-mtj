// Seed masters + opening data (blueprint-consistent examples)
'use strict';
const { db, audit, moveStock, nextDocNo } = require('./db.js');

const wh = (code, name, type) => db.prepare(
  `INSERT INTO warehouses(code,name,type) VALUES(?,?,?)`).run(code, name, type);
const partner = (kind, code, name, extra = {}) => {
  const info = db.prepare(`INSERT INTO business_partners(kind,code,name,customer_type,pic,phone,pkp_status,payment_term_days,city,address)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(kind, code, name, extra.type || null, extra.pic || null, extra.phone || null,
         extra.pkp || 'PKP', extra.term ?? 30, extra.city || null, extra.address || null);
  return Number(info.lastInsertRowid);
};
const product = (o) => {
  const info = db.prepare(`INSERT INTO products(code,barcode,name,brand,model,type,category,uom,serial_policy,warranty_months,cost_price,last_cost,retail_price,project_price,min_stock,reorder_point)
    VALUES(@code,@barcode,@name,@brand,@model,@type,@category,@uom,@sp,@wm,@cp,@lc,@rp,@pp,@ms,@ro)`).run({
    barcode: null, model: null, type: 'FINISHED_GOODS', uom: 'PCS', sp: 'NONE', wm: 12, cp: 0, lc: 0, rp: 0, pp: 0, ms: 0, ro: 0, ...o });
  return Number(info.lastInsertRowid);
};

if (db.prepare(`SELECT COUNT(*) n FROM warehouses`).get().n > 0) {
  console.log('[seed] already seeded, skipping');
} else {
  // Warehouses (§8)
  const whMain = wh('WH-JKT-MAIN', 'Main Warehouse Jakarta', 'MAIN').lastInsertRowid;
  wh('WH-PROJECT', 'Project Warehouse', 'PROJECT');
  wh('WH-SERVICE', 'Service Warehouse', 'SERVICE');

  // Users (§10)
  const hash = s => s; // single-tenant internal tool; password gate is the Basic Auth layer
  db.prepare(`INSERT INTO users(username,full_name,role,password_hash) VALUES(?,?,?,?)`)
    .run('admin', 'System Administrator', 'SUPER_ADMIN', hash('-'));
  db.prepare(`INSERT INTO users(username,full_name,role,password_hash) VALUES(?,?,?,?)`)
    .run('teknisi1', 'Field Technician One', 'FIELD_TECHNICIAN', hash('-'));

  // Partners
  const cPallas = partner('CUSTOMER', 'C0001', 'The Pallas (SCBD)', { type: 'PROJECT', city: 'Jakarta' });
  const cMirror = partner('CUSTOMER', 'C0002', 'Mirror Club (Seminyak)', { type: 'PROJECT', city: 'Badung' });
  partner('CUSTOMER', 'C0003', 'Walk-in Retail Cash', { type: 'RETAIL', term: 0, pkp: 'NON_PPN' });
  const sAztec = partner('SUPPLIER', 'S0001', 'Aztec Lighting Principal', { city: 'Jakarta', term: 45 });
  partner('SUPPLIER', 'S0002', 'Proel / Eikon Principal (via PT ASJ)', { city: 'Jakarta', term: 30 });

  // Products (§4) — brand portfolio of MTJ
  const pMH   = product({ code: 'AZT-MH350BSW', name: 'Moving Head Beam 350W BSW', brand: 'AZTEC',
    model: 'MH350', category: 'Lighting', sp: 'REQUIRED', wm: 24, cp: 18500000, rp: 28500000, pp: 26000000, ms: 2, ro: 2 });
  const pSpk  = product({ code: 'PRO-DIVA15A', name: 'Active Speaker 15in 1000W DIVA15A', brand: 'Proel',
    category: 'Audio', sp: 'REQUIRED', wm: 24, cp: 9200000, rp: 14500000, pp: 13200000, ms: 2, ro: 2 });
  const pSub  = product({ code: 'PRO-SUB18A', name: 'Active Subwoofer 18in 1500W', brand: 'Proel',
    category: 'Audio', sp: 'NONE', wm: 24, cp: 11500000, rp: 17500000, pp: 16000000 });
  const pCab  = product({ code: 'CAB-XLR10', name: 'XLR Cable 10m Proel Stage', brand: 'Proel Stage',
    category: 'Accessories', type: 'ACCESSORIES', cp: 120000, rp: 250000 });
  const pLed  = product({ code: 'LED-P3IND', name: 'LED Panel P3 Indoor (per panel)', brand: 'AZTEC',
    category: 'LED Visual', uom: 'PCS', wm: 12, cp: 6800000, rp: 10500000, pp: 9500000, ms: 8, ro: 8 });

  // Opening stock via the transaction engine only (§20 OPENING movement)
  moveStock({ productId: pCab, warehouseId: Number(whMain), qtyDelta: 200, type: 'OPENING', refTable: 'seed', userId: 1, avgCost: 120000 });
  moveStock({ productId: pLed, warehouseId: Number(whMain), qtyDelta: 40, type: 'OPENING', refTable: 'seed', userId: 1, avgCost: 6800000 });

  // FX (§9)
  db.prepare(`INSERT INTO fx_rates(currency,rate_to_idr,rate_date) VALUES(?,?,date('now'))`).run('USD', 16500);

  console.log('[seed] done:', { cPallas, cMirror, sAztec, products: [pMH, pSpk, pSub, pCab, pLed] });
}
