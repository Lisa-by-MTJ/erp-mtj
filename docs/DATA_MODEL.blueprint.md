# MTJ Channel Manager — Master System Blueprint V2.0 (blueprint-faithful)
# ONE DATABASE → ONE TRANSACTION ENGINE → FULL TRACEABILITY
record "Agency / Brand House" = null;
type ProductType { FINISHED_GOODS SPAREPART MATERIAL ACCESSORIES ASSET }
type Uom { PCS UNIT SET M M2 KGS LTR }
enum SerialPolicy { NONE REQUIRED BATCH }
enum CurrencyCode { IDR USD EUR MYR CNY SGD AUD }
enum TaxCode { PPN NON_PPN TAX_EXEMPT } // PPN 11%
enum DocStatus { DRAFT SUBMITTED UNDER_REVIEW APPROVED POSTED LOCKED REJECTED }
enum MovementType {
  OPENING PURCHASE_IN RETURN_IN TRANSFER_IN SERVICE_RETURN SALES_OUT PROJECT_DELIVERY_OUT
  TRANSFER_OUT SERVICE_ISSUE DAMAGE ADJUSTMENT
}
enum ReceivingType { LOCAL_PURCHASE IMPORT_PURCHASE CUSTOMER_RETURN PROJECT_RETURN WAREHOUSE_TRANSFER SERVICE_RETURN ADJUSTMENT OTHER }
type WarehouseType { MAIN PROJECT SERVICE TRANSIT }
enum WarrantyStatus { ACTIVE EXPIRED CLAIMED SERVICE REPLACED CLOSED }
enum ServiceStatus { RECEIVED WAITING_DIAGNOSIS DIAGNOSIS_WAITING_SPAREPART REPAIRING TESTING QC COMPLETED WAITING_CUSTOMER DELIVERED CLOSED }
enum ProjectStatus { LEAD QUOTATION CONTRACTED IN_PROGRESS DELIVERED BILLING COMPLETED CLOSED CANCELLED }
enum CustomerType { RETAIL PROJECT DEALER CONTRACTOR CONSULTANT GOVERNMENT CORPORATE OTHER }

// §4.1 Product classification: Asset/Equipment items are MTJ-owned, not for sale
rule product_asset_not_sellable: product.type == ASSET => excluded from sales inventory

// §5 Serial-numbered products: Moving Head, Speaker, Amplifier, LED Processor,
// Controller, Camera, Projector. One SN must never belong to two active products.
table products {
  id           snowflake
  code         varchar(32)  // SKU
  barcode      varchar(64)
  name         varchar(200)
  brand        varchar(80)
  model        varchar(120)
  type         ProductType
  category     varchar(80)   // Lighting / Audio / LED Visual / ...
  subcategory  varchar(80)
  description  text
  spec         text
  uom          Uom
  serial_policy SerialPolicy
  warranty_months int default 12
  cost_price   decimal(18,2)   // average cost
  last_cost    decimal(18,2)
  retail_price decimal(18,2)
  project_price decimal(18,2)
  min_stock    int default 0
  reorder_point int default 0
  default_supplier_id snowflake
  is_active    bool default true
  created_at   timestamp
  indexes { unique(code), unique(barcode) where barcode != '' }
}

table warehouses {
  id snowflake
  code varchar(16)      // WH-JKT-MAIN etc
  name varchar(120)
  type WarehouseType
  address text
  is_active bool
}

// warehouse location structure (§8): zone > rack > shelf > bin (prepared, phase-later detail)
table wh_locations {
  id snowflake
  warehouse_id snowflake
  zone varchar(24)
  rack varchar(24)
  shelf varchar(24)
  bin varchar(24)
}

table business_partners {
  id snowflake
  kind PartnerKind // CUSTOMER | SUPPLIER
  code varchar(24)
  name varchar(200)
  customer_type CustomerType
  pic varchar(120)
  phone varchar(40)
  email varchar(160)
  npwp varchar(40)
  pkp_status TaxCode
  payment_term_days int
  credit_limit decimal(18,2)
  currency CurrencyCode
  address text
  city varchar(80)
  province varchar(80)
  country varchar(80) default 'Indonesia'
  status varchar(20) // ACTIVE / BLACKLIST
  lead_time_days int         // supplier only
  warranty_policy varchar(120) // supplier only
  is_active bool
  indexes { unique(kind, code), unique(kind, name) }
}

