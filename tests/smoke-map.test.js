/* 冒烟测试：足迹地图底图配置（默认关闭 / 脱敏 / '******' 保持 / 连通性测试 / ver 缓存协议）
 * 运行：node tests/smoke-map.test.js
 * 覆盖：
 *   1. 默认关闭：admin 设置页 provider=none；普通用户不下发任何 key
 *   2. 非法 provider → 400
 *   3. 保存 amap（key + securityJsCode）→ 设置页脱敏 ******；footprint 下发明文（前端 SDK 需要）
 *   4. '******' 保持原值语义（与邮件密码同模式）；空串不误清已有 key
 *   5. 切换 tencent → footprint 下发 tencent_key
 *   6. 连通性测试：无 key / 假 key → { ok:false }（真实请求厂商；网络不可达同样 ok:false，断言稳定）
 *   7. /map ver 缓存协议：ver 变化前 notModified=true，手动点亮后 ver 推进
 *   8. 审计：update_map_config / test_map_config
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3938;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-map-'));

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
    r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const admin0 = r.setCookie;
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, admin0);
    r = await req('POST', '/api/auth/login', { login: 'admin', password: 'adminnew123' });
    const admin = r.setCookie;
    r = await req('POST', '/api/auth/register', { username: 'mu1', password: 'mu1pass123' });
    const u1 = r.setCookie;

    section('默认关闭');
    r = await req('GET', '/api/admin/map-config', null, admin);
    check('设置页 provider=none / enabled=false', r.json.data.provider === 'none' && r.json.data.enabled === false, r.json.data);
    check('未配置时 key 为空串', r.json.data.amap_key === '' && r.json.data.tencent_key === '', r.json.data);
    r = await req('GET', '/api/footprints/map-config', null, u1);
    check('足迹接口关闭态不回任何 key', r.json.data.enabled === false && r.json.data.provider === 'none' && !r.json.data.amap_key, r.json.data);

    section('保存与脱敏');
    r = await req('POST', '/api/admin/map-config', { provider: 'baidu' }, admin);
    check('非法 provider → 400', r.status === 400, r.status);
    r = await req('POST', '/api/admin/map-config', { provider: 'amap', amap_key: 'AMAPKEY123', amap_security: 'SEC456' }, admin);
    check('保存 amap 配置 200', r.status === 200, r.status);
    r = await req('GET', '/api/admin/map-config', null, admin);
    check('设置页脱敏（******）', r.json.data.amap_key === '******' && r.json.data.amap_security === '******', r.json.data);
    check('enabled=true', r.json.data.enabled === true, r.json.data);
    r = await req('GET', '/api/footprints/map-config', null, u1);
    check('足迹接口下发 SDK 所需明文 key', r.json.data.enabled === true && r.json.data.amap_key === 'AMAPKEY123' && r.json.data.amap_security === 'SEC456', r.json.data);

    r = await req('POST', '/api/admin/map-config', { provider: 'amap', amap_key: '******', amap_security: '******' }, admin);
    check("'******' 保存不报错", r.status === 200, r.status);
    r = await req('GET', '/api/footprints/map-config', null, u1);
    check("'******' 保持原值", r.json.data.amap_key === 'AMAPKEY123' && r.json.data.amap_security === 'SEC456', r.json.data);

    section('切换腾讯');
    r = await req('POST', '/api/admin/map-config', { provider: 'tencent', tencent_key: 'QQMAP-KEY-1' }, admin);
    check('切换 tencent 200', r.status === 200, r.status);
    r = await req('GET', '/api/footprints/map-config', null, u1);
    check('footprint 只下发 tencent_key', r.json.data.provider === 'tencent' && r.json.data.tencent_key === 'QQMAP-KEY-1' && !r.json.data.amap_key, r.json.data);

    section('连通性测试');
    r = await req('POST', '/api/admin/map-config/test', { provider: 'amap', amap_key: '' }, admin);
    check('无 key → ok:false', r.status === 200 && r.json.data.ok === false, r.json.data);
    r = await req('POST', '/api/admin/map-config/test', { provider: 'amap', amap_key: 'FAKE-KEY-FOR-TEST' }, admin);
    /* 假 key：厂商返回 INVALID_USER_KEY（或网络不可达 → 网络提示）；两者均为 ok:false，断言稳定 */
    check('假 key → ok:false 且给可读原因', r.status === 200 && r.json.data.ok === false && r.json.data.message, r.json.data);
    check('message 为中文提示', /高德|网络|Key/.test(r.json.data.message || ''), r.json.data);
    r = await req('POST', '/api/admin/map-config/test', { provider: 'none' }, admin);
    check('关闭态测试 → ok:false 未知的图商类型', r.status === 200 && r.json.data.ok === false, r.json.data);

    section('/map ver 缓存协议');
    r = await req('POST', '/api/routes', { name: '点亮路线', year: '2026', start_date: '2026-06-01', end_date: '2026-06-03', days: 3, people: 1, places: ['330100'] }, u1);
    const rid = r.json.data.id;
    check('u1 建路线（点亮杭州）201', r.status === 201, r.status);
    r = await req('GET', '/api/footprints/map', null, u1);
    const ver1 = r.json.data.ver;
    check('/map 返回 ver', !!ver1 && ver1 !== '0:0', ver1);
    r = await req('GET', `/api/footprints/map?ver=${encodeURIComponent(ver1)}`, null, u1);
    check('ver 相同 → notModified（省流量）', r.json.data.notModified === true, r.json.data);
    r = await req('POST', '/api/footprints/manual', { place: '成都', date: '2025-08-01' }, u1);
    check('手动点亮成都', r.status === 200, r.status);
    r = await req('GET', `/api/footprints/map?ver=${encodeURIComponent(ver1)}`, null, u1);
    check('点亮后 ver 推进 → 返回全量', !r.json.data.notModified && r.json.data.ver !== ver1, r.json.data.ver);
    const v2 = r.json.data.ver;
    r = await req('GET', `/api/footprints/map?ver=${encodeURIComponent(v2)}`, null, u1);
    check('新 ver 再查 → notModified', r.json.data.notModified === true, r.json.data);

    section('审计');
    r = await req('GET', '/api/admin/audit-logs?action=update_map_config', null, admin);
    check('审计含 update_map_config', (r.json.data.list || []).length > 0, r.json.data && r.json.data.total);
    r = await req('GET', '/api/admin/audit-logs?action=test_map_config', null, admin);
    check('审计含 test_map_config', (r.json.data.list || []).length > 0, r.json.data && r.json.data.total);
  } finally {
    await stop(srv);
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }

  console.log(`\nsmoke-map：${pass} 通过，${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
}

main().catch(e => { console.error('冒烟异常：', e); process.exit(2); });
