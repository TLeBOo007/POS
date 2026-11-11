'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

let t = new Date('2026-11-11T05:00:00Z'); // 12:00 น. เวลาไทย
let app, base;

function client() {
  let cookie = '';
  return {
    async req(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (sc.length) { const c = sc[0].split(';')[0]; cookie = c === 'sid=' ? '' : c; }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    },
    login(email, password) { return this.req('POST', '/api/login', { email, password }); },
    get cookie() { return cookie; }
  };
}

const items = {}; // ชื่อเมนู -> id
const hq = client(), a = client(), b = client();
let branchA, branchB, pwA, pwB;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  app = createApp({ dataDir: dir, quiet: true, now: () => t, adminEmail: 'hq@test.com', adminPassword: 'hq-password-1', secureCookie: false });
  base = 'http://127.0.0.1:' + (await app.listen(0));
});
test.after(async () => { await app.close(); });

test('ต้องล็อกอินก่อน และรหัสผิดเข้าไม่ได้', async () => {
  const anon = client();
  assert.equal((await anon.req('GET', '/api/menu')).status, 401);
  assert.equal((await anon.login('hq@test.com', 'wrong')).status, 401);
  assert.equal((await anon.login('nobody@test.com', 'whatever1')).status, 401);
  const ok = await hq.login('hq@test.com', 'hq-password-1');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'hq');
  assert.ok(hq.cookie.startsWith('sid='));
  assert.equal((await hq.req('GET', '/api/me')).json.user.email, 'hq@test.com');
});

test('สำนักงานใหญ่สร้างสาขาและเจ้าของร้าน', async () => {
  const ra = await hq.req('POST', '/api/branches', { name: 'สาขาเชียงใหม่', area: 'นิมมาน', owner_name: 'คุณเอ', owner_email: 'A@Test.com' });
  assert.equal(ra.status, 200);
  assert.ok(ra.json.temp_password && ra.json.temp_password.length >= 12);
  branchA = ra.json.id; pwA = ra.json.temp_password;
  const rb = await hq.req('POST', '/api/branches', { name: 'สาขาลำปาง', area: 'ตัวเมือง', owner_name: 'คุณบี', owner_email: 'b@test.com', password: 'bee-password-1' });
  branchB = rb.json.id; pwB = 'bee-password-1';
  assert.equal(rb.json.temp_password, null);
  // อีเมลซ้ำ (ไม่สนตัวพิมพ์ใหญ่เล็ก)
  assert.equal((await hq.req('POST', '/api/branches', { name: 'ซ้ำ', owner_name: 'x', owner_email: 'a@test.com' })).status, 409);
  assert.equal((await a.login('a@test.com', pwA)).status, 200);
  assert.equal((await b.login('b@test.com', pwB)).status, 200);
  const menu = (await a.req('GET', '/api/menu')).json.menu;
  assert.ok(menu.length >= 13);
  menu.forEach((m) => { items[m.name] = m.id; });
});

test('เจ้าของสาขาเข้าถึงฟังก์ชันของสำนักงานใหญ่ไม่ได้', async () => {
  assert.equal((await a.req('GET', '/api/branches')).status, 403);
  assert.equal((await a.req('POST', '/api/menu', { name: 'x', cat: 'y', price: 1 })).status, 403);
  assert.equal((await a.req('PUT', '/api/branches/' + branchA, { name: 'แฮ็ก', area: '', status: 'active' })).status, 403);
  assert.equal((await a.req('POST', '/api/branches/' + branchB + '/reset-password')).status, 403);
  assert.equal((await hq.req('POST', '/api/orders', { lines: [] })).status, 403); // สำนักงานใหญ่ไม่ใช่สาขา
});

test('คำนวณราคาที่เซิร์ฟเวอร์ ไม่เชื่อราคาจากเครื่อง', async () => {
  const r = await a.req('POST', '/api/orders', {
    client_id: 'cid-0001-aaaa', pay: 'cash', received: 200, discount: 10,
    lines: [{ item_id: items['ชาไทย'], temp: 1, sweet: 2, tops: [0], qty: 2, note: 'แยกน้ำแข็ง', unit: 1, price: 1 }]
  });
  assert.equal(r.status, 200);
  const o = r.json.order;
  assert.equal(o.no, 1);
  assert.equal(o.lines[0].unit, 60);        // 45 + เย็น 5 + ไข่มุก 10
  assert.equal(o.lines[0].opt, 'เย็น · ปกติ · ไข่มุก');
  assert.equal(o.subtotal, 120);
  assert.equal(o.total, 110);
  assert.equal(o.received, 200);
  // ของที่ไม่มีตัวเลือก
  const r2 = await a.req('POST', '/api/orders', { client_id: 'cid-0002-aaaa', pay: 'transfer', lines: [{ item_id: items['บราวนี่'], qty: 1 }] });
  assert.equal(r2.json.order.no, 2);
  assert.equal(r2.json.order.total, 35);
  assert.equal(r2.json.order.received, null);
});

