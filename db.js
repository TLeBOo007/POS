'use strict';
// ฐานข้อมูล SQLite (ในตัว Node ไม่ต้องติดตั้งอะไรเพิ่ม)
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('hq','branch','staff')),
  branch_id INTEGER REFERENCES branches(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cat TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  opts INTEGER NOT NULL DEFAULT 1,
  pos INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS branch_items (
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  item_id INTEGER NOT NULL REFERENCES menu_items(id),
  price INTEGER CHECK (price IS NULL OR price >= 0),
  sold_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, item_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  date TEXT NOT NULL,
  no INTEGER NOT NULL,
  client_id TEXT,
  created_at TEXT NOT NULL,
  lines TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  pay TEXT NOT NULL CHECK (pay IN ('cash','transfer','other')),
  received INTEGER,
  void INTEGER NOT NULL DEFAULT 0,
  void_at TEXT,
  user_id INTEGER REFERENCES users(id),
  void_reason TEXT,
  void_by INTEGER REFERENCES users(id),
  void_restock INTEGER NOT NULL DEFAULT 0,
  UNIQUE (branch_id, date, no),
  UNIQUE (branch_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_branch_date ON orders (branch_id, date);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders (date);
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  pos INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS recipes (
  item_id INTEGER NOT NULL REFERENCES menu_items(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  qty REAL NOT NULL CHECK (qty > 0),
  PRIMARY KEY (item_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS topping_recipes (
  top_idx INTEGER NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  qty REAL NOT NULL CHECK (qty > 0),
  PRIMARY KEY (top_idx, ingredient_id)
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  kind TEXT NOT NULL CHECK (kind IN ('sale','receive','waste','count','void_return','void_redo')),
  qty REAL NOT NULL,
  expected REAL,
  order_id INTEGER REFERENCES orders(id),
  user_id INTEGER REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_branch_ing ON stock_moves (branch_id, ingredient_id);
CREATE INDEX IF NOT EXISTS idx_moves_branch_date ON stock_moves (branch_id, date);
CREATE INDEX IF NOT EXISTS idx_moves_order ON stock_moves (order_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_branch ON audit (branch_id, id);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// ทำหลายคำสั่งเป็นก้อนเดียว สำเร็จทั้งหมดหรือไม่ทำเลย
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { open, tx };
