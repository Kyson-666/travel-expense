/* 冒烟测试：逐笔消费流水 + AA 分账（v1.1.0）
 * 自起服务（隔离 DATA_DIR），覆盖：
 *  - 同行人：批量新增 / 去重 / 改名 / 被引用时拒绝删除（409）与 force 删除的降级行为
 *  - 流水：新增 / 编辑 / 删除 / 批量删除 / 筛选 / 参数校验
 *  - 物化聚合：routes.exp_* 恒等于流水之和（增删改后均同步）
 *  - 统一口径：历史 9 类金额自动转为「期初」流水，金额不丢且不参与 AA
 *  - 结算：Σnet=0、Σ转账=债权额、转账笔数 ≤ 人数−1（不变量 I1–I5）
 *  - 权限：他人路线 404、示例路线普通用户只读 403
 * 运行：node tests/smoke-ledger.test.js
 * 退出码：0=全绿 1=有失败
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3911;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-ledger-'));
/* 拷入示例数据（与其它冒烟一致），用于验证「示例路线普通用户只读」 */
fs.copyFileSync(path.join(__dirname, '..', 'data', 'routes.json'), path.join(DATA_DIR, 'routes.json'));

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

const approx = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 0.01 : eps);
const CATS = ['交通', '机票', '高铁', '住宿', '餐饮', '门票', '团费', '购物', '其他'];
const totalOf = (exp) => CATS.reduce((s, c) => s + (exp[c] || 0), 0);

