'use strict';
// เซิร์ฟเวอร์ระบบขายหน้าร้านกลาง: สำนักงานใหญ่ + สาขา (แต่ละสาขามีเจ้าของคนละคน)
// ไม่ต้องติดตั้งไลบรารีเพิ่ม ใช้เฉพาะของที่มากับ Node 22.13 ขึ้นไป
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, tx } = require('./db');

/* ---------- ค่าคงที่ที่ใช้ร่วมกันทุกสาขา (แก้แล้วติดตั้งใหม่ ทุกสาขาเปลี่ยนพร้อมกัน) ---------- */
const OPT = {
  temp: [['ร้อน', 0], ['เย็น', 5], ['ปั่น', 10]],
  sweet: ['ไม่หวาน', 'หวานน้อย', 'ปกติ', 'หวานมาก'],
  tops: [['ไข่มุก', 10], ['วิปครีม', 10], ['เพิ่มช็อต', 15], ['ชีสฟอง', 15]]
};
const PAYS = ['cash', 'transfer', 'other'];
const PAY_LABEL = { cash: 'เงินสด', transfer: 'โอน/พร้อมเพย์', other: 'อื่นๆ' };
const DEMO_MENU = [
  ['ชาไทย', 'ชา', 45, 1], ['ชาเขียวนม', 'ชา', 45, 1], ['ชามะนาวใบเตย', 'ชา', 40, 1], ['ชาอู่หลงมะลิ', 'ชา', 55, 1],
  ['อเมริกาโน่', 'กาแฟ', 45, 1], ['ลาเต้', 'กาแฟ', 55, 1], ['กาแฟดอยน้ำผึ้ง', 'กาแฟ', 60, 1], ['เอสเปรสโซ่โทนิค', 'กาแฟ', 60, 1],
  ['โกโก้เข้ม', 'โกโก้และนม', 50, 1], ['มัทฉะลาเต้', 'โกโก้และนม', 60, 1], ['นมสดเย็น', 'โกโก้และนม', 40, 1],
  ['บราวนี่', 'ขนม', 35, 0], ['คุกกี้', 'ขนม', 25, 0]
];