test('ส่งซ้ำด้วยรหัสคำขอเดิมไม่เกิดออเดอร์ซ้ำ', async () => {
  const body = { client_id: 'cid-dup-0001', pay: 'cash', lines: [{ item_id: items['คุกกี้'], qty: 1 }] };
  const r1 = await a.req('POST', '/api/orders', body);
  const r2 = await a.req('POST', '/api/orders', body);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r1.json.order.id, r2.json.order.id);
  assert.equal(r1.json.order.no, r2.json.order.no);
});

test('แต่ละสาขาเลขออเดอร์แยกกัน และมองไม่เห็นกัน', async () => {
  const rb = await b.req('POST', '/api/orders', { client_id: 'cid-b-00001', pay: 'cash', lines: [{ item_id: items['ลาเต้'], temp: 0, sweet: 2, qty: 1 }] });
  assert.equal(rb.json.order.no, 1);
  const own = (await b.req('GET', '/api/orders')).json.orders;
  assert.equal(own.length, 1);
  assert.ok(own.every((o) => o.branch_id === branchB));
  // ลองขอข้อมูลสาขา A ด้วย branch_id ก็ยังได้เฉพาะของตัวเอง
  const peek = (await b.req('GET', '/api/orders?branch_id=' + branchA)).json.orders;
  assert.ok(peek.every((o) => o.branch_id === branchB));
  const rep = (await b.req('GET', '/api/report?from=2026-11-11&to=2026-11-11&branch_id=' + branchA)).json;
  assert.equal(rep.count, 1);
  assert.equal(rep.by_branch, undefined);
  // ยกเลิกออเดอร์ของสาขาอื่นไม่ได้
  const aOrders = (await a.req('GET', '/api/orders')).json.orders;
  assert.equal((await b.req('PATCH', '/api/orders/' + aOrders[0].id, { void: true })).status, 403);
  // ตั้งค่าเมนูของสาขาอื่นไม่ได้
  assert.equal((await b.req('PUT', '/api/branches/' + branchA + '/items/' + items['ชาไทย'], { sold_out: true })).status, 403);
});

test('ราคาเฉพาะสาขาและเมนูหมด', async () => {
  const id = items['ชาไทย'];
  // เจ้าของสาขาตั้งราคาเองไม่ได้
  assert.equal((await a.req('PUT', '/api/branches/' + branchA + '/items/' + id, { price: 1 })).status, 403);
  // สำนักงานใหญ่ตั้งราคาสาขา A เป็น 50
  assert.equal((await hq.req('PUT', '/api/branches/' + branchA + '/items/' + id, { price: 50 })).status, 200);
  const ma = (await a.req('GET', '/api/menu')).json.menu.find((m) => m.id === id);
  const mb = (await b.req('GET', '/api/menu')).json.menu.find((m) => m.id === id);
  assert.equal(ma.price, 50);
  assert.equal(mb.price, 45);
  const o = (await a.req('POST', '/api/orders', { client_id: 'cid-0003-aaaa', pay: 'cash', lines: [{ item_id: id, temp: 0, sweet: 0, qty: 1 }] })).json.order;
  assert.equal(o.lines[0].unit, 50);
  // เจ้าของสาขา A ตั้งหมด → ขายไม่ได้ แต่สาขา B ยังขายได้ และราคาที่ตั้งไว้ไม่หาย
  assert.equal((await a.req('PUT', '/api/branches/' + branchA + '/items/' + id, { sold_out: true })).status, 200);
  const blocked = await a.req('POST', '/api/orders', { client_id: 'cid-0004-aaaa', pay: 'cash', lines: [{ item_id: id, temp: 0, sweet: 0, qty: 1 }] });
  assert.equal(blocked.status, 409);
  const okB = await b.req('POST', '/api/orders', { client_id: 'cid-b-00002', pay: 'cash', lines: [{ item_id: id, temp: 0, sweet: 0, qty: 1 }] });
  assert.equal(okB.status, 200);
  assert.equal((await a.req('GET', '/api/menu')).json.menu.find((m) => m.id === id).price, 50);
  // ล้างราคาเฉพาะสาขา กลับไปใช้ราคากลาง
  await hq.req('PUT', '/api/branches/' + branchA + '/items/' + id, { price: null });
  await a.req('PUT', '/api/branches/' + branchA + '/items/' + id, { sold_out: false });
  assert.equal((await a.req('GET', '/api/menu')).json.menu.find((m) => m.id === id).price, 45);
});

