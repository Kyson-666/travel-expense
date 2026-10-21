/* 冒烟测试：行程按天（景点路线 / 住宿）
 * 运行：node tests/smoke-days.test.js
 * 覆盖：day_plans 读写、scenic/hotel 物化镜像、routes.days(天数) 不被覆盖、
 *      历史自由文本回填为「未分天」单条、跨用户隔离
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3908;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-days-'));

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
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie = r.setCookie;
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);
    r = await req('POST', '/api/auth/register', { username: 'dave', password: 'davepass123' });
    const userCookie = r.setCookie;
    r = await req('POST', '/api/auth/register', { username: 'eve', password: 'evepass123' });
    const eveCookie = r.setCookie;

    /* ---------- 新建：带 day_plans ---------- */
    section('新建带按天数据');
    r = await req('POST', '/api/routes', {
      name: '按天环线', year: '2026', start_date: '2026-09-21', end_date: '2026-09-22',
      days: 2, people: 2, currency: 'CNY', dest: '青海',
      day_plans: [
        { date: '2026-09-21', scenic: '西宁 - 祁连', hotel: '西宁如家' },
        { date: '2026-09-22', scenic: '张掖 - 丹霞', hotel: '张掖汉庭' }
      ]
    }, userCookie);
    check('新建 201', r.status === 201, r.status);
    const rid = r.json.data.id;

    r = await req('GET', '/api/routes/' + rid, null, userCookie);
    const d1 = r.json.data;
    check('详情返回 day_plans 2 条', Array.isArray(d1.day_plans) && d1.day_plans.length === 2, d1.day_plans);
    check('day_plans 日期正确', d1.day_plans[0].date === '2026-09-21' && d1.day_plans[1].scenic === '张掖 - 丹霞', d1.day_plans);
    check('routes.days(天数) 未被覆盖 = 2', d1.days === 2, d1.days);
    check('镜像 scenic 带日期前缀', d1.scenic === '【9月21日】西宁 - 祁连\n【9月22日】张掖 - 丹霞', d1.scenic);
    check('镜像 hotel 带日期前缀', d1.hotel === '【9月21日】西宁如家\n【9月22日】张掖汉庭', d1.hotel);

    r = await req('GET', '/api/routes?year=2026', null, userCookie);
    const inList = r.json.data.list.find(x => x.id === rid);
    check('列表含 day_plans 2 条', inList && Array.isArray(inList.day_plans) && inList.day_plans.length === 2, inList && inList.day_plans);

    /* ---------- 更新：替换按天数据 ---------- */
    section('更新替换按天数据');
    r = await req('PUT', '/api/routes/' + rid, {
      name: '按天环线', year: '2026', days: 1,
      day_plans: [{ date: '2026-09-21', scenic: '西宁 - 祁连（改）', hotel: '西宁如家' }]
    }, userCookie);
    check('更新 200', r.status === 200, r.status);
    r = await req('GET', '/api/routes/' + rid, null, userCookie);
    check('更新后 day_plans 1 条', r.json.data.day_plans.length === 1, r.json.data.day_plans);
    check('更新后镜像同步', r.json.data.scenic === '【9月21日】西宁 - 祁连（改）', r.json.data.scenic);

    /* ---------- 历史自由文本：回填为「未分天」单条 ---------- */
    section('历史自由文本（无 day_plans）');
    r = await req('POST', '/api/routes', {
      name: '历史路线', year: '2026', days: 2, dest: '云南',
      scenic: 'Day1 大理古城\nDay2 洱海环湖', hotel: '大理客栈'
    }, userCookie);
    const lid = r.json.data.id;
    r = await req('GET', '/api/routes/' + lid, null, userCookie);
    const lg = r.json.data;
    check('未分天单条（date 为空）', lg.day_plans.length === 1 && lg.day_plans[0].date === '', lg.day_plans);
    check('历史 scenic 原样保留（镜像不变）', lg.scenic === 'Day1 大理古城\nDay2 洱海环湖', lg.scenic);

    /* ---------- 跨用户隔离 ---------- */
    section('跨用户隔离');
    r = await req('GET', '/api/routes/' + rid, null, eveCookie);
    check('他人读私有路线 → 404', r.status === 404, r.status);
    r = await req('PUT', '/api/routes/' + rid, { name: 'x', days: 1, day_plans: [] }, eveCookie);
    check('他人改私有路线 → 404', r.status === 404, r.status);
    r = await req('GET', '/api/routes/' + rid, null, adminCookie);
    check('管理员读他人私有路线 → 404（与普通用户一致，无越权读取）', r.status === 404, r.status);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 按天冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
