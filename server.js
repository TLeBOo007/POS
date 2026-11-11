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
      id: r.id, branch_id: r.branch_id, branch_name: r.branch_name, date: r.date, no: r.no, created_at: r.created_at,
      lines: JSON.parse(r.lines), subtotal: r.subtotal, discount: r.discount, total: r.total, pay: r.pay,
      received: r.received, void: !!r.void, void_at: r.void_at
    };
  }
  const ORDER_SELECT = 'SELECT o.*, b.name AS branch_name FROM orders o JOIN branches b ON b.id = o.branch_id';

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
    const lines = body.lines.map((l) => {
      const item = menu.get(reqInt(l.item_id, 1, 1e9, 'รหัสเมนู'));
      if (!item) throw new HttpError(400, 'มีเมนูที่ไม่มีในระบบแล้ว ลองรีเฟรชหน้า');
      if (item.sold_out) throw new HttpError(409, 'เมนู "' + item.name + '" หมดอยู่ ลบออกจากตะกร้าก่อน');
      const qty = reqInt(l.qty, 1, 99, 'จำนวน');
      let unit = item.price, optText = '';
      if (item.opts) {
        const t = reqInt(l.temp, 0, OPT.temp.length - 1, 'แบบเครื่องดื่ม');
        const s = reqInt(l.sweet, 0, OPT.sweet.length - 1, 'ความหวาน');
        const tops = Array.isArray(l.tops) ? [...new Set(l.tops.map((x) => reqInt(x, 0, OPT.tops.length - 1, 'ท็อปปิ้ง')))].sort() : [];
        unit += OPT.temp[t][1] + tops.reduce((a, i) => a + OPT.tops[i][1], 0);
        optText = [OPT.temp[t][0], OPT.sweet[s]].concat(tops.length ? [tops.map((i) => OPT.tops[i][0]).join(', ')] : []).join(' · ');
      }
      const note = l.note == null || l.note === '' ? '' : reqStr(String(l.note), 0, 100, 'หมายเหตุ');
      subtotal += unit * qty;
      return { item_id: item.id, name: item.name, opt: optText, unit, qty, note };
    });
    const discount = Math.min(body.discount == null || body.discount === '' ? 0 : reqInt(body.discount, 0, 1e7, 'ส่วนลด'), subtotal);
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
      return { order: fmtOrder(db.prepare(ORDER_SELECT + ' WHERE o.id = ?').get(r.lastInsertRowid)), duplicate: false };
    });
  }

  /* ----- รายงาน ----- */
  function rangeOf(q) {
    if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HttpError(400, 'ช่วงวันที่ไม่ถูกต้อง');
    if ((new Date(q.to) - new Date(q.from)) / 86400e3 > 366) throw new HttpError(400, 'เลือกช่วงได้ไม่เกิน 1 ปี');
    return [q.from, q.to];
  }
  function scopeBranch(user, q) {
    if (user.role === 'branch') return user.branch_id;
    if (q.branch_id == null || q.branch_id === '') return null;
    const id = reqInt(q.branch_id, 1, 1e9, 'สาขา');
    if (!getBranch(id)) throw new HttpError(404, 'ไม่พบสาขา');
    return id;
  }
  function report(user, q) {
    const [from, to] = rangeOf(q);
    const bid = scopeBranch(user, q);
    const rows = db.prepare(
      `SELECT branch_id, date, total, pay, void, lines FROM orders WHERE date BETWEEN ? AND ?` + (bid ? ' AND branch_id = ?' : '')
    ).all(...(bid ? [from, to, bid] : [from, to]));
    let count = 0, voided = 0, total = 0;
    const byPay = {}, byDay = {}, byItem = {}, byBranch = {};
    for (const r of rows) {
      const bb = byBranch[r.branch_id] || (byBranch[r.branch_id] = { count: 0, total: 0, voided: 0 });
      if (r.void) { voided++; bb.voided++; continue; }
      count++; total += r.total; bb.count++; bb.total += r.total;
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
    const head = ['สาขา', 'วันที่', 'เวลา', 'เลขออเดอร์', 'รายการ', 'ส่วนลด', 'ยอดรวม', 'ชำระโดย', 'สถานะ'];
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const body = rows.map((r) => [
      r.branch_name, r.date, time.format(new Date(r.created_at)), r.no,
      JSON.parse(r.lines).map((l) => l.name + (l.opt ? ' (' + l.opt + ')' : '') + ' x' + l.qty).join('; '),
      r.discount, r.total, PAY_LABEL[r.pay] || r.pay, r.void ? 'ยกเลิก' : 'ปกติ'
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
    if (user.role === 'branch' && user.branch_id !== branchId) throw new HttpError(403, 'ไม่มีสิทธิ์เข้าถึงสาขานี้');
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
  add('PUT', '/api/branches/:id/items/:itemId', 'any', ({ user, params, body }) => {
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
    return { ok: true };
  });

  /* ออเดอร์ */
  add('POST', '/api/orders', 'branch', ({ user, body }) => createOrder(user, body));
  add('GET', '/api/orders', 'any', ({ user, query }) => {
    const date = query.date == null ? today() : query.date;
    if (!isDate(date)) throw new HttpError(400, 'วันที่ไม่ถูกต้อง');
    const bid = scopeBranch(user, query);
    const rows = db.prepare(ORDER_SELECT + ' WHERE o.date = ?' + (bid ? ' AND o.branch_id = ?' : '') + ' ORDER BY o.branch_id, o.no DESC LIMIT 1000')
      .all(...(bid ? [date, bid] : [date]));
    return { date, orders: rows.map(fmtOrder) };
  });
  add('PATCH', '/api/orders/:id', 'any', ({ user, params, body }) => {
    const o = db.prepare('SELECT id, branch_id FROM orders WHERE id = ?').get(reqInt(params.id, 1, 1e9, 'ออเดอร์'));
    if (!o) throw new HttpError(404, 'ไม่พบออเดอร์');
    needBranchAccess(user, o.branch_id);
    if (typeof body.void !== 'boolean') throw new HttpError(400, 'คำขอไม่ถูกต้อง');
    db.prepare('UPDATE orders SET void = ?, void_at = ? WHERE id = ?').run(body.void ? 1 : 0, body.void ? nowIso() : null, o.id);
    return { ok: true };
  });

  /* รายงาน */
  add('GET', '/api/report', 'any', ({ user, query }) => report(user, query));
  add('GET', '/api/export.csv', 'any', ({ user, query, res }) => {
    const csv = exportCsv(user, query);
    res.setHeader('Content-Disposition', 'attachment; filename="sales-' + query.from + '_' + query.to + '.csv"');
    return { raw: csv, type: 'text/csv; charset=utf-8' };
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
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (p === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
      if (!p.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'ไม่รองรับ');
        if (/\.[a-z0-9]+$/i.test(p)) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
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
        if (r.auth === 'branch' && user.role !== 'branch') throw new HttpError(403, 'เฉพาะบัญชีสาขา');
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
