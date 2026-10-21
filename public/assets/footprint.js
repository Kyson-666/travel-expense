/* footprint.js — 足迹点亮（新一级模块 #/footprint）
 * 子页签：地图（点阵中国地图）/ 成就 / 回顾 / 管理。
 * 地图为手写 SVG 点阵：不绘制任何行政边界线，仅按官方经纬度放点（合规风险最低）；
 * 含台湾省、香港、澳门与南海诸岛附图（右下角）与钓鱼岛示意点。
 * 移动端：成就卡 + 点亮列表优先，地图默认收起为可展开卡片；点省弹底部抽屉。 */
import { store, toast, api, navigate, esc, reportClientError } from './api.js';
import { createPlacePicker } from './places-picker.js';
import { openRouteEditor } from './app.js';

const fp = { tab: 'map', mode: 'city', year: 'all', map: null, summary: null, mapOpen: false, animated: false, mapConfig: null, sdkMap: null };

/* 地图数据缓存：localStorage 持久缓存 + 服务端版本戳（点亮流水只增不删 → ver 乐观锁）。
 * 命中 ver → 服务端仅返回 notModified（省流量、秒开）；网络失败回退本地缓存（离线可看上次点亮）。 */
const MAP_CACHE_KEY = 'fp_map_cache_v1';
async function loadMapData() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(MAP_CACHE_KEY) || 'null'); } catch (e) { cached = null; }
  /* 缓存结构即扁平 {points, countries_lit, stats, ver}；完整性以 points 判定 */
  const cacheOk = !!(cached && Array.isArray(cached.points) && cached.points.length);
  try {
    const r = await api.get('/footprints/map' + (cacheOk && cached.ver ? '?ver=' + encodeURIComponent(cached.ver) : ''));
    if (r && r.notModified && cacheOk) return cached;
    const data = { points: r.points || [], countries_lit: r.countries_lit || [], stats: r.stats || {}, ver: r.ver || '' };
    if (!data.points.length && cacheOk) return cached; /* 异常空响应时宁用旧缓存 */
    try { localStorage.setItem(MAP_CACHE_KEY, JSON.stringify(data)); } catch (e) { /* 隐私模式/存储满忽略 */ }
    return data;
  } catch (e) {
    if (cacheOk) return cached;
    throw e;
  }
}

/* 底图增强配置：会话级缓存（管理员保存配置后，用户重新打开会话生效） */
async function loadMapConfig() {
  if (fp.mapConfig) return fp.mapConfig;
  try { fp.mapConfig = await api.get('/footprints/map-config'); }
  catch (e) { fp.mapConfig = { enabled: false, provider: 'none' }; }
  return fp.mapConfig;
}

function skeleton() {
  return `<div class="wrap"><div class="empty">足迹加载中…</div></div>`;
}

/* 点阵投影（线性等距）：覆盖经度 73–135.5、纬度 17.5–54.5 主图区 */
const PX = (lon) => (lon - 73) * 9.4 + 18;
const PY = (lat) => (54.8 - lat) * 11.8 + 8;
/* 南海诸岛附图投影（右下角矩形 x:556-674, y:388-462） */
const SX = (lon) => 560 + (lon - 105) * 7.5;
const SY = (lat) => 390 + (21 - lat) * 3.8;

const MUNI = new Set(['北京', '上海', '天津', '重庆', '香港', '澳门']);

export async function renderFootprint() {
  const view = document.getElementById('view');
  view.innerHTML = skeleton();
  try {
    const [map, summary, mapCfg] = await Promise.all([
      loadMapData(), api.get('/footprints/summary'), loadMapConfig()
    ]);
    fp.map = map; fp.summary = summary; fp.mapConfig = mapCfg;
  } catch (e) {
    view.innerHTML = `<div class="wrap"><div class="empty">足迹数据加载失败：${esc(e.message || '未知错误')}<br>
      <button class="btn btn-primary btn-sm" id="fpRetry" style="margin-top:10px">重试</button></div></div>`;
    const b = document.getElementById('fpRetry');
    if (b) b.onclick = renderFootprint;
    return;
  }
  fp.animated = false;
  render();
}

