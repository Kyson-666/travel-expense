/* 冒烟测试：管理后台数据库备份下载（#24）
 * 运行：node tests/smoke-backup.test.js
 * 覆盖：备份 200 + SQLite 魔数 + Content-Disposition、非管理员 403、审计留痕
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3906;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-backup-'));

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
    return { status: r.status, buf, text: new TextDecoder().decode(buf), headers: r.headers, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  }
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
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
    r = await req('POST', '/api/auth/register', { username: 'frank', password: 'frankpass123' });
    const userCookie = r.setCookie;

    section('权限');
    r = await req('GET', '/api/admin/db-backup', null, userCookie, true);
    check('普通用户备份 → 403', r.status === 403, r.status);

    section('备份下载');
    r = await req('GET', '/api/admin/db-backup', null, adminCookie, true);
    check('备份 200', r.status === 200, r.status);
    check('Content-Disposition 附件下载', /attachment/.test(r.headers.get('content-disposition') || '') && /travel-expense-backup-.*\.db/.test(r.headers.get('content-disposition') || ''), r.headers.get('content-disposition'));
    check('文件以 SQLite 魔数开头', r.buf[0] === 0x53 && r.buf[1] === 0x51 && r.buf[2] === 0x4c, [r.buf[0], r.buf[1], r.buf[2]].map(x => x && x.toString(16)));
    check('文件大小 > 32KB（含表数据）', r.buf.length > 32768, r.buf.length);

    r = await req('GET', '/api/admin/audit-logs?action=db_backup', null, adminCookie);
    check('备份动作写入审计日志', r.status === 200 && r.json.data.list.some(a => a.action === 'db_backup'), r.json && r.json.data && r.json.data.list && r.json.data.list[0]);
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== 备份冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
