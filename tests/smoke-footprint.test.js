/* 冒烟测试：足迹点亮（标准地名多选 + dest 镜像 + 点亮流水 + 成就 + 备份往返）
 * 运行：node tests/smoke-footprint.test.js
 * 覆盖：
 *   1. 字典 seed（466 条：34 省级/333 市级/99 国家，含台湾省、港澳、三沙市）
 *   2. 存量 dest 一次性清空迁移（user_version 幂等，重启不重复执行）
 *   3. 地名搜索排序（汉字 / 拼音前缀 / 首字母 / 国家；字典外地名无结果）
 *   4. route_places 真源 → dest 物化镜像（新增 / 覆盖式更新 / 清空）
 *   5. 点亮流水：只增不删（删路线不熄灭）、owner 隔离
 *   6. 路线外手动点亮：幂等 already、字典外拒绝（INVALID_PLACE）
 *   7. 成就口径（首次点亮 / 点亮省份 / 连续年份）
 *   8. 待标注路线 pending 列表
 *   9. JSON 备份往返（places adcode 数组还原；未命中字典计入 errors）
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3918;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-fp-'));

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
  /* 等待进程真正退出（而非固定 500ms）：Node 18 下 server.close() 因
     keep-alive 连接阻塞，旧进程可能在 500ms 后仍未退出，导致新实例
     EADDRINUSE —— 此时 waitUp 会误连到旧服务器，从而跳过迁移。 */
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
    /* ---------- 字典与存量迁移 ---------- */
    section('字典 seed 与存量 dest 清空迁移');
    const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
    const dbFile = path.join(DATA_DIR, 'app.db');
    let db = new Database(dbFile);
    const placeCount = db.prepare('SELECT COUNT(*) c FROM places').get().c;
    check('字典 466 条', placeCount === 466, placeCount);
    check('含台湾省', !!db.prepare("SELECT 1 FROM places WHERE adcode='710000'").get());
    check('含三沙市（南海诸岛）', !!db.prepare("SELECT 1 FROM places WHERE adcode='460300' AND lng>110 AND lng<115").get());
    check('含港澳', !!db.prepare("SELECT 1 FROM places WHERE adcode IN ('810000','820000')").get());
    /* 模拟旧版本升级：构造存量自由文本 dest + 回退 user_version，
     * 重启后 migrateDestToStructured 应一次性清空（且只执行一次） */
    db.prepare("UPDATE routes SET dest='东海群岛' WHERE id='sample001'").run();
    db.prepare("DELETE FROM route_places WHERE route_id='sample001'").run();
    db.pragma('user_version = 0');
    db.close();
    await stop(srv);

    srv = startServer();
    check('迁移后服务重启', await waitUp(srv));
    db = new Database(dbFile);
    const migrated = db.prepare("SELECT dest FROM routes WHERE id='sample001'").get();
    check('存量 dest 已清空', migrated.dest === '', migrated.dest);
    check('user_version=1（迁移只执行一次）', db.pragma('user_version', { simple: true }) === 1);
    db.close();

    /* 幂等：先以管理员重设 sample001 的目的地（生成镜像），重启后不得被二次清空 */
    r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie0 = r.setCookie;
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie0);
    const seedRoute = await req('GET', '/api/routes', null, adminCookie0).then(x => x.json.data.list.find(x => x.id === 'sample001'));
    await req('PUT', '/api/routes/sample001', {
      name: seedRoute.name, year: seedRoute.year, start_date: seedRoute.start_date, end_date: seedRoute.end_date,
      days: seedRoute.days, people: seedRoute.people, places: ['330900']
    }, adminCookie0);
    await stop(srv);
    srv = startServer();
    check('幂等重启', await waitUp(srv));
    db = new Database(dbFile);
    const reMirror = db.prepare("SELECT dest FROM routes WHERE id='sample001'").get();
    check('重启不重复清空（dest 保持再生成镜像）', reMirror.dest === '舟山', reMirror.dest);
    db.close();
    await stop(srv);

    /* 正式用例：最后一次启动常驻（admin 密码已改为 adminnew123） */
    srv = startServer();
    check('最终启动', await waitUp(srv));
    r = await req('POST', '/api/auth/login', { login: 'admin', password: 'adminnew123' });
    const adminCookie = r.setCookie;
    r = await req('POST', '/api/auth/register', { username: 'dave', password: 'davepass123' });
    const daveCookie = r.setCookie;
    r = await req('POST', '/api/auth/register', { username: 'eve', password: 'evepass123' });
    const eveCookie = r.setCookie;

    /* ---------- 地名搜索 ---------- */
    section('地名搜索');
    r = await req('GET', '/api/footprints/places?q=' + encodeURIComponent('苏州'), null, daveCookie);
    check('苏州 → 320500 市', r.json.data.list[0].adcode === '320500' && r.json.data.list[0].level === 'city', r.json.data.list[0]);
    r = await req('GET', '/api/footprints/places?q=sz', null, daveCookie);
    check('首字母 sz → 深圳/苏州 均命中', r.json.data.list.some(x => x.name === '深圳') && r.json.data.list.some(x => x.name === '苏州'), r.json.data.list.map(x => x.name));
    r = await req('GET', '/api/footprints/places?q=hangz', null, daveCookie);
    check('拼音前缀 hangz → 杭州', r.json.data.list[0].name === '杭州', r.json.data.list[0]);
    r = await req('GET', '/api/footprints/places?q=' + encodeURIComponent('日本'), null, daveCookie);
    check('国家 → 日本 level=country', r.json.data.list[0].name === '日本' && r.json.data.list[0].level === 'country', r.json.data.list[0]);
    r = await req('GET', '/api/footprints/places?q=' + encodeURIComponent('东海群岛'), null, daveCookie);
    check('字典外地名无结果', r.json.data.list.length === 0, r.json.data.list);

    /* ---------- 真源与镜像 ---------- */
    section('route_places 真源 → dest 镜像');
    r = await req('POST', '/api/routes', {
      name: '沪杭快闪', year: '2026', start_date: '2026-06-06', end_date: '2026-06-08',
      days: 3, people: 2, currency: 'CNY',
      places: ['330100', '杭州', '不存在的城市']
    }, daveCookie);
    check('新建 201', r.status === 201, r.status);
    const rid = r.json.data.id;
    check('同名去重后 dest 镜像 = 杭州', r.json.data.dest === '杭州', r.json.data.dest);
    check('路线 places 返回 1 条（330100 与「杭州」同一条目）', r.json.data.places.length === 1, r.json.data.places);

    r = await req('GET', '/api/routes/' + rid, null, daveCookie);
    check('详情 places 含 adcode 与省份', r.json.data.places[0].adcode === '330100' && r.json.data.places[0].province === '浙江', r.json.data.places);

    r = await req('PUT', '/api/routes/' + rid, { name: '沪杭快闪', year: '2026', start_date: '2026-06-06', end_date: '2026-06-08', days: 3, people: 2, places: ['320500', '330100'] }, daveCookie);
    check('PUT 覆盖后 dest = 苏州 · 杭州（顺序保持）', r.json.data.dest === '苏州 · 杭州', r.json.data.dest);

    r = await req('GET', '/api/routes?q=' + encodeURIComponent('苏州'), null, daveCookie);
    check('搜索命中 dest 镜像文本', r.json.data.list.some(x => x.dest.includes('苏州')), r.json.data.list.map(x => x.dest));

    /* ---------- 点亮流水 ---------- */
    section('点亮流水（只增不删 / owner 隔离）');
    let s = await req('GET', '/api/footprints/summary', null, daveCookie).then(x => x.json.data);
    check('dave 点亮：苏州/杭州 2 处', s.litCount === 2, s.litCount);
    check('省级行政区 = 浙江、江苏 2 个', s.provinceCount === 2, s.provinceCount);
    check('城市数 = 2', s.cityCount === 2, s.cityCount);
    check('年份含 2026', s.years.includes('2026'), s.years);
    check('成就「迈出第一步」已解锁', s.achievements.find(a => a.key === 'first').done === true);
    check('成就「十城记」未解锁', s.achievements.find(a => a.key === 'city10').done === false);

    const se = await req('GET', '/api/footprints/summary', null, eveCookie).then(x => x.json.data);
    check('eve 无点亮（owner 隔离）', se.litCount === 0, se.litCount);

    /* ---------- 路线外手动点亮 ---------- */
    section('路线外手动点亮');
    r = await req('POST', '/api/footprints/manual', { place: '成都', date: '2024-03-02' }, daveCookie);
    check('手动点亮成都 200', r.status === 200, r.status);
    check('first_lit_on 记录到访日期', r.json.data.first_lit_on === '2024-03-02', r.json.data);
    r = await req('POST', '/api/footprints/manual', { place: '成都' }, daveCookie);
    check('重复点亮幂等 already=true', r.json.data.already === true, r.json.data);
    r = await req('POST', '/api/footprints/manual', { place: '东海群岛' }, daveCookie);
    check('字典外拒绝 400 INVALID_PLACE', r.status === 400 && r.json.code === 'INVALID_PLACE', r.status);
    s = await req('GET', '/api/footprints/summary', null, daveCookie).then(x => x.json.data);
    check('点亮 3 处（成都归入 2024 年）', s.litCount === 3 && s.years.includes('2024'), s.years);

    /* ---------- 地图数据 ---------- */
    section('地图点阵数据');
    r = await req('GET', '/api/footprints/map', null, daveCookie).then(x => x.json.data);
    check('全国省/市中心点 367 个', r.points.length === 367, r.points.length);
    check('省级模式口径：苏州/杭州所在省也点亮', r.points.filter(p => p.level === 'province' && p.lit).length >= 2);
    check('统计与 summary 一致', r.stats.cityCount === s.cityCount && r.stats.provinceCount === s.provinceCount, r.stats);

    /* ---------- 待标注 ---------- */
    section('待标注路线');
    await req('POST', '/api/routes', { name: '无目的地路线', year: '2026', start_date: '2026-07-01', end_date: '2026-07-02', days: 2, people: 1 }, daveCookie);
    const pending = await req('GET', '/api/footprints/pending', null, daveCookie).then(x => x.json.data);
    check('pending 含「无目的地路线」', pending.list.some(x => x.name === '无目的地路线'), pending.list);

    /* ---------- 备份往返（在删除路线前执行） ---------- */
    section('JSON 备份往返');
    const exp = await req('GET', '/api/routes/export?fmt=json', null, daveCookie).then(x => x.json.data);
    const withPlaces = exp.routes.filter(x => Array.isArray(x.places) && x.places.length);
    check('导出含 places adcode 数组', withPlaces.length > 0, exp.routes.map(x => x.places));
    const items = exp.routes.map(x => ({ ...x, name: x.name + '（导入副本）' }));
    /* 取一条带 places 的导出条目，替换为「320500 + 字典外地名」：验证 adcode 还原 + 未命中丢弃 */
    const target = items.find(x => x.places && x.places.length);
    target.places = ['320500', '东海群岛'];
    r = await req('POST', '/api/routes/import', { routes: items }, eveCookie);
    check('导入成功', r.json.data.created > 0, r.json.data);
    check('字典外目的地计入 errors', (r.json.data.errors || []).some(e => e.includes('东海群岛')), r.json.data.errors);
    const eveSummary = await req('GET', '/api/footprints/summary', null, eveCookie).then(x => x.json.data);
    check('导入还原后 eve 出现点亮', eveSummary.litCount > 0, eveSummary.litCount);
    const eveRoutes = await req('GET', '/api/routes', null, eveCookie).then(x => x.json.data);
    const imported = eveRoutes.list.find(x => x.name.includes('导入副本') && x.dest.includes('苏州'));
    check('导入路线 dest 为再生成镜像（320500→苏州）', imported && imported.dest === '苏州', imported && imported.dest);

    /* ---------- 删除路线不熄灭 ---------- */
    section('删除路线不熄灭地图');
    await req('DELETE', '/api/routes/' + rid, null, daveCookie);
    s = await req('GET', '/api/footprints/summary', null, daveCookie).then(x => x.json.data);
    check('删除路线后点亮保留（不回退成就）', s.litCount === 3 && s.cityCount === 3, s.litCount);
    check('首次点亮年份仍保留', s.years.includes('2026'), s.years);

    /* ---------- 示例 seed 路线（新装用户首屏即点亮） ---------- */
    section('示例数据');
    r = await req('GET', '/api/routes?q=' + encodeURIComponent('江南'), null, adminCookie).then(x => x.json.data);
    check('seed 路线 dest = 苏州 · 杭州', r.list.some(x => x.dest === '苏州 · 杭州'), r.list.map(x => x.dest));
    const adminSummary = await req('GET', '/api/footprints/summary', null, adminCookie).then(x => x.json.data);
    check('admin 由 seed 获得点亮', adminSummary.litCount >= 4, adminSummary.litCount);
  } finally {
    await stop(srv);
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }

  console.log(`\nsmoke-footprint：${pass} 通过，${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
}

main().catch(e => { console.error('冒烟异常：', e); process.exit(2); });
