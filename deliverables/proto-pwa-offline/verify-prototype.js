/* CDP 真机验证脚本：PWA 离线记账交互原型
 * 零依赖（Node 22 内置 WebSocket/fetch），复用本机 Chrome/Chromium 内核。
 * 交互一律走真实 UI 路径（点按钮 / 填表单），断言只读 __proto 暴露的状态。
 * 运行：node verify-prototype.js   （可用 CHROME_BIN 指定 chrome.exe）
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

function resolveChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    'C:/Program Files/Google/Chrome/Application',
    'C:/Program Files (x86)/Google/Chrome/Application',
    'C:/Program Files (x86)/Microsoft/Edge/Application',
    'C:/Program Files/Microsoft/Edge/Application'
  ];
  /* Playwright 的 chromium-<rev> 目录 */
  try {
    const base = cands[0];
    let best = null, bestRev = -1;
    for (const d of fs.readdirSync(base)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > bestRev) { best = exe; bestRev = Number(m[1]); }
    }
    if (best) return best;
  } catch { /* 目录不存在 */ }
  for (const dir of cands.slice(1)) {
    for (const exe of ['chrome.exe', 'msedge.exe']) {
      const p = path.join(dir, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const CHROME = resolveChrome();
if (!CHROME) {
  console.error('未找到 Chromium 内核。请用 CHROME_BIN 指定 chrome.exe 路径：');
  console.error('  CHROME_BIN=/path/to/chrome.exe node verify-prototype.js');
  process.exit(1);
}
const PAGE = path.join(__dirname, 'index.html');
const OUT = path.join(__dirname, 'shots');
const PORT = 9334;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-pwa-'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--window-size=1280,1100', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { /* 尚未就绪 */ }
  }
  if (!target) { console.error('无法获取 CDP target'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];
      addEventListener('error',e=>window.__errs.push('error: '+(e.message||e.type)));
      addEventListener('unhandledrejection',e=>window.__errs.push('reject: '+((e.reason&&e.reason.message)||e.reason)));`
  });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  const waitFor = async (expr, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await ev(expr)) return true; } catch { /* 重绘间隙 */ }
      await sleep(120);
    }
    return false;
  };
  const shot = async (name) => {
    await sleep(350);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  /* 走真实 UI：填「记一笔」表单并保存 */
  const addExpense = async (amount, category) => {
    await ev(`document.getElementById('addBtn').click()`);
    await waitFor(`document.getElementById('expMask').classList.contains('open')`);
    await ev(`(()=>{const a=document.getElementById('e_amount');a.value='${amount}';a.dispatchEvent(new Event('input'));})()`);
    if (category) await ev(`document.querySelector('#e_cats [data-c="${category}"]').click()`);
    await ev(`document.getElementById('e_save').click()`);
    await sleep(500);
  };

  await send('Page.navigate', { url: pathToFileURL(PAGE).href });
  await waitFor(`!!window.__proto && document.querySelectorAll('.led').length>0`, 10000);

  /* ---------- A. 初始态 ---------- */
  console.log('\n■ A. 初始态');
  check('A1 初始渲染 2 条流水', await ev(`document.querySelectorAll('.led').length`) === 2);
  check('A2 初始队列为空', await ev(`__proto.queueLen()`) === 0);
  check('A3 初始指示条隐藏', await ev(`document.getElementById('offlineBar').classList.contains('show')`) === false);
  check('A4 无待同步行', await ev(`__proto.pendingRows()`) === 0);
  await shot('01-initial');

  /* ---------- B. 在线直发（不经过队列） ---------- */
  console.log('\n■ B. 在线直发');
  await addExpense(300, '餐饮');
  check('B1 服务端 +1', await ev(`__proto.serverLen()`) === 3);
  check('B2 未产生队列项（在线直发）', await ev(`__proto.queueLen()`) === 0);
  check('B3 界面 3 条流水', await ev(`document.querySelectorAll('.led').length`) === 3);

  /* ---------- C. 离线记账 → 队列 → 恢复网络自动同步 ---------- */
  console.log('\n■ C. 离线记账与自动同步');
  await ev(`(()=>{const t=document.getElementById('netToggle');t.checked=false;t.dispatchEvent(new Event('change'));})()`);
  check('C1 指示条显示离线', (await ev(`__proto.barText()`)).includes('离线'));
  await addExpense(1200, '门票');
  await addExpense(450, '购物');
  check('C2 队列累计 2 笔', await ev(`__proto.queueLen()`) === 2);
  check('C3 服务端未变（仍 3）', await ev(`__proto.serverLen()`) === 3);
  check('C4 投影出 2 条待同步行', await ev(`__proto.pendingRows()`) === 2);
  check('C5 待同步行有虚线样式类', await ev(`document.querySelectorAll('.led.pending').length`) === 2);
  check('C6 指示条含待同步计数', (await ev(`__proto.barText()`)).includes('2 笔待同步'), await ev(`__proto.barText()`));
  check('C7 总花费含「待同步」提示', (await ev(`document.getElementById('totalLine').innerText`)).includes('待同步'));
  await shot('02-offline-pending');

  await ev(`document.getElementById('queueBtn').click()`);
  await waitFor(`document.getElementById('queueMask').classList.contains('open')`);
  check('C8 同步队列面板列出 2 项', await ev(`document.querySelectorAll('#queueBody .q-item').length`) >= 2);
  await shot('03-queue-panel');
  await ev(`document.getElementById('q_close').click()`);

  /* 恢复网络 → 自动同步 */
  await ev(`(()=>{const t=document.getElementById('netToggle');t.checked=true;t.dispatchEvent(new Event('change'));})()`);
  const ok = await waitFor(`__proto.queueLen()===0 && __proto.serverLen()===5`, 10000);
  check('C9 恢复网络后自动同步完成（队列清空）', ok, { q: await ev(`__proto.queueLen()`), s: await ev(`__proto.serverLen()`) });
  check('C10 服务端恰好 +2（不多不少）', await ev(`__proto.serverLen()`) === 5);
  check('C11 无残留待同步行', await ev(`__proto.pendingRows()`) === 0);
  check('C12 指示条已隐藏', await ev(`document.getElementById('offlineBar').classList.contains('show')`) === false);
  await shot('04-synced');

  /* ---------- D. 幂等：重放同一批 ---------- */
  console.log('\n■ D. 幂等重放');
  const before = await ev(`__proto.serverLen()`);
  await ev(`document.getElementById('btnReplay').click()`);
  await waitFor(`__proto.queueLen()===0`, 10000);
  await sleep(400);
  check('D1 重放后服务端条数不变（判为重复）', await ev(`__proto.serverLen()`) === before, { before, after: await ev(`__proto.serverLen()`) });
  check('D2 日志出现「判为重复」', (await ev(`__proto.logText()`)).includes('判为重复'));
  check('D3 结果列表含 duplicate 状态', await ev(`__proto.state().results.some(r=>r.status==='duplicate')`) === true);
  await shot('05-idempotent-replay');

  /* ---------- E. 降级：付款人已不存在 ---------- */
  console.log('\n■ E. 同行人失效自动降级');
  await ev(`(()=>{const s=document.getElementById('faultSel');s.value='degraded';s.dispatchEvent(new Event('change'));})()`);
  const s0 = await ev(`__proto.serverLen()`);
  await addExpense(888, '其他');
  await waitFor(`__proto.queueLen()===0`, 10000);
  await sleep(300);
  check('E1 服务端 +1（数据未丢）', await ev(`__proto.serverLen()`) === s0 + 1, { s0, now: await ev(`__proto.serverLen()`) });
  const degraded = await ev(`__proto.state().server.filter(e=>e.amount===888)[0]`);
  check('E2 已降级：payer_id 置空', degraded && degraded.payer_id === null, degraded && degraded.payer_id);
  check('E3 已降级：parts 清空', degraded && Array.isArray(degraded.parts) && degraded.parts.length === 0);
  check('E4 已降级：split_mode=none', degraded && degraded.split_mode === 'none', degraded && degraded.split_mode);
  check('E5 结果列表含 degraded 状态', await ev(`__proto.state().results.some(r=>r.status==='degraded')`) === true);
  await shot('06-degraded');

  /* ---------- F. 拒绝：路线已删除 ---------- */
  console.log('\n■ F. 路线已删除 → 拒绝且保留队列');
  await ev(`(()=>{const s=document.getElementById('faultSel');s.value='rejected';s.dispatchEvent(new Event('change'));})()`);
  await addExpense(500, '交通');
  await sleep(800);
  check('F1 队列保留该笔（不静默丢弃）', await ev(`__proto.queueLen()`) >= 1, await ev(`__proto.queueLen()`));
  check('F2 该笔状态为 failed（停止自动重试）', await ev(`__proto.state().queue.some(o=>o.status==='failed')`) === true);
  check('F3 结果列表含 rejected 状态', await ev(`__proto.state().results.some(r=>r.status==='rejected')`) === true);
  check('F4 指示条仍显示待同步', (await ev(`__proto.barText()`)).includes('待同步'), await ev(`__proto.barText()`));
  await shot('07-rejected');

  /* ---------- G. 网络失败 → 退避 ---------- */
  console.log('\n■ G. 网络失败与退避');
  await ev(`__proto.reset()`);
  await ev(`(()=>{const t=document.getElementById('netToggle');t.checked=false;t.dispatchEvent(new Event('change'));})()`);
  await addExpense(321, '交通');
  check('G0 离线入队 1 笔', await ev(`__proto.queueLen()`) === 1, await ev(`__proto.queueLen()`));
  await ev(`(()=>{const s=document.getElementById('faultSel');s.value='network';s.dispatchEvent(new Event('change'));})()`);
  await ev(`(()=>{const t=document.getElementById('netToggle');t.checked=true;t.dispatchEvent(new Event('change'));})()`);
  await sleep(1300);
  const op = await ev(`__proto.state().queue.filter(o=>o.status==='pending')[0]`);
  check('G1 存在 pending 项（未被丢弃）', !!op);
  check('G2 attempts 已递增', op && op.attempts >= 1, op && op.attempts);
  check('G3 已排定退避重试时刻', op && op.nextRetryAt > 0, op && op.nextRetryAt - Date.now());
  check('G4 日志含「退避」', (await ev(`__proto.logText()`)).includes('退避'));
  await shot('08-backoff');

  /* ---------- H. 离线新增后即删 → 本地消解 ---------- */
  console.log('\n■ H. 本地消解（新增后即删除）');
  await ev(`__proto.reset()`);
  await ev(`(()=>{const t=document.getElementById('netToggle');t.checked=false;t.dispatchEvent(new Event('change'));})()`);
  await ev(`(()=>{const s=document.getElementById('faultSel');s.value='none';s.dispatchEvent(new Event('change'));})()`);
  await addExpense(999, '餐饮');
  check('H1 队列 1 笔', await ev(`__proto.queueLen()`) === 1);
  await ev(`document.querySelector('.led.pending').click()`);   /* 点待同步行 → 入队删除 */
  check('H2 队列 2 笔（新增 + 删除）', await ev(`__proto.queueLen()`) === 2, await ev(`__proto.queueLen()`));
  await ev(`(()=>{const t=document.getElementById('netToggle');t.checked=true;t.dispatchEvent(new Event('change'));})()`);
  await waitFor(`__proto.queueLen()===0`, 10000);
  await sleep(300);
  check('H3 队列清空', await ev(`__proto.queueLen()`) === 0);
  check('H4 服务端未新增（本地消解，未发网络请求）', await ev(`__proto.serverLen()`) === 2, await ev(`__proto.serverLen()`));
  check('H5 日志含「本地消解」', (await ev(`__proto.logText()`)).includes('本地消解'));
  await shot('09-local-resolve');

  /* ---------- I. 运行期无 JS 错误 ---------- */
  console.log('\n■ I. 健壮性');
  const errs = await ev(`window.__errs`);
  check('I1 全流程无未捕获 JS 错误', Array.isArray(errs) && errs.length === 0, errs);

  chrome.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  const fail = results.filter(r => !r.ok).length;
  console.log('\n══════════════════════════════════');
  console.log(`断言：${results.length} 条，通过 ${results.length - fail}，失败 ${fail}`);
  console.log(`截图：${OUT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