test('แก้เมนูกลางแล้วทุกสาขาเปลี่ยนพร้อมกัน', async () => {
  const id = items['อเมริกาโน่'];
  assert.equal((await hq.req('PUT', '/api/menu/' + id, { name: 'อเมริกาโน่', cat: 'กาแฟ', price: 48, opts: true })).status, 200);
  assert.equal((await a.req('GET', '/api/menu')).json.menu.find((m) => m.id === id).price, 48);
  assert.equal((await b.req('GET', '/api/menu')).json.menu.find((m) => m.id === id).price, 48);
  const add = await hq.req('POST', '/api/menu', { name: 'ชาใหม่', cat: 'ชา', price: 42, opts: true });
  assert.ok((await b.req('GET', '/api/menu')).json.menu.some((m) => m.id === add.json.id));
  await hq.req('DELETE', '/api/menu/' + add.json.id);
  assert.ok(!(await b.req('GET', '/api/menu')).json.menu.some((m) => m.id === add.json.id));
});

test('ข้อมูลที่ไม่ถูกต้องถูกปฏิเสธ', async () => {
  const id = items['ชาไทย'];
  const line = { item_id: id, temp: 0, sweet: 0, qty: 1 };
  const post = (over) => a.req('POST', '/api/orders', { client_id: 'cid-bad-' + Math.random().toString(36).slice(2, 10), pay: 'cash', lines: [line], ...over });
  assert.equal((await post({ lines: [] })).status, 400);
  assert.equal((await post({ pay: 'bitcoin' })).status, 400);
  assert.equal((await post({ lines: [{ ...line, qty: 0 }] })).status, 400);
  assert.equal((await post({ lines: [{ ...line, qty: 1000 }] })).status, 400);
  assert.equal((await post({ lines: [{ ...line, temp: 9 }] })).status, 400);
  assert.equal((await post({ lines: [{ ...line, tops: [99] }] })).status, 400);
  assert.equal((await post({ lines: [{ item_id: 99999, qty: 1 }] })).status, 400);
  assert.equal((await post({ received: 10 })).status, 400);
  assert.equal((await post({ discount: -5 })).status, 400);
  const big = await post({ discount: 99999 }); // ส่วนลดเกินยอด ถูกจำกัดที่ยอดรวม
  assert.equal(big.json.order.total, 0);
});

test('ยกเลิกออเดอร์ไม่นับในรายงาน และสำนักงานใหญ่เห็นทุกสาขา', async () => {
  const day = '2026-11-11';
  const before = (await hq.req('GET', `/api/report?from=${day}&to=${day}`)).json;
  const list = (await a.req('GET', '/api/orders')).json.orders;
  const target = list.find((o) => o.total === 110);
  assert.equal((await a.req('PATCH', '/api/orders/' + target.id, { void: true })).status, 200);
  const after = (await hq.req('GET', `/api/report?from=${day}&to=${day}`)).json;
  assert.equal(after.total, before.total - 110);
  assert.equal(after.voided, before.voided + 1);
  assert.equal(after.by_branch.length, 2);
  const sumBranches = after.by_branch.reduce((s, x) => s + x.total, 0);
  assert.equal(sumBranches, after.total);
  // กู้คืนได้
  await a.req('PATCH', '/api/orders/' + target.id, { void: false });
  assert.equal((await hq.req('GET', `/api/report?from=${day}&to=${day}`)).json.total, before.total);
  // เลือกสาขาเดียว
  const onlyB = (await hq.req('GET', `/api/report?from=${day}&to=${day}&branch_id=${branchB}`)).json;
  assert.equal(onlyB.by_branch, undefined);
  assert.ok(onlyB.total > 0 && onlyB.total < after.total);
  assert.equal((await hq.req('GET', '/api/report?from=2026-12-01&to=2026-11-01')).status, 400);
});

test('ขึ้นวันใหม่ เลขออเดอร์เริ่ม 1 ใหม่ (ตามเวลาไทย)', async () => {
  t = new Date('2026-11-11T16:59:00Z'); // 23:59 น. ยังเป็นวันที่ 11
  const r1 = await a.req('POST', '/api/orders', { client_id: 'cid-late-001', pay: 'cash', lines: [{ item_id: items['คุกกี้'], qty: 1 }] });
  assert.equal(r1.json.order.date, '2026-11-11');
  t = new Date('2026-11-11T17:01:00Z'); // 00:01 น. วันที่ 12
  const r2 = await a.req('POST', '/api/orders', { client_id: 'cid-late-002', pay: 'cash', lines: [{ item_id: items['คุกกี้'], qty: 1 }] });
  assert.equal(r2.json.order.date, '2026-11-12');
  assert.equal(r2.json.order.no, 1);
  t = new Date('2026-11-11T05:00:00Z');
});

