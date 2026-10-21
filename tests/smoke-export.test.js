/* 冒烟测试：CSV/JSON 导出 + JSON 导入（#22）
 * 运行：node tests/smoke-export.test.js
 * 覆盖：个人 CSV 列头/BOM/转义、JSON 导出往返、导入白名单（防 id 覆盖）、
 *      非法行跳过、2000 条上限、管理端全站 CSV（含 owner_name）+ 审计留痕
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3903;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-export-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

async function req(method, p, body, cookie, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + p, opt);
  if (raw) {
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, buf, text: new TextDecoder().decode(buf), headers: r.headers };
  }
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore'
  });
  /* 拷贝种子数据，让隔离库贴近生产（含 4 条示例路线） */
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'routes.json'), path.join(DATA_DIR, 'routes.json'));
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动', up);
  if (!up) { srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie = r.setCookie;
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);
    r = await req('POST', '/api/auth/register', { username: 'carol', password: 'carolpass123' });
    const userCookie = r.setCookie;
    check('注册普通用户 carol', r.status === 201, r);

    /* ---------- 造数 ---------- */
    r = await req('POST', '/api/routes', {
      name: '含逗号,引号"路线', year: '2026', daterange: '8/1-8/5', start_date: '2026-08-01', end_date: '2026-08-05',
      days: 5, people: 2, currency: 'USD', budget_total: 1000, budget_daily: 200,
      exp: { 机票: 300, 住宿: 400, 餐饮: 100 }, notes: '多行\n备注'
    }, userCookie);
    check('carol 建路线 201', r.status === 201, r);

    /* ---------- 个人 CSV 导出 ---------- */
    section('个人 CSV 导出');
    r = await req('GET', '/api/routes/export?fmt=csv', null, userCookie, true);
    check('导出 200 且 Content-Type text/csv', r.status === 200 && /text\/csv/.test(r.headers.get('content-type') || ''), r.status);
    const csv = r.text;
    check('带 UTF-8 BOM（字节级 EF BB BF）', r.buf[0] === 0xEF && r.buf[1] === 0xBB && r.buf[2] === 0xBF, [r.buf[0], r.buf[1], r.buf[2]]);
    check('列头含 currency/budget_total/start_date', /currency/.test(csv) && /budget_total/.test(csv) && /start_date/.test(csv), csv.split('\r\n')[0]);
    check('含逗号/引号字段被正确转义', csv.includes('"含逗号,引号""路线"'), csv.split('\r\n').find(l => l.includes('含逗号')));
    check('多行备注被引号包裹', csv.includes('"多行'), csv.split('\r\n').find(l => l.includes('多行')));
    check('CSV 不含示例种子', !csv.includes('示例'), csv.slice(0, 300));
    check('CSV 含 USD/1000', csv.includes('USD') && csv.includes('1000'), csv.split('\r\n')[1]);
    check('CSV 含 9 类明细列（机票=300）', /机票/.test(csv) && csv.includes('300'), csv.split('\r\n')[0]);

    /* ---------- 个人 JSON 导出 + 往返导入 ---------- */
    section('JSON 导出 + 往返导入');
    r = await req('GET', '/api/routes/export?fmt=json', null, userCookie);
    check('JSON 导出 200', r.status === 200 && Array.isArray(r.json.data.routes) && r.json.data.count === 1, r.json);
    const exported = r.json.data.routes[0];
    check('导出对象含完整 exp 与预算', exported.exp.机票 === 300 && exported.budget_total === 1000 && exported.currency === 'USD', exported);

    r = await req('POST', '/api/routes/import', { routes: [{ exp: {} }, exported, { id: 'hack123', owner_id: 999, name: '带系统字段的路线', exp: { 其他: 5 } }] }, userCookie);
    /* 去重：exported 与已存在路线同名同年同目的地 → 跳过；非法行 → 跳过；新路线 → 新增 */
    check('导入 200 返回计数', r.status === 200 && r.json.data.created === 1 && r.json.data.skipped === 1 && r.json.data.duplicates === 1, r.json.data);
    check('非法行被跳过并说明', r.json.data.errors.length === 1 && /缺少名称/.test(r.json.data.errors[0]), r.json.data.errors);

    r = await req('GET', '/api/routes', null, userCookie);
    const mine = r.json.data.list.filter(x => !x.is_seed);
    /* 去重后：1 原始 + 1 新导入 = 2（重复的 exported 未新增） */
    check('导入后本人路线 = 1 + 1 = 2（去重生效）', mine.length === 2, mine.length);
    const imported = mine.find(x => x.name === '含逗号,引号"路线');
    check('往返导入字段完整（USD/预算/日期/exp）',
      imported && imported.currency === 'USD' && imported.budget_total === 1000
      && imported.start_date === '2026-08-01' && imported.exp.机票 === 300, imported);
    check('系统字段未随导入覆盖（id 为新 id）', imported && imported.id !== 'hack123', imported && imported.id);
    check('恶意 owner_id 未生效（owner 仍是 carol）', imported && imported.owner_id === 2, imported && imported.owner_id);
    const imported2 = mine.find(x => x.name === '带系统字段的路线');
    check('带系统字段行正常导入（白名单剥离）', imported2 && imported2.exp.其他 === 5 && imported2.owner_id === 2, imported2);

    r = await req('POST', '/api/routes/import', { routes: [] }, userCookie);
    check('空数组导入 → created=0', r.status === 200 && r.json.data.created === 0, r.json.data);
    const big = new Array(2001).fill({ name: 'x', exp: {} });
    r = await req('POST', '/api/routes/import', { routes: big }, userCookie);
    check('超过 2000 条被拒绝 400', r.status === 400, r);

    /* ---------- 管理端全站导出 ---------- */
    section('管理端全站 CSV + 审计');
    r = await req('GET', '/api/admin/export?fmt=csv', null, adminCookie, true);
    const acsv = r.text;
    check('管理端导出 200 且字节级 BOM', r.status === 200 && r.buf[0] === 0xEF && r.buf[1] === 0xBB && r.buf[2] === 0xBF, r.status);
    check('含 owner_name 列', /owner_name/.test(acsv.split('\r\n')[0]), acsv.split('\r\n')[0]);
    check('包含普通用户数据（carol 的路线）', acsv.includes('carol'), acsv.slice(0, 400));
    check('包含示例种子', acsv.includes('示例'), '—');
    const guest = await req('GET', '/api/admin/export?fmt=csv', null, userCookie, true);
    check('普通用户访问管理导出 → 403', guest.status === 403, guest.status);
    r = await req('GET', '/api/admin/audit-logs?action=export_routes', null, adminCookie);
    check('导出动作写入审计日志', r.status === 200 && r.json.data.list.some(a => a.action === 'export_routes'), r.json && r.json.data && r.json.data.list && r.json.data.list[0]);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 导出导入冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
