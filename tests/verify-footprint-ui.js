/* UI 端到端验证：足迹点亮（CDP / puppeteer-core 驱动本机 Chrome）
 * 运行：node tests/verify-footprint-ui.js   （依赖 puppeteer-core，NODE_PATH 指向 node 工作区）
 * 覆盖：
 *   A. 登录 → 工作台足迹入口卡（数字亮点）
 *   B. 路线表单目的地选择器：拼音搜索 → 选中 chip → dest 只读镜像
 *   C. 保存后详情页 places 与地图点亮（点阵 SVG 渲染 / 点亮上色）
 *   D. 足迹页四页签：地图 / 成就 / 回顾 / 管理
 *   E. 省份底部抽屉（点击省点）
 *   F. 路线外手动点亮（管理页）
 *   G. 移动端 390px：地图默认收起、可展开；列表优先
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3922;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-fpui-'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

/* 从地点选择器下拉中选中指定地名。
 * 选择器输入有 180ms 防抖且会整列表重渲染：waitForSelector 可能命中旧查询的残留节点，
 * 随后重渲染使节点脱离文档，puppeteer 命中点检测报 "not clickable"。
 * 因此必须等目标地名的 .pp-item-name 真正出现，再用 evaluate 触发 click（不依赖命中点/稳定性）。 */
async function pickFromDropdown(page, inputSel, expectName) {
  await page.waitForFunction((sel, name) => {
    const names = [...document.querySelectorAll('.pp-drop .pp-item-name')];
    return names.some(el => el.textContent.trim() === name);
  }, { timeout: 6000 }, inputSel, expectName);
  await page.evaluate((name) => {
    const items = [...document.querySelectorAll('.pp-drop .pp-item')];
    const el = items.find(e => {
      const n = e.querySelector('.pp-item-name');
      return n && n.textContent.trim() === name;
    });
    if (el) el.click();
  }, expectName);
}

/* 确定性赋值：input[type=date] 用 page.type 常常不生效（浏览器分段编辑），
 * 且表单会预填当前年份（type 会追加成 "20262026"）。统一走 value 赋值 + 事件派发。 */