test('สาขาที่ถูกระงับขายไม่ได้ แต่เข้าดูข้อมูลได้', async () => {
  assert.equal((await hq.req('PUT', '/api/branches/' + branchB, { name: 'สาขาลำปาง', area: 'ตัวเมือง', status: 'paused' })).status, 200);
  const r = await b.req('POST', '/api/orders', { client_id: 'cid-paused-1', pay: 'cash', lines: [{ item_id: items['คุกกี้'], qty: 1 }] });
  assert.equal(r.status, 403);
  assert.equal((await b.req('GET', '/api/orders')).status, 200);
  await hq.req('PUT', '/api/branches/' + branchB, { name: 'สาขาลำปาง', area: 'ตัวเมือง', status: 'active' });
  assert.equal((await b.req('POST', '/api/orders', { client_id: 'cid-paused-2', pay: 'cash', lines: [{ item_id: items['คุกกี้'], qty: 1 }] })).status, 200);
});

test('เปลี่ยน/รีเซ็ตรหัสผ่านแล้วเซสชันเก่าใช้ไม่ได้', async () => {
  const oldB = client();
  await oldB.login('b@test.com', pwB);
  assert.equal((await oldB.req('GET', '/api/me')).status, 200);
  const reset = await hq.req('POST', '/api/branches/' + branchB + '/reset-password');
  assert.equal(reset.status, 200);
  assert.equal(reset.json.email, 'b@test.com');
  assert.equal((await oldB.req('GET', '/api/me')).status, 401);
  assert.equal((await client().login('b@test.com', pwB)).status, 401);
  pwB = reset.json.temp_password;
  assert.equal((await b.login('b@test.com', pwB)).status, 200);
  // เปลี่ยนเอง
  assert.equal((await b.req('POST', '/api/password', { old: 'wrong', new: 'new-password-1' })).status, 400);
  assert.equal((await b.req('POST', '/api/password', { old: pwB, new: 'short' })).status, 400);
  assert.equal((await b.req('POST', '/api/password', { old: pwB, new: 'new-password-1' })).status, 200);
  assert.equal((await b.req('GET', '/api/me')).status, 200); // ได้คุกกี้ใหม่ ไม่ต้องล็อกอินซ้ำ
  assert.equal((await client().login('b@test.com', 'new-password-1')).status, 200);
});

test('ส่งออก CSV ครอบคลุมทุกสาขา และกันสูตร Excel', async () => {
  await hq.req('PUT', '/api/menu/' + items['คุกกี้'], { name: '=HYPERLINK("x")', cat: 'ขนม', price: 25, opts: false });
  await a.req('POST', '/api/orders', { client_id: 'cid-csv-0001', pay: 'cash', lines: [{ item_id: items['คุกกี้'], qty: 1 }] });
  const day = '2026-11-11';
  const res = await hq.req('GET', `/api/export.csv?from=${day}&to=${day}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/csv'));
  const raw = new Uint8Array(await (await fetch(base + `/api/export.csv?from=${day}&to=${day}`, { headers: { Cookie: hq.cookie } })).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // BOM ให้ Excel อ่านภาษาไทยถูก
  assert.ok(res.text.includes('สาขาเชียงใหม่') && res.text.includes('สาขาลำปาง'));
  assert.ok(res.text.includes("'=HYPERLINK"), 'ต้องมี \' นำหน้าสูตร');
  assert.ok(!res.text.includes(',"=HYPERLINK'));
  const onlyA = await a.req('GET', `/api/export.csv?from=${day}&to=${day}`);
  assert.ok(!onlyA.text.includes('สาขาลำปาง'));
});

test('กันเดารหัสผ่านและคำขอข้ามเว็บ', async () => {
  const x = client();
  let last;
  for (let i = 0; i < 9; i++) last = await x.login('victim@test.com', 'bad-guess-' + i);
  assert.equal(last.status, 429);
  const csrf = await hq.req('POST', '/api/menu', { name: 'x', cat: 'y', price: 1 }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
  const wrongType = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'email=a' });
  assert.equal(wrongType.status, 415);
});

test('เวอร์ชันและหน้าเว็บ', async () => {
  const v = (await client().req('GET', '/api/version')).json.version;
  assert.equal(v, app.version);
  const page = await client().req('GET', '/anything/here');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(v));
  assert.equal((await client().req('GET', '/favicon.ico')).status, 404);
  assert.equal((await client().req('GET', '/api/nope')).status, 404);
  assert.equal((await client().req('GET', '/healthz')).text, 'ok');
});