const DEMO_ING = [
  ['แก้ว+ฝา', 'ใบ', 2], ['เมล็ดกาแฟ', 'กรัม', 0.8], ['ใบชาไทย', 'กรัม', 0.4], ['ผงชาเขียว', 'กรัม', 1.2], ['ผงมัทฉะ', 'กรัม', 3],
  ['ผงโกโก้', 'กรัม', 0.5], ['นมสด', 'มล.', 0.04], ['นมข้นหวาน', 'มล.', 0.06], ['น้ำเชื่อม', 'มล.', 0.02], ['ไข่มุก', 'กรัม', 0.15],
  ['วิปครีม', 'มล.', 0.12], ['ผงชีสฟอง', 'กรัม', 0.6], ['บราวนี่ (ชิ้น)', 'ชิ้น', 18], ['คุกกี้ (ชิ้น)', 'ชิ้น', 10]
];
const C = 'แก้ว+ฝา';
const DEMO_RECIPE = {
  'ชาไทย': [[C, 1], ['ใบชาไทย', 12], ['นมข้นหวาน', 30], ['นมสด', 40], ['น้ำเชื่อม', 10]],
  'ชาเขียวนม': [[C, 1], ['ผงชาเขียว', 10], ['นมสด', 60], ['น้ำเชื่อม', 15]],
  'ชามะนาวใบเตย': [[C, 1], ['ใบชาไทย', 8], ['น้ำเชื่อม', 25]],
  'ชาอู่หลงมะลิ': [[C, 1], ['ใบชาไทย', 10], ['น้ำเชื่อม', 15]],
  'อเมริกาโน่': [[C, 1], ['เมล็ดกาแฟ', 18], ['น้ำเชื่อม', 10]],
  'ลาเต้': [[C, 1], ['เมล็ดกาแฟ', 18], ['นมสด', 150], ['น้ำเชื่อม', 10]],
  'กาแฟดอยน้ำผึ้ง': [[C, 1], ['เมล็ดกาแฟ', 18], ['นมสด', 60], ['น้ำเชื่อม', 20]],
  'เอสเปรสโซ่โทนิค': [[C, 1], ['เมล็ดกาแฟ', 18], ['น้ำเชื่อม', 15]],
  'โกโก้เข้ม': [[C, 1], ['ผงโกโก้', 25], ['นมสด', 120], ['น้ำเชื่อม', 15]],
  'มัทฉะลาเต้': [[C, 1], ['ผงมัทฉะ', 6], ['นมสด', 150], ['น้ำเชื่อม', 15]],
  'นมสดเย็น': [[C, 1], ['นมสด', 200], ['น้ำเชื่อม', 15]],
  'บราวนี่': [['บราวนี่ (ชิ้น)', 1]],
  'คุกกี้': [['คุกกี้ (ชิ้น)', 1]]
};
const DEMO_TOP = [['ไข่มุก', 40], ['วิปครีม', 20], ['เมล็ดกาแฟ', 9], ['ผงชีสฟอง', 20]];
const STAFF_MAX_DISCOUNT_PCT = process.env.STAFF_MAX_DISCOUNT_PCT ? Math.max(0, +process.env.STAFF_MAX_DISCOUNT_PCT || 0) : 20;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- ตัวช่วยตรวจข้อมูล ---------- */
function reqInt(v, min, max, label) {
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = parseInt(v, 10);
  if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, label + ' ไม่ถูกต้อง');
  return v;
}
function reqStr(v, min, max, label) {
  if (typeof v !== 'string') throw new HttpError(400, 'กรอก' + label);
  const s = v.trim();
  if (s.length < min || (max && s.length > max)) {
    throw new HttpError(400, min > 0 && s.length < min ? 'กรอก' + label : label + ' ยาวเกินไป');
  }
  return s;
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function reqNum(v, min, max, label) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, label + ' ไม่ถูกต้อง');
  return n;
}
const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- รหัสผ่าน ---------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('base64') + '$' + crypto.scryptSync(pw, salt, 64).toString('base64');
}
function checkPw(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const exp = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), exp.length);
  return crypto.timingSafeEqual(got, exp);
}
function genPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(12)) s += A[b % A.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
const DUMMY_HASH = hashPw('timing-equalizer');

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const db = open(opts.dbFile || path.join(dataDir, 'pos.db'));
  const now = opts.now || (() => new Date());
  const shop = opts.shop || process.env.SHOP_NAME || 'ดอยเมฆ';
  const tz = opts.tz || process.env.SHOP_TZ || 'Asia/Bangkok';
  const secureCookie = opts.secureCookie !== undefined ? opts.secureCookie : (!!process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === 'production');
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => dfmt.format(now());
  const nowIso = () => now().toISOString();

  /* ----- ความลับสำหรับเซ็นคุกกี้ (เก็บในฐานข้อมูล อยู่ถาวรบน Volume) ----- */
  let secretRow = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  if (!secretRow) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(crypto.randomBytes(32).toString('hex'));
    secretRow = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  }
  const secret = secretRow.value;

  /* ----- สร้างบัญชีสำนักงานใหญ่และเมนูตัวอย่างครั้งแรก ----- */
  if (!db.prepare("SELECT 1 AS x FROM users WHERE role = 'hq' LIMIT 1").get()) {
    const email = String(opts.adminEmail || process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
    let pw = opts.adminPassword || process.env.ADMIN_PASSWORD;
    let generated = false;
    if (pw && String(pw).length < 8) throw new Error('ADMIN_PASSWORD ต้องยาวอย่างน้อย 8 ตัวอักษร');
    if (!pw) { pw = genPassword(); generated = true; }
    db.prepare("INSERT INTO users (email, name, pass_hash, role, created_at) VALUES (?, 'สำนักงานใหญ่', ?, 'hq', ?)").run(email, hashPw(String(pw)), nowIso());
    log('==================================================');
    log('สร้างบัญชีสำนักงานใหญ่แล้ว');
    log('อีเมล: ' + email);
    if (generated) log('รหัสผ่าน (แสดงครั้งเดียว ให้จดไว้): ' + pw);
    log('==================================================');
  }
  const menuEmpty = !db.prepare('SELECT 1 AS x FROM menu_items LIMIT 1').get();
  if (menuEmpty && (opts.seedMenu !== undefined ? opts.seedMenu : process.env.SEED_MENU !== '0')) {
    const ins = db.prepare('INSERT INTO menu_items (name, cat, price, opts, pos) VALUES (?, ?, ?, ?, ?)');
    tx(db, () => DEMO_MENU.forEach((m, i) => ins.run(m[0], m[1], m[2], m[3], i + 1)));
    log('ใส่เมนูตัวอย่างให้แล้ว ' + DEMO_MENU.length + ' รายการ (แก้ได้ในหน้าเมนูของสำนักงานใหญ่)');
  }
  // ฐานข้อมูลที่อัปเกรดมาจากเวอร์ชันก่อนสต๊อก (มีเมนูแล้วแต่ยังไม่มีวัตถุดิบ) ก็ใส่วัตถุดิบ/สูตรตัวอย่างให้ด้วย
  if (!db.prepare('SELECT 1 AS x FROM ingredients LIMIT 1').get() && db.prepare('SELECT 1 AS x FROM menu_items LIMIT 1').get() &&
      (opts.seedMenu !== undefined ? opts.seedMenu : process.env.SEED_MENU !== '0')) {
    tx(db, () => {
      const ing = {};
      DEMO_ING.forEach((x, i) => { ing[x[0]] = Number(db.prepare('INSERT INTO ingredients (name, unit, cost, pos) VALUES (?, ?, ?, ?)').run(x[0], x[1], x[2], i + 1).lastInsertRowid); });
      for (const m of db.prepare('SELECT id, name FROM menu_items').all()) {
        (DEMO_RECIPE[m.name] || []).forEach((r) => db.prepare('INSERT INTO recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)').run(m.id, ing[r[0]], r[1]));
      }
      DEMO_TOP.forEach((t, i) => db.prepare('INSERT INTO topping_recipes (top_idx, ingredient_id, qty) VALUES (?, ?, ?)').run(i, ing[t[0]], t[1]));
    });
    log('ใส่วัตถุดิบและสูตรตัวอย่างให้แล้ว (แก้ได้ในแท็บ "วัตถุดิบ/สูตร")');
  }

  /* ----- เวอร์ชันของโค้ด: เปลี่ยนเมื่อแก้ไฟล์ใดไฟล์หนึ่ง ใช้ให้เครื่องสาขารีโหลดเอง ----- */
  const indexRaw = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const version = crypto.createHash('sha1')
    .update(indexRaw).update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, 'db.js')))
    .digest('hex').slice(0, 10);
  const indexHtml = indexRaw.replace(/\{\{SHOP\}\}/g, esc(shop)).replace(/\{\{VERSION\}\}/g, version);

  /* ----- เซสชัน (คุกกี้เซ็นลายเซ็น) ----- */
  const pv = (hash) => crypto.createHash('sha256').update(hash).digest('hex').slice(0, 8);
  function sign(payload) {
    const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url');
  }
  function verify(tok) {
    const [b, mac] = String(tok || '').split('.');
    if (!b || !mac) return null;
    const exp = Buffer.from(crypto.createHmac('sha256', secret).update(b).digest('base64url'));
    const got = Buffer.from(mac);
    if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
    try {
      const p = JSON.parse(Buffer.from(b, 'base64url').toString());
      return p && p.exp > now().getTime() ? p : null;
    } catch (_) { return null; }
  }
  const cookieFor = (user) => 'sid=' + sign({ uid: user.id, pv: pv(user.pass_hash), exp: now().getTime() + 30 * 86400e3 }) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (secureCookie ? '; Secure' : '');
  const clearCookie = 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secureCookie ? '; Secure' : '');
  function parseCookies(h) {
    const out = {};
    String(h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    return out;
  }
  function userFromReq(req) {
    const p = verify(parseCookies(req.headers.cookie).sid);
    if (!p) return null;
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(p.uid);
    return u && pv(u.pass_hash) === p.pv ? u : null;
  }

  /* ----- กันเดารหัส: ผิดเกิน 8 ครั้งใน 10 นาที ถูกพัก ----- */
  const attempts = new Map();
  function throttle(key) {
    const t = now().getTime(), a = attempts.get(key);
    if (a && t - a.first < 600e3 && a.count >= 8) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป รอ 10 นาทีแล้วลองใหม่');
  }
  function fail(key) {
    const t = now().getTime(), a = attempts.get(key);
    if (!a || t - a.first >= 600e3) attempts.set(key, { first: t, count: 1 }); else a.count++;
  }

  /* ----- ข้อมูลทั่วไป ----- */
  const getBranch = (id) => db.prepare('SELECT * FROM branches WHERE id = ?').get(id);
  function mePayload(u) {
    const b = u.branch_id ? getBranch(u.branch_id) : null;
    return {
      user: { id: u.id, email: u.email, name: u.name, role: u.role },
      branch: b ? { id: b.id, name: b.name, area: b.area, status: b.status } : null,
      shop, opt: OPT, version, today: today()
    };
  }
  function branchMenu(branchId) {
    return db.prepare(
      `SELECT m.id, m.name, m.cat, m.opts, m.pos, COALESCE(bi.price, m.price) AS price, COALESCE(bi.sold_out, 0) AS sold_out
         FROM menu_items m LEFT JOIN branch_items bi ON bi.item_id = m.id AND bi.branch_id = ?
        WHERE m.active = 1 ORDER BY m.pos, m.id`
    ).all(branchId).map((r) => ({ id: r.id, name: r.name, cat: r.cat, opts: !!r.opts, pos: r.pos, price: r.price, sold_out: !!r.sold_out }));
  }
  const hqMenu = () => db.prepare('SELECT id, name, cat, price, opts, pos FROM menu_items WHERE active = 1 ORDER BY pos, id').all()
    .map((r) => ({ id: r.id, name: r.name, cat: r.cat, price: r.price, opts: !!r.opts, pos: r.pos }));

  function fmtOrder(r) {
    return {
      staff_name: r.staff_name, void_reason: r.void_reason,
      id: r.id, branch_id: r.branch_id, branch_name: r.branch_name, date: r.date, no: r.no, created_at: r.created_at,
      lines: JSON.parse(r.lines), subtotal: r.subtotal, discount: r.discount, total: r.total, pay: r.pay,
      received: r.received, void: !!r.void, void_at: r.void_at
    };
  }
  const ORDER_SELECT = 'SELECT o.*, b.name AS branch_name, u.name AS staff_name FROM orders o JOIN branches b ON b.id = o.branch_id LEFT JOIN users u ON u.id = o.user_id';

  /* ----- บันทึกตรวจสอบ + สต๊อก ----- */
  const audit = (branchId, userId, action, detail) =>
    db.prepare('INSERT INTO audit (branch_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(branchId || null, userId || null, action, String(detail || '').slice(0, 300), nowIso());
  function usageOf(meta) {
    const u = new Map();
    const put = (id, q) => u.set(id, (u.get(id) || 0) + q);
    const rq = db.prepare('SELECT r.ingredient_id, r.qty FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id AND i.active = 1 WHERE r.item_id = ?');
    const tq = db.prepare('SELECT r.ingredient_id, r.qty FROM topping_recipes r JOIN ingredients i ON i.id = r.ingredient_id AND i.active = 1 WHERE r.top_idx = ?');
    for (const m of meta) {
      rq.all(m.item_id).forEach((r) => put(r.ingredient_id, r.qty * m.qty));
      if (m.opts) m.tops.forEach((t) => tq.all(t).forEach((r) => put(r.ingredient_id, r.qty * m.qty)));
    }
    return u;
  }
  const onHand = (branchId, ingId) => r3(db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE branch_id = ? AND ingredient_id = ?').get(branchId, ingId).q);

  /* ----- สร้างออเดอร์: ราคาคำนวณที่เซิร์ฟเวอร์เสมอ ไม่เชื่อราคาจากเครื่องสาขา ----- */
  function createOrder(user, body) {
    const branch = getBranch(user.branch_id);
    if (!branch) throw new HttpError(403, 'ไม่พบสาขาของบัญชีนี้');
    if (branch.status !== 'active') throw new HttpError(403, 'สาขานี้ถูกระงับการขาย ติดต่อสำนักงานใหญ่');
    const clientId = body.client_id == null ? null : reqStr(body.client_id, 8, 64, 'รหัสคำขอ');
    if (clientId) {
      const ex = db.prepare(ORDER_SELECT + ' WHERE o.branch_id = ? AND o.client_id = ?').get(branch.id, clientId);
      if (ex) return { order: fmtOrder(ex), duplicate: true };
    }
    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 50) throw new HttpError(400, 'ตะกร้าว่างหรือมีรายการมากเกินไป');
    const menu = new Map(branchMenu(branch.id).map((m) => [m.id, m]));
    let subtotal = 0;
    const meta = [];
    const lines = body.lines.map((l) => {
      const item = menu.get(reqInt(l.item_id, 1, 1e9, 'รหัสเมนู'));
      if (!item) throw new HttpError(400, 'มีเมนูที่ไม่มีในระบบแล้ว ลองรีเฟรชหน้า');
      if (item.sold_out) throw new HttpError(409, 'เมนู "' + item.name + '" หมดอยู่ ลบออกจากตะกร้าก่อน');
      const qty = reqInt(l.qty, 1, 99, 'จำนวน');
      let unit = item.price, optText = '', tops = [];
      if (item.opts) {
        const t = reqInt(l.temp, 0, OPT.temp.length - 1, 'แบบเครื่องดื่ม');
        const s = reqInt(l.sweet, 0, OPT.sweet.length - 1, 'ความหวาน');
        tops = Array.isArray(l.tops) ? [...new Set(l.tops.map((x) => reqInt(x, 0, OPT.tops.length - 1, 'ท็อปปิ้ง')))].sort() : [];
        unit += OPT.temp[t][1] + tops.reduce((a, i) => a + OPT.tops[i][1], 0);
        optText = [OPT.temp[t][0], OPT.sweet[s]].concat(tops.length ? [tops.map((i) => OPT.tops[i][0]).join(', ')] : []).join(' · ');
      }
      const note = l.note == null || l.note === '' ? '' : reqStr(String(l.note), 0, 100, 'หมายเหตุ');
      subtotal += unit * qty;
      meta.push({ item_id: item.id, qty, opts: !!item.opts, tops });
      return { item_id: item.id, name: item.name, opt: optText, unit, qty, note };
    });
    const discountAsked = body.discount == null || body.discount === '' ? 0 : reqInt(body.discount, 0, 1e7, 'ส่วนลด');
    if (user.role === 'staff' && discountAsked > subtotal * STAFF_MAX_DISCOUNT_PCT / 100) {
      throw new HttpError(403, 'ส่วนลดเกินสิทธิ์พนักงาน (สูงสุด ' + STAFF_MAX_DISCOUNT_PCT + '% ของยอด) ให้เจ้าของสาขาทำรายการ');
    }
    const discount = Math.min(discountAsked, subtotal);
    const total = subtotal - discount;
    if (!PAYS.includes(body.pay)) throw new HttpError(400, 'วิธีชำระเงินไม่ถูกต้อง');
    let received = null;
    if (body.pay === 'cash') {
      received = body.received == null || body.received === '' ? total : reqInt(body.received, 0, 1e8, 'เงินที่รับ');
      if (received < total) throw new HttpError(400, 'รับเงินมาไม่พอ');
    }
    return tx(db, () => {
      const date = today();
      const no = db.prepare('SELECT COALESCE(MAX(no), 0) + 1 AS n FROM orders WHERE branch_id = ? AND date = ?').get(branch.id, date).n;
      const r = db.prepare(
        `INSERT INTO orders (branch_id, date, no, client_id, created_at, lines, subtotal, discount, total, pay, received, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(branch.id, date, no, clientId, nowIso(), JSON.stringify(lines), subtotal, discount, total, body.pay, received, user.id);
      const oid = Number(r.lastInsertRowid);
      for (const [ing, q] of usageOf(meta)) {
        db.prepare("INSERT INTO stock_moves (branch_id, ingredient_id, kind, qty, order_id, user_id, date, created_at) VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)")
          .run(branch.id, ing, -r3(q), oid, user.id, date, nowIso());
      }
      return { order: fmtOrder(db.prepare(ORDER_SELECT + ' WHERE o.id = ?').get(oid)), duplicate: false };
    });
  }

  /* ----- รายงาน ----- */
  function rangeOf(q) {
    if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HttpError(400, 'ช่วงวันที่ไม่ถูกต้อง');
    if ((new Date(q.to) - new Date(q.from)) / 86400e3 > 366) throw new HttpError(400, 'เลือกช่วงได้ไม่เกิน 1 ปี');
    return [q.from, q.to];
  }
  function scopeBranch(user, q) {
    if (user.role !== 'hq') return user.branch_id;
    if (q.branch_id == null || q.branch_id === '') return null;
    const id = reqInt(q.branch_id, 1, 1e9, 'สาขา');
    if (!getBranch(id)) throw new HttpError(404, 'ไม่พบสาขา');
    return id;
  }
  function report(user, q) {
    const [from, to] = rangeOf(q);
    const bid = scopeBranch(user, q);
    const rows = db.prepare(
      `SELECT branch_id, user_id, date, total, discount, pay, void, lines FROM orders WHERE date BETWEEN ? AND ?` + (bid ? ' AND branch_id = ?' : '')
    ).all(...(bid ? [from, to, bid] : [from, to]));
    let count = 0, voided = 0, total = 0;
    const byPay = {}, byDay = {}, byItem = {}, byBranch = {}, byUser = {};
    for (const r of rows) {
      const bb = byBranch[r.branch_id] || (byBranch[r.branch_id] = { count: 0, total: 0, voided: 0 });
      const bu = byUser[r.user_id] || (byUser[r.user_id] = { count: 0, total: 0, discount: 0, voided: 0 });
      if (r.void) { voided++; bb.voided++; bu.voided++; continue; }
      count++; total += r.total; bb.count++; bb.total += r.total;
      bu.count++; bu.total += r.total; bu.discount += r.discount;
      byPay[r.pay] = (byPay[r.pay] || 0) + r.total;
      const d = byDay[r.date] || (byDay[r.date] = { date: r.date, count: 0, total: 0 });
      d.count++; d.total += r.total;
      for (const l of JSON.parse(r.lines)) {
        const it = byItem[l.name] || (byItem[l.name] = { name: l.name, qty: 0, value: 0 });
        it.qty += l.qty; it.value += l.unit * l.qty;
      }
    }
    const out = {
      from, to, count, voided, total, avg: count ? Math.round(total / count) : 0,
      by_pay: byPay,
      items: Object.values(byItem).sort((a, b) => b.qty - a.qty).slice(0, 10),
      by_day: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date))
    };
    if (bid && user.role !== 'hq') {   // รายงานรายพนักงานเป็นของเจ้าของสาขาเท่านั้น
      const nm = new Map(db.prepare('SELECT id, name, role FROM users WHERE branch_id = ?').all(bid).map((u) => [u.id, u]));
      out.by_user = Object.keys(byUser).map((id) => ({ user_id: +id, name: (nm.get(+id) || {}).name || 'ไม่ทราบ', role: (nm.get(+id) || {}).role || '', ...byUser[id] }))
        .sort((a, b) => b.total - a.total);
    }
    if (user.role === 'hq' && !bid) {
      out.by_branch = db.prepare('SELECT id, name, area, status FROM branches ORDER BY id').all().map((b) => {
        const x = byBranch[b.id] || { count: 0, total: 0, voided: 0 };
        return { id: b.id, name: b.name, area: b.area, status: b.status, count: x.count, total: x.total, voided: x.voided, avg: x.count ? Math.round(x.total / x.count) : 0 };
      });
    }
    return out;
  }
  const csvCell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // กันสูตรใน Excel
    return '"' + s.replace(/"/g, '""') + '"';
  };
  function exportCsv(user, q) {
    const [from, to] = rangeOf(q);
    const bid = scopeBranch(user, q);
    const rows = db.prepare(ORDER_SELECT + ' WHERE o.date BETWEEN ? AND ?' + (bid ? ' AND o.branch_id = ?' : '') + ' ORDER BY o.created_at')
      .all(...(bid ? [from, to, bid] : [from, to]));
    const head = ['สาขา', 'วันที่', 'เวลา', 'เลขออเดอร์', 'รายการ', 'ส่วนลด', 'ยอดรวม', 'ชำระโดย', 'สถานะ', 'พนักงาน', 'เหตุผลยกเลิก'];
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const body = rows.map((r) => [
      r.branch_name, r.date, time.format(new Date(r.created_at)), r.no,
      JSON.parse(r.lines).map((l) => l.name + (l.opt ? ' (' + l.opt + ')' : '') + ' x' + l.qty).join('; '),
      r.discount, r.total, PAY_LABEL[r.pay] || r.pay, r.void ? 'ยกเลิก' : 'ปกติ', r.staff_name || '', r.void_reason || ''
    ]);
    return '﻿' + [head].concat(body).map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /* ---------- เส้นทาง API ---------- */
  const routes = [];
  const add = (method, pattern, auth, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth, handler });
  };
  const needBranchAccess = (user, branchId) => {
    if (user.role !== 'hq' && user.branch_id !== branchId) throw new HttpError(403, 'ไม่มีสิทธิ์เข้าถึงสาขานี้');
  };

  add('GET', '/api/version', 'none', () => ({ version }));

  add('POST', '/api/login', 'none', ({ req, body, res }) => {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = ip + '|' + email;
    throttle(key);
    const u = email ? db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email) : null;
    const ok = checkPw(password, u ? u.pass_hash : DUMMY_HASH) && !!u;
    if (!ok) { fail(key); throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'); }
    attempts.delete(key);
    res.setHeader('Set-Cookie', cookieFor(u));
    return mePayload(u);
  });
  add('POST', '/api/logout', 'none', ({ res }) => { res.setHeader('Set-Cookie', clearCookie); return { ok: true }; });
  add('GET', '/api/me', 'any', ({ user }) => mePayload(user));

  add('POST', '/api/password', 'any', ({ user, body, res }) => {
    if (typeof body.old !== 'string' || !checkPw(body.old, user.pass_hash)) throw new HttpError(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
    const pw = reqStr(body.new, 8, 100, 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)');
    const hash = hashPw(pw);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, user.id);
    res.setHeader('Set-Cookie', cookieFor({ id: user.id, pass_hash: hash }));
    return { ok: true };
  });

  /* เมนู */
  add('GET', '/api/menu', 'any', ({ user }) => ({ menu: user.role === 'hq' ? hqMenu() : branchMenu(user.branch_id) }));
  const menuFields = (b) => ({
    name: reqStr(b.name, 1, 60, 'ชื่อเมนู'), cat: reqStr(b.cat, 1, 30, 'หมวด'),
    price: reqInt(b.price, 0, 100000, 'ราคา'), opts: b.opts === false || b.opts === 0 ? 0 : 1
  });
  add('POST', '/api/menu', 'hq', ({ body }) => {
    const f = menuFields(body);
    const pos = db.prepare('SELECT COALESCE(MAX(pos), 0) + 1 AS n FROM menu_items').get().n;
    const r = db.prepare('INSERT INTO menu_items (name, cat, price, opts, pos) VALUES (?, ?, ?, ?, ?)').run(f.name, f.cat, f.price, f.opts, pos);
    return { id: Number(r.lastInsertRowid) };
  });
  add('PUT', '/api/menu/:id', 'hq', ({ params, body }) => {
    const f = menuFields(body);
    const r = db.prepare('UPDATE menu_items SET name = ?, cat = ?, price = ?, opts = ? WHERE id = ? AND active = 1').run(f.name, f.cat, f.price, f.opts, reqInt(params.id, 1, 1e9, 'เมนู'));
    if (!r.changes) throw new HttpError(404, 'ไม่พบเมนู');
    return { ok: true };
  });
  add('DELETE', '/api/menu/:id', 'hq', ({ params }) => {
    const r = db.prepare('UPDATE menu_items SET active = 0 WHERE id = ? AND active = 1').run(reqInt(params.id, 1, 1e9, 'เมนู'));
    if (!r.changes) throw new HttpError(404, 'ไม่พบเมนู');
    return { ok: true };
  });

  /* สาขา (สำนักงานใหญ่) */
  add('GET', '/api/branches', 'hq', () => {
    const stats = {};
    db.prepare('SELECT branch_id, COUNT(*) AS c, COALESCE(SUM(total), 0) AS t FROM orders WHERE date = ? AND void = 0 GROUP BY branch_id').all(today())
      .forEach((r) => { stats[r.branch_id] = { count: r.c, total: r.t }; });
    return {
      branches: db.prepare(
        `SELECT b.id, b.name, b.area, b.status, u.email AS owner_email, u.name AS owner_name
           FROM branches b LEFT JOIN users u ON u.branch_id = b.id ORDER BY b.id`
      ).all().map((b) => ({ ...b, today: stats[b.id] || { count: 0, total: 0 } }))
    };
  });
  add('POST', '/api/branches', 'hq', ({ body }) => {
    const name = reqStr(body.name, 2, 60, 'ชื่อสาขา');
    const area = body.area == null ? '' : reqStr(body.area, 0, 100, 'ทำเล');
    const ownerName = reqStr(body.owner_name, 1, 80, 'ชื่อเจ้าของ');
    const email = reqStr(body.owner_email, 3, 120, 'อีเมลเจ้าของ').toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
    if (db.prepare('SELECT 1 AS x FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'อีเมลนี้ถูกใช้แล้ว');
    let pw = body.password == null || body.password === '' ? null : reqStr(body.password, 8, 100, 'รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)');
    const temp = pw ? null : genPassword();
    pw = pw || temp;
    return tx(db, () => {
      const b = db.prepare('INSERT INTO branches (name, area, created_at) VALUES (?, ?, ?)').run(name, area, nowIso());
      db.prepare("INSERT INTO users (email, name, pass_hash, role, branch_id, created_at) VALUES (?, ?, ?, 'branch', ?, ?)")
        .run(email, ownerName, hashPw(pw), Number(b.lastInsertRowid), nowIso());
      return { id: Number(b.lastInsertRowid), email, temp_password: temp };
    });
  });
  add('PUT', '/api/branches/:id', 'hq', ({ params, body }) => {
    const id = reqInt(params.id, 1, 1e9, 'สาขา');
    if (!getBranch(id)) throw new HttpError(404, 'ไม่พบสาขา');
    const name = reqStr(body.name, 2, 60, 'ชื่อสาขา');
    const area = body.area == null ? '' : reqStr(body.area, 0, 100, 'ทำเล');
    if (body.status !== 'active' && body.status !== 'paused') throw new HttpError(400, 'สถานะไม่ถูกต้อง');
    db.prepare('UPDATE branches SET name = ?, area = ?, status = ? WHERE id = ?').run(name, area, body.status, id);
    return { ok: true };
  });
  add('POST', '/api/branches/:id/reset-password', 'hq', ({ params }) => {
    const id = reqInt(params.id, 1, 1e9, 'สาขา');
    const u = db.prepare("SELECT id, email FROM users WHERE branch_id = ? AND role = 'branch' ORDER BY id LIMIT 1").get(id);
    if (!u) throw new HttpError(404, 'ไม่พบบัญชีเจ้าของสาขา');
    const temp = genPassword();
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPw(temp), u.id);
    return { email: u.email, temp_password: temp };
  });
  add('GET', '/api/branches/:id/items', 'hq', ({ params }) => {
    const id = reqInt(params.id, 1, 1e9, 'สาขา');
    if (!getBranch(id)) throw new HttpError(404, 'ไม่พบสาขา');
    return {
      items: db.prepare(
        `SELECT m.id, m.name, m.cat, m.price AS base_price, bi.price AS override_price, COALESCE(bi.sold_out, 0) AS sold_out
           FROM menu_items m LEFT JOIN branch_items bi ON bi.item_id = m.id AND bi.branch_id = ? WHERE m.active = 1 ORDER BY m.pos, m.id`
      ).all(id).map((r) => ({ id: r.id, name: r.name, cat: r.cat, base_price: r.base_price, override_price: r.override_price, sold_out: !!r.sold_out }))
    };
  });
  // สำนักงานใหญ่ตั้งราคาเฉพาะสาขาได้ ส่วนเจ้าของสาขาตั้งได้แค่ "หมด/พร้อมขาย"
  add('PUT', '/api/branches/:id/items/:itemId', 'manager', ({ user, params, body }) => {
    const bid = reqInt(params.id, 1, 1e9, 'สาขา');
    const iid = reqInt(params.itemId, 1, 1e9, 'เมนู');
    needBranchAccess(user, bid);
    if (!getBranch(bid)) throw new HttpError(404, 'ไม่พบสาขา');
    if (!db.prepare('SELECT 1 AS x FROM menu_items WHERE id = ? AND active = 1').get(iid)) throw new HttpError(404, 'ไม่พบเมนู');
    if (user.role === 'branch' && 'price' in body) throw new HttpError(403, 'ตั้งราคาได้เฉพาะสำนักงานใหญ่');
    const cur = db.prepare('SELECT price, sold_out FROM branch_items WHERE branch_id = ? AND item_id = ?').get(bid, iid) || { price: null, sold_out: 0 };
    const price = 'price' in body ? (body.price === null ? null : reqInt(body.price, 0, 100000, 'ราคา')) : cur.price;
    const soldOut = 'sold_out' in body ? (body.sold_out ? 1 : 0) : cur.sold_out;
    db.prepare(
      `INSERT INTO branch_items (branch_id, item_id, price, sold_out) VALUES (?, ?, ?, ?)
       ON CONFLICT (branch_id, item_id) DO UPDATE SET price = excluded.price, sold_out = excluded.sold_out`
    ).run(bid, iid, price, soldOut);
    if (price !== cur.price) audit(bid, user.id, 'price', 'เมนู #' + iid + ' ราคาสาขา ' + (cur.price == null ? 'กลาง' : cur.price) + ' → ' + (price == null ? 'กลาง' : price));
    if (soldOut !== cur.sold_out) audit(bid, user.id, 'sold_out', 'เมนู #' + iid + (soldOut ? ' ตั้งเป็นหมด' : ' เปิดขายอีกครั้ง'));
    return { ok: true };
  });

  /* ออเดอร์ */
  add('POST', '/api/orders', 'seller', ({ user, body }) => createOrder(user, body));
  add('GET', '/api/orders', 'any', ({ user, query }) => {
    const date = user.role === 'staff' || query.date == null ? today() : query.date;
    if (!isDate(date)) throw new HttpError(400, 'วันที่ไม่ถูกต้อง');
    const bid = scopeBranch(user, query);
    const rows = db.prepare(ORDER_SELECT + ' WHERE o.date = ?' + (bid ? ' AND o.branch_id = ?' : '') + ' ORDER BY o.branch_id, o.no DESC LIMIT 1000')
      .all(...(bid ? [date, bid] : [date]));
    return { date, orders: rows.map(fmtOrder) };
  });
  add('PATCH', '/api/orders/:id', 'manager', ({ user, params, body }) => {
    const o = db.prepare('SELECT id, branch_id, no, date, total, void, void_restock FROM orders WHERE id = ?').get(reqInt(params.id, 1, 1e9, 'ออเดอร์'));
    if (!o) throw new HttpError(404, 'ไม่พบออเดอร์');
    needBranchAccess(user, o.branch_id);
    if (typeof body.void !== 'boolean') throw new HttpError(400, 'คำขอไม่ถูกต้อง');
    if (body.void === !!o.void) throw new HttpError(409, 'ออเดอร์นี้อยู่ในสถานะนั้นแล้ว');
    const sales = () => db.prepare("SELECT ingredient_id, qty FROM stock_moves WHERE order_id = ? AND kind = 'sale'").all(o.id);
    const mv = db.prepare('INSERT INTO stock_moves (branch_id, ingredient_id, kind, qty, order_id, user_id, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    tx(db, () => {
      if (body.void) {
        const reason = reqStr(body.reason, 2, 100, 'เหตุผลที่ยกเลิก');
        const restock = body.restock === true;
        db.prepare('UPDATE orders SET void = 1, void_at = ?, void_reason = ?, void_by = ?, void_restock = ? WHERE id = ?').run(nowIso(), reason, user.id, restock ? 1 : 0, o.id);
        if (restock) sales().forEach((x) => mv.run(o.branch_id, x.ingredient_id, 'void_return', -x.qty, o.id, user.id, today(), nowIso()));
        audit(o.branch_id, user.id, 'void', 'ยกเลิกออเดอร์ #' + o.no + ' (' + o.date + ') ยอด ' + o.total + ' เหตุผล: ' + reason + (restock ? ' · คืนสต๊อก' : ' · ไม่คืนสต๊อก'));
      } else {
        db.prepare('UPDATE orders SET void = 0, void_at = NULL, void_reason = NULL, void_by = NULL, void_restock = 0 WHERE id = ?').run(o.id);
        if (o.void_restock) sales().forEach((x) => mv.run(o.branch_id, x.ingredient_id, 'void_redo', x.qty, o.id, user.id, today(), nowIso()));
        audit(o.branch_id, user.id, 'unvoid', 'กู้คืนออเดอร์ #' + o.no + ' (' + o.date + ') ยอด ' + o.total);
      }
    });
    return { ok: true };
  });

  /* รายงาน */
  add('GET', '/api/report', 'manager', ({ user, query }) => report(user, query));
  add('GET', '/api/export.csv', 'manager', ({ user, query, res }) => {
    const csv = exportCsv(user, query);
    res.setHeader('Content-Disposition', 'attachment; filename="sales-' + query.from + '_' + query.to + '.csv"');
    return { raw: csv, type: 'text/csv; charset=utf-8' };
  });


  /* ----- พนักงานหน้าร้าน (เจ้าของสาขาจัดการ) ----- */
  const staffOf = (u, id) => {
    const t = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'staff' AND branch_id = ?").get(reqInt(id, 1, 1e9, 'พนักงาน'), u.branch_id);
    if (!t) throw new HttpError(404, 'ไม่พบพนักงาน');
    return t;
  };
  add('GET', '/api/staff', 'owner', ({ user }) => ({
    staff: db.prepare("SELECT id, email AS username, name, active FROM users WHERE role = 'staff' AND branch_id = ? ORDER BY id").all(user.branch_id).map((x) => ({ ...x, active: !!x.active }))
  }));
  add('POST', '/api/staff', 'owner', ({ user, body }) => {
    const name = reqStr(body.name, 1, 60, 'ชื่อพนักงาน');
    const username = reqStr(body.username, 3, 60, 'ชื่อผู้ใช้ (อย่างน้อย 3 ตัวอักษร)').toLowerCase();
    if (/\s/.test(username)) throw new HttpError(400, 'ชื่อผู้ใช้ห้ามมีช่องว่าง');
    if (db.prepare('SELECT 1 AS x FROM users WHERE email = ?').get(username)) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
    if (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'staff' AND branch_id = ?").get(user.branch_id).c >= 30) throw new HttpError(400, 'มีพนักงานครบ 30 คนแล้ว');
    let pw = body.password == null || body.password === '' ? null : reqStr(body.password, 8, 100, 'รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)');
    const temp = pw ? null : genPassword();
    const r = db.prepare("INSERT INTO users (email, name, pass_hash, role, branch_id, created_at) VALUES (?, ?, ?, 'staff', ?, ?)").run(username, name, hashPw(pw || temp), user.branch_id, nowIso());
    audit(user.branch_id, user.id, 'staff_add', 'เพิ่มพนักงาน ' + name + ' (' + username + ')');
    return { id: Number(r.lastInsertRowid), username, temp_password: temp };
  });
  add('PUT', '/api/staff/:id', 'owner', ({ user, params, body }) => {
    const t = staffOf(user, params.id);
    const name = body.name == null ? t.name : reqStr(body.name, 1, 60, 'ชื่อพนักงาน');
    const active = body.active == null ? t.active : (body.active ? 1 : 0);
    db.prepare('UPDATE users SET name = ?, active = ? WHERE id = ?').run(name, active, t.id);
    if (active !== t.active) audit(user.branch_id, user.id, active ? 'staff_on' : 'staff_off', (active ? 'เปิดใช้งาน ' : 'ปิดบัญชี ') + t.name);
    return { ok: true };
  });
  add('POST', '/api/staff/:id/reset-password', 'owner', ({ user, params }) => {
    const t = staffOf(user, params.id);
    const temp = genPassword();
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPw(temp), t.id);
    audit(user.branch_id, user.id, 'staff_reset', 'รีเซ็ตรหัสผ่าน ' + t.name);
    return { username: t.email, temp_password: temp };
  });

  /* ----- วัตถุดิบ + สต๊อก ----- */
  const ingFields = (b) => ({
    name: reqStr(b.name, 1, 60, 'ชื่อวัตถุดิบ'), unit: reqStr(b.unit, 1, 12, 'หน่วย'), cost: reqNum(b.cost == null || b.cost === '' ? 0 : b.cost, 0, 1e6, 'ต้นทุนต่อหน่วย')
  });
  add('GET', '/api/ingredients', 'hq', () => ({ ingredients: db.prepare('SELECT id, name, unit, cost FROM ingredients WHERE active = 1 ORDER BY pos, id').all() }));
  add('POST', '/api/ingredients', 'hq', ({ body }) => {
    const f = ingFields(body);
    const pos = db.prepare('SELECT COALESCE(MAX(pos), 0) + 1 AS n FROM ingredients').get().n;
    return { id: Number(db.prepare('INSERT INTO ingredients (name, unit, cost, pos) VALUES (?, ?, ?, ?)').run(f.name, f.unit, f.cost, pos).lastInsertRowid) };
  });
  add('PUT', '/api/ingredients/:id', 'hq', ({ params, body }) => {
    const f = ingFields(body);
    if (!db.prepare('UPDATE ingredients SET name = ?, unit = ?, cost = ? WHERE id = ? AND active = 1').run(f.name, f.unit, f.cost, reqInt(params.id, 1, 1e9, 'วัตถุดิบ')).changes) throw new HttpError(404, 'ไม่พบวัตถุดิบ');
    return { ok: true };
  });
  add('DELETE', '/api/ingredients/:id', 'hq', ({ params }) => {
    const id = reqInt(params.id, 1, 1e9, 'วัตถุดิบ');
    tx(db, () => {
      if (!db.prepare('UPDATE ingredients SET active = 0 WHERE id = ? AND active = 1').run(id).changes) throw new HttpError(404, 'ไม่พบวัตถุดิบ');
      db.prepare('DELETE FROM recipes WHERE ingredient_id = ?').run(id);
      db.prepare('DELETE FROM topping_recipes WHERE ingredient_id = ?').run(id);
    });
    return { ok: true };
  });
  add('GET', '/api/recipes', 'hq', () => {
    const items = {}, tops = {};
    db.prepare('SELECT item_id, ingredient_id, qty FROM recipes').all().forEach((r) => { (items[r.item_id] = items[r.item_id] || []).push({ ingredient_id: r.ingredient_id, qty: r.qty }); });
    db.prepare('SELECT top_idx, ingredient_id, qty FROM topping_recipes').all().forEach((r) => { (tops[r.top_idx] = tops[r.top_idx] || []).push({ ingredient_id: r.ingredient_id, qty: r.qty }); });
    return { items, tops };
  });
  function saveRecipe(table, keyCol, key, lines) {
    if (!Array.isArray(lines) || lines.length > 30) throw new HttpError(400, 'สูตรไม่ถูกต้อง');
    const seen = new Set();
    tx(db, () => {
      db.prepare('DELETE FROM ' + table + ' WHERE ' + keyCol + ' = ?').run(key);
      for (const l of lines) {
        const id = reqInt(l.ingredient_id, 1, 1e9, 'วัตถุดิบ');
        if (seen.has(id)) throw new HttpError(400, 'วัตถุดิบซ้ำในสูตร');
        seen.add(id);
        if (!db.prepare('SELECT 1 AS x FROM ingredients WHERE id = ? AND active = 1').get(id)) throw new HttpError(400, 'ไม่พบวัตถุดิบ');
        db.prepare('INSERT INTO ' + table + ' (' + keyCol + ', ingredient_id, qty) VALUES (?, ?, ?)').run(key, id, reqNum(l.qty, 0.001, 1e6, 'ปริมาณ'));
      }
    });
    return { ok: true };
  }
  add('PUT', '/api/recipes/item/:id', 'hq', ({ params, body }) => {
    const id = reqInt(params.id, 1, 1e9, 'เมนู');
    if (!db.prepare('SELECT 1 AS x FROM menu_items WHERE id = ? AND active = 1').get(id)) throw new HttpError(404, 'ไม่พบเมนู');
    return saveRecipe('recipes', 'item_id', id, body.lines);
  });
  add('PUT', '/api/recipes/topping/:idx', 'hq', ({ params, body }) => saveRecipe('topping_recipes', 'top_idx', reqInt(params.idx, 0, OPT.tops.length - 1, 'ท็อปปิ้ง'), body.lines));

  add('GET', '/api/stock', 'seller', ({ user, query }) => {
    const bid = scopeBranch(user, query);
    if (!bid) throw new HttpError(400, 'เลือกสาขา');
    const rows = db.prepare(
      `SELECT i.id, i.name, i.unit, i.cost,
              COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.branch_id = ? AND m.ingredient_id = i.id), 0) AS on_hand
         FROM ingredients i WHERE i.active = 1 ORDER BY i.pos, i.id`).all(bid);
    // พนักงานเห็นแค่รายชื่อวัตถุดิบ ไม่เห็นยอดคงเหลือ เพื่อให้ "นับสต๊อกแบบปิดตา" ได้
    return { ingredients: rows.map((r) => user.role === 'staff' ? { id: r.id, name: r.name, unit: r.unit } : { id: r.id, name: r.name, unit: r.unit, cost: r.cost, on_hand: r3(r.on_hand) }) };
  });
  add('POST', '/api/stock/receive', 'owner', ({ user, body }) => {
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ? AND active = 1').get(reqInt(body.ingredient_id, 1, 1e9, 'วัตถุดิบ'));
    if (!ing) throw new HttpError(404, 'ไม่พบวัตถุดิบ');
    const qty = reqNum(body.qty, 0.001, 1e7, 'จำนวนที่รับเข้า');
    const note = body.note ? reqStr(String(body.note), 0, 100, 'หมายเหตุ') : '';
    tx(db, () => {
      db.prepare("INSERT INTO stock_moves (branch_id, ingredient_id, kind, qty, user_id, note, date, created_at) VALUES (?, ?, 'receive', ?, ?, ?, ?, ?)").run(user.branch_id, ing.id, qty, user.id, note, today(), nowIso());
      audit(user.branch_id, user.id, 'stock_receive', 'รับเข้า ' + ing.name + ' ' + qty + ' ' + ing.unit + (note ? ' (' + note + ')' : ''));
    });
    return { ok: true, on_hand: onHand(user.branch_id, ing.id) };
  });
  add('POST', '/api/stock/waste', 'seller', ({ user, body }) => {
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ? AND active = 1').get(reqInt(body.ingredient_id, 1, 1e9, 'วัตถุดิบ'));
    if (!ing) throw new HttpError(404, 'ไม่พบวัตถุดิบ');
    const qty = reqNum(body.qty, 0.001, 1e7, 'จำนวนที่เสีย');
    const reason = reqStr(body.reason, 2, 100, 'เหตุผล (เช่น หกทิ้ง ทำผิด หมดอายุ)');
    tx(db, () => {
      db.prepare("INSERT INTO stock_moves (branch_id, ingredient_id, kind, qty, user_id, note, date, created_at) VALUES (?, ?, 'waste', ?, ?, ?, ?, ?)").run(user.branch_id, ing.id, -qty, user.id, reason, today(), nowIso());
      audit(user.branch_id, user.id, 'stock_waste', 'ของเสีย ' + ing.name + ' ' + qty + ' ' + ing.unit + ' — ' + reason);
    });
    return { ok: true };
  });
  add('POST', '/api/stock/count', 'seller', ({ user, body }) => {
    if (!Array.isArray(body.counts) || !body.counts.length || body.counts.length > 200) throw new HttpError(400, 'ไม่มีรายการที่นับ');
    const bid = user.branch_id;
    return tx(db, () => {
      const out = [], seen = new Set();
      let totalValue = 0;
      for (const c of body.counts) {
        const id = reqInt(c.ingredient_id, 1, 1e9, 'วัตถุดิบ');
        if (seen.has(id)) throw new HttpError(400, 'นับวัตถุดิบซ้ำ');
        seen.add(id);
        const ing = db.prepare('SELECT * FROM ingredients WHERE id = ? AND active = 1').get(id);
        if (!ing) throw new HttpError(400, 'ไม่พบวัตถุดิบ');
        const actual = reqNum(c.actual, 0, 1e7, 'จำนวนที่นับ ของ ' + ing.name);
        const expected = onHand(bid, id), diff = r3(actual - expected);
        db.prepare("INSERT INTO stock_moves (branch_id, ingredient_id, kind, qty, expected, user_id, date, created_at) VALUES (?, ?, 'count', ?, ?, ?, ?, ?)").run(bid, id, diff, expected, user.id, today(), nowIso());
        totalValue += diff * ing.cost;
        out.push({ ingredient_id: id, name: ing.name, unit: ing.unit, expected, actual, diff, value: r3(diff * ing.cost) });
      }
      audit(bid, user.id, 'stock_count', 'นับสต๊อก ' + out.length + ' รายการ ส่วนต่างรวม ' + Math.round(totalValue) + ' บาท');
      return user.role === 'staff' ? { ok: true, counted: out.length } : { ok: true, counted: out.length, results: out };
    });
  });
  add('GET', '/api/stock/report', 'owner', ({ user, query }) => {
    const [from, to] = rangeOf(query);
    const bid = scopeBranch(user, query);
    const where = ' WHERE m.date BETWEEN ? AND ?' + (bid ? ' AND m.branch_id = ?' : '');
    const args = bid ? [from, to, bid] : [from, to];
    const rows = db.prepare(
      `SELECT m.branch_id, m.ingredient_id, i.name, i.unit, i.cost,
              SUM(CASE WHEN m.kind = 'receive' THEN m.qty ELSE 0 END) AS received,
              SUM(CASE WHEN m.kind IN ('sale', 'void_return', 'void_redo') THEN m.qty ELSE 0 END) AS used,
              SUM(CASE WHEN m.kind = 'waste' THEN m.qty ELSE 0 END) AS waste,
              SUM(CASE WHEN m.kind = 'count' THEN m.qty ELSE 0 END) AS variance
         FROM stock_moves m JOIN ingredients i ON i.id = m.ingredient_id` + where + ' GROUP BY m.branch_id, m.ingredient_id ORDER BY i.pos, i.id').all(...args);
    const bb = {};
    let varianceValue = 0, wasteValue = 0;
    for (const r of rows) {
      const b = bb[r.branch_id] || (bb[r.branch_id] = { variance_value: 0, waste_value: 0 });
      b.variance_value += r.variance * r.cost; b.waste_value += -r.waste * r.cost;
      varianceValue += r.variance * r.cost; wasteValue += -r.waste * r.cost;
    }
    const out = { from, to, variance_value: Math.round(varianceValue), waste_value: Math.round(wasteValue) };
    if (bid) {
      out.items = rows.map((r) => ({ ingredient_id: r.ingredient_id, name: r.name, unit: r.unit, received: r3(r.received), used: r3(-r.used), waste: r3(-r.waste), variance: r3(r.variance), variance_value: Math.round(r.variance * r.cost),
        on_hand: onHand(bid, r.ingredient_id) }));
      const list = (kind) => db.prepare(
        `SELECT m.created_at, m.qty, m.expected, m.note, i.name, i.unit, i.cost, u.name AS by_name
           FROM stock_moves m JOIN ingredients i ON i.id = m.ingredient_id LEFT JOIN users u ON u.id = m.user_id
          WHERE m.kind = ? AND m.branch_id = ? AND m.date BETWEEN ? AND ?` + (kind === 'count' ? ' AND m.qty != 0' : '') + ' ORDER BY m.id DESC LIMIT 200').all(kind, bid, from, to);
      out.variances = list('count').map((m) => ({ at: m.created_at, name: m.name, unit: m.unit, expected: m.expected, actual: r3(m.expected + m.qty), diff: m.qty, value: Math.round(m.qty * m.cost), by: m.by_name }));
      out.wastes = list('waste').map((m) => ({ at: m.created_at, name: m.name, unit: m.unit, qty: -m.qty, value: Math.round(-m.qty * m.cost), reason: m.note, by: m.by_name }));
    } else {
      out.by_branch = db.prepare('SELECT id, name FROM branches ORDER BY id').all().map((b) => ({ id: b.id, name: b.name, variance_value: Math.round((bb[b.id] || {}).variance_value || 0), waste_value: Math.round((bb[b.id] || {}).waste_value || 0) }));
    }
    return out;
  });
  add('GET', '/api/audit', 'owner', ({ user, query }) => {
    const bid = scopeBranch(user, query);
    const rows = db.prepare(
      `SELECT a.id, a.branch_id, a.action, a.detail, a.created_at, u.name AS by_name, b.name AS branch_name
         FROM audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN branches b ON b.id = a.branch_id` + (bid ? ' WHERE a.branch_id = ?' : '') + ' ORDER BY a.id DESC LIMIT 200').all(...(bid ? [bid] : []));
    return { log: rows };
  });

  /* ---------- ตัวรับคำขอ ---------- */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 200 * 1024) { reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        if (!String(req.headers['content-type'] || '').includes('application/json')) return reject(new HttpError(415, 'ต้องส่งเป็น JSON'));
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch (_) { reject(new HttpError(400, 'ข้อมูลไม่ถูกต้อง')); }
      });
      req.on('error', reject);
    });
  }
  function send(res, status, type, data) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  }
  const sendJson = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (p === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
      if (!p.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'ไม่รองรับ');
        if (/\.[a-z0-9]+$/i.test(p)) {
          const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
          const safe = path.normalize(p).replace(/\\/g, '/');
          if (!safe.includes('..')) {
            try { const data = fs.readFileSync(path.join(__dirname, 'public', safe)); return send(res, 200, MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream', data); } catch (_) { /* fall through */ }
          }
          return send(res, 404, 'text/plain; charset=utf-8', 'not found');
        }
        return send(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : indexHtml);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(p));
      if (!r) throw new HttpError(404, 'ไม่พบหน้านี้');
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin) {
          let ok = false;
          try { ok = new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch (_) { /* ignore */ }
          if (!ok) throw new HttpError(403, 'คำขอไม่ถูกต้อง');
        }
      }
      let user = null;
      if (r.auth !== 'none') {
        user = userFromReq(req);
        if (!user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
        if (r.auth === 'hq' && user.role !== 'hq') throw new HttpError(403, 'เฉพาะสำนักงานใหญ่');
        if (r.auth === 'seller' && user.role === 'hq') throw new HttpError(403, 'เฉพาะบัญชีสาขา');
        if (r.auth === 'manager' && user.role === 'staff') throw new HttpError(403, 'เฉพาะเจ้าของสาขาหรือสำนักงานใหญ่');
        if (r.auth === 'owner' && user.role !== 'branch') throw new HttpError(403, 'เฉพาะเจ้าของสาขา');
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
      const m = r.re.exec(p);
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const query = Object.fromEntries(url.searchParams);
      const out = r.handler({ req, res, user, params, query, body });
      if (out && out.raw !== undefined) return send(res, 200, out.type, out.raw);
      return sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      return sendJson(res, 500, { error: 'เกิดข้อผิดพลาดในระบบ ลองอีกครั้ง' });
    }
  }

  const server = http.createServer(handle);
  return {
    server, db, version,
    listen: (port) => new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) { /* ignore */ } resolve(); }))
  };
}

module.exports = { createApp, OPT };

if (require.main === module) {
  const app = createApp();
  app.listen(+process.env.PORT || 3000).then((port) => {
    console.log('ระบบขายหน้าร้านพร้อมใช้งานที่พอร์ต ' + port + ' (เวอร์ชัน ' + app.version + ')');
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
