'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','owner')),
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  catalog_number TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  condition TEXT NOT NULL DEFAULT 'used' CHECK (condition IN ('new','used')),
  defective INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- Залишок конкретного товару на конкретному складі (ТЗ, етап 10)
CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (product_id, warehouse_id)
);

-- Кожна зміна залишку (ТЗ, етап 11)
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  change INTEGER NOT NULL,
  before_qty INTEGER NOT NULL,
  after_qty INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('receipt','sale','adjustment','transfer','return')),
  deal_id TEXT,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invtx_product ON inventory_transactions(product_id, at);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  no INTEGER NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('pickup','delivery')),
  delivery_details TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid','paid')),
  status TEXT NOT NULL CHECK (status IN ('new','done','cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  pay_account TEXT,
  pay_amount REAL,
  pay_currency TEXT,
  pay_rate REAL,
  edited_at TEXT,
  edited_by TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS deal_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price >= 0),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deal_items_deal ON deal_items(deal_id);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('UAH','USD','USDT'))
);

-- Журнал фінансових операцій (ТЗ, етап 12). Баланс = SUM(amount) по рахунку.
CREATE TABLE IF NOT EXISTS financial_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('opening','sale','expense','deposit','transfer','return','adjustment','investment','repayment')),
  deal_id TEXT,
  deal_amount_uah REAL,
  rate REAL,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL,
  taken_by TEXT,
  taken_by_user_id TEXT,
  purpose TEXT,
  recorded_at TEXT NOT NULL,
  deal_currency TEXT,
  investor_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_fintx_account ON financial_transactions(account_id);

-- Донор (авто, з якого знімають запчастини)
CREATE TABLE IF NOT EXISTS donors (
  id TEXT PRIMARY KEY,
  make TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  years TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  template_key TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
`;

const ACCOUNTS = [
  { id: 'CASH_UAH', name: 'Каса UAH', currency: 'UAH' },
  { id: 'CASH_USD', name: 'Каса USD', currency: 'USD' },
  { id: 'CRYPTO_USDT', name: 'Крипто USDT', currency: 'USDT' },
  { id: 'FOP_UAH', name: 'ФОП UAH', currency: 'UAH' },
];

function loadSecret(dataDir) {
  if (process.env.PIN_SECRET) return process.env.PIN_SECRET;
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = open(path.join(dataDir, 'teamcars.db'));
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO accounts (id, name, currency) VALUES (?, ?, ?)');
  ACCOUNTS.forEach(a => ins.run(a.id, a.name, a.currency));
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('next_deal_no', '1')").run();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '1')").run();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1')").run();
  // міграції: нові колонки для вже існуючих баз
  const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
  if (!hasCol('products', 'block')) db.exec('ALTER TABLE products ADD COLUMN block INTEGER');
  if (!hasCol('deals', 'currency')) db.exec("ALTER TABLE deals ADD COLUMN currency TEXT NOT NULL DEFAULT 'UAH'");
  if (!hasCol('financial_transactions', 'deal_currency')) db.exec('ALTER TABLE financial_transactions ADD COLUMN deal_currency TEXT');
  if (!hasCol('financial_transactions', 'investor_user_id')) db.exec('ALTER TABLE financial_transactions ADD COLUMN investor_user_id TEXT');
  // Інвестиції: старі бази мають CHECK без 'investment'/'repayment' — перебудовуємо таблицю, дані зберігаються
  const ftSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_transactions'").get().sql;
  if (!ftSql.includes("'investment'")) {
    const cols = db.prepare('PRAGMA table_info(financial_transactions)').all().map(c => c.name).join(', ');
    const newSql = ftSql.replace("'adjustment')", "'adjustment','investment','repayment')").replace('CREATE TABLE financial_transactions', 'CREATE TABLE financial_transactions_new');
    db.transaction(() => {
      db.exec(newSql);
      db.exec(`INSERT INTO financial_transactions_new (${cols}) SELECT ${cols} FROM financial_transactions`);
      db.exec('DROP TABLE financial_transactions');
      db.exec('ALTER TABLE financial_transactions_new RENAME TO financial_transactions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_fintx_account ON financial_transactions(account_id)');
    })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_fintx_investor ON financial_transactions(investor_user_id)');
  // Структура складу як у каталозі: донор, група/підкатегорія, артикул, виробник, ринкова ціна, сумісність
  const pcols = { donor_id: 'TEXT', grp: "TEXT NOT NULL DEFAULT ''", sub: "TEXT NOT NULL DEFAULT ''", analog: 'INTEGER NOT NULL DEFAULT 0',
    art: 'INTEGER', manufacturer: "TEXT NOT NULL DEFAULT ''", market_price: 'REAL', compat: "TEXT NOT NULL DEFAULT ''", ex_url: 'TEXT', ex_img: 'TEXT' };
  for (const [c, t] of Object.entries(pcols)) if (!hasCol('products', c)) db.exec(`ALTER TABLE products ADD COLUMN ${c} ${t}`);
  if (!hasCol('donors', 'cost')) db.exec('ALTER TABLE donors ADD COLUMN cost REAL');
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('next_art', '1')").run();
  const noArt = db.prepare('SELECT id FROM products WHERE art IS NULL ORDER BY created_at, id').all();
  if (noArt.length) db.transaction(() => {
    let n = Number(db.prepare("SELECT value FROM meta WHERE key = 'next_art'").get().value);
    const up = db.prepare('UPDATE products SET art = ? WHERE id = ?');
    noArt.forEach(r => up.run(n++, r.id));
    db.prepare("UPDATE meta SET value = ? WHERE key = 'next_art'").run(String(n));
  })();
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_catalog ON products(catalog_number)');
  return db;
}

// Валюта цін товарів і нових угод
const PRICE_CURRENCY = 'USD';

module.exports = { openDatabase, loadSecret, ACCOUNTS, PRICE_CURRENCY };
