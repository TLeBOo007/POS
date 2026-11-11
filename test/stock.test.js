'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

const t0 = new Date('2026-11-11T05:00:00Z');
let app, base;
function client() {
  let cookie = '';
  return {
    async req(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (sc.length) { const c = sc[0].split(';')[0]; cookie = c === 'sid=' ? '' : c; }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* not json */ }
      return { status: res.status, json, text };
    },
    login(u, p) { return this.req('POST', '/api/login', { email: u, password: p }); }
  };
}
const hq = client(), owner = client(), staff = client(), owner2 = client();
const ing = {}, item = {};
let bA, bB, staffId, staffPw;
const today = '2026-11-11';

test.before(async () => {
  app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pos-stock-')), quiet: true, now: () => t0, adminEmail: 'hq@t.com', adminPassword: 'hq-password-1', secureCookie: false });
  base = 'http://127.0.0.1:' + (await app.listen(0));
  await hq.login('hq@t.com', 'hq-password-1');
  bA = (await hq.req('POST', '/api/branches', { name: 'สาขา A', owner_name: 'เจ้าของ A', owner_email: 'a@t.com', password: 'owner-pass-1' })).json.id;
  bB = (await hq.req('POST', '/api/branches', { name: 'สาขา B', owner_name: 'เจ้าของ B', owner_email: 'b@t.com', password: 'owner-pass-2' })).json.id;
  await owner.login('a@t.com', 'owner-pass-1');
  await owner2.login('b@t.com', 'owner-pass-2');
  (await owner.req('GET', '/api/menu')).json.menu.forEach((m) => { item[m.name] = m.id; });
  (await hq.req('GET', '/api/ingredients')).json.ingredients.forEach((i) => { ing[i.name] = i.id; });
});
test.after(async () => { await app.close(); });

const stock = async (c, bid) => {
  const r = (await c.req('GET', '/api/stock' + (bid ? '?branch_id=' + bid : ''))).json.ingredients;
  return Object.fromEntries(r.map((x) => [x.name, x.on_hand]));
};
const sell = (c, id, extra = {}, lines) => c.req('POST', '/api/orders', { client_id: 'cid-' + Math.random().toString(36).slice(2, 12), pay: 'cash', lines: lines || [{ item_id: id, temp: 0, sweet: 0, qty: 1 }], ...extra });

test('เจ้าของสร้างพนักงาน และพนักงานเข้าถึงได้เฉพาะงานขายหน้าร้าน', async () => {
  const r = await owner.req('POST', '/api/staff', { name: 'น้องนิด', username: 'Nid01' });
  assert.equal(r.status, 200);
  assert.equal(r.json.username, 'nid01');
  staffId = r.json.id; staffPw = r.json.temp_password;
  assert.equal((await owner.req('POST', '/api/staff', { name: 'ซ้ำ', username: 'nid01' })).status, 409);
  assert.equal((await staff.login('nid01', staffPw)).status, 200);
  const me = (await staff.req('GET', '/api/me')).json;
  assert.equal(me.user.role, 'staff');
  assert.equal(me.branch.id, bA);
  for (const [m, u, b] of [['GET', '/api/report?from=2026-11-11&to=2026-11-11'], ['GET', '/api/export.csv?from=2026-11-11&to=2026-11-11'], ['GET', '/api/audit'],
    ['GET', '/api/staff'], ['POST', '/api/staff', { name: 'x', username: 'xxxx' }], ['POST', '/api/stock/receive', { ingredient_id: 1, qty: 5 }],
    ['GET', '/api/stock/report?from=2026-11-11&to=2026-11-11'], ['POST', '/api/menu', { name: 'x', cat: 'y', price: 1 }], ['GET', '/api/branches'],
    ['PUT', '/api/branches/' + bA + '/items/' + item['ชาไทย'], { sold_out: true }]]) {
    assert.equal((await staff.req(m, u, b)).status, 403, m + ' ' + u);
  }
  assert.equal((await owner.req('GET', '/api/staff')).json.staff.length, 1);
  // เจ้าของสาขา B จัดการพนักงานสาขา A ไม่ได้
  assert.equal((await owner2.req('PUT', '/api/staff/' + staffId, { active: false })).status, 404);
  // พนักงานไม่เห็นยอดคงเหลือ/ต้นทุน
  const list = (await staff.req('GET', '/api/stock')).json.ingredients;
  assert.ok(list.length > 5);
  assert.ok(list.every((x) => x.on_hand === undefined && x.cost === undefined));
});

