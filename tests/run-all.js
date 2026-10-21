/* 测试编排：一条命令跑全部测试（本地与 CI 通用）
 * 1. 起后端（隔离 DATA_DIR + 种子数据），注入注册/登录验证码
 * 2. 顺序执行主回归 + 深测（共享同一服务，数据前后衔接）
 * 3. 停服务，执行 12 个自托管冒烟与离线引擎单测
 * 运行：node tests/run-all.js
 * 退出码：0=全绿 1=有失败 2=异常
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'app.js');
const PORT = 3907;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-regress-'));
const REGISTER_CODE = '654321';
const LOGIN_CODE = '111222';

const results = [];
function runStep(name, fn) {
  console.log('\n══════════════ ' + name + ' ══════════════');
  try { fn(); results.push([name, true]); console.log('✅ ' + name); }
  catch (e) { results.push([name, false]); console.error('❌ ' + name + '\n' + (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') + (e.message || '')); }
}

function runNode(script, extraEnv, cwd, extraArgs) {
  const r = spawnSync(process.execPath, [script].concat(extraArgs || []), {
    cwd: cwd || ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    timeout: 120000
  });
  if (r.error) throw r.error;
  if (r.status !== 0) { const e = new Error('exit ' + r.status); e.stdout = ''; e.stderr = ''; throw e; }
}

function injectCode(dbPath, email, purpose, code) {
  const Database = require(path.join(ROOT, 'server', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare('UPDATE verification_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0').run(email, purpose);
  db.prepare('INSERT INTO verification_codes (email, purpose, code, expires_at, consumed, created_at) VALUES (?,?,?,?,0,?)')
    .run(email, purpose, code, now + 300000, now);
  db.close();
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) return; } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 250));
  }
  throw new Error('服务未能启动（/health 无响应）');
}

async function main() {
  /* 种子数据拷贝进隔离库 */
  fs.copyFileSync(path.join(ROOT, 'data', 'routes.json'), path.join(DATA_DIR, 'routes.json'));

  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore'
  });
  try {
    await waitUp();
    injectCode(path.join(DATA_DIR, 'app.db'), 'carol@example.com', 'register', REGISTER_CODE);
    injectCode(path.join(DATA_DIR, 'app.db'), 'carol@example.com', 'login', LOGIN_CODE);

    runStep('主回归 regression.test.js', () => runNode(path.join(__dirname, 'regression.test.js'), { REGISTER_CODE }, ROOT, [BASE]));
    runStep('深测 regression.deep.test.js', () => runNode(path.join(__dirname, 'regression.deep.test.js'), { LOGIN_CODE }, ROOT, [BASE]));
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  /* 冒烟（各自自托管，端口独立） */
  runStep('冒烟 smoke-budget', () => runNode(path.join(__dirname, 'smoke-budget.test.js'), {}, ROOT));
  runStep('冒烟 smoke-export', () => runNode(path.join(__dirname, 'smoke-export.test.js'), {}, ROOT));
  runStep('冒烟 smoke-share', () => runNode(path.join(__dirname, 'smoke-share.test.js'), {}, ROOT));
  runStep('冒烟 smoke-share-export', () => runNode(path.join(__dirname, 'smoke-share-export.test.js'), {}, ROOT));
  runStep('冒烟 smoke-backup', () => runNode(path.join(__dirname, 'smoke-backup.test.js'), {}, ROOT));
  runStep('冒烟 smoke-ledger（逐笔流水 + AA 分账）', () => runNode(path.join(__dirname, 'smoke-ledger.test.js'), {}, ROOT));
  runStep('冒烟 smoke-ai（AI 规划 / 调整）', () => runNode(path.join(__dirname, 'smoke-ai.test.js'), {}, ROOT));
  runStep('冒烟 smoke-days（行程按天：景点/住宿）', () => runNode(path.join(__dirname, 'smoke-days.test.js'), {}, ROOT));
  runStep('冒烟 smoke-cors（跨域预检 / 写方法白名单）', () => runNode(path.join(__dirname, 'smoke-cors.test.js'), {}, ROOT));
  runStep('冒烟 smoke-fixes（排序权威 / 币种不变量 / 导出导入往返 / 去重键 / 分享含结算）', () => runNode(path.join(__dirname, 'smoke-fixes.test.js'), {}, ROOT));
  runStep('冒烟 smoke-footprint（足迹点亮：字典/镜像/点亮流水/成就/备份往返）', () => runNode(path.join(__dirname, 'smoke-footprint.test.js'), {}, ROOT));
  runStep('冒烟 smoke-offline（离线幂等 / 批量同步 / 降级 / 拒绝 / 幂等删除）', () => runNode(path.join(__dirname, 'smoke-offline.test.js'), {}, ROOT));
  runStep('单测 offline-engine（MemoryAdapter / 退避 / 401 保全 / 幂等投影 / 本地消解）', () => runNode(path.join(__dirname, 'offline-engine.test.js'), {}, ROOT));
  runStep('单测 body-decode（分片解码 / 空体 / 非法 JSON / 字节与字符上限）', () => runNode(path.join(__dirname, 'body-decode.test.js'), {}, ROOT));

  console.log('\n══════════════════════════════════');
  let fail = 0;
  for (const [name, ok] of results) {
    console.log((ok ? '  ✅ ' : '  ❌ ') + name);
    if (!ok) fail++;
  }
  console.log(`总计 ${results.length} 个测试脚本，通过 ${results.length - fail}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('编排异常：', e); process.exit(2); });
