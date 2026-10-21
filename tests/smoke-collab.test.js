/* 冒烟测试：路线级家庭协作（白名单共享）+ 年度旅行报告
 * 运行：node tests/smoke-collab.test.js
 * 覆盖：
 *   1. 候选人搜索（排除 owner/已在名单、用户名/邮箱匹配）
 *   2. 邀请/移除（仅 owner；种子不可协作；上限 8；不能邀本人/重复）
 *   3. 权限矩阵：协作者可记账/同行人/看结算；不可改路线本体/删除/分享/管理名单
 *   4. 列表合并：协作者列表出现协作路线（is_collab + owner_name）；年份胶囊同源
 *   5. 流水归属：协作者代记的流水归路线 owner（列表 expense_count / settle 正常）
 *   6. 统计口径：stats 不含协作路线（避免家庭账双算）；导出不含协作路线
 *   7. 离线 sync：协作者对协作路线可同步
 *   8. 审计：add/remove_collaborator 入审计
 *   9. recap：available_years / 结构 / 非法年份 400
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3928;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-collab-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

async function req(method, p, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + p, opt);
  const txt = await r.text();
  let json = null; try { json = JSON.parse(txt); } catch (e) { /* non-json */ }
  return { status: r.status, json, text: txt, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

function startServer() {
  return spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore' });
}
async function waitUp(srv) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) return true; } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  return false;
}
async function stop(srv) {
  srv.kill();
  await new Promise((res) => {
    let done = false;
    const fallback = setTimeout(() => { if (!done) { done = true; res(); } }, 8000);
    srv.on('exit', () => { if (!done) { done = true; clearTimeout(fallback); res(); } });
    srv.on('error', () => { if (!done) { done = true; clearTimeout(fallback); res(); } });
  });
}