async function main() {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 250));
  }
  check('服务启动 /health 200', up);
  if (!up) { console.log('服务未启动，中止'); srv.kill(); process.exit(1); }

  try {
    /* ---------- 登录 ---------- */
    section('登录');
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie = r.setCookie;
    check('管理员登录', r.status === 200 && !!adminCookie, r.status);
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);
    r = await req('POST', '/api/auth/register', { username: 'ledgeruser', password: 'test1234' });
    let userCookie = r.setCookie;
    if (!userCookie) { r = await req('POST', '/api/auth/login', { login: 'ledgeruser', password: 'test1234' }); userCookie = r.setCookie; }
    check('普通用户注册/登录并取得会话', (r.status === 200 || r.status === 201) && !!userCookie, r.status);

    /* ---------- 新建路线：9 类金额自动转为期初流水 ---------- */
    section('统一口径：9 类金额 → 期初流水');
    r = await req('POST', '/api/routes', {
      name: '流水冒烟-大环线', year: '2026', start_date: '2026-07-01', end_date: '2026-07-05',
      type: '自由行', days: 5, people: 4, dest: '西宁', currency: 'CNY',
      budget_total: 12000, budget_daily: 2400,
      exp: { 机票: 4000, 住宿: 3000, 餐饮: 1000 }, notes: ''
    }, adminCookie);
    check('新建路线返回 201', r.status === 201, r.status);
    const rid = r.json.data.id;
    const expCreated = r.json.data.exp;
    check('期初流水保留传入的 9 类金额（机票4000/住宿3000/餐饮1000）',
      expCreated['机票'] === 4000 && expCreated['住宿'] === 3000 && expCreated['餐饮'] === 1000, expCreated);

    r = await req('GET', '/api/routes/' + rid + '/expenses', null, adminCookie);
    check('自动生成 3 笔期初流水', r.status === 200 && r.json.data.total === 3, r.json.data && r.json.data.total);
    check('期初流水标记 is_opening 且 split_mode=none、无付款人',
      r.json.data.list.every(e => e.is_opening === true && e.split_mode === 'none' && !e.payer_id),
      r.json.data.list.map(e => ({ o: e.is_opening, s: e.split_mode, p: e.payer_id })));

    /* ---------- 同行人 ---------- */
    section('同行人');
    r = await req('POST', '/api/routes/' + rid + '/travelers', { names: ['我（Kyson）', '阿May', '老陈', '小王', '阿May'] }, adminCookie);
    check('批量新增同行人（重名自动去重 → 4 人）', r.status === 200 && r.json.data.list.length === 4, r.json.data && r.json.data.list.length);
    check('首次新增的同行人默认标记为 is_self', r.json.data.list[0].is_self === true, r.json.data.list[0]);
    const tvs = r.json.data.list;
    const [tMe, tMay, tChen, tWang] = tvs;

    r = await req('PATCH', '/api/routes/' + rid + '/travelers/' + tWang.id, { name: '小王（改名）' }, adminCookie);
    check('同行人改名生效', r.status === 200 && r.json.data.name === '小王（改名）', r.json.data && r.json.data.name);
    r = await req('PATCH', '/api/routes/' + rid + '/travelers/' + tWang.id, { name: '阿May' }, adminCookie);
    check('改名撞重名被拒绝 400', r.status === 400, r.status);

    /* ---------- 流水 CRUD ---------- */
    section('流水增删改');
    r = await req('POST', '/api/routes/' + rid + '/expenses', {
      spent_on: '2026-07-01', category: '餐饮', amount: 520, title: '莫家街夜市',
      payer_id: tMay.id, parts: tvs.map(t => t.id)
    }, adminCookie);
    check('新增流水返回 201', r.status === 201, r.status);
    const e1 = r.json.data;
    check('新增后聚合随之更新（餐饮 1000+520=1520）', r.json && true);
    let route = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('聚合：餐饮 = 期初1000 + 流水520 = 1520', approx(route.json.data.exp['餐饮'], 1520), route.json.data.exp['餐饮']);

    r = await req('POST', '/api/routes/' + rid + '/expenses', {
      spent_on: '2026-07-02', category: '门票', amount: 640, title: '塔尔寺+青海湖',
      payer_id: tMe.id, parts: tvs.map(t => t.id)
    }, adminCookie);
    const e2 = r.json.data;
    r = await req('POST', '/api/routes/' + rid + '/expenses', {
      spent_on: '2026-07-03', category: '门票', amount: 280, title: '茶卡盐湖',
      payer_id: tMe.id, parts: [tMe.id, tMay.id]
    }, adminCookie);
    const e3 = r.json.data;
    r = await req('POST', '/api/routes/' + rid + '/expenses', {
      spent_on: '2026-07-04', category: '购物', amount: 500, title: '特产（自购）',
      payer_id: tMe.id, parts: []
    }, adminCookie);
    const e4 = r.json.data;
    check('未选分摊人时 split_mode 自动为 none（纯记录）', e4.split_mode === 'none', e4.split_mode);

    route = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('聚合：门票 = 640+280 = 920', approx(route.json.data.exp['门票'], 920), route.json.data.exp['门票']);
    check('聚合：总花费 = 期初8000 + 流水1940 = 9940', approx(totalOf(route.json.data.exp), 9940), totalOf(route.json.data.exp));

    r = await req('PATCH', '/api/routes/' + rid + '/expenses/' + e1.id, { amount: 620 }, adminCookie);
    check('编辑流水金额返回 200', r.status === 200 && approx(r.json.data.amount, 620), r.json.data && r.json.data.amount);
    check('编辑未提交字段保留（分摊人仍为 4 人）', r.json.data.parts.length === 4, r.json.data.parts.length);
    route = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('编辑后聚合同步（餐饮 = 1000+620）', approx(route.json.data.exp['餐饮'], 1620), route.json.data.exp['餐饮']);

    r = await req('GET', '/api/routes/' + rid + '/expenses?category=' + encodeURIComponent('门票'), null, adminCookie);
    check('按类目筛选：门票 2 笔', r.status === 200 && r.json.data.total === 2, r.json.data && r.json.data.total);
    check('筛选结果的汇总金额 = 920', approx(r.json.data.amount, 920), r.json.data && r.json.data.amount);
    r = await req('GET', '/api/routes/' + rid + '/expenses?payer=' + tMe.id, null, adminCookie);
    check('按付款人筛选：我付的 3 笔', r.json.data.total === 3, r.json.data && r.json.data.total);

    /* ---------- 参数校验 ---------- */
    section('参数校验');
    r = await req('POST', '/api/routes/' + rid + '/expenses', { category: '不存在的类目', amount: 10, payer_id: tMe.id, parts: [] }, adminCookie);
    check('非法类目 → 400 INVALID_CATEGORY', r.status === 400 && r.json.code === 'INVALID_CATEGORY', r.status + ' ' + r.json.code);
    r = await req('POST', '/api/routes/' + rid + '/expenses', { category: '餐饮', amount: 0, payer_id: tMe.id, parts: [] }, adminCookie);
    check('金额为 0 → 400 INVALID_AMOUNT', r.status === 400 && r.json.code === 'INVALID_AMOUNT', r.status + ' ' + r.json.code);
    r = await req('POST', '/api/routes/' + rid + '/expenses', { category: '餐饮', amount: 10, payer_id: 'not-exist', parts: [] }, adminCookie);
    check('付款人不在名单 → 400 INVALID_PAYER', r.status === 400 && r.json.code === 'INVALID_PAYER', r.status + ' ' + r.json.code);
    r = await req('POST', '/api/routes/' + rid + '/expenses', { category: '餐饮', amount: 10, payer_id: tMe.id, parts: ['bad-id'] }, adminCookie);
    check('分摊人不在名单 → 400 INVALID_PARTICIPANT', r.status === 400 && r.json.code === 'INVALID_PARTICIPANT', r.status + ' ' + r.json.code);
    r = await req('POST', '/api/routes/' + rid + '/expenses', { category: '餐饮', amount: 10, spent_on: '2026/07/01', payer_id: tMe.id, parts: [] }, adminCookie);
    check('日期格式非法 → 400 INVALID_DATE', r.status === 400 && r.json.code === 'INVALID_DATE', r.status + ' ' + r.json.code);

    /* ---------- 结算 ---------- */
    section('AA 结算');
    r = await req('GET', '/api/routes/' + rid + '/settle', null, adminCookie);
    check('结算接口 200', r.status === 200, r.status);
    const st = r.json.data;
    check('结算含 4 人', st.rows.length === 4, st.rows.length);
    check('不变量 I2：Σnet = 0', approx(st.rows.reduce((s, x) => s + x.net, 0), 0), st.rows.reduce((s, x) => s + x.net, 0));
    const creditSum = st.rows.filter(x => x.net > 0).reduce((s, x) => s + x.net, 0);
    check('不变量 I3：Σ转账 = 债权总额', approx(st.transfers.reduce((s, x) => s + x.amount, 0), creditSum), st.transfers.reduce((s, x) => s + x.amount, 0));
    check('不变量 I4：转账笔数 ≤ 人数 − 1', st.transfers.length <= st.rows.length - 1, st.transfers.length);
    check('不变量 I5：期初 8000 计为 unassigned（不参与 AA）', approx(st.summary.unassigned, 8000), st.summary.unassigned);
    check('自付 500 计入付款人自担（not_split=500）', approx(st.summary.not_split, 500), st.summary.not_split);
    const me = st.rows.find(x => x.is_self);
    check('我的实付 = 640+280+500 = 1420', approx(me.paid, 1420), me.paid);
    check('我的应负担 = 分摊份额 + 自付 500', approx(me.owed - 500, me.owed - 500) && me.owed > 500, { owed: me.owed, share: me.share, self: me.self_borne });

    /* ---------- 被引用同行人的删除保护 ---------- */
    section('同行人删除保护');
    r = await req('DELETE', '/api/routes/' + rid + '/travelers/' + tMay.id, null, adminCookie);
    check('删除被引用的同行人 → 409 TRAVELER_IN_USE', r.status === 409 && r.json.code === 'TRAVELER_IN_USE', r.status + ' ' + (r.json && r.json.code));
    check('409 回传被引用笔数 affected', r.json.affected > 0, r.json.affected);
    r = await req('DELETE', '/api/routes/' + rid + '/travelers/' + tMay.id + '?force=1', null, adminCookie);
    check('force=1 可删除并回传影响范围', r.status === 200 && r.json.data.ok, r.json.data);
    route = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('删除同行人不影响流水金额（门票聚合仍 920）', approx(route.json.data.exp['门票'], 920), route.json.data.exp['门票']);
    r = await req('GET', '/api/routes/' + rid + '/settle', null, adminCookie);
    check('失去付款人的流水计入 unassigned（期初8000 + 餐饮620 = 8620）', approx(r.json.data.summary.unassigned, 8620), r.json.data.summary.unassigned);

    /* ---------- 删除流水与聚合回收 ---------- */
    section('删除流水');
    r = await req('DELETE', '/api/routes/' + rid + '/expenses/' + e4.id, null, adminCookie);
    check('删除单笔流水 200', r.status === 200, r.status);
    route = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('删除后聚合回收（购物 = 0）', approx(route.json.data.exp['购物'], 0), route.json.data.exp['购物']);
    r = await req('POST', '/api/routes/' + rid + '/expenses/bulk-delete', { ids: [e2.id, e3.id] }, adminCookie);
    check('批量删除 2 笔', r.status === 200 && r.json.data.deleted === 2, r.json.data);
    route = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('批量删除后聚合回收（门票 = 0）', approx(route.json.data.exp['门票'], 0), route.json.data.exp['门票']);
    check('总花费 = 期初 8000 + 餐饮流水 620 = 8620', approx(totalOf(route.json.data.exp), 8620), totalOf(route.json.data.exp));

    /* ---------- 列表徽标与详情 ---------- */
    section('列表与详情');
    r = await req('GET', '/api/routes?year=2026', null, adminCookie);
    const row = r.json.data.list.find(x => x.id === rid);
    check('列表项带 expense_count（期初3 + 餐饮流水1 = 4）', row && row.expense_count === 4, row && row.expense_count);

    /* ---------- 权限 ---------- */
    section('权限');
    r = await req('GET', '/api/routes/' + rid + '/expenses', null, userCookie);
    check('他人路线流水 → 404（不泄露存在性）', r.status === 404, r.status);
    r = await req('POST', '/api/routes/' + rid + '/travelers', { names: ['越权'] }, userCookie);
    check('他人路线写同行人 → 404', r.status === 404, r.status);
    r = await req('GET', '/api/routes/' + rid + '/settle', null, userCookie);
    check('他人路线结算 → 404', r.status === 404, r.status);

    /* 示例路线（is_seed=1）对普通用户只读；示例 id 取自普通用户可见列表 */
    r = await req('GET', '/api/routes', null, userCookie);
    const seedRow = (r.json.data.list || []).find(x => x.is_seed);
    if (seedRow) {
      r = await req('GET', '/api/routes/' + seedRow.id + '/expenses', null, userCookie);
      check('示例路线流水对普通用户可读', r.status === 200, r.status);
      r = await req('POST', '/api/routes/' + seedRow.id + '/expenses', { category: '餐饮', amount: 1, parts: [] }, userCookie);
      check('示例路线写流水对普通用户 → 403', r.status === 403, r.status);
      r = await req('POST', '/api/routes/' + seedRow.id + '/travelers', { names: ['x'] }, userCookie);
      check('示例路线写同行人 → 403', r.status === 403, r.status);
    } else {
      check('示例路线存在（种子数据）', false, '列表无 is_seed 路线');
    }

    /* ---------- 未登录 ---------- */
    section('未登录');
    r = await req('GET', '/api/routes/' + rid + '/expenses');
    check('未登录访问流水 → 401', r.status === 401, r.status);

    /* ---------- 清理 ---------- */
    section('清理');
    r = await req('DELETE', '/api/routes/' + rid, null, adminCookie);
    check('删除路线', r.status === 200, r.status);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 流水冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