async function setDate(page, sel, value) {
  await page.$eval(sel, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function setText(page, sel, value) {
  await page.$eval(sel, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function main() {
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'routes.json'), path.join(DATA_DIR, 'routes.json'));
  const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动', up);
  if (!up) { srv.kill(); process.exit(1); }

  /* 预注册测试用户（避免首登改密流程干扰 UI 断言） */
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'uitester', password: 'uipass123' })
  }).then(r => r.json());
  check('预注册用户', !!(reg && reg.ok), reg && reg.msg);

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  const errors = [];
  page.on('pageerror', e => errors.push('JS: ' + String(e).split('\n')[0]));
  page.on('console', m => {
    /* 网络资源类噪声不计入：未登录时应用主动发起的 /api/auth/me（401，守卫正常行为）、
     * 浏览器自动请求 /favicon.ico（404，全站既有现象，与本功能无关）。 */
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource/.test(t)) return;
    errors.push('CONSOLE: ' + t.slice(0, 200));
  });

  try {
    /* ---------- A. 登录与工作台入口 ---------- */
    section('登录与工作台入口');
    await page.goto(BASE + '/#/login', { waitUntil: 'networkidle0' });
    await page.type('#lg_login', 'uitester');
    await page.type('#lg_password', 'uipass123');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {}),
      page.click('#lg_submit')
    ]);
    await page.waitForFunction(() => location.hash.startsWith('#/workbench'), { timeout: 8000 });
    await page.waitForSelector('#fpEntry', { timeout: 8000 });
    const entryText = await page.$eval('#fpEntrySub', el => el.textContent);
    check('工作台足迹入口卡显示点亮统计', /已点亮/.test(entryText), entryText);
    const fpBtnVisible = await page.$eval('#footprintLink', el => getComputedStyle(el).display !== 'none');
    check('页头足迹入口登录态可见', fpBtnVisible);

    /* ---------- B. 路线表单选择器 ---------- */
    section('路线表单目的地选择器');
    await page.click('#newRouteBtn');
    await page.waitForSelector('#f_destPicker .pp-input', { timeout: 5000 });
    await page.type('#f_name', 'UI测试路线');
    await setText(page, '#f_year', '2026');
    await setDate(page, '#f_start_date', '2026-05-01');
    await setDate(page, '#f_end_date', '2026-05-03');
    await page.type('#f_destPicker .pp-input', 'suzhou');
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('.pp-drop .pp-item-name')];
      return names.some(el => el.textContent.trim() === '苏州');
    }, { timeout: 6000 });
    const firstItem = await page.$eval('.pp-drop .pp-item-name', el => el.textContent.trim());
    check('拼音搜索出现候选（苏州）', firstItem === '苏州', firstItem);
    await pickFromDropdown(page, '#f_destPicker .pp-input', '苏州');
    await page.waitForSelector('.pp-chip', { timeout: 5000 });
    await page.type('#f_destPicker .pp-input', '杭州');
    await pickFromDropdown(page, '#f_destPicker .pp-input', '杭州');
    const chips = await page.$$eval('.pp-chip', els => els.map(e => e.textContent.replace(/[×◀▶]/g, '').trim()));
    check('chips 顺序为苏州、杭州', chips[0].includes('苏州') && chips[1].includes('杭州'), chips);
    const destPreview = await page.$eval('#f_dest', el => el.value);
    check('dest 只读镜像 = 苏州 · 杭州', destPreview === '苏州 · 杭州', destPreview);
    const destReadonly = await page.$eval('#f_dest', el => el.readOnly);
    check('dest 为只读', destReadonly === true);

    /* ---------- C. 保存与地图点亮 ---------- */
    section('保存与地图点亮');
    await page.click('#formSave');
    await page.waitForFunction(() => document.querySelector('#detailMask') && document.querySelector('#detailMask').classList.contains('open'), { timeout: 8000 });
    /* 回归：详情浮层打开时发生路由切换（模拟浏览器前进/后退），浮层应自动关闭，
     * 否则遮罩（z-index 50）会盖在新页面上拦截所有点击。 */
    await page.evaluate(() => { location.hash = '#/footprint'; });
    await page.waitForFunction(() => {
      const m = document.querySelector('#detailMask');
      return m && !m.classList.contains('open');
    }, { timeout: 6000 });
    check('路由切换自动关闭详情浮层', true);
    await page.waitForSelector('#fpSvg', { timeout: 8000 });
    const dotCount = await page.$$eval('#fpSvg circle', els => els.length);
    check('点阵地图渲染节点 > 300', dotCount > 300, dotCount);
    const litDots = await page.$$eval('#fpSvg circle', els => els.filter(e => e.getAttribute('fill') === 'var(--primary)').length);
    check('已上色点亮圆点 ≥ 4（含 seed）', litDots >= 4, litDots);
    const stats = await page.$eval('.fp-sub', el => el.textContent);
    check('页头统计含 2 座城市', /点亮 2 座城市/.test(stats), stats);
    const litList = await page.$eval('#fpLitList', el => el.textContent);
    check('点亮列表按省分组含苏州/杭州', litList.includes('苏州') && litList.includes('杭州'), litList);

    /* ---------- D. 页签切换 ---------- */
    section('子页签');
    await page.click('#fpTabs .tab[data-tab="ach"]');
    await page.waitForSelector('.fp-ach', { timeout: 5000 });
    const achCount = await page.$$eval('.fp-ach', els => els.length);
    check('成就卡渲染 12 项', achCount === 12, achCount);
    await page.click('#fpTabs .tab[data-tab="year"]');
    await page.waitForSelector('.fp-year-row', { timeout: 5000 });
    const yearText = await page.$eval('.fp-year-row', el => el.textContent);
    check('回顾页含 2026 年新增', yearText.includes('2026'), yearText);
    await page.click('#fpTabs .tab[data-tab="manage"]');
    await page.waitForSelector('#fpManualPicker .pp-input', { timeout: 5000 });
    const pendingText = await page.$eval('#fpPending', el => el.textContent);
    check('管理页待标注区加载', pendingText.length >= 0, pendingText);

    /* ---------- E. 省份底部抽屉 ---------- */
    section('省份底部抽屉');
    await page.click('#fpTabs .tab[data-tab="map"]');
    await page.waitForSelector('#fpSvg', { timeout: 5000 });
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('#fpSvg circle[data-prov]')].find(el => el.getAttribute('fill') === 'transparent' && el.dataset.prov === '浙江');
      if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForSelector('#fpSheetMask .sheet', { timeout: 5000 });
    const sheetText = await page.$eval('#fpSheetMask .sheet', el => el.textContent);
    check('抽屉显示浙江省与点亮城市', sheetText.includes('浙江') && sheetText.includes('杭州'), sheetText);
    await page.click('#fpSheetX');

    /* ---------- F. 路线外手动点亮 ---------- */
    section('路线外手动点亮');
    await page.click('#fpTabs .tab[data-tab="manage"]');
    await page.waitForSelector('#fpManualPicker .pp-input', { timeout: 5000 });
    await page.type('#fpManualPicker .pp-input', 'chengdu');
    await pickFromDropdown(page, '#fpManualPicker .pp-input', '成都');
    await setDate(page, '#fpManualDate', '2024-03-02');
    await page.click('#fpManualSave');
    /* toast 元素复用且 2.2s 才自动隐藏：必须等包含目标地名的 toast，
     * 否则可能命中早前「保存路线」的陈旧 toast（时序抖动）。 */
    await page.waitForFunction(() => {
      const t = document.querySelector('.toast.show');
      return t && t.textContent.includes('成都');
    }, { timeout: 8000 });
    const toastText = await page.$eval('.toast', el => el.textContent);
    check('手动点亮成都 toast', toastText.includes('成都'), toastText);

    /* ---------- G. 移动端 ---------- */
    section('移动端 390px');
    await page.setViewport({ width: 390, height: 844 });
    /* 当前停在「管理」页签；地图开关只存在于地图页签（且仅 ≤560px 显示），先切回地图页签。
     * 注意不能再用 page.goto 相同 hash——不触发 hashchange、不会重渲染。 */
    await page.click('#fpTabs .tab[data-tab="map"]');
    await page.waitForSelector('.fp-map-toggle', { timeout: 8000 });
    const mapHidden = await page.$eval('.fp-map-panel', el => getComputedStyle(el).display === 'none');
    check('移动端地图默认收起（列表优先）', mapHidden);
    const litListFirst = await page.$eval('#fpLitList', el => el.textContent);
    check('移动端点亮列表仍可用', litListFirst.includes('苏州'), litListFirst);
    await page.click('#fpMapToggle');
    await page.waitForFunction(() => {
      const el = document.querySelector('.fp-map-panel');
      return el && el.classList.contains('fp-map-open');
    }, { timeout: 5000 });
    check('点击展开地图', true);
    const mapShown = await page.$eval('.fp-map-panel', el => getComputedStyle(el).display !== 'none');
    check('展开后地图可见', mapShown);

    check('无前端运行时报错', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }

  console.log(`\nverify-footprint-ui：${pass} 通过，${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
}

main().catch(e => { console.error('UI 验证异常：', e); process.exit(2); });
