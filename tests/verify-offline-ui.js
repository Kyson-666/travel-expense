/* 真机端到端：PWA 离线记账（真实浏览器 + 真实服务端）
 * 零依赖：Node 22 内置 WebSocket/fetch + 本机 Chrome/Chromium 内核（CDP 直连）。
 * 覆盖：在线直发、断网入队与虚线待同步行、恢复网络自动同步、服务端恰好 +1。
 * 运行：node tests/verify-offline-ui.js    （CHROME_BIN 可指定 chrome.exe）
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'app.js');
const PORT = 3914;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9336;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-offlineui-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const d = extra === undefined ? '' : ' got=' + JSON.stringify(extra); failures.push(name + d); console.log('  ❌ ' + name + d); }
}
function section(t) { console.log('\n■ ' + t); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function resolveChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const pw = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  try {
    let best = null, rev = -1;
    for (const d of fs.readdirSync(pw)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(pw, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > rev) { best = exe; rev = Number(m[1]); }
    }
    if (best) return best;
  } catch (e) { /* 目录不存在 */ }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function api(method, p, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + p, opt);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  const CHROME = resolveChrome();
  if (!CHROME) { console.error('未找到 Chromium 内核，可用 CHROME_BIN 指定 chrome.exe'); process.exit(1); }

  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await sleep(200);
  }
  if (!up) { server.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); console.error('服务未启动'); process.exit(1); }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--window-size=1280,1100', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    /* ---------- 准备数据（走 API，等价于用户已有数据） ---------- */
    let r = await api('POST', '/api/auth/register', { username: 'offui', password: 'offuipass123' });
    const cookie = r.cookie;
    check('注册测试账户', r.status === 201 && !!cookie, r.status);
    r = await api('POST', '/api/routes', { name: '离线端到端路线', year: '2026', start_date: '2026-10-01', end_date: '2026-10-03', days: 3, people: 2, currency: 'CNY' }, cookie);
    const routeId = r.json.data.id;
    await api('POST', `/api/routes/${routeId}/travelers`, { names: ['我', '阿May'] }, cookie);
    const tvs = (await api('GET', `/api/routes/${routeId}/travelers`, null, cookie)).json.data.list;
    await api('POST', `/api/routes/${routeId}/expenses`, { category: '餐饮', amount: 100, spent_on: '2026-10-01', title: '出发晚餐', payer_id: tvs[0].id, parts: tvs.map(t => t.id) }, cookie);
    const before = (await api('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data.total;
    check('准备：路线已有 1 笔流水', before === 1, before);

    /* ---------- 连接 CDP ---------- */
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(250);
      try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { /* retry */ }
    }
    if (!target) throw new Error('无法获取 CDP target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs=[];window.__toastLog=[];window.__fetchErrs=[];
        addEventListener('error',e=>window.__errs.push('error: '+(e.message||e.type)));
        addEventListener('unhandledrejection',e=>window.__errs.push('reject: '+((e.reason&&e.reason.message)||e.reason)));
        const _f=window.fetch;
        window.fetch=function(){const t0=Date.now();return _f.apply(this,arguments).catch(e=>{
          window.__fetchErrs.push({t:t0,url:String(arguments[0]),msg:String(e&&(e.message||e.name))});throw e;});};
        window.confirm=()=>true; /* 测试内确认类交互默认同意，避免对话框阻塞 */
        const boot=()=>{const obs=new MutationObserver(()=>{const el=document.getElementById('toast');
          if(el&&el.classList.contains('show')){const L=window.__toastLog;const last=L[L.length-1];
            if(!last||last.m!==el.textContent||Date.now()-last.t>100){L.push({t:Date.now(),m:el.textContent});}}});
          obs.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class'],characterData:true});};
        if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();`
    });

    const ev = async (expr) => {
      const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (res.result && res.result.exceptionDetails) throw new Error('eval: ' + (res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text));
      return res.result.result.value;
    };
    const waitFor = async (expr, timeout = 12000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await ev(expr)) return true; } catch (e) { /* 重绘间隙 */ }
        await sleep(150);
      }
      return false;
    };
    const setOffline = async (offline) => {
      await send('Network.emulateNetworkConditions', {
        offline, latency: offline ? 0 : 20, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1
      });
    };
    /* 离线窗口登记：E2 断言「所有请求失败都必须落在预期的离线窗口内」。 */
    const offlineWindows = [];
    const beginOffline = async () => { const w = { from: Date.now(), to: Infinity }; offlineWindows.push(w); await setOffline(true); return w; };
    const endOffline = async (w) => { w.to = Date.now(); await setOffline(false); };
    /* 点击流水行打开编辑弹层。注意：同步事件会触发异步重渲染（容器先清空为「加载流水…」，
     * 异步重绘后行节点才回来）—— 此刻行可能短暂不存在，直接 click 会静默落空。
     * 故：等行就绪 + 允许重试，隔离测试自身的时序抖动。 */
    const openRowSheet = async (expId) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!(await waitFor(`!!document.querySelector('.led[data-exp="${expId}"]')`, 8000))) continue;
        await ev(`(()=>{const r=document.querySelector('.led[data-exp="${expId}"]'); if(r) r.click();})()`);
        if (await waitFor(`document.getElementById('expMask').classList.contains('open') && document.getElementById('e_title').textContent.indexOf('编辑') >= 0`, 4000)) return true;
        await sleep(250);
      }
      return false;
    };
    const addExpenseViaUI = async (amount, category, title) => {
      /* 同上：入口按钮也可能处于重渲染窗口，等它就绪再点（避免误点旧节点导致重复记账） */
      await waitFor(`document.getElementById('lgAdd') || document.getElementById('d_ledgerAdd')`, 8000);
      await ev(`(()=>{const b=document.getElementById('lgAdd')||document.getElementById('d_ledgerAdd'); if(b) b.click();})()`);
      if (!(await waitFor(`document.getElementById('expMask').classList.contains('open')`, 5000))) {
        await waitFor(`!!document.getElementById('d_ledgerAdd')`, 5000);
        await ev(`(()=>{const b=document.getElementById('d_ledgerAdd'); if(b) b.click();})()`);
        await waitFor(`document.getElementById('expMask').classList.contains('open')`, 5000);
      }
      await ev(`(()=>{const a=document.getElementById('e_amount');a.value='${amount}';a.dispatchEvent(new Event('input'));})()`);
      if (category) await ev(`document.querySelector('#e_cats [data-c="${category}"]').click()`);
      if (title) await ev(`(()=>{const t=document.getElementById('e_name');t.value=${JSON.stringify(title)};t.dispatchEvent(new Event('input'));})()`);
      await ev(`document.getElementById('e_save').click()`);
      await sleep(700);
    };
    /* 按 1080 宽（与 screenshots/ 既有规格一致）抓图到 .te_test/，供 README 使用 */
    const captureShot = async (name) => {
      await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(350);
      const cap = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ROOT, '.te_test', name), Buffer.from(cap.result.data, 'base64'));
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(200);
      console.log('  ℹ 截图：.te_test/' + name);
    };

    /* ---------- 打开应用并登录态注入 ---------- */
    await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' });
    await send('Page.navigate', { url: BASE + '/' });
    const booted = await waitFor(`document.querySelectorAll('.card').length > 0`, 15000);
    check('应用加载并渲染路线卡', booted, booted);
    check('离线引擎已初始化（IndexedDB 可用）', await ev(`!!(window.indexedDB)`));

    /* 打开详情 → 流水页签（先确保缓存写入） */
    await ev(`(()=>{const b=document.querySelector('.card [data-act="detail"]'); if(b) b.click();})()`);
    await waitFor(`document.getElementById('detailMask').classList.contains('open')`, 5000);
    await ev(`(()=>{const t=document.querySelector('#d_tabs [data-tab="ledger"]'); if(t) t.click();})()`);
    check('流水页签渲染出已有流水', await waitFor(`document.querySelectorAll('#d_body .led').length >= 1`, 8000));

    /* ---------- A. 在线直发 ---------- */
    section('A. 在线直发不经过队列');
    await addExpenseViaUI(200, '门票', '在线直发项');
    await sleep(600);
    check('A1 服务端变为 2 笔', (await api('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data.total === 2);
    check('A2 无待同步行', await ev(`document.querySelectorAll('#d_body .led.pending').length`) === 0);
    check('A3 顶部无离线提示条', await ev(`!document.getElementById('offlineBar').classList.contains('show')`));

    /* ---------- B. 断网记账 → 待同步 ---------- */
    section('B. 断网记账进入本地队列');
    const winB = await beginOffline();
    check('B1 浏览器已切离线', await ev(`navigator.onLine === false`));
    await waitFor(`document.getElementById('offlineBar').classList.contains('show')`, 5000);
    check('B2 顶部出现离线状态条', await ev(`document.getElementById('offlineBar').classList.contains('show')`));
    await addExpenseViaUI(333, '购物', '离线记录项');
    check('B3 出现虚线「待同步」行', await waitFor(`document.querySelectorAll('#d_body .led.pending').length >= 1`, 6000));
    check('B4 待同步行带胶囊标记', (await ev(`(document.querySelector('#d_body .led.pending')||{}).innerText || ''`)).includes('待同步'));
    check('B5 服务端仍为 2 笔（未误发）', (await api('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data.total === 2);
    check('B6 状态条显示待同步数量', (await ev(`document.getElementById('offlineBar').innerText`)).includes('待同步'));
    await ev(`(()=>{const b=document.getElementById('offlineAction'); if(b) b.click();})()`);
    check('B7 队列面板列出该笔', await waitFor(`document.querySelectorAll('#offlineQueueList .offline-queue-item').length >= 1`, 4000));
    await ev(`(()=>{const c=document.getElementById('offlineClose'); if(c) c.click();})()`);
    await sleep(300);
    await captureShot('shot-offline-pending.png');

    /* ---------- C. 恢复网络自动同步 ---------- */
    section('C. 恢复网络自动同步（恰好一次）');
    await endOffline(winB);
    const synced = await waitFor(`document.querySelectorAll('#d_body .led.pending').length === 0 && document.getElementById('offlineBar').classList.contains('show') === false`, 20000);
    check('C1 待同步行清零且状态条隐藏', synced, {
      pending: await ev(`document.querySelectorAll('#d_body .led.pending').length`),
      bar: await ev(`document.getElementById('offlineBar').classList.contains('show')`)
    });
    const after = (await api('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data;
    check('C2 服务端恰好 3 笔（不多不少）', after.total === 3, after.total);
    const offlineRow = (after.list || []).find(e => e.title === '离线记录项');
    check('C3 离线项已落库且金额/类目正确', !!offlineRow && offlineRow.amount === 333 && offlineRow.category === '购物', offlineRow && { a: offlineRow.amount, c: offlineRow.category });
    check('C4 离线项保留了付款人与分摊（未被误降级）', !!offlineRow && !!offlineRow.payer_id && (offlineRow.parts || []).length === 2, offlineRow && { p: offlineRow.payer_id, n: (offlineRow.parts || []).length });
    /* 队列为空：以 UI 为准（状态条已隐藏 + 面板显示空态），不依赖内部全局变量 */
    await ev(`(()=>{const b=document.getElementById('offlineAction'); if(b) b.click();})()`);
    const queueEmpty = await waitFor(`(document.getElementById('offlineQueueList')||{}).innerText && document.getElementById('offlineQueueList').innerText.includes('队列为空')`, 4000);
    check('C5 同步队列面板显示空态', queueEmpty, await ev(`(document.getElementById('offlineQueueList')||{}).innerText`));
    await ev(`(()=>{const c=document.getElementById('offlineClose'); if(c) c.click();})()`);

    /* ---------- D. 幂等：重复同步不产生重复流水 ---------- */
    section('D. 重复同步不产生重复数据');
    /* 重放必须使用与首次落库完全一致的载荷，才是真正的幂等验证；
     * 内容不一致时服务端返回 conflict 属于正确行为（另有 D3 断言）。 */
    const replayData = {
      category: offlineRow.category, amount: offlineRow.amount, spent_on: offlineRow.spent_on,
      title: offlineRow.title, note: offlineRow.note || '', payer_id: offlineRow.payer_id, parts: offlineRow.parts || []
    };
    const dupRes = await api('POST', `/api/routes/${routeId}/expenses/sync`, {
      ops: [{ op_id: 'o-dup-1', type: 'expense.create', client_id: offlineRow.id, data: replayData }]
    }, cookie);
    check('D1 同载荷重放判为 duplicate', dupRes.json.data.results[0].status === 'duplicate', dupRes.json.data.results[0]);
    check('D2 流水总数仍为 3', (await api('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data.total === 3);
    const conflictRes = await api('POST', `/api/routes/${routeId}/expenses/sync`, {
      ops: [{ op_id: 'o-dup-2', type: 'expense.create', client_id: offlineRow.id, data: { ...replayData, amount: 999 } }]
    }, cookie);
    check('D3 同 id 但内容不同判为 conflict（不覆盖已有记录）',
      conflictRes.json.data.results[0].status === 'conflict', conflictRes.json.data.results[0]);
    const afterConflict = (await api('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data;
    check('D4 conflict 未篡改原记录金额', (afterConflict.list || []).find(e => e.id === offlineRow.id).amount === 333);

    /* ---------- F. 离线编辑已同步流水（阶段 2） ---------- */
    section('F. 离线编辑 → 待同步 → 自动同步落地');
    const editId = offlineRow.id;
    const winF = await beginOffline();
    await waitFor(`document.getElementById('offlineBar').classList.contains('show')`, 5000);
    check('F0 编辑弹层已打开（编辑模式）', await openRowSheet(editId));
    await ev(`(()=>{const a=document.getElementById('e_amount');a.value='345';a.dispatchEvent(new Event('input'));})()`);
    await ev(`document.getElementById('e_save').click()`);
    await sleep(700);
    check('F1 离线编辑进入待同步（虚线行 + 本地值已生效）',
      await waitFor(`(()=>{const r=document.querySelector('.led.pending[data-exp="${editId}"]'); return !!r && r.innerText.indexOf('345')>=0;})()`, 8000));
    check('F2 服务端仍为旧值（离线未误发）',
      ((await api('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie)).json.data.list.find(e => e.id === editId) || {}).amount === 333);
    await endOffline(winF);
    check('F3 恢复网络后编辑自动同步、待同步标记消失',
      await waitFor(`!document.querySelector('.led.pending[data-exp="${editId}"]')`, 20000));
    const afterEdit = ((await api('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie)).json.data.list.find(e => e.id === editId) || {});
    check('F4 服务端金额更新为 345（恰好一次）', afterEdit.amount === 345, afterEdit.amount);

    /* ---------- G. 编辑冲突 → 二选一面板（阶段 2） ---------- */
    section('G. 编辑冲突与冲突处置面板');
    await api('PATCH', `/api/routes/${routeId}/expenses/${editId}`, { amount: 400 }, cookie);
    const winG = await beginOffline();
    await waitFor(`document.getElementById('offlineBar').classList.contains('show')`, 5000);
    await openRowSheet(editId);
    await ev(`(()=>{const a=document.getElementById('e_amount');a.value='460';a.dispatchEvent(new Event('input'));})()`);
    await ev(`document.getElementById('e_save').click()`);
    await sleep(700);
    await endOffline(winG);
    check('G1 同步返回冲突：行上出现「需处理」',
      await waitFor(`(()=>{const r=document.querySelector('.led[data-exp="${editId}"]'); return !!r && r.innerText.indexOf('需处理')>=0;})()`, 20000));
    await ev(`document.getElementById('offlineAction').click()`);
    check('G2 队列面板提供「保留本地 / 采用服务端」',
      await waitFor(`document.querySelectorAll('#offlineQueueList [data-keep]').length===1 && document.querySelectorAll('#offlineQueueList [data-adopt]').length===1`, 5000));
    await captureShot('shot-offline-conflict.png');
    await ev(`document.querySelector('#offlineQueueList [data-adopt]').click()`);
    check('G3 采用服务端后冲突项移除', await waitFor(`document.querySelectorAll('#offlineQueueList .offline-queue-item').length===0`, 5000));
    await ev(`document.getElementById('offlineClose').click()`);
    await sleep(700);
    const afterAdopt = ((await api('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie)).json.data.list.find(e => e.id === editId) || {});
    check('G4 服务端保留其版本（400），本地改动按选择被丢弃', afterAdopt.amount === 400, afterAdopt.amount);
    check('G5 界面回到服务端版本（显示 400 且不再「需处理」）',
      await waitFor(`(()=>{const r=document.querySelector('.led[data-exp="${editId}"]'); return !!r && r.innerText.indexOf('400')>=0 && r.innerText.indexOf('需处理')<0;})()`, 6000));

    /* ---------- E. 健壮性 ---------- */
    section('E. 健壮性');
    const errs = await ev(`window.__errs`);
    check('E1 全流程无未捕获 JS 错误', Array.isArray(errs) && errs.length === 0, errs);
    /* E2：所有请求级失败都必须落在预期的离线窗口内（±300ms 边界容差）——
     * 恢复网络后仍有失败即属回归（同步须「恰好一次」且干净）。 */
    const fetchErrs = await ev(`window.__fetchErrs.map(x => ({ t: x.t, url: x.url, msg: x.msg }))`) || [];
    const late = fetchErrs.filter(x => !offlineWindows.some(w => x.t >= w.from - 300 && x.t <= w.to + 300));
    check('E2 所有请求失败都发生在预期离线窗口内', late.length === 0, late);
    /* E3：离线期不得弹出「统计加载失败」类误导性网络提示（顶部离线条已表达状态，且文案含「检查证书」属误导） */
    const toasts = await ev(`window.__toastLog`) || [];
    const noise = toasts.filter(x => /统计加载失败/.test(x.m || ''));
    check('E3 离线期无「统计加载失败」噪音提示', noise.length === 0, noise);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, '.te_test');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'offline-e2e-final.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  ℹ 截图：.te_test/offline-e2e-final.png');
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    chrome.kill();
    server.kill();
    setTimeout(() => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }, 400);
  }

  console.log(`\n===== 离线端到端（真实浏览器）：${pass} 通过 / ${fail} 失败 =====`);
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(2); });