test('ขายแล้วตัดสต๊อกตามสูตร รวมท็อปปิ้ง', async () => {
  await owner.req('POST', '/api/stock/receive', { ingredient_id: ing['นมสด'], qty: 2000, note: 'ซื้อจากแม็คโคร' });
  for (const n of ['แก้ว+ฝา', 'ใบชาไทย', 'นมข้นหวาน', 'น้ำเชื่อม', 'ไข่มุก', 'คุกกี้ (ชิ้น)']) await owner.req('POST', '/api/stock/receive', { ingredient_id: ing[n], qty: 1000 });
  const r = await sell(staff, item['ชาไทย'], {}, [{ item_id: item['ชาไทย'], temp: 0, sweet: 2, tops: [0], qty: 2 }]);
  assert.equal(r.status, 200);
  const s = await stock(owner);
  assert.equal(s['แก้ว+ฝา'], 998);
  assert.equal(s['ใบชาไทย'], 1000 - 24);
  assert.equal(s['นมข้นหวาน'], 1000 - 60);
  assert.equal(s['นมสด'], 2000 - 80);
  assert.equal(s['น้ำเชื่อม'], 1000 - 20);
  assert.equal(s['ไข่มุก'], 1000 - 80);
  assert.equal((await r.json.order.staff_name), 'น้องนิด');
  // สาขา B ไม่ได้รับผลกระทบ
  assert.ok(Object.values(await stock(owner2)).every((v) => v === 0));
  // ขนมไม่มีตัวเลือก/ท็อปปิ้ง ตัดเฉพาะสูตรของมัน
  await sell(staff, item['คุกกี้']);
  assert.equal((await stock(owner))['คุกกี้ (ชิ้น)'], 999);
});