function render() {
  destroySdkMap();
  const s = fp.summary, m = fp.map;
  const view = document.getElementById('view');
  const tabs = [
    ['map', '地图'], ['ach', '成就'], ['recap', '年报'], ['year', '回顾'], ['manage', '管理']
  ];
  view.innerHTML = `<div class="wrap fp-wrap">
    <div class="fp-head">
      <div>
        <div class="fp-title">我的足迹</div>
        <div class="fp-sub">点亮 ${s.cityCount} 座城市 · ${s.provinceCount} 个省级行政区${s.countryCount ? ' · ' + s.countryCount + ' 个国家/地区' : ''}</div>
      </div>
      <button class="btn btn-line btn-sm" id="fpBack" title="返回路线列表">← 返回路线</button>
    </div>
    <div class="tabs" id="fpTabs">${tabs.map(([k, n]) =>
      `<div class="tab${fp.tab === k ? ' active' : ''}" data-tab="${k}">${n}</div>`).join('')}</div>
    <div id="fpBody"></div>
    <div class="fp-note">示意点阵图（不含行政边界线）。地名与坐标源自公开行政区划数据（GB/T 2260 · DataV.GeoAtlas），含台湾省、香港、澳门及南海诸岛附图。<br>
      口径：以「路线目的地选择 / 手动标记」为准，途经与否由你自行判断；<b>删除路线不熄灭已点亮记录</b>（成就只增不退）。</div>
  </div>`;

  view.querySelectorAll('#fpTabs .tab').forEach(t => t.onclick = () => { fp.tab = t.dataset.tab; render(); });
  const backBtn = document.getElementById('fpBack');
  if (backBtn) backBtn.onclick = () => navigate('/workbench');
  const body = document.getElementById('fpBody');
  if (fp.tab === 'map') renderMapTab(body);
  else if (fp.tab === 'ach') renderAchTab(body);
  else if (fp.tab === 'recap') renderRecapTab(body);
  else if (fp.tab === 'year') renderYearTab(body);
  else renderManageTab(body);
}

/* ---------- 年度旅行报告（点亮 × 花费 × 成就长图） ---------- */
async function renderRecapTab(body) {
  body.innerHTML = '<div class="empty">年报加载中…</div>';
  let years;
  try {
    const meta = await api.get('/footprints/recap');
    years = (meta && meta.available_years) || [];
  } catch (e) {
    body.innerHTML = `<div class="empty">年报加载失败：${esc(e.message || '未知错误')}</div>`;
    return;
  }
  if (!years.length) {
    body.innerHTML = '<div class="empty">还没有可回顾的数据 —— 记录路线并点亮目的地后，这里会生成你的年度旅行报告</div>';
    return;
  }
  fp.recapYear = fp.recapYear && years.includes(fp.recapYear) ? fp.recapYear : years[0];

  body.innerHTML = `<div class="chip-row" id="recapYears">
      ${years.map(y => `<button class="chip${fp.recapYear === y ? ' active' : ''}" data-year="${y}">${y}</button>`).join('')}
    </div>
    <div id="recapCardBox"></div>
    <div style="margin-top:10px"><button class="btn btn-primary btn-block" id="recapExport">生成分享长图（PNG）</button></div>
    <div class="fp-note">口径：花费为本位币换算合计（仅本人路线，协作账本归发起人统计）；点亮含「年度新增」与「累计」两层。</div>`;

  body.querySelectorAll('#recapYears .chip').forEach(c => c.onclick = () => { fp.recapYear = c.dataset.year; renderRecapTab(body); });
  await paintRecapCard(body);
  body.querySelector('#recapExport').onclick = exportRecapImage;
}

async function paintRecapCard(body) {
  const box = document.getElementById('recapCardBox');
  let d;
  try { d = await api.get('/footprints/recap?year=' + encodeURIComponent(fp.recapYear)); }
  catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const lit = d.lit || {}, trip = d.trip || {};
  const money = (v) => fmtCny(v, d.homeCurrency);
  const achHtml = (d.achievements || []).map(a => `<span class="chip fp-chip-lit">${esc(a.title)}</span>`).join('') || '<span class="fp-c-label">本年度暂无新成就</span>';
  const newCities = (lit.new_cities || []);
  box.innerHTML = `<div class="panel" id="recapCard">
    <div style="text-align:center;padding:14px 10px 12px;background:var(--primary);color:#fff;border-radius:12px;margin-bottom:12px">
      <div style="font-size:12px;opacity:.85">${esc(d.year)} · 我的旅行年报</div>
      <div style="font-size:20px;font-weight:500;margin-top:5px">点亮 ${lit.total_cities || 0} 城 · ${lit.total_provinces || 0} 省${lit.total_countries ? ' · ' + lit.total_countries + ' 国' : ''}</div>
    </div>
    <div class="stat-cards fp-stats">
      <div class="stat"><div class="v">${lit.new_count || 0}</div><div class="l">年度新增点亮</div></div>
      <div class="stat"><div class="v">${trip.count || 0}</div><div class="l">行程次数</div></div>
      <div class="stat"><div class="v">${trip.days || 0}</div><div class="l">在路上天数</div></div>
      <div class="stat"><div class="v">${money(trip.grand || 0)}</div><div class="l">年度总花费</div></div>
    </div>
    <div class="panel" style="margin-top:10px"><h3>年度亮点</h3>
      <div class="detail-row"><span class="k">最贵一笔</span><span class="v">${trip.top_expense ? esc(trip.top_expense.title) + ' · ' + money(trip.top_expense.value != null ? trip.top_expense.value : trip.top_expense.amount) : '—'}</span></div>
      <div class="detail-row"><span class="k">最长旅程</span><span class="v">${trip.longest && trip.longest.days ? esc(trip.longest.name) + '（' + trip.longest.days + ' 天）' : '—'}</span></div>
      <div class="detail-row"><span class="k">预算完成</span><span class="v">${trip.budget_within ? trip.budget_within.within + ' / ' + trip.budget_within.total + ' 次行程控制在预算内' : '—'}</span></div>
      ${newCities.length ? `<div class="detail-row"><span class="k">新点亮</span><span class="v">${newCities.map(esc).join(' · ')}</span></div>` : ''}
      ${(lit.new_countries || []).length ? `<div class="detail-row"><span class="k">新国家/地区</span><span class="v">${lit.new_countries.map(esc).join(' · ')}</span></div>` : ''}
    </div>
    <div class="panel" style="margin-top:10px"><h3>已获成就</h3><div class="chip-row">${achHtml}</div></div>
  </div>`;
}