table users {
  id snowflake
  username varchar(60) unique
  full_name varchar(120)
  role UserRole // SUPER_ADMIN DIRECTOR MANAGEMENT FINANCE ACCOUNTING PURCHASING WAREHOUSE SALES MARKETING PROJECT_MANAGER SERVICE_ADMIN SERVICE_TECHNICIAN FIELD_TECHNICIAN
  password_hash varchar(200)
  is_active bool
}

// §4.2 currencies & tax (§9)
table fx_rates {
  id snowflake
  currency CurrencyCode
  rate_to_idr decimal(18,6)
  rate_date date
}

// ============================================================
// DOCUMENT ENGINE + NUMBERING (§48) QT-/PR-/PO-/GRN-/DO-/SJ-/INV-/WAR-/SRV-/WO--YYYY-#####
// every doc: doc_no unique sequential traceable non-duplicable (§48)
// ============================================================
signature document_mixin {
  id            snowflake
  doc_no        varchar(24)  // from Document Numbering Engine
  status        DocStatus    // §11 lifecycle DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED→POSTED→LOCKED
  version       int default 1        // §49 document versioning, history retained
  created_by    snowflake
  approved_by   snowflake nullable
  posted_at     timestamp nullable
  note          text
  created_at timestamp
  updated_at timestamp
}

// §13 PURCHASING — Purchase Request
table purchase_requests (document_mixin) {
  pr_date date
  supplier_id snowflake nullable
  requester_note text
}
table purchase_request_lines {
  id snowflake
  purchase_request_id snowflake
  product_id snowflake
  qty decimal(18,3)
  note varchar(200)
}

// §13/§14 PURCHASE ORDER (+ landed cost for import)
table purchase_orders (document_mixin) {
  po_date date
  supplier_id snowflake
  po_type ReceivingType // LOCAL_PURCHASE | IMPORT_PURCHASE
  currency CurrencyCode
  fx_rate decimal(18,6) default 1
  expected_date date nullable
  warehouse_id snowflake   // destination
  goods_value decimal(18,2)  // in original currency
  freight decimal(18,2) default 0       // §14
  insurance decimal(18,2) default 0
  duty_customs decimal(18,2) default 0
  ppn_import decimal(18,2) default 0
  forwarder decimal(18,2) default 0
  handling decimal(18,2) default 0
  port_charges decimal(18,2) default 0
  bank_charges decimal(18,2) default 0
  other_cost decimal(18,2) default 0
  landed_cost_total decimal(18,2) default 0
}
table purchase_order_lines {
  id snowflake
  purchase_order_id snowflake
  product_id snowflake
  qty decimal(18,3)
  unit_price decimal(18,2)  // original currency
  discount_pct decimal(5,2) default 0
  line_total decimal(18,2)  // base-currency amount stored per §9
}

// §15 WAREHOUSE RECEIVING — stock IN only after CONFIRMED (POSTED)
table receivings (document_mixin) {
  receiving_type ReceivingType
  receive_date date
  purchase_order_id snowflake nullable
  partner_id snowflake nullable   // supplier or returner
  warehouse_id snowflake
  received_by snowflake
  condition_check bool default true  // QC
  qc_notes varchar(300)
}
table receiving_lines {
  id snowflake
  receiving_id snowflake
  product_id snowflake
  qty decimal(18,3)
  unit_cost decimal(18,2)  // landed unit cost IDR (§14)
}

// §22 QUOTATION — Retail & Project; statuses per §22; converts to SO or Project
table quotations (document_mixin) {
  quote_date date
  valid_until date
  quotation_kind QuoteKind // RETAIL | PROJECT
  customer_id snowflake
  salesperson_id snowflake
  tax_code TaxCode
  subtotal decimal(18,2)
  discount_total decimal(18,2)
  tax_amount decimal(18,2)
  grand_total decimal(18,2)
  project_id snowflake nullable   // link when PROJECT kind
}
table quotation_lines {
  id snowflake
  quotation_id snowflake
  product_id snowflake
  description_override varchar(240)
  qty decimal(18,3)
  unit_price decimal(18,2)
  discount_pct decimal(5,2)
  line_total decimal(18,2)
}

