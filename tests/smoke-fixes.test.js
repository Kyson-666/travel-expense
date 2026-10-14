/* 冒烟测试：v1.1.4 修复项
 * 运行：node tests/smoke-fixes.test.js
 * 覆盖：
 *   1) 列表排序权威在服务端（按出发时间倒序；分页后跨页顺序自洽，不再页内二次排序）
 *   2) 币种不变量（改路线币种 → 该路线全部流水币种同步；金额数字不变，汇总/结算不错加）
 *   3) JSON 导出/导入完整还原（同行人 + 逐笔流水，含分摊人；结算结果一致）
 *   4) 导入去重键细化（同名同年同目的地但日期不同 → 不再误判重复）
 *   5) 分享页含 AA 结算方案（每人实付/应负担/差额 + 最少转账方案）
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3912;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-fixes-'));

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

/* 结算结果归一化：按姓名排序 + 金额四舍五入到分，便于跨导入比对 */
function normSettle(s) {
  const rows = (s.rows || []).map(x => ({ name: x.name, is_self: !!x.is_self, paid: Math.round(x.paid * 100), owed: Math.round(x.owed * 100), net: Math.round(x.net * 100) }))
    .sort((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
  const transfers = (s.transfers || []).map(t => `${t.from_name}->${t.to_name}:${Math.round(t.amount * 100)}`).sort();
  return { rows, transfers, unassigned: Math.round((s.summary || {}).unassigned * 100 || 0) };
}

async function main() {
  const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动', up);
  if (!up) { srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    let r = await req('POST', '/api/auth/register', { username: 'fixuser', password: 'fixpass123' });
    const cookie = r.setCookie;
    check('注册并登录', r.status === 201 && !!cookie, r.status);

    /* ================= 1. 排序权威（跨页顺序自洽） ================= */
    section('1. 列表排序：服务端按出发时间倒序');
    const mk = async (name, year, start, end) => {
      const res = await req('POST', '/api/routes', { name, year, start_date: start, end_date: end, days: 2, people: 2, currency: 'CNY' }, cookie);
      return res.json.data.id;
    };
    await mk('R1-三月', '2026', '2026-03-01', '2026-03-05');
    await mk('R2-一月', '2026', '2026-01-05', '2026-01-08');
    await mk('R3-九月', '2026', '2026-09-20', '2026-09-25');
    await mk('R4-去年末', '2025', '2025-12-31', '2026-01-02');

    let p1 = await req('GET', '/api/routes?hideSeed=1&pageSize=2&page=1', null, cookie);
    let p2 = await req('GET', '/api/routes?hideSeed=1&pageSize=2&page=2', null, cookie);
    const names1 = (p1.json.data.list || []).map(x => x.name);
    const names2 = (p2.json.data.list || []).map(x => x.name);
    check('第 1 页为「九月, 三月」', names1.join(',') === 'R3-九月,R1-三月', names1);
    check('第 2 页为「一月, 去年末」', names2.join(',') === 'R2-一月,R4-去年末', names2);
    /* 全局单调：上一页最后一条的出发日必须不早于下一页第一条（页间不再按年+创建时间切） */
    const last1 = (p1.json.data.list || [])[1];
    const first2 = (p2.json.data.list || [])[0];
    check('跨页出发日单调不递增（排序全局自洽）',
      new Date(last1.start_date) >= new Date(first2.start_date),
      [last1.start_date, first2.start_date]);

    /* ================= 2. 币种不变量 ================= */
    section('2. 币种不变量：改路线币种 → 全部流水同步');
    r = await req('POST', '/api/routes', { name: '币种测试', year: '2026', start_date: '2026-05-01', end_date: '2026-05-03', days: 3, people: 2, currency: 'CNY' }, cookie);
    const cid = r.json.data.id;
    await req('POST', '/api/routes/' + cid + '/travelers', { names: ['我', '小王'] }, cookie);
    let tv = await req('GET', '/api/routes/' + cid + '/travelers', null, cookie);
    const meId = tv.json.data.list[0].id, wangId = tv.json.data.list[1].id;
    await req('POST', '/api/routes/' + cid + '/expenses', { category: '餐饮', amount: 300, spent_on: '2026-05-01', title: '晚饭', payer_id: meId, parts: [meId, wangId] }, cookie);
    await req('POST', '/api/routes/' + cid + '/expenses', { category: '门票', amount: 200, spent_on: '2026-05-02', title: '景区', payer_id: wangId, parts: [meId, wangId] }, cookie);

    let before = await req('GET', '/api/routes/' + cid, null, cookie);
    const sumBefore = before.json.data.exp['餐饮'] + before.json.data.exp['门票'];

    /* 改币种（PUT 整体覆盖） */
    r = await req('PUT', '/api/routes/' + cid, { name: '币种测试', year: '2026', days: 3, people: 2, currency: 'JPY' }, cookie);
    check('改币种 PUT 200', r.status === 200, r.status);

    let expList = await req('GET', '/api/routes/' + cid + '/expenses', null, cookie);
    const allJpy = (expList.json.data.list || []).every(e => e.currency === 'JPY');
    check('全部流水币种同步为 JPY', allJpy, (expList.json.data.list || []).map(e => e.currency));

    let after = await req('GET', '/api/routes/' + cid, null, cookie);
    const sumAfter = after.json.data.exp['餐饮'] + after.json.data.exp['门票'];
    check('改币种不改变金额数字（汇总不变）', sumBefore === sumAfter, [sumBefore, sumAfter]);
    check('路线币种已为 JPY', after.json.data.currency === 'JPY', after.json.data.currency);

    let st = await req('GET', '/api/routes/' + cid + '/settle', null, cookie);
    check('结算仍账恒平（Σnet=0）',
      Math.abs((st.json.data.rows || []).reduce((s, x) => s + x.net, 0)) < 0.005,
      (st.json.data.rows || []).map(x => x.net));

    /* ================= 3. 导出 / 导入完整还原 ================= */
    section('3. JSON 导出导入：同行人 + 流水完整往返');
    r = await req('POST', '/api/routes', {
      name: '往返测试', year: '2026', start_date: '2026-07-01', end_date: '2026-07-03', days: 3, people: 3, currency: 'CNY', dest: '成都',
      day_plans: [
        { date: '2026-07-01', scenic: '宽窄巷子', hotel: '锦江之星' },
        { date: '2026-07-02', scenic: '都江堰', hotel: '锦江之星' }
      ]
    }, cookie);
    const rid = r.json.data.id;
    await req('POST', '/api/routes/' + rid + '/travelers', { names: ['我', '小王', '小李'] }, cookie);
    tv = await req('GET', '/api/routes/' + rid + '/travelers', null, cookie);
    const t = tv.json.data.list;
    const idOf = (n) => t.find(x => x.name === n).id;
    await req('POST', '/api/routes/' + rid + '/expenses', { category: '餐饮', amount: 300, spent_on: '2026-07-01', title: '火锅', payer_id: idOf('我'), parts: [idOf('我'), idOf('小王'), idOf('小李')] }, cookie);
    await req('POST', '/api/routes/' + rid + '/expenses', { category: '门票', amount: 200, spent_on: '2026-07-02', title: '门票', payer_id: idOf('小王'), parts: [idOf('我'), idOf('小王')] }, cookie);
    await req('POST', '/api/routes/' + rid + '/expenses', { category: '购物', amount: 150, spent_on: '2026-07-02', title: '特产', payer_id: idOf('小李'), parts: [] }, cookie);

    const settleBefore = normSettle((await req('GET', '/api/routes/' + rid + '/settle', null, cookie)).json.data);

    const dump = await req('GET', '/api/routes/export?fmt=json', null, cookie);
    const exported = (dump.json.data.routes || []).find(x => x.id === rid);
    check('导出含 travelers 3 人', exported && exported.travelers.length === 3, exported && exported.travelers.length);
    check('导出含 expenses 3 笔', exported && exported.expenses.length === 3, exported && exported.expenses.length);
    check('导出含按天行程 2 条', exported && Array.isArray(exported.day_plans) && exported.day_plans.length === 2, exported && exported.day_plans);
    const expIds = new Set(exported.travelers.map(x => x.id));
    check('流水的付款人/分摊人均指向导出名单内的同行人',
      exported.expenses.every(e => (e.payer_id === null || expIds.has(e.payer_id)) && e.parts.every(p => expIds.has(p))));

    /* 删除原路线，再导入还原 */
    await req('DELETE', '/api/routes/' + rid, null, cookie);
    r = await req('POST', '/api/routes/import', { routes: [exported] }, cookie);
    check('导入 1 条', r.json.data.created === 1, r.json.data);
    check('还原同行人 3 人', r.json.data.travelers === 3, r.json.data.travelers);
    check('还原流水 3 笔', r.json.data.expenses === 3, r.json.data.expenses);

    const list2 = await req('GET', '/api/routes?hideSeed=1&q=往返测试', null, cookie);
    const rid2 = (list2.json.data.list || [])[0].id;
    const settleAfter = normSettle((await req('GET', '/api/routes/' + rid2 + '/settle', null, cookie)).json.data);
    check('还原后结算与导出前完全一致', JSON.stringify(settleAfter) === JSON.stringify(settleBefore), [settleBefore, settleAfter]);
    check('还原后最少转账方案为「小李 → 我 100」',
      settleAfter.transfers.length === 1 && settleAfter.transfers[0] === '小李->我:10000', settleAfter.transfers);

    const rt2 = await req('GET', '/api/routes/' + rid2, null, cookie);
    check('还原后按天行程保留 2 条', (rt2.json.data.day_plans || []).length === 2, rt2.json.data.day_plans);

    /* ================= 4. 导入去重键 ================= */
    section('4. 导入去重键：同名同年同目的地、不同日期不再误判');
    const two = [
      { name: '同名行程', year: '2026', dest: '东京', start_date: '2026-04-01', end_date: '2026-04-05', currency: 'CNY' },
      { name: '同名行程', year: '2026', dest: '东京', start_date: '2026-10-01', end_date: '2026-10-07', currency: 'CNY' }
    ];
    r = await req('POST', '/api/routes/import', { routes: two }, cookie);
    check('两条同名同年同目的地（日期不同）均创建', r.json.data.created === 2 && r.json.data.duplicates === 0, r.json.data);

    r = await req('POST', '/api/routes/import', { routes: two }, cookie);
    check('再次导入同批次 → 全部判重（created 0 / duplicates 2）', r.json.data.created === 0 && r.json.data.duplicates === 2, r.json.data);

    /* ================= 5. 分享页含 AA 结算方案 ================= */
    section('5. 分享页包含 AA 结算方案');
    r = await req('POST', '/api/routes/' + rid2 + '/share', null, cookie);
    check('生成分享令牌', r.status === 200 && !!r.json.data.token, r.json.data);
    const token = r.json.data.token;
    const share = await fetch(BASE + '/share/' + token);
    const html = await share.text();
    check('分享页 200', share.status === 200, share.status);
    check('分享页含「AA 结算方案」', html.includes('AA 结算方案'));
    check('分享页含「最少转账方案」', html.includes('最少转账方案'));
    check('分享页含同行人姓名', html.includes('小王') && html.includes('小李'));
    check('分享页含应收/应付标记', html.includes('recv') || html.includes('pay'));
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 修复项冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