async function main() {
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'routes.json'), path.join(DATA_DIR, 'routes.json'));
  let srv = startServer();
  let r = null;
  if (!(await waitUp(srv))) { check('服务启动', false); process.exit(1); }
  check('服务启动', true);

  try {
    /* admin 首登改密（解锁业务 API） */
    r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const admin0 = r.setCookie;
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, admin0);
    r = await req('POST', '/api/auth/login', { login: 'admin', password: 'adminnew123' });
    const admin = r.setCookie;
    check('管理员登录', r.status === 200);

    /* 注册 4 个普通用户 */
    const users = {};
    for (const [name, pwd] of [['u1', 'u1pass123'], ['u2', 'u2pass123'], ['u3', 'u3pass123'], ['u4', 'u4pass123']]) {
      r = await req('POST', '/api/auth/register', { username: name, password: pwd });
      users[name] = r.setCookie;
      check(`注册 ${name}`, r.status === 201, r.status);
    }

    /* u1 建路线（带标准地名点亮 + 流水） */
    r = await req('POST', '/api/routes', {
      name: '全家杭州行', year: '2026', start_date: '2026-05-01', end_date: '2026-05-04',
      days: 4, people: 3, currency: 'CNY', budget_total: 6000, places: ['330100']
    }, users.u1);
    check('u1 新建路线 201', r.status === 201, r.status);
    const rid = r.json.data.id;

    r = await req('POST', `/api/routes/${rid}/expenses`, { category: '餐饮', amount: 1280, title: '外婆家', spent_on: '2026-05-02' }, users.u1);
    check('u1 记流水 201', r.status === 201, r.status);

    /* ---------- 候选人搜索 ---------- */
    section('候选人搜索');
    r = await req('GET', `/api/routes/${rid}/collab-candidates?q=u2`, null, users.u1);
    check('owner 搜索命中 u2', r.status === 200 && r.json.data.list.some(x => x.username === 'u2'), r.json);
    r = await req('GET', `/api/routes/${rid}/collab-candidates?q=`, null, users.u1);
    check('空关键字也返回候选人（≤10）', r.status === 200 && r.json.data.list.length <= 10 && r.json.data.list.length > 0, r.json);
    r = await req('GET', `/api/routes/${rid}/collab-candidates?q=u2`, null, users.u2);
    /* 名单外用户对路线不可见 → 404（不暴露存在性），而非 403 */
    check('名单外搜候选人 → 404', r.status === 404, r.status);

    /* ---------- 邀请与权限矩阵 ---------- */
    section('邀请与权限矩阵');
    /* 拿各用户真实 id（admin 用户列表） */
    const uidOf = async (name) => (await req('GET', `/api/admin/users?q=${name}`, null, admin)).json.data.list.find(x => x.username === name).id;
    const u1id = await uidOf('u1');
    const u2id = await uidOf('u2');
    const u3id = await uidOf('u3');
    const u4id = await uidOf('u4');

    r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: 999999 }, users.u1);
    check('邀请不存在用户 → 400 USER_NOT_FOUND', r.status === 400 && r.json.code === 'USER_NOT_FOUND', r.json);
    r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: u1id }, users.u1);
    check('邀请自己（owner）→ 400 IS_OWNER', r.status === 400 && r.json.code === 'IS_OWNER', r.json);
    r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: u2id }, users.u2);
    /* 未受邀者对路线 404（不暴露存在性） */
    check('未受邀者邀请 → 404', r.status === 404, r.status);

    r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: u2id }, users.u1);
    check('u1 邀请 u2 → 201', r.status === 201, r.json);
    check('返回名单含 u2', (r.json.data.list || []).some(x => x.username === 'u2'), r.json);
    r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: u2id }, users.u1);
    check('重复邀请 → 400 ALREADY_IN', r.status === 400 && r.json.code === 'ALREADY_IN', r.json);

    r = await req('GET', `/api/routes/${rid}/collaborators`, null, users.u2);
    check('协作者可看名单', r.status === 200 && r.json.data.is_owner === false, r.json);
    r = await req('GET', `/api/routes/${rid}`, null, users.u2);
    check('协作者可见详情', r.status === 200 && r.json.data.is_collab === true && r.json.data.owner_name === 'u1', r.json.data && r.json.data.owner_name);

    section('协作者可记账');
    r = await req('POST', `/api/routes/${rid}/expenses`, { category: '交通', amount: 216, title: '地铁', spent_on: '2026-05-02' }, users.u2);
    check('u2 记流水 201', r.status === 201, r.status);
    r = await req('GET', `/api/routes/${rid}/expenses`, null, users.u1);
    check('owner 侧可见协作者记的流水（2 笔）', r.json.data.list.length === 2, r.json.data.list.length);
    r = await req('POST', `/api/routes/${rid}/travelers`, { names: ['爸爸', '妈妈'] }, users.u2);
    check('u2 添加同行人 200', r.status === 200, r.status);
    r = await req('GET', `/api/routes/${rid}/settle`, null, users.u2);
    check('u2 查看结算 200', r.status === 200, r.status);
    const expId = (await req('GET', `/api/routes/${rid}/expenses`, null, users.u2)).json.data.list.find(x => x.title === '地铁').id;
    r = await req('PATCH', `/api/routes/${rid}/expenses/${expId}`, { amount: 300 }, users.u2);
    check('u2 改自己记的流水 200', r.status === 200, r.status);

    section('协作者不可越权');
    r = await req('PUT', `/api/routes/${rid}`, { name: '被改名', year: '2026', days: 4, people: 3, places: ['330100'] }, users.u2);
    check('u2 改路线本体 → 403', r.status === 403, r.status);
    r = await req('DELETE', `/api/routes/${rid}`, null, users.u2);
    check('u2 删路线 → 403', r.status === 403, r.status);
    r = await req('POST', `/api/routes/${rid}/share`, null, users.u2);
    check('u2 生成分享 → 403', r.status === 403, r.status);
    r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: u3id }, users.u2);
    check('u2 邀请他人 → 403', r.status === 403, r.status);
    r = await req('GET', `/api/routes/${rid}`, null, users.u3);
    check('名单外 u3 看详情 → 404', r.status === 404, r.status);
    r = await req('POST', `/api/routes/${rid}/expenses`, { category: '餐饮', amount: 10 }, users.u3);
    check('名单外 u3 记流水 → 404', r.status === 404, r.status);
    r = await req('GET', `/api/routes/${rid}`, null, users.u4);
    check('名单外 u4 → 404', r.status === 404, r.status);

    /* ---------- 列表合并与年份胶囊 ---------- */
    section('列表合并 / 统计口径');
    r = await req('GET', '/api/routes', null, users.u2);
    const collabRow = r.json.data.list.find(x => x.id === rid);
    check('u2 列表出现协作路线', !!collabRow, r.json.data.list.map(x => x.name));
    check('is_collab 标记 + owner_name=u1', collabRow && collabRow.is_collab === true && collabRow.owner_name === 'u1', collabRow);
    check('u2 列表流水计数含协作路线（1 笔）', collabRow && collabRow.expense_count === 2, collabRow && collabRow.expense_count);
    r = await req('GET', '/api/routes/years', null, users.u2);
    check('u2 年份胶囊含 2026（与列表同源）', r.json.data.years.includes('2026'), r.json.data.years);
    r = await req('GET', '/api/routes/' + rid, null, users.u1);
    check('owner 详情 is_collab=false', r.json.data.is_collab === false, r.json.data.is_collab);

    /* 统计不含协作路线（用 hideSeed=1 剔除种子干扰）：
     * u2 无自有路线 → grand=0（协作路线 1660 不计入，防双算）；u1 = 自己路线 1580+游船 80 */
    r = await req('GET', '/api/routes/stats/summary?hideSeed=1', null, users.u2);
    check('u2 统计不含协作路线（grand=0，防双算）', r.json.data.grand === 0, r.json.data.grand);
    r = await req('GET', '/api/routes/stats/summary?hideSeed=1', null, users.u1);
    /* 此刻 u2 尚未离线同步游船 80 → u1 侧 = 1280 + 300 = 1580 */
    check('u1 统计含自己路线（grand=1580）', Math.abs(r.json.data.grand - 1580) < 0.01, r.json.data.grand);

    /* 导出不含协作路线 */
    r = await req('GET', '/api/routes/export?fmt=json', null, users.u2);
    check('u2 导出不含协作路线', r.json.data.routes.every(x => x.id !== rid), r.json.data.routes.map(x => x.name));

    /* ---------- 离线 sync：协作者可同步 ---------- */
    section('离线同步');
    r = await req('POST', `/api/routes/${rid}/expenses/sync`, { ops: [
      { op_id: 'c1', type: 'expense.create', client_id: 'u2dev00001',
        data: { id: 'c-exp-1', category: '门票', amount: 80, spent_on: '2026-05-03', title: '西湖游船' } }
    ] }, users.u2);
    check('u2 离线 sync 一笔 → accepted', r.status === 200 && r.json.data.results[0].status === 'accepted', r.json.data && r.json.data.results);
    r = await req('POST', `/api/routes/${rid}/expenses/sync`, { ops: [
      { op_id: 'c2', type: 'expense.create', client_id: 'u3dev00001',
        data: { id: 'c-exp-2', category: '门票', amount: 1 } }
    ] }, users.u3);
    check('名单外 u3 sync → rejected ROUTE_NOT_FOUND', r.json.data.results[0].status === 'rejected' && r.json.data.results[0].code === 'ROUTE_NOT_FOUND', r.json.data.results);

    /* ---------- 上限与种子 ---------- */
    section('上限 / 种子 / 审计');
    for (const uid of [u3id, u4id]) {
      r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: uid }, users.u1);
      check(`邀请成员（当前 ${r.json.data.list.length - 1}/8）`, r.status === 201, r.json);
    }
    /* 现有 3 名协作者（u2/u3/u4），补 m1..m5 到 8 人上限，再邀 m6 应被拒 */
    const extra = [];
    for (let i = 1; i <= 6; i++) {
      const rr = await req('POST', '/api/auth/register', { username: 'm' + i, password: 'm' + i + 'pass123' });
      extra.push(rr.setCookie);
    }
    const adminList = (await req('GET', '/api/admin/users?q=m', null, admin)).json.data.list;
    for (let i = 0; i < 6; i++) {
      r = await req('POST', `/api/routes/${rid}/collaborators`, { user_id: adminList.find(x => x.username === 'm' + (i + 1)).id }, users.u1);
      check(i < 5 ? `补邀请 m${i + 1} → 201（${3 + i + 1}/8）` : '第 9 人 → 400 TOO_MANY', i < 5 ? r.status === 201 : (r.status === 400 && r.json.code === 'TOO_MANY'), r.json);
    }
    /* seed 路线不可协作：admin 找一条种子路线 */
    r = await req('GET', '/api/routes?q=江南', null, admin);
    const seedId = r.json.data.list.find(x => x.is_seed).id;
    r = await req('POST', `/api/routes/${seedId}/collaborators`, { user_id: u2id }, admin);
    check('种子路线加协作者 → 400 SEED_ROUTE', r.status === 400 && r.json.code === 'SEED_ROUTE', r.json);

    /* 审计（端点 /api/admin/audit-logs，action 为精确匹配） */
    r = await req('GET', '/api/admin/audit-logs?action=add_collaborator', null, admin);
    check('审计含 add_collaborator', ((r.json.data.list || []).some(x => x.action === 'add_collaborator')), r.json.data && r.json.data.total);

    /* ---------- 移除 ---------- */
    section('移除协作者');
    r = await req('DELETE', `/api/routes/${rid}/collaborators/${u2id}`, null, users.u1);
    check('u1 移除 u2 → 200', r.status === 200, r.json);
    r = await req('GET', '/api/routes', null, users.u2);
    check('u2 列表不再出现协作路线', !r.json.data.list.some(x => x.id === rid), r.json.data.list.map(x => x.name));
    r = await req('POST', `/api/routes/${rid}/expenses`, { category: '餐饮', amount: 5 }, users.u2);
    check('移除后 u2 记流水 → 404', r.status === 404, r.status);
    check('移除后流水保留（u1 侧仍 3 笔：地铁300+外婆家+游船）',
      (await req('GET', `/api/routes/${rid}/expenses`, null, users.u1)).json.data.list.length === 3);
    r = await req('DELETE', `/api/routes/${rid}/collaborators/${u2id}`, null, users.u1);
    check('重复移除 → 404 NOT_IN_LIST', r.status === 404 && r.json.code === 'NOT_IN_LIST', r.json);
    r = await req('GET', '/api/admin/audit-logs?action=remove_collaborator', null, admin);
    check('审计含 remove_collaborator', ((r.json.data.list || []).some(x => x.action === 'remove_collaborator')), r.json.data && r.json.data.total);

    /* ---------- 年度旅行报告 ---------- */
    section('年度旅行报告 recap');
    r = await req('GET', '/api/footprints/recap', null, users.u1);
    check('不带 year → available_years 含 2026', r.status === 200 && r.json.data.available_years.includes('2026'), r.json.data);
    r = await req('GET', '/api/footprints/recap?year=2026', null, users.u1);
    const d = r.json.data;
    check('recap 200', r.status === 200, r.status);
    check('点亮累计：城市 ≥1 / 省 ≥1', d.lit.total_cities >= 1 && d.lit.total_provinces >= 1, d.lit);
    check('年度新增点亮含杭州', (d.lit.new_cities || []).includes('杭州'), d.lit.new_cities);
    check('行程 count=1 / days=4 / grand=1580+80', d.trip.count === 1 && d.trip.days === 4 && Math.abs(d.trip.grand - 1660) < 0.01, d.trip);
    check('最贵一笔 = 外婆家 1280', d.trip.top_expense && d.trip.top_expense.amount === 1280, d.trip.top_expense);
    check('最长旅程 = 全家杭州行（4 天）', d.trip.longest && d.trip.longest.days === 4, d.trip.longest);
    check('预算完成 1/1', d.trip.budget_within && d.trip.budget_within.within === 1, d.trip.budget_within);
    check('成就含「迈出第一步」已解锁', (d.achievements || []).some(a => a.key === 'first'), d.achievements && d.achievements.map(a => a.key));
    r = await req('GET', '/api/footprints/recap?year=abcd', null, users.u1);
    check('非法年份 → 400 INVALID_YEAR', r.status === 400 && r.json.code === 'INVALID_YEAR', r.json);
    r = await req('GET', '/api/footprints/recap?year=2026', null, users.u2);
    check('u2（无自有数据）recap 行程为 0，不双算', r.json.data.trip.count === 0, r.json.data.trip);
  } finally {
    await stop(srv);
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }

  console.log(`\nsmoke-collab：${pass} 通过，${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
}

main().catch(e => { console.error('冒烟异常：', e); process.exit(2); });
