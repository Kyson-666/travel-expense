/* 冒烟测试：路线只读分享链接（#23）
 * 运行：node tests/smoke-share.test.js
 * 覆盖：生成令牌、重复生成重置、取消分享、普通用户无权分享他人/种子、
 *      公开页 200/404、内容转义（防 XSS）、noindex
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3905;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-share-'));
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
  return { status: r.status, json, text: txt, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
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
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie = r.setCookie;
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);
    r = await req('POST', '/api/auth/register', { username: 'dave', password: 'davepass123' });
    const userCookie = r.setCookie;
    r = await req('POST', '/api/auth/register', { username: 'eve', password: 'evepass123' });
    const eveCookie = r.setCookie;

    /* 造数：dave 建一条含 XSS 载荷的路线 */
    r = await req('POST', '/api/routes', {
      name: '川西环线<script>alert(1)</script>', year: '2026', daterange: '8/1-8/5',
      days: 5, people: 2, currency: 'CNY', budget_total: 1000,
      exp: { 机票: 300, 住宿: 400 }, notes: '<img src=x onerror=alert(2)>'
    }, userCookie);
    check('dave 建路线', r.status === 201, r);
    const rid = r.json.data.id;

    const seed = await req('GET', '/api/routes', null, userCookie);
    const seedId = seed.json.data.list.find(x => x.is_seed).id;

    /* ---------- 令牌管理 ---------- */
    section('令牌管理');
    r = await req('GET', '/api/routes/' + rid + '/share', null, userCookie);
    check('初始无令牌 → token=null', r.status === 200 && r.json.data.token === null, r.json);

    r = await req('POST', '/api/routes/' + rid + '/share', null, userCookie);
    check('生成令牌 200 且 32 位 hex', r.status === 200 && /^[0-9a-f]{32}$/.test(r.json.data.token || ''), r.json);
    const token = r.json.data.token;

    r = await req('POST', '/api/routes/' + rid + '/share', null, userCookie);
    check('再次生成返回新令牌（重置）', r.status === 200 && r.json.data.token !== token && /^[0-9a-f]{32}$/.test(r.json.data.token), r.json);
    const token2 = r.json.data.token;
    const oldPage = await req('GET', '/share/' + token, null, null);
    check('旧令牌立即失效 → 404', oldPage.status === 404, oldPage.status);

    r = await req('GET', '/api/routes/' + rid + '/share', null, eveCookie);
    check('他人查他人私有路线 → 404（不泄露存在性）', r.status === 404, r.status);
    r = await req('POST', '/api/routes/' + rid + '/share', null, eveCookie);
    check('他人生成令牌（私有路线）→ 404', r.status === 404, r.status);
    r = await req('GET', '/api/routes/' + seedId + '/share', null, eveCookie);
    check('他人管理种子分享 → 403', r.status === 403, r.status);
    r = await req('POST', '/api/routes/' + seedId + '/share', null, eveCookie);
    check('普通用户分享种子 → 403', r.status === 403, r.status);
    r = await req('DELETE', '/api/routes/' + seedId + '/share', null, eveCookie);
    check('普通用户取消种子分享 → 403', r.status === 403, r.status);
    r = await req('POST', '/api/routes/' + seedId + '/share', null, adminCookie);
    check('管理员可分享种子', r.status === 200 && r.json.data.token, r.status);

    /* ---------- 公开分享页 ---------- */
    section('公开分享页');
    const page = await req('GET', '/share/' + token2, null, null);
    check('公开页 200（无需登录）', page.status === 200 && /text\/html/.test((await (await fetch(BASE + '/share/' + token2)).headers).get('content-type')), page.status);
    check('页面含路线名（转义后无 <script>）', page.text.includes('川西环线&lt;script&gt;alert(1)&lt;/script&gt;') && !page.text.includes('<script>alert'), page.text.slice(0, 400));
    check('备注中的 <img> 被转义', page.text.includes('&lt;img src=x onerror=alert(2)&gt;') && !page.text.includes('<img src=x'), '—');
    check('页面含预算与明细', page.text.includes('预算') && page.text.includes('机票') && page.text.includes('700'), '—');
    check('noindex 声明', page.text.includes('noindex,nofollow'), '—');
    r = await req('GET', '/share/notexisttoken', null, null);
    check('无效令牌 → 404 JSON', r.status === 404 && r.json && r.json.ok === false, r.status);

    /* 取消分享后失效 */
    r = await req('DELETE', '/api/routes/' + rid + '/share', null, userCookie);
    check('本人取消分享', r.status === 200, r);
    r = await req('GET', '/share/' + token2, null, null);
    check('取消后公开页 404', r.status === 404, r.status);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 分享冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
