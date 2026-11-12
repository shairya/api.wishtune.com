-- 001_initial_schema.sql — Wishtune CRM (schema v2)
--
-- A contact is identified by its numeric id. Emails and mobiles that point
-- to a contact live in contact_identifiers (UNIQUE per type+value), so the
-- matching rule can later move from "email" to "email + mobile" without a
-- schema change. Money is DECIMAL in the order's own currency (INR first,
-- USD supported); nothing is converted. All DATETIME columns are UTC.

-- ---------------------------------------------------------------------
-- Admin logins
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'admin',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  is_revoked TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_refresh_token_hash (token_hash),
  KEY idx_refresh_user (user_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Contacts: one person
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  primary_email VARCHAR(255) NULL,         -- copy of the primary email identifier (lists/search)
  primary_mobile VARCHAR(20) NULL,         -- copy of the primary mobile identifier (E.164)
  mobile_added_at DATETIME NULL,           -- when primary_mobile was last set (bot delay)
  first_name VARCHAR(120) NULL,
  last_name VARCHAR(120) NULL,
  country VARCHAR(100) NULL,
  state VARCHAR(100) NULL,
  stage ENUM('contact','subscriber','customer','repeat_buyer') NOT NULL,
  lead_source ENUM('buyer','signup','contact_message') NOT NULL,
  first_page_seen VARCHAR(100) NULL,
  utm_source VARCHAR(255) NULL,
  utm_medium VARCHAR(255) NULL,
  utm_campaign VARCHAR(255) NULL,
  email_consent TINYINT(1) NULL,
  email_consent_at DATETIME NULL,
  unsubscribed TINYINT(1) NOT NULL DEFAULT 0,
  unsubscribed_at DATETIME NULL,
  purchase_count INT UNSIGNED NOT NULL DEFAULT 0,       -- every completed order, free ones included (drives stage)
  paid_purchase_count INT UNSIGNED NOT NULL DEFAULT 0,  -- orders where money was paid
  first_purchase_at DATETIME NULL,
  last_purchase_at DATETIME NULL,
  last_paid_purchase_at DATETIME NULL,
  last_coupon_code VARCHAR(100) NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,            -- team/test contact: kept out of audiences, stats, bots
  internal_reason VARCHAR(20) NULL,                     -- 'rule' (Settings test list) or 'manual'
  merged_into_id INT UNSIGNED NULL,                     -- set when merged into another contact
  last_event_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_contacts_email (primary_email),
  KEY idx_contacts_mobile (primary_mobile),
  KEY idx_contacts_stage (stage),
  KEY idx_contacts_internal (is_internal),
  KEY idx_contacts_last_purchase (last_purchase_at),
  KEY idx_contacts_created (created_at),
  KEY idx_contacts_merged (merged_into_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every email / mobile that identifies a contact. One value → one contact.
CREATE TABLE IF NOT EXISTS contact_identifiers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id INT UNSIGNED NOT NULL,
  type ENUM('email','mobile') NOT NULL,
  value VARCHAR(255) NOT NULL,             -- normalised: lowercased email / E.164 mobile
  value_raw VARCHAR(320) NULL,             -- as first received
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(30) NULL,                 -- payhip | signup | contact_form | import | admin
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_identifier (type, value),
  KEY idx_identifier_contact (contact_id),
  CONSTRAINT fk_identifier_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for future merges (email + mobile matching).
CREATE TABLE IF NOT EXISTS contact_merges (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  survivor_id INT UNSIGNED NOT NULL,
  merged_id INT UNSIGNED NOT NULL,
  reason VARCHAR(255) NULL,
  merged_by INT UNSIGNED NULL,
  snapshot JSON NULL,                      -- the merged contact + identifiers before the merge
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_merges_survivor (survivor_id),
  KEY idx_merges_merged (merged_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Imports (Payhip CSV / Excel)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(30) NOT NULL DEFAULT 'payhip',
  file_name VARCHAR(255) NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  is_dry_run TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running',   -- running | completed | failed
  rows_total INT UNSIGNED NOT NULL DEFAULT 0,
  rows_created INT UNSIGNED NOT NULL DEFAULT 0,    -- new order saved (contact new or existing)
  rows_duplicate INT UNSIGNED NOT NULL DEFAULT 0,  -- order already in the CRM
  rows_rejected INT UNSIGNED NOT NULL DEFAULT 0,   -- bad email / missing order id / unreadable
  contacts_created INT UNSIGNED NOT NULL DEFAULT 0,
  report JSON NULL,
  run_by VARCHAR(150) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  KEY idx_import_hash (file_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Events: every incoming event / admin action is a row
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id INT UNSIGNED NULL,
  source VARCHAR(30) NOT NULL,          -- payhip | import | signup | contact_form | admin | bot | system
  type VARCHAR(40) NOT NULL,            -- sale | refund | signup | contact_message | note | unsubscribe | ...
  status VARCHAR(20) NOT NULL DEFAULT 'processed', -- processed | rejected | duplicate | ignored
  dedupe_key VARCHAR(191) NULL,         -- e.g. payhip:paid:<order id> (shared by webhook and import)
  matched_by VARCHAR(20) NULL,          -- which identifier found the contact: email | mobile
  email_raw VARCHAR(320) NULL,
  summary VARCHAR(500) NULL,
  details JSON NULL,
  payload JSON NULL,
  error VARCHAR(500) NULL,
  stage_before VARCHAR(20) NULL,
  stage_after VARCHAR(20) NULL,
  created_by INT UNSIGNED NULL,
  import_batch_id INT UNSIGNED NULL,
  occurred_at DATETIME NULL,            -- when it happened at the source
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_events_dedupe (dedupe_key),
  KEY idx_events_contact (contact_id, created_at),
  KEY idx_events_status (status, created_at),
  KEY idx_events_type (type),
  KEY idx_events_batch (import_batch_id),
  CONSTRAINT fk_events_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Products: MT-001..MT-015 = format × focus
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_code VARCHAR(20) NOT NULL,       -- MT-001
  format ENUM('shower','party','sleep') NOT NULL,
  focus ENUM('love','beauty','health','wealth','everything') NOT NULL,
  name VARCHAR(255) NOT NULL,              -- "Shower Mixtape — Love" (as on Payhip)
  name_key VARCHAR(255) NOT NULL,          -- normalised name used to match Payhip/CSV item names
  payhip_product_key VARCHAR(100) NULL,
  payhip_product_id VARCHAR(100) NULL,
  payhip_permalink VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_products_code (product_code),
  UNIQUE KEY uq_products_format_focus (format, focus),
  UNIQUE KEY uq_products_name_key (name_key),
  UNIQUE KEY uq_products_key (payhip_product_key),
  UNIQUE KEY uq_products_pid (payhip_product_id),
  UNIQUE KEY uq_products_permalink (payhip_permalink)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- List price per currency (INR is the main one; USD kept as an option).
CREATE TABLE IF NOT EXISTS product_prices (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_price (product_id, currency),
  CONSTRAINT fk_price_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Orders (Payhip) — from the webhook or an import, never both
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payhip_order_id VARCHAR(100) NOT NULL,
  contact_id INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  list_amount DECIMAL(12,2) NULL,          -- price before discount
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_gross DECIMAL(12,2) NOT NULL DEFAULT 0,   -- what the customer paid
  amount_net DECIMAL(12,2) NULL,                   -- after Payhip + gateway fees
  payhip_fee DECIMAL(12,2) NULL,
  gateway_fee DECIMAL(12,2) NULL,
  coupon_code VARCHAR(100) NULL,
  coupon_pct DECIMAL(5,2) NULL,
  used_coupon TINYINT(1) NOT NULL DEFAULT 0,
  is_free TINYINT(1) NOT NULL DEFAULT 0,           -- amount_gross = 0
  payment_type VARCHAR(30) NULL,                   -- free | razorpay | stripe | paypal
  status VARCHAR(30) NOT NULL DEFAULT 'completed', -- completed | refunded | partially_refunded
  refunded_amount DECIMAL(12,2) NULL,
  refunded_at DATETIME NULL,
  country VARCHAR(100) NULL,
  state VARCHAR(100) NULL,
  downloads INT UNSIGNED NULL,
  ordered_at DATETIME NOT NULL,
  date_precision ENUM('second','day') NOT NULL DEFAULT 'second',  -- imports only know the day
  source ENUM('webhook','import') NOT NULL,
  import_batch_id INT UNSIGNED NULL,
  event_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_orders_payhip (payhip_order_id),
  KEY idx_orders_contact (contact_id),
  KEY idx_orders_date (ordered_at),
  CONSTRAINT fk_orders_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NULL,            -- NULL until the product is mapped (Settings → Products)
  payhip_product_name VARCHAR(255) NULL,
  payhip_product_id VARCHAR(100) NULL,
  payhip_product_key VARCHAR(100) NULL,
  payhip_permalink VARCHAR(255) NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  unit_list_price DECIMAL(12,2) NULL,
  currency CHAR(3) NULL,
  KEY idx_items_order (order_id),
  KEY idx_items_product (product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Settings + bots
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_outreach (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id INT UNSIGNED NOT NULL,
  channel ENUM('voice','whatsapp') NOT NULL,
  provider VARCHAR(30) NOT NULL,
  status ENUM('queued','sent','completed','failed','skipped') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  mobile VARCHAR(20) NULL,
  external_id VARCHAR(191) NULL,
  last_error VARCHAR(500) NULL,
  result JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_outreach_contact_channel (contact_id, channel),
  KEY idx_outreach_status (status),
  KEY idx_outreach_external (external_id),
  CONSTRAINT fk_outreach_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
('bots', JSON_OBJECT(
  'voice', JSON_OBJECT('enabled', false, 'provider', 'teleagent'),
  'whatsapp', JSON_OBJECT('enabled', false, 'provider', 'wylto'),
  'delayMinutes', 10,
  'eligibleStages', JSON_ARRAY('contact','subscriber','customer','repeat_buyer'),
  'businessHours', JSON_OBJECT('start', '09:00', 'end', '21:00'),
  'batchSize', 20,
  'maxAttempts', 3
)),
-- Team/test contacts (editable in Settings → Test contacts).
('internal', JSON_OBJECT(
  'emails', JSON_ARRAY('abhishekhxlnc@gmail.com', 'sumit.shairya@gmail.com', 'ashmitaworkid@gmail.com', 'notsorial@gmail.com'),
  'domains', JSON_ARRAY('xlncacademy.com', 'xlnctechnologies.com'),
  'coupons', JSON_ARRAY()
));

-- MT-001..MT-015: Shower (001-005), Party (006-010), Sleep (011-015)
--                 × Love, Beauty, Health, Wealth, Everything
INSERT IGNORE INTO products (product_code, format, focus, name, name_key) VALUES
('MT-001','shower','love','Shower Mixtape — Love','shower mixtape - love'),
('MT-002','shower','beauty','Shower Mixtape — Beauty','shower mixtape - beauty'),
('MT-003','shower','health','Shower Mixtape — Health','shower mixtape - health'),
('MT-004','shower','wealth','Shower Mixtape — Wealth','shower mixtape - wealth'),
('MT-005','shower','everything','Shower Mixtape — Everything','shower mixtape - everything'),
('MT-006','party','love','Party Mixtape — Love','party mixtape - love'),
('MT-007','party','beauty','Party Mixtape — Beauty','party mixtape - beauty'),
('MT-008','party','health','Party Mixtape — Health','party mixtape - health'),
('MT-009','party','wealth','Party Mixtape — Wealth','party mixtape - wealth'),
('MT-010','party','everything','Party Mixtape — Everything','party mixtape - everything'),
('MT-011','sleep','love','Sleep Mixtape — Love','sleep mixtape - love'),
('MT-012','sleep','beauty','Sleep Mixtape — Beauty','sleep mixtape - beauty'),
('MT-013','sleep','health','Sleep Mixtape — Health','sleep mixtape - health'),
('MT-014','sleep','wealth','Sleep Mixtape — Wealth','sleep mixtape - wealth'),
('MT-015','sleep','everything','Sleep Mixtape — Everything','sleep mixtape - everything');

-- Current list prices: INR (main) and USD (earlier international pricing).
INSERT IGNORE INTO product_prices (product_id, currency, price)
SELECT id, 'INR', CASE format WHEN 'shower' THEN 999 WHEN 'party' THEN 1999 ELSE 1499 END FROM products;
INSERT IGNORE INTO product_prices (product_id, currency, price)
SELECT id, 'USD', CASE format WHEN 'shower' THEN 12 WHEN 'party' THEN 24 ELSE 18 END FROM products;
