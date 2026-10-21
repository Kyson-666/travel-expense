/* 冒烟测试：分享页「导出为图片」（html2canvas + 分享页独立 CSP）
 * 运行：node tests/smoke-share-export.test.js
 * 覆盖（服务端可断言的部分；浏览器内实际渲染已用无头 Chrome 单测验证，CI 不含浏览器）：
 *   - 分享页 200 且 CSP 的 script-src 含 'unsafe-inline'（导出脚本所需）
 *   - 分享页含「导出为图片」按钮（exportAsImage）+ 引用 /assets/html2canvas.min.js + 卡片 id="shareCard"
 *   - 分享页内容仍转义，防 XSS
 *   - /assets/html2canvas.min.js 可访问（200 + javascript MIME + 体积正常）
 *   - 主应用首页 CSP 的 script-src 仍不含 'unsafe-inline'（保持严格）
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3904;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-sharexp-'));
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
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (e) { /* non-json */ }
  return { status: r.status, json, text: txt, headers: r.headers, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动', up);
  if (!up) { srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    const r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const admin = r.setCookie;
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, admin);

    section('分享页导出图片');
    const cr = await req('POST', '/api/routes', {
      name: '西北大环线<script>x</script>', year: '2026',
      start_date: '2026-08-01', end_date: '2026-08-05', days: 5, people: 2,
      dest: '青海甘肃', currency: 'CNY', budget_total: 8000,
      scenic: 'Day1 西宁；Day2 塔尔寺', hotel: '全程准四', notes: '注意高反'
    }, admin);
    check('建路线 201', cr.status === 201, cr.status);
    const rid = cr.json.data.id;

    const sh = await req('POST', '/api/routes/' + rid + '/share', null, admin);
    const token = sh.json.data.token;
    check('生成分享令牌', !!token, sh.json);

    const page = await req('GET', '/share/' + token);
    check('分享页 200', page.status === 200, page.status);
    const csp = page.headers.get('content-security-policy') || '';
    check('分享页 CSP script-src 含 unsafe-inline', /script-src[^;]*'unsafe-inline'/.test(csp), csp);
    check('分享页含导出按钮（exportAsImage + 导出为图片）', page.text.includes('exportAsImage') && page.text.includes('导出为图片'));
    check('分享页引用 html2canvas', page.text.includes('/assets/html2canvas.min.js'));
    check('分享卡片带 id="shareCard"', page.text.includes('id="shareCard"'));
    check('分享页内容转义（XSS 防注入）', !page.text.includes('<script>x</script>') && page.text.includes('&lt;script&gt;'));

    const lib = await req('GET', '/assets/html2canvas.min.js');
    const ct = lib.headers.get('content-type') || '';
    check('html2canvas 可访问 200', lib.status === 200, lib.status);
    check('html2canvas MIME 为 javascript', /javascript/.test(ct), ct);
    check('html2canvas 体积正常（>150KB）', lib.text.length > 150000, lib.text.length);

    const idx = await req('GET', '/');
    const idxCsp = idx.headers.get('content-security-policy') || '';
    check('主应用 CSP script-src 仍不含 unsafe-inline', !/script-src[^;]*'unsafe-inline'/.test(idxCsp), idxCsp);
  } catch (e) {
    fail++; failures.push('异常：' + e.message); console.log('  ❌ 异常：' + e.stack);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 分享页导出图片冒烟：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (fail) { failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
}

main();