// §23 RETAIL SALES: Customer→Quotation→SO→Payment/Credit→Picking→DO→SJ→Invoice Ref→Warranty
table sales_orders (document_mixin) {
  so_date date
  customer_id snowflake
  salesperson_id snowflake
  source_quotation_id snowflake nullable
  sales_type SalesType // RETAIL | PROJECT
  project_id snowflake nullable
  warehouse_id snowflake
  tax_code TaxCode
  subtotal/discount_total/tax_amount/grand_total decimal(18,2)
  invoice_ref varchar(40) nullable   // §36 financial reference layer
  paid_amount decimal(18,2) default 0
}
table sales_order_lines {
  id snowflake
  sales_order_id snowflake
  product_id snowflake
  qty decimal(18,3)
  unit_price decimal(18,2)
  discount_pct decimal(5,2)
  reserved_qty decimal(18,3) default 0
  delivered_qty decimal(18,3) default 0
  line_total decimal(18,2)
}

// §24 PROJECT MASTER — core module
table projects (document_mixin) {
  project_code varchar(24)
  name varchar(200)
  customer_id snowflake
  site_location varchar(200)
  salesperson_id snowflake
  project_manager_id snowflake
  source_quotation_id snowflake nullable
  contract_value decimal(18,2)
  start_date date
  end_date date nullable
  billing_terms json // §25 DP/Progress1..3/Retention/Final/Other
  status ProjectStatus
}
// §25 PROJECT BILLING — separated from physical delivery (§26)
table project_billings {
  id snowflake
  project_id snowflake
  seq int               // DP=0, P1..Pn, RETENTION, FINAL
  label varchar(60)
  percent decimal(5,2)
  amount decimal(18,2)
  invoice_ref varchar(40)
  due_date date nullable
  paid_amount decimal(18,2) default 0
  paid_at date nullable
  status BillingStatus // PLANNED INVOICED PARTIAL PAID
}

// §19 RESERVATION ENGINE — Sales may only consume Available Stock
table reservations {
  id snowflake
  reservation_no varchar(24)   // RSV-YYYY-#####
  project_id snowflake nullable
  sales_order_id snowflake nullable
  warehouse_id snowflake
  requested_by snowflake
  approved_by snowflake nullable
  status ResvStatus // RESERVED ALLOCATED CONSUMED RELEASED
  created_at timestamp
}
table reservation_lines {
  id snowflake
  reservation_id snowflake
  product_id snowflake
  qty decimal(18,3)
}

// §20 STOCK MOVEMENT ENGINE — every inventory change emits a movement; no manual edits
table stock_movements {
  id snowflake
  movement_type MovementType
  product_id snowflake
  warehouse_id snowflake
  serial_id snowflake nullable
  qty_delta decimal(18,3)   // signed
  ref_table varchar(30)
  ref_id snowflake
  ref_no varchar(24)
  moved_at timestamp
  by_user snowflake
}

// Inventory Engine (§18): balances maintained by the transaction engine only
table inventory_balances {
  id snowflake
  product_id snowflake
  warehouse_id snowflake
  physical decimal(18,3) default 0
  reserved decimal(18,3) default 0
  available == physical - reserved   // computed invariant (§18 formula)
  avg_cost decimal(18,2) default 0
  indexes { unique(product_id, warehouse_id) }
}

// §5 SERIAL NUMBER ENGINE — SN never duplicated on two active products
table serial_numbers {
  id snowflake
  product_id snowflake
  serial varchar(64)
  batch_no varchar(40) nullable
  status SnStatus // IN_STOCK RESERVED SOLD_DELIVERED IN_SERVICE WARRANTY_CLAIM RETURNED SCRAPPED
  current_warehouse_id snowflake nullable
  current_partner_id snowflake nullable  // customer holding it
  purchase_order_id snowflake nullable
  warranty_start date nullable
  warranty_end date nullable
  indexes { unique(product_id, serial) }
}

// §28 DO + SURAT JALAN (3 copies: Customer/MTJ Admin/Warehouse)
table delivery_orders (document_mixin) {
  do_date date
  sales_order_id snowflake nullable
  project_id snowflake nullable
  warehouse_id snowflake
  vehicle_info varchar(120)
  driver_name varchar(80)
  surat_jalan_no varchar(24)
  recipient_name varchar(120)
  signed_copy Attachment nullable // uploaded signed copy closes flow
}
table delivery_order_lines {
  id snowflake
  delivery_order_id snowflake
  sales_order_line_id snowflake nullable
  product_id snowflake
  serial_id snowflake nullable
  qty decimal(18,3)
}

// §29 WARRANTY ENGINE — cert auto-created from retail sale/project delivery/SN
table warranties {
  id snowflake
  warranty_no varchar(24)  // WAR-
  customer_id snowflake
  product_id snowflake
  serial_id snowflake nullable
  source_type WarrantySource // RETAIL_SALES PROJECT_DELIVERY
  source_doc_no varchar(24)
  purchase_date date
  delivery_date date nullable
  warranty_start date
  warranty_end date
  months int
  status WarrantyStatus
}

