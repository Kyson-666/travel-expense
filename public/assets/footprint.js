/* footprint.js — 足迹点亮（新一级模块 #/footprint）
 * 子页签：地图（点阵中国地图）/ 成就 / 回顾 / 管理。
 * 地图为手写 SVG 点阵：不绘制任何行政边界线，仅按官方经纬度放点（合规风险最低）；
 * 含台湾省、香港、澳门与南海诸岛附图（右下角）与钓鱼岛示意点。
 * 移动端：成就卡 + 点亮列表优先，地图默认收起为可展开卡片；点省弹底部抽屉。 */
import { store, toast, api, navigate, esc } from './api.js';
import { createPlacePicker } from './places-picker.js';
import { openRouteEditor } from './app.js';

const fp = { tab: 'map', mode: 'city', year: 'all', map: null, summary: null, mapOpen: false, animated: false };

/* 点阵投影（线性等距）：覆盖经度 73–135.5、纬度 17.5–54.5 主图区 */
const PX = (lon) => (lon - 73) * 9.4 + 18;
const PY = (lat) => (54.8 - lat) * 11.8 + 8;
/* 南海诸岛附图投影（右下角矩形 x:556-674, y:388-462） */
const SX = (lon) => 560 + (lon - 105) * 7.5;
const SY = (lat) => 390 + (21 - lat) * 3.8;

const MUNI = new Set(['北京', '上海', '天津', '重庆', '香港', '澳门']);

function skeleton() {
  return `<div class="wrap"><div class="empty">足迹加载中…</div></div>`;
}

export async function renderFootprint() {
  const view = document.getElementById('view');
  view.innerHTML = skeleton();
  try {
    const [map, summary] = await Promise.all([api.get('/footprints/map'), api.get('/footprints/summary')]);
    fp.map = map; fp.summary = summary;
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
  const s = fp.summary, m = fp.map;
  const view = document.getElementById('view');
  const tabs = [
    ['map', '地图'], ['ach', '成就'], ['year', '回顾'], ['manage', '管理']
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
  else if (fp.tab === 'year') renderYearTab(body);
  else renderManageTab(body);
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
      <div class="fp-map-wrap"><svg id="fpSvg" viewBox="0 0 680 470" role="img" aria-label="中国足迹点亮点阵地图（示意，不含边界线）"></svg></div>
      ${s.countries.length ? `<div class="fp-countries"><span class="fp-c-label">🌍 国家/地区：</span>
        ${s.countries.map(c => `<span class="chip fp-chip-country">${esc(c.name)}${c.first_lit_on ? ' <i>' + esc(String(c.first_lit_on).slice(0, 4)) + '</i>' : ''}</span>`).join('')}</div>` : ''}
    </div>
    <div class="panel"><h3>点亮列表</h3><div id="fpLitList">${litListHtml()}</div></div>`;

  drawMap();
  bindMapEvents(body);
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
      out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="16" fill="transparent" style="cursor:pointer" data-prov="${esc(p.name)}"/>`;
    }
  } else {
    for (const p of m.points.filter(x => x.level === 'province')) {
      const lit = yearFiltered(p);
      out += `<circle cx="${PX(p.lng).toFixed(1)}" cy="${PY(p.lat).toFixed(1)}" r="${MUNI.has(p.name) ? 4.8 : 4}" fill="${lit ? 'var(--primary)' : dotOffProv}"/>`;
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
  svg.innerHTML = out;
}

function bindMapEvents(body) {
  const svg = document.getElementById('fpSvg');
  svg.querySelectorAll('circle[data-prov]').forEach(c => {
    if (c.getAttribute('fill') !== 'transparent') return;
    c.onclick = () => openProvSheet(c.dataset.prov);
  });
  body.querySelectorAll('#fpMode .chip').forEach(b => b.onclick = () => { fp.mode = b.dataset.mode; render(); });
  body.querySelectorAll('#fpYear .chip').forEach(b => b.onclick = () => { fp.year = b.dataset.year; render(); });
  body.querySelectorAll('#fpLitList .fp-chip-lit').forEach(el => el.onclick = () => openProvSheet(el.dataset.prov));
  const toggle = document.getElementById('fpMapToggle');
  if (toggle) toggle.onclick = () => {
    fp.mapOpen = !fp.mapOpen;
    toggle.textContent = fp.mapOpen ? '收起地图' : '展开点亮地图';
    document.querySelector('.fp-map-panel').classList.toggle('fp-map-open', fp.mapOpen);
    if (fp.mapOpen) document.querySelector('.fp-map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
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