/* 长图导出：与分享页同一份 html2canvas（CSP script-src 'self' 同源加载）。
 * 手机看图比例：离屏克隆卡片并固定 1080px 宽、放大字号、补底部落款，高度随内容自适应 ——
 * 避免直接截桌面面板得到「矮宽扁」的图。 */
async function exportRecapImage() {
  const el = document.getElementById('recapCard');
  if (!el) return;
  if (typeof window.html2canvas !== 'function') { toast('导出组件未就绪，请稍后重试'); return; }
  toast('正在生成长图…');
  /* 离屏容器：视口外 + 固定 1080 宽，clone 后按手机阅读放大字号与间距 */
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-99999px;top:0;width:1080px;background:#f4f8f6;padding:36px;z-index:-1';
  const clone = el.cloneNode(true);
  clone.style.cssText = 'width:100%;margin:0;background:#fff;border:1px solid #dcebe6;border-radius:24px;padding:36px;font-size:30px';
  clone.querySelectorAll('h3').forEach(h => { h.style.cssText = 'font-size:34px;margin:0 0 18px'; });
  clone.querySelectorAll('.detail-row').forEach(r => { r.style.cssText = 'display:flex;justify-content:space-between;gap:24px;padding:14px 0;font-size:30px;border-bottom:1px dashed #e3efeb'; });
  clone.querySelectorAll('.detail-row .k').forEach(k => { k.style.cssText = 'color:#6b7d79;flex:0 0 auto'; });
  clone.querySelectorAll('.detail-row .v').forEach(v => { v.style.cssText = 'text-align:right;word-break:break-all'; });
  clone.querySelectorAll('.stat-cards').forEach(sc => { sc.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin:0 0 18px'; });
  clone.querySelectorAll('.stat-cards .stat').forEach(st => { st.style.cssText = 'background:#f4f8f6;border-radius:16px;padding:20px;text-align:center'; });
  clone.querySelectorAll('.stat-cards .stat .v').forEach(v => { v.style.cssText = 'font-size:40px;font-weight:500'; });
  clone.querySelectorAll('.stat-cards .stat .l').forEach(l => { l.style.cssText = 'font-size:24px;color:#6b7d79;margin-top:6px'; });
  clone.querySelectorAll('.chip-row').forEach(cr => { cr.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px'; });
  clone.querySelectorAll('.chip').forEach(c => { c.style.cssText = 'font-size:26px;padding:8px 18px'; });
  const foot = document.createElement('div');
  foot.style.cssText = 'text-align:center;color:#9db4ae;font-size:22px;padding:26px 0 6px';
  foot.textContent = '由旅行经费工作台生成 · ' + fp.recapYear + ' 年度旅行报告';
  stage.appendChild(clone);
  stage.appendChild(foot);
  document.body.appendChild(stage);
  try {
    const canvas = await window.html2canvas(stage, { scale: 2, useCORS: true, backgroundColor: '#f4f8f6', logging: false });
    const link = document.createElement('a');
    link.download = '旅行年报_' + fp.recapYear + '_' + new Date().toISOString().slice(0, 10) + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast('长图已生成（1080 宽 · 手机阅读比例）');
  } catch (e) { toast('生成失败：' + (e.message || e)); }
  finally { stage.remove(); }
}

function fmtCny(v, cur) {
  const n = parseFloat(v);
  const val = isFinite(n) ? n : 0;
  return (cur || 'CNY') === 'CNY' ? '¥' + val.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : cur + ' ' + val.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/* ---------- 地图 ---------- */
function renderMapTab(body) {
  const m = fp.map, s = fp.summary;
  const years = s.years || [];
  body.innerHTML = `
    <div class="stat-cards fp-stats">
      <div class="stat"><div class="v">${s.cityCount}</div><div class="l">点亮城市</div></div>
      <div class="stat"><div class="v">${s.provinceCount}<span class="fp-unit">/34</span></div><div class="l">省级行政区</div></div>
      <div class="stat"><div class="v">${s.countryCount}</div><div class="l">国家/地区</div></div>
      <div class="stat"><div class="v">${years.length}</div><div class="l">走过年份</div></div>
    </div>
    <button class="btn btn-line btn-block fp-map-toggle" id="fpMapToggle">${fp.mapOpen ? '收起地图' : '展开点亮地图'}</button>
    <div class="panel fp-map-panel${fp.mapOpen ? ' fp-map-open' : ''}">
      <div class="fp-controls">
        <div class="chip-row" id="fpMode">
          <button class="chip${fp.mode === 'city' ? ' active' : ''}" data-mode="city">城市模式</button>
          <button class="chip${fp.mode === 'province' ? ' active' : ''}" data-mode="province">省级模式</button>
        </div>
        ${years.length ? `<div class="chip-row" id="fpYear">
          <button class="chip${fp.year === 'all' ? ' active' : ''}" data-year="all">全部</button>
          ${years.map(y => `<button class="chip${fp.year === y ? ' active' : ''}" data-year="${y}">${y}</button>`).join('')}
        </div>` : ''}
      </div>
      <div class="fp-map-wrap" id="fpMapHost"></div>
      ${s.countries.length ? `<div class="fp-countries"><span class="fp-c-label">🌍 国家/地区：</span>
        ${s.countries.map(c => `<span class="chip fp-chip-country">${esc(c.name)}${c.first_lit_on ? ' <i>' + esc(String(c.first_lit_on).slice(0, 4)) + '</i>' : ''}</span>`).join('')}</div>` : ''}
    </div>
    <div class="panel"><h3>点亮列表</h3><div id="fpLitList">${litListHtml()}</div></div>`;

  bindMapEvents(body);
  paintMapHost();
}

/* 地图宿主分流：管理员开启底图增强 → 真实底图渲染（失败自动降级点阵）；否则自绘点阵 */
function paintMapHost() {
  const host = document.getElementById('fpMapHost');
  if (!host) return;
  const cfg = fp.mapConfig;
  if (cfg && cfg.enabled && (cfg.provider === 'amap' || cfg.provider === 'tencent') && fp.mapOpen) {
    host.innerHTML = `<div id="fpSdkMap" style="height:430px;border-radius:10px;overflow:hidden;background:#e8eef0"></div>
      <div class="hint" style="margin-top:6px">底图由${cfg.provider === 'amap' ? '高德地图' : '腾讯地图'}提供（管理员已开启）；标记为示意点亮，不含行政边界。点击城市点查看详情。</div>`;
    renderSdkMap(document.getElementById('fpSdkMap'), cfg).catch(e => {
      /* 关键降级上报服务端日志（含 provider / key 尾号 / 安全码是否配置，便于远程排查） */
      reportClientError('error', 'sdk-map-load-failed: ' + (e && e.message ? e.message : e), e && e.stack, {
        provider: cfg.provider,
        key_tail: String(cfg.amap_key || cfg.tencent_key || '').slice(-4),
        security_set: !!cfg.amap_security,
        page: location.href.split('#')[0]
      });
      toast('底图加载失败，已降级为点阵示意');
      paintDotMap(host, e.message || String(e));
    });
  } else if (cfg && cfg.enabled && fp.mapOpen) {
    paintDotMap(host, '底图配置异常');
  } else {
    paintDotMap(host);
  }
}

function paintDotMap(host, sdkErr) {
  const warn = sdkErr
    ? `<div class="banner" style="margin-bottom:8px">⚠ 底图未能加载（${esc(sdkErr)}），已降级为点阵示意。
        常见原因：图商控制台未把本站域名加入该 Key 的域名白名单 / 服务器或浏览器无法访问图商。
        可到 管理后台 → 地图配置 重新测试。</div>`
    : '';
  host.innerHTML = warn + `<svg id="fpSvg" viewBox="0 0 680 470" role="img" aria-label="中国足迹点亮点阵地图（示意，不含边界线）"></svg>`;
  drawMap();
  bindDotMapClicks();
}

/* ---------- 底图增强（高德 / 腾讯 JS SDK） ----------
 * 坐标系：places_data 源自 DataV.GeoAtlas（GCJ-02），与高德/腾讯底图同系，无需转换。
 * 仅渲染点亮相关标记与省名标注（底图自身已有地理要素）；点击标记复用省份抽屉。 */
function loadSdkScript(provider, cfg) {
  if (provider === 'amap' && window.AMap) return Promise.resolve();
  if (provider === 'tencent' && window.TMap) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('SDK 加载超时')), 12000);
    s.onload = () => { clearTimeout(timer); (provider === 'amap' ? window.AMap : window.TMap) ? resolve() : reject(new Error('SDK 未就绪')); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('SDK 脚本加载失败（检查 Key / 域名白名单 / 网络）')); };
    if (provider === 'amap') {
      if (cfg.amap_security) window._AMapSecurityConfig = { securityJsCode: cfg.amap_security };
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cfg.amap_key);
    } else {
      s.src = 'https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(cfg.tencent_key);
    }
    document.head.appendChild(s);
  });
}