// §30 WARRANTY CLAIM: problem→photo→diagnosis→repair/replacement→tech→cost→supplier claim→closed
table warranty_claims {
  id snowflake
  claim_no varchar(24)
  warranty_id snowflake
  reported_at date
  problem text
  diagnosis text
  resolution text
  repair_cost decimal(18,2) default 0
  supplier_claim_ref varchar(40)
  technician_id snowflake
  status ClaimStatus // OPEN DIAGNOSED IN_REPAIR RESOLVED CLOSED REJECTED
}

// §31/§32 SERVICE CENTER
table service_orders (document_mixin) {
  customer_id snowflake
  product_id snowflake
  serial_id snowflake nullable
  complaint text
  condition_in varchar(200)
  accessories_in varchar(200)
  diagnosis text
  technician_id snowflake nullable
  parts_used json
  labor_cost decimal(18,2) default 0
  parts_cost decimal(18,2) default 0
  target_date date nullable
  completed_at timestamp nullable
  result varchar(200)
  qc_passed bool
  cust_confirmed bool
  rating int // 1-5
  status ServiceStatus
}

// §33 FIELD TECHNICIAN — Work Order / Surat Kerja Lapangan
table work_orders (document_mixin) {
  project_id snowflake nullable
  customer_id snowflake nullable
  location varchar(200)
  scheduled_date date
  checkin_at timestamp nullable
  checkout_at timestamp nullable
  technicians json          // [user ids]
  supervisor_id snowflake nullable
  work_description text
  materials_used json
  problems text
  solutions text
  photo_before Attachments  // §17 shared attachment engine
  photo_during Attachments
  photo_after Attachments
  customer_signature varchar(120) nullable
  rating int nullable
}

// §35 PROJECT COST ENGINE
table project_costs {
  id snowflake
  project_id snowflake
  category CostCategory // MATERIAL PURCHASE TECHNICIAN INSTALLATION TRANSPORT ACCOMMODATION OTHER
  description varchar(240)
  amount decimal(18,2)
  cost_date date
  ref_no varchar(24) nullable
}
// billing/payment refs (§36 Financial Reference Layer — no full accounting in MVP)

// §11 APPROVAL + §12 AUDIT TRAIL: user/date/module/doc/action/old/new/reason/approver
table audit_trail {
  id snowflake
  user_id snowflake
  at timestamp
  module varchar(40)
  doc_no varchar(24)
  action varchar(40)
  entity snowflake nullable
  field varchar(80) nullable
  old_value text nullable
  new_value text nullable
  reason varchar(240)
  approval_ref varchar(24) nullable
}

// §17 one shared attachment engine for ALL modules
table attachments {
  id snowflake
  entity_table varchar(40)
  entity_id snowflake
  att_type AttachmentType // PRODUCT_PHOTO RECEIVING DO SIGNED_SJ SERVICE WARRANTY PROJECT DOCUMENT_SCAN
  file_name varchar(200)
  mime varchar(80)
  storage_url varchar(400)   // abstraction layer: local disk now, cloud later (§50)
  uploaded_by snowflake
  uploaded_at timestamp
  description varchar(240)
}

table app_settings { key varchar(60) primary, value text } // ppn_rate, company profile

===== TRANSACTION ENGINE RULES =====
rule trx_engine_source_of_truth: inventory_balances && stock_movements are writable ONLY by
  the transaction engine; no UI writes stocks directly (§2.2, §20).
rule posting_gate: a document may POST only when status==APPROVED; posting emits movements,
  updates balances, stamps posted_at, then LOCKED. Locked docs change via correction+approval.
rule sn_handshake: receiving with serial_policy REQUIRED must register each SN (unique per product),
  moving an SN to RESERVED/SOLD requires an active reservation/delivery referencing it (§5).
rule warranty_birth: posting a SO(RETAIL) line or PROJECT delivery of a serializable product
  creates a warranty certificate WAR-... starting on invoice/delivery date (§29).
rule number_seq: doc numbers allocated atomically {prefix}-{year}-{seq:05d}; gaps allowed,
  duplicates impossible (§48).
rule negative_stock_guard: posting that would push physical<0 is rejected without approval (§55);
  reservations may not exceed physical - already_reserved (sales uses Available only, §19).
rule duplicate_guards (§55): unique SKU/barcode/(product,serial)/doc_no enforced at DB level.
