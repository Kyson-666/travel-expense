/* 冒烟测试：预算 vs 实际 + 超限提示（#21）
 * 自起服务（隔离 DATA_DIR），覆盖：
 *  - 路线增删改带 currency / budget_total / budget_daily / start_date / end_date
 *  - /api/stats/summary 返回 homeCurrency/budgetTotal/remaining/overBudget，多币种换算正确
 *  - 管理端改本位币后统计口径切换
 *  - 列表分页 total/page/pageSize
 * 运行：node tests/smoke-budget.test.js
 * 退出码：0=全绿 1=有失败
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3901;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-budget-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

async function req(method, p, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + p, opt);
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

const approx = (a, b, eps) => Math.abs(a - b) < (eps || 0.01);

async function main() {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动 /health 200', up);
  if (!up) { console.log('服务未启动，中止'); srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    /* ---------- 登录 ---------- */
    section('登录管理员');
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    check('admin 登录成功', r.status === 200 && r.json.ok && r.json.data.role === 'admin', r);
    const adminCookie = r.setCookie;
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);

    /* ---------- 预算字段增删改 ---------- */
    section('路线：多币种 + 预算字段');
    r = await req('POST', '/api/routes', {
      name: '东京赏枫', year: '2026', daterange: '8/1-8/5', start_date: '2026-08-01', end_date: '2026-08-05',
      days: 5, people: 2, currency: 'USD', budget_total: 1000, budget_daily: 200,
      exp: { 机票: 300, 住宿: 400, 餐饮: 100 }
    }, adminCookie);
    check('新建路线 201', r.status === 201, r);
    const d = r.json && r.json.data;
    check('路由 JSON 带 currency=USD', d && d.currency === 'USD', d);
    check('路由 JSON 带 budget_total=1000 / budget_daily=200', d && d.budget_total === 1000 && d.budget_daily === 200, d);
    check('路由 JSON 带 start_date/end_date', d && d.start_date === '2026-08-01' && d.end_date === '2026-08-05', d);
    const usdId = d.id;

    r = await req('POST', '/api/routes', {
      name: '周末短途', year: '2026', daterange: '9/1-9/2', days: 2, people: 1,
      currency: 'CNY', budget_total: 100, budget_daily: 50,
      exp: { 餐饮: 200 }
    }, adminCookie);
    check('新建超支路线 201', r.status === 201, r);
    const cnyId = r.json && r.json.data && r.json.data.id;

    r = await req('GET', '/api/routes/' + usdId, null, adminCookie);
    check('详情回读字段一致', r.status === 200 && r.json.data.currency === 'USD' && r.json.data.budget_total === 1000, r);

    r = await req('PUT', '/api/routes/' + usdId, { ...r.json.data, budget_total: 800 }, adminCookie);
    check('PUT 更新预算生效', r.status === 200 && r.json.data.budget_total === 800, r);

    /* ---------- 统计聚合（本位币 CNY） ---------- */
    section('统计：本位币 CNY 聚合');
    r = await req('GET', '/api/routes/stats/summary', null, adminCookie);
    const s = r.json && r.json.data;
    check('summary 200 + homeCurrency=CNY', r.status === 200 && s && s.homeCurrency === 'CNY', s);
    check('summary 返回 budgetTotal>0', s && s.budgetTotal > 0, s);
    // USD800(→CNY) + CNY200，grand = 800*rate + 200；budgetTotal = 800*rate + 100
    const rateUsd = s.budgetTotal > s.remaining + s.grand ? 1 : 0; // 占位，下面用精确断言
    const budgetCNY = s.budgetTotal, grandCNY = s.grand, remCNY = s.remaining;
    check('remaining = budgetTotal - grand', approx(remCNY, budgetCNY - grandCNY, 0.1), { budgetCNY, grandCNY, remCNY });
    check('overBudget=true（CNY 路线 200 > 100）', s.overBudget === true, s.overBudget);
    check('USD 路线换算计入总额（grand>CNY 部分）', grandCNY > 200, grandCNY);

    /* ---------- 改本位币 USD ---------- */
    section('统计：切本位币 USD');
    r = await req('PUT', '/api/admin/site-settings', { site_name: '旅行经费工作台', allow_register: true, register_mode: 'all', announce_text: '', home_currency: 'usd' }, adminCookie);
    check('PUT site-settings 接受小写 usd 并归一', r.status === 200, r);
    r = await req('GET', '/api/admin/site-settings', null, adminCookie);
    check('本位币已存为 USD', r.json.data.home_currency === 'USD', r.json);
    r = await req('GET', '/api/routes/stats/summary', null, adminCookie);
    const s2 = r.json && r.json.data;
    check('summary homeCurrency=USD', s2 && s2.homeCurrency === 'USD', s2);
    check('USD 口径下 grand ≈ 800 + 200/rate', s2 && s2.grand > 800 && s2.grand < 900, s2 && s2.grand);
    check('USD 口径 overBudget 仍为 true', s2 && s2.overBudget === true, s2 && s2.overBudget);
    // 比值自洽：budgetTotal(USD)/budgetTotal(CNY) ≈ 1/rate，rate>1 则 USD 口径更小
    check('USD 口径 budgetTotal < CNY 口径 budgetTotal', s2.budgetTotal < budgetCNY, { s2: s2.budgetTotal, cny: budgetCNY });

    /* ---------- 分页 ---------- */
    section('列表分页');
    for (let i = 0; i < 60; i++) {
      await req('POST', '/api/routes', { name: '批量路线' + i, year: '2025', daterange: '3/1-3/2', days: 2, people: 1, exp: { 其他: 10 } }, adminCookie);
    }
    r = await req('GET', '/api/routes?page=1&pageSize=50', null, adminCookie);
    check('page1 返回 50 条', r.status === 200 && r.json.data.list.length === 50, r.json && r.json.data && r.json.data.list && r.json.data.list.length);
    check('total = 62（种子4 + 新建2 + 批量60）', r.json.data.total === 62, r.json.data && r.json.data.total);
    r = await req('GET', '/api/routes?page=2&pageSize=50', null, adminCookie);
    check('page2 返回剩余 12 条', r.status === 200 && r.json.data.list.length === 12, r.json.data && r.json.data.list && r.json.data.list.length);
    r = await req('GET', '/api/routes?pageSize=999', null, adminCookie);
    check('pageSize 超上限被钳制为 200', r.status === 200 && r.json.data.pageSize === 200, r.json.data && r.json.data.pageSize);

    /* ---------- 清理 ---------- */
    section('清理');
    r = await req('DELETE', '/api/routes/' + usdId, null, adminCookie);
    check('删除 USD 路线', r.status === 200, r);
    r = await req('DELETE', '/api/routes/' + cnyId, null, adminCookie);
    check('删除 CNY 路线', r.status === 200, r);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 预算冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