function destroySdkMap() {
  if (fp.sdkMap) { try { fp.sdkMap.destroy(); } catch (e) { /* ignore */ } fp.sdkMap = null; }
}

async function renderSdkMap(host, cfg) {
  destroySdkMap();
  await loadSdkScript(cfg.provider, cfg);
  const m = fp.map;
  const litPts = m.points.filter(p => p.lit && yearFiltered(p) && p.level === 'city');
  const litProvs = m.points.filter(p => p.lit && yearFiltered(p) && p.level === 'province');

  if (cfg.provider === 'amap') {
    const AMap = window.AMap;
    const map = new AMap.Map(host, { zoom: 4, center: [104.8, 36.6], viewMode: '2D', mapStyle: 'amap://styles/whitesmoke', zooms: [3.5, 12] });
    fp.sdkMap = map;
    /* 用 CircleMarker（圆点）而非 Marker：无图标依赖、不受默认 pin 影响，样式更统一 */
    litPts.forEach(p => {
      const c = new AMap.CircleMarker({ center: [p.lng, p.lat], radius: 5,
        fillColor: '#15a98c', fillOpacity: 0.95, strokeColor: '#ffffff', strokeWeight: 1.5, zIndex: 120, cursor: 'pointer', bubble: true });
      c.on('click', () => openProvSheet(p.province || p.name));
      map.add(c);
    });
    litProvs.forEach(p => {
      const c = new AMap.CircleMarker({ center: [p.lng, p.lat], radius: 8,
        fillColor: '#0f6e56', fillOpacity: 0.95, strokeColor: '#ffffff', strokeWeight: 1.5, zIndex: 130, cursor: 'pointer', bubble: true });
      c.on('click', () => openProvSheet(p.name));
      map.add(c);
    });
    /* 省名不额外标注：真实底图自带行政区名（仅点阵模式需要自绘省名） */
  } else {
    const TMap = window.TMap;
    const map = new TMap.Map(host, { zoom: 4, center: new TMap.LatLng(36.6, 104.8), baseMap: { type: 'vector' } });
    fp.sdkMap = map;
    const circles = [];
    litPts.forEach(p => circles.push({ id: 'c' + p.id, styleId: 'cityLit', center: new TMap.LatLng(p.lat, p.lng), radius: 5, properties: { prov: p.province || p.name } }));
    litProvs.forEach(p => circles.push({ id: 'p' + p.id, styleId: 'provLit', center: new TMap.LatLng(p.lat, p.lng), radius: 8, properties: { prov: p.name } }));
    const multiCircle = new TMap.MultiCircle({ map, styles: {
      cityLit: new TMap.CircleStyle({ color: 'rgba(21,169,140,0.95)', showBorder: true, borderColor: '#ffffff', borderWidth: 1.5 }),
      provLit: new TMap.CircleStyle({ color: 'rgba(15,110,86,0.95)', showBorder: true, borderColor: '#ffffff', borderWidth: 1.5 })
    }, geometries: circles });
    multiCircle.on('click', (evt) => {
      const prop = evt.geometry && evt.geometry.properties;
      if (prop && prop.prov) openProvSheet(prop.prov);
    });
  }
}