test('นับสต๊อกแบบปิดตา: พนักงานไม่เห็นยอดที่ควรเหลือ แต่ส่วนต่างถูกบันทึกให้เจ้าของ', async () => {
  const expected = (await stock(owner))['นมสด']; // 1920
  const r = await staff.req('POST', '/api/stock/count', { counts: [{ ingredient_id: ing['นมสด'], actual: 1820 }, { ingredient_id: ing['ไข่มุก'], actual: 920 }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.results, undefined);
  assert.equal(r.json.counted, 2);
  const s = await stock(owner);
  assert.equal(s['นมสด'], 1820); // ยอดถูกปรับเป็นของที่นับจริง
  const rep = (await owner.req('GET', `/api/stock/report?from=${today}&to=${today}`)).json;
  const milk = rep.items.find((x) => x.name === 'นมสด');
  assert.equal(milk.variance, -100);
  assert.equal(milk.variance_value, -4); // 100 มล. × 0.04
  assert.equal(expected, 1920);
  assert.equal(rep.variances.length, 1); // ไข่มุกนับตรงพอดี ไม่ถือเป็นส่วนต่าง
  assert.equal(rep.variances[0].by, 'น้องนิด');
  assert.equal(rep.variances[0].expected, 1920);
  assert.equal(rep.variances[0].actual, 1820);
  assert.equal(rep.variance_value, -4);
  // เจ้าของนับเองจะเห็นผลทันที
  const o = await owner.req('POST', '/api/stock/count', { counts: [{ ingredient_id: ing['นมสด'], actual: 1800 }] });
  assert.equal(o.json.results[0].diff, -20);
  // ข้อมูลผิด
  assert.equal((await staff.req('POST', '/api/stock/count', { counts: [] })).status, 400);
  assert.equal((await staff.req('POST', '/api/stock/count', { counts: [{ ingredient_id: ing['นมสด'], actual: -1 }] })).status, 400);
  assert.equal((await staff.req('POST', '/api/stock/count', { counts: [{ ingredient_id: ing['นมสด'], actual: 5 }, { ingredient_id: ing['นมสด'], actual: 6 }] })).status, 400);
});

test('ของเสียต้องมีเหตุผล และถูกบันทึกว่าใครทำ', async () => {
  assert.equal((await staff.req('POST', '/api/stock/waste', { ingredient_id: ing['นมสด'], qty: 50 })).status, 400);
  assert.equal((await staff.req('POST', '/api/stock/waste', { ingredient_id: ing['นมสด'], qty: 50, reason: 'หกทิ้ง' })).status, 200);
  assert.equal((await stock(owner))['นมสด'], 1750);
  const rep = (await owner.req('GET', `/api/stock/report?from=${today}&to=${today}`)).json;
  assert.equal(rep.wastes[0].reason, 'หกทิ้ง');
  assert.equal(rep.wastes[0].by, 'น้องนิด');
  assert.equal(rep.waste_value, 2);
});

test('ยกเลิกบิล: ต้องเป็นเจ้าของ ต้องมีเหตุผล เลือกคืนสต๊อกหรือไม่ได้', async () => {
  const o1 = (await sell(staff, item['คุกกี้'])).json.order;
  const before = (await stock(owner))['คุกกี้ (ชิ้น)'];
  assert.equal((await staff.req('PATCH', '/api/orders/' + o1.id, { void: true, reason: 'ลองดู' })).status, 403);
  assert.equal((await owner.req('PATCH', '/api/orders/' + o1.id, { void: true })).status, 400);
  assert.equal((await owner.req('PATCH', '/api/orders/' + o1.id, { void: true, reason: 'ทำผิด ทิ้งแล้ว' })).status, 200);
  assert.equal((await stock(owner))['คุกกี้ (ชิ้น)'], before); // ไม่คืน: ของถูกใช้ไปแล้ว
  assert.equal((await owner.req('PATCH', '/api/orders/' + o1.id, { void: true, reason: 'ซ้ำ' })).status, 409);
  const o2 = (await sell(staff, item['คุกกี้'])).json.order;
  const b2 = (await stock(owner))['คุกกี้ (ชิ้น)'];
  await owner.req('PATCH', '/api/orders/' + o2.id, { void: true, reason: 'ลูกค้ายกเลิกก่อนทำ', restock: true });
  assert.equal((await stock(owner))['คุกกี้ (ชิ้น)'], b2 + 1);
  await owner.req('PATCH', '/api/orders/' + o2.id, { void: false });
  assert.equal((await stock(owner))['คุกกี้ (ชิ้น)'], b2); // กู้บิลแล้วตัดสต๊อกอีกครั้ง
  const orders = (await owner.req('GET', '/api/orders')).json.orders;
  assert.equal(orders.find((x) => x.id === o1.id).void_reason, 'ทำผิด ทิ้งแล้ว');
});

test('ส่วนลดเกินสิทธิ์พนักงานถูกปฏิเสธ แต่เจ้าของทำได้', async () => {
  const id = item['ชาไทย']; // 45 บาท → พนักงานลดได้ไม่เกิน 20% = 9 บาท
  assert.equal((await sell(staff, id, { discount: 10 })).status, 403);
  assert.equal((await sell(staff, id, { discount: 9 })).status, 200);
  assert.equal((await sell(owner, id, { discount: 30 })).status, 200);
});

test('บันทึกตรวจสอบ และรายงานแยกตามพนักงาน', async () => {
  const log = (await owner.req('GET', '/api/audit')).json.log;
  const acts = log.map((x) => x.action);
  for (const a of ['staff_add', 'stock_receive', 'stock_count', 'stock_waste', 'void', 'unvoid']) assert.ok(acts.includes(a), a);
  assert.ok(log.some((x) => x.action === 'void' && x.detail.includes('ทำผิด ทิ้งแล้ว')));
  assert.ok(log.every((x) => x.branch_id === bA)); // เจ้าของเห็นแต่ของสาขาตัวเอง
  assert.ok((await owner2.req('GET', '/api/audit')).json.log.length === 0);
  const rep = (await owner.req('GET', `/api/report?from=${today}&to=${today}`)).json;
  const nid = rep.by_user.find((u) => u.name === 'น้องนิด');
  assert.ok(nid && nid.count >= 3 && nid.discount === 9 && nid.voided === 1);
  const owned = rep.by_user.find((u) => u.name === 'เจ้าของ A');
  assert.equal(owned.discount, 30);
  // สำนักงานใหญ่ไม่เห็นสต๊อก/ส่วนต่าง/ประวัติตรวจสอบ/ยอดรายพนักงานของสาขา (ขายขาดแล้ว ข้อมูลเป็นของเจ้าของสาขา)
  for (const u of [`/api/stock/report?from=${today}&to=${today}&branch_id=${bA}`, '/api/audit?branch_id=' + bA, '/api/stock?branch_id=' + bA]) {
    assert.equal((await hq.req('GET', u)).status, 403, u);
  }
  const hrep = (await hq.req('GET', `/api/report?from=${today}&to=${today}&branch_id=${bA}`)).json;
  assert.equal(hrep.by_user, undefined);
});

test('สำนักงานใหญ่แก้สูตร แล้วการตัดสต๊อกครั้งถัดไปใช้สูตรใหม่', async () => {
  const id = item['คุกกี้'];
  assert.equal((await hq.req('PUT', '/api/recipes/item/' + id, { lines: [{ ingredient_id: ing['คุกกี้ (ชิ้น)'], qty: 2 }, { ingredient_id: ing['แก้ว+ฝา'], qty: 1 }] })).status, 200);
  const b = await stock(owner);
  await sell(staff, id);
  const a = await stock(owner);
  assert.equal(b['คุกกี้ (ชิ้น)'] - a['คุกกี้ (ชิ้น)'], 2);
  assert.equal(b['แก้ว+ฝา'] - a['แก้ว+ฝา'], 1);
  assert.equal((await hq.req('PUT', '/api/recipes/item/' + id, { lines: [{ ingredient_id: 99999, qty: 1 }] })).status, 400);
  assert.equal((await hq.req('PUT', '/api/recipes/item/' + id, { lines: [{ ingredient_id: ing['นมสด'], qty: 0 }] })).status, 400);
  assert.equal((await owner.req('PUT', '/api/recipes/item/' + id, { lines: [] })).status, 403);
  // เพิ่มวัตถุดิบใหม่และลบ
  const n = await hq.req('POST', '/api/ingredients', { name: 'ฝาโดม', unit: 'ใบ', cost: 0.5 });
  assert.equal(n.status, 200);
  assert.ok((await stock(owner))['ฝาโดม'] === 0);
  await hq.req('DELETE', '/api/ingredients/' + n.json.id);
  assert.ok(!('ฝาโดม' in (await stock(owner))));
});

test('ปิดบัญชีพนักงาน: เข้าระบบไม่ได้ทันที และรีเซ็ตรหัสผ่านได้', async () => {
  assert.equal((await staff.req('GET', '/api/me')).status, 200);
  await owner.req('PUT', '/api/staff/' + staffId, { active: false });
  assert.equal((await staff.req('GET', '/api/me')).status, 401);
  assert.equal((await client().login('nid01', staffPw)).status, 401);
  await owner.req('PUT', '/api/staff/' + staffId, { active: true });
  const rs = await owner.req('POST', '/api/staff/' + staffId + '/reset-password');
  assert.equal(rs.status, 200);
  assert.equal((await staff.login('nid01', rs.json.temp_password)).status, 200);
  // พนักงานดูออเดอร์ได้เฉพาะวันนี้ ถึงจะขอวันอื่นก็ตาม
  const o = (await staff.req('GET', '/api/orders?date=2026-01-01')).json;
  assert.equal(o.date, today);
});