function litListHtml() {
  const m = fp.map;
  const lit = m.points.filter(p => p.lit && (fp.mode === 'province' ? p.level === 'province' || p.direct : true));
  const cities = m.points.filter(p => p.lit && (p.level === 'city' || MUNI.has(p.name)));
  const byProv = {};
  cities.forEach(c => { (byProv[c.province] || (byProv[c.province] = [])).push(c); });
  /* 省级点亮的直辖市/港澳直接列出；省级条目（如台湾）也归组 */
  MUNI.forEach(n => { const p = m.points.find(x => x.name === n && x.lit); if (p && !byProv[n]) byProv[n] = [p]; });
  const provs = Object.keys(byProv).sort((a, b) => byProv[b].length - byProv[a].length);
  if (!provs.length && !m.countries_lit.length) return '<div class="empty">还没有点亮任何地方 —— 编辑路线选择目的地，或在「管理」里手动标记</div>';
  return provs.map(pv => `<div class="fp-prov-group">
      <div class="fp-prov-name">${esc(pv)} <span class="fp-prov-count">${byProv[pv].length}</span></div>
      <div class="chip-row">${byProv[pv].map(c => `<span class="chip fp-chip-lit" data-prov="${esc(pv)}">${esc(c.name)}${c.on ? '<i>' + esc(c.on.slice(0, 4)) + '</i>' : ''}</span>`).join('')}</div>
    </div>`).join('') +
    (m.countries_lit.length ? `<div class="fp-prov-group"><div class="fp-prov-name">国家 / 地区 <span class="fp-prov-count">${m.countries_lit.length}</span></div>
      <div class="chip-row">${m.countries_lit.map(c => `<span class="chip fp-chip-country">${esc(c.name)}</span>`).join('')}</div></div>` : '');
}

function yearFiltered(p) {
  if (fp.year === 'all') return p.lit;
  return p.lit && String(p.on || '').slice(0, 4) === fp.year;
}

function drawMap() {
  const svg = document.getElementById('fpSvg');
  if (!svg) return;
  const m = fp.map;
  let out = '';
  const dotOff = '#d5e2de', dotOffProv = '#c8dcd6';

  /* 南海诸岛附图（含三沙） */
  out += `<rect x="556" y="386" width="118" height="76" rx="6" fill="#f7fbfa" stroke="#dbeae5"/>
    <text x="615" y="400" text-anchor="middle" font-size="10" fill="#6b7d79">南海诸岛</text>`;
  const sansha = m.points.find(p => p.name === '三沙');
  if (sansha) {
    const lit = yearFiltered(sansha);
    out += `<circle cx="${SX(sansha.lng).toFixed(1)}" cy="${SY(sansha.lat).toFixed(1)}" r="${lit ? 3.4 : 2.6}"
      fill="${lit ? 'var(--primary)' : dotOff}"/>
      <circle cx="${SX(sansha.lng).toFixed(1)}" cy="${SY(sansha.lat).toFixed(1)}" r="12" fill="transparent" style="cursor:pointer" data-prov="海南"/>`;
  }
  /* 曾母暗沙示意点（南界） */
  out += `<circle cx="${SX(112.3).toFixed(1)}" cy="${SY(3.9).toFixed(1)}" r="1.4" fill="#b8d4cc"/>`;

  /* 钓鱼岛、赤尾屿示意点（在主图台湾东北方向，不可交互、不作点亮统计） */
  out += `<circle cx="${PX(123.47).toFixed(1)}" cy="${PY(25.72).toFixed(1)}" r="2" fill="#9fc6bb"/>
          <circle cx="${PX(124.55).toFixed(1)}" cy="${PY(25.9).toFixed(1)}" r="1.5" fill="#9fc6bb"/>`;

  if (fp.mode === 'province') {
    for (const p of m.points.filter(x => x.level === 'province')) {
      const lit = yearFiltered(p);
      const r = MUNI.has(p.name) ? 5.6 : 4.6;
      if (lit && fp.animated === false && fp.year === 'all') {
        out += `<circle class="fp-pop" style="animation-delay:${(p.id % 12) * 60}ms" cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="${r}" fill="var(--primary)"/>`;
      } else {
        out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="${r}" fill="${lit ? 'var(--primary)' : dotOffProv}"/>`;
      }
      /* 省名标注（方案 C 可读性增强）：非直辖市在点旁标注，点亮省深色 */
      if (!MUNI.has(p.name) && p.name !== '台湾') {
        out += `<text x="${(PX(p.lng) + 8).toFixed(1)}" y="${(PY(p.lat) + 3).toFixed(1)}" font-size="8.5"
          fill="${lit ? 'var(--primary-d, #0f6e56)' : '#9db4ae'}" style="pointer-events:none">${esc(p.name)}</text>`;
      }
      out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="16" fill="transparent" style="cursor:pointer" data-prov="${esc(p.name)}"/>`;
    }
  } else {
    for (const p of m.points.filter(x => x.level === 'province')) {
      const lit = yearFiltered(p);
      out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="${MUNI.has(p.name) ? 4.8 : 4}" fill="${lit ? 'var(--primary)' : dotOffProv}"/>`;
      if (!MUNI.has(p.name) && p.name !== '台湾') {
        out += `<text x="${(PX(p.lng) + 7).toFixed(1)}" y="${(PY(p.lat) + 3).toFixed(1)}" font-size="8.5"
          fill="${lit ? 'var(--primary-d, #0f6e56)' : '#9db4ae'}" style="pointer-events:none">${esc(p.name)}</text>`;
      }
      out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="14" fill="transparent" style="cursor:pointer" data-prov="${esc(p.name)}"/>`;
    }
    let i = 0;
    for (const p of m.points.filter(x => x.level === 'city')) {
      const lit = yearFiltered(p);
      if (lit) {
        out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="6" fill="var(--primary)" opacity=".18"/>`;
        if (!fp.animated && fp.year === 'all') {
          out += `<circle class="fp-pop" style="animation-delay:${(i % 20) * 45}ms" cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="3" fill="var(--primary)"/>`;
        } else {
          out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="3" fill="var(--primary)"/>`;
        }
        i++;
      } else {
        out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="2.2" fill="${dotOff}"/>`;
      }
      out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="12" fill="transparent" style="cursor:${lit ? 'pointer' : 'default'}" data-prov="${esc(p.province)}"/>`;
    }
  }
  fp.animated = true;
  /* 图例（左上角）：点亮 / 未点亮 */
  out += `<g style="pointer-events:none">
    <rect x="20" y="18" width="92" height="34" rx="7" fill="#ffffff" opacity=".88" stroke="#dbeae5"/>
    <circle cx="33" cy="28" r="3.4" fill="var(--primary)"/><text x="42" y="31" font-size="9.5" fill="#1f2d2b">已点亮</text>
    <circle cx="33" cy="42" r="2.6" fill="${dotOff}"/><text x="42" y="45" font-size="9.5" fill="#9db4ae">未点亮</text>
  </g>`;
  svg.innerHTML = out;
}

function bindMapEvents(body) {
  body.querySelectorAll('#fpMode .chip').forEach(b => b.onclick = () => { fp.mode = b.dataset.mode; render(); });
  body.querySelectorAll('#fpYear .chip').forEach(b => b.onclick = () => { fp.year = b.dataset.year; render(); });
  body.querySelectorAll('#fpLitList .fp-chip-lit').forEach(el => el.onclick = () => openProvSheet(el.dataset.prov));
  const toggle = document.getElementById('fpMapToggle');
  if (toggle) toggle.onclick = () => {
    fp.mapOpen = !fp.mapOpen;
    toggle.textContent = fp.mapOpen ? '收起地图' : '展开点亮地图';
    document.querySelector('.fp-map-panel').classList.toggle('fp-map-open', fp.mapOpen);
    if (fp.mapOpen) document.querySelector('.fp-map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    /* 收起时销毁 SDK 实例（释放底图资源）；展开时 paintMapHost 重新初始化 */
    if (!fp.mapOpen) { destroySdkMap(); paintMapHost(); }
    else paintMapHost();
  };
}

/* 点阵图点击绑定（独立函数：降级路径与首次绘制共用） */
function bindDotMapClicks() {
  const svg = document.getElementById('fpSvg');
  if (!svg) return;
  svg.querySelectorAll('circle[data-prov]').forEach(c => {
    if (c.getAttribute('fill') !== 'transparent') return;
    c.onclick = () => openProvSheet(c.dataset.prov);
  });
}

/* 省份底部抽屉：省内已点亮城市 + 首次点亮年份 */
function openProvSheet(prov) {
  const m = fp.map;
  const cities = m.points.filter(p => (p.province === prov || p.name === prov) &&
    p.lit && (p.level === 'city' || MUNI.has(p.name) || p.name === prov));
  const litCities = cities.filter(p => p.name !== prov || MUNI.has(p.name) || p.level === 'province');
  const mask = document.createElement('div');
  mask.className = 'mask open';
  mask.id = 'fpSheetMask';
  mask.innerHTML = `<div class="sheet">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
    ${esc(prov)}<button class="close-x" id="fpSheetX">×</button></h2>
    ${litCities.length ? `<div class="fp-sheet-count">已点亮 ${litCities.length} 处</div>
      <div class="chip-row">${litCities.map(c => `<span class="chip fp-chip-lit">${esc(c.name)}${c.on ? '<i>' + esc(c.on.slice(0, 4)) + '</i>' : ''}</span>`).join('')}</div>`
      : '<div class="empty">该省暂无点亮记录，编辑路线时选择这里的目的地即可点亮</div>'}
    <div class="caliber">点亮年份为首次到达年份；删除路线不熄灭记录。</div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('#fpSheetX').onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', function esc2(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); } });
}

/* ---------- 成就 ---------- */
function renderAchTab(body) {
  const list = fp.summary.achievements || [];
  const done = list.filter(a => a.done).length;
  body.innerHTML = `
    <div class="panel fp-ach-head"><div class="fp-ach-big">🏆 已解锁 ${done} / ${list.length} 项成就</div></div>
    <div class="fp-ach-grid">
      ${list.map(a => `
        <div class="card fp-ach${a.done ? ' fp-ach-done' : ''}">
          <div class="fp-ach-title">${a.done ? '🏅' : '🔒'} ${esc(a.title)}</div>
          <div class="fp-ach-desc">${esc(a.desc)}</div>
          ${!a.done ? `<div class="budget-bar"><span style="width:${a.target ? Math.min(100, Math.round(a.progress / a.target * 100)) : 0}%;background:var(--primary)"></span></div>
          <div class="budget-txt">${a.progress} / ${a.target}</div>` : ''}
        </div>`).join('')}
    </div>`;
}

/* ---------- 回顾 ---------- */
function renderYearTab(body) {
  const yearly = (fp.summary.yearly || []).slice().reverse();
  if (!yearly.length) {
    body.innerHTML = '<div class="panel"><div class="empty">暂无年度记录，点亮第一座城市后这里会出现你的旅行年历</div></div>';
    return;
  }
  const max = Math.max(...yearly.map(y => y.new_count), 1);
  body.innerHTML = `<div class="panel"><h3>年度新增点亮</h3>
    ${yearly.map(y => `
      <div class="fp-year-row">
        <div class="fp-year-head"><b>${esc(y.year)}</b><span class="fp-year-n">+${y.new_count}</span></div>
        <div class="budget-bar"><span style="width:${Math.round(y.new_count / max * 100)}%;background:var(--primary)"></span></div>
        <div class="fp-year-detail">
          ${y.new_cities.length ? `<div class="chip-row">${y.new_cities.map(c => `<span class="chip fp-chip-lit">${esc(c)}</span>`).join('')}</div>` : ''}
          ${y.provinces.length ? `<div class="fp-year-prov">省级行政区：${esc(y.provinces.join('、'))}</div>` : ''}
          ${y.countries.length ? `<div class="fp-year-prov">国家/地区：${esc(y.countries.join('、'))}</div>` : ''}
        </div>
      </div>`).join('')}
  </div>`;
}

/* ---------- 管理 ---------- */
function renderManageTab(body) {
  body.innerHTML = `
    <div class="panel">
      <h3>路线外点亮</h3>
      <div class="hint" style="margin-bottom:10px">出差、路过、探亲等不建路线的到访，可以手动点亮。点亮记录只增不删。</div>
      <div id="fpManualPicker"></div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>到访日期 <span class="hint">用于年度回顾</span></label><input type="date" id="fpManualDate"></div>
        <div class="field" style="align-self:end"><button class="btn btn-primary" id="fpManualSave" style="width:100%">点亮</button></div>
      </div>
    </div>
    <div class="panel">
      <h3>待标注目的地</h3>
      <div class="hint" style="margin-bottom:10px">以下路线尚未选择标准地名（升级前的旧目的地文本已按计划清空），点击去补选后即可点亮地图。</div>
      <div id="fpPending"><div class="empty">加载中…</div></div>
    </div>`;

  let picked = null;
  const picker = createPlacePicker(document.getElementById('fpManualPicker'), {
    single: true, max: 1, placeholder: '搜索要点亮的地名（如：成都 / chengdu / cd）',
    onChange: (list) => { picked = list[0] || null; }
  });
  document.getElementById('fpManualSave').onclick = async () => {
    if (!picked) { toast('请先搜索并选择地名'); return; }
    const date = document.getElementById('fpManualDate').value;
    try {
      const r = await api.post('/footprints/manual', { place: picked.adcode, date });
      toast(r.already ? `「${r.place.name}」此前已点亮` : `已点亮「${r.place.name}」`);
      picker.setSelection([]);
      picked = null;
      const [map, summary] = await Promise.all([api.get('/footprints/map'), api.get('/footprints/summary')]);
      fp.map = map; fp.summary = summary;
    } catch (e) { toast(e.message || '点亮失败'); }
  };

  api.get('/footprints/pending').then(r => {
    const box = document.getElementById('fpPending');
    const list = (r && r.list) || [];
    if (!list.length) { box.innerHTML = '<div class="empty">全部路线都已标注目的地 🎉</div>'; return; }
    box.innerHTML = list.map(t => `
      <div class="fp-pending-row">
        <div class="fp-pending-main"><b>${esc(t.name)}</b><span class="fp-pending-meta">${esc(t.year || '')}${t.daterange ? ' · ' + esc(t.daterange) : ''}</span></div>
        <button class="btn btn-sm btn-primary" data-id="${esc(t.id)}">去标注</button>
      </div>`).join('');
    box.querySelectorAll('button[data-id]').forEach(b => b.onclick = () => {
      const ok = openRouteEditor(b.dataset.id);
      if (ok) navigate('/workbench');
    });
  }).catch(e => {
    document.getElementById('fpPending').innerHTML = `<div class="empty">${esc(e.message || '加载失败')}</div>`;
  });
}
