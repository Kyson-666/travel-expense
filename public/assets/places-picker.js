/* places-picker.js — 标准地名多选选择器（足迹点亮 · 路线表单）
 * 交互：搜索框（汉字模糊 + 拼音/首字母前缀，市优先）→ 下拉候选 → 选中成 chip；
 * chips 仅支持移除（先选的排前面，即 dest 展示顺序；不提供排序按钮，保持行内紧凑），
 * 上限 20。选中值以 adcode 为准（稳定 ID），展示名带省份前缀消歧（如「朝阳（辽宁）」）。
 * createPlacePicker(container, opts) → { getSelection, setSelection, destroy } */
import { api, toast, esc } from './api.js';

const MAX_PLACES = 20;

function placeLabel(p) {
  if (!p) return '';
  /* 城市 → 「名称」+ 省份前缀消歧；省级/国家直接展示简名 */
  if (p.level === 'city' && p.province && p.province !== p.name) {
    const same = p.province.includes(p.name);
    return same ? p.name : `${p.name}（${p.province}）`;
  }
  return p.name;
}

function levelTag(p) {
  if (p.level === 'country') return '国家/地区';
  if (p.level === 'province') return '省级行政区';
  return (p.province || '') + ' · 城市';
}

export function createPlacePicker(container, opts = {}) {
  const max = opts.max || MAX_PLACES;
  const single = !!opts.single;
  let selected = [];          // [{adcode,name,province,country,level}]
  let searchTimer = null;
  let destroyed = false;

  container.classList.add('pp');
  container.innerHTML = `
    ${single ? '' : '<div class="pp-chips" role="list"></div>'}
    <div class="pp-box">
      <input class="pp-input" type="text" placeholder="${esc(opts.placeholder || '搜索地名（汉字 / 拼音 / 首字母）')}"
             autocomplete="off" inputmode="search" aria-label="搜索标准地名">
      <div class="pp-drop" style="display:none" role="listbox"></div>
    </div>`;

  const chipsEl = container.querySelector('.pp-chips');
  const input = container.querySelector('.pp-input');
  const drop = container.querySelector('.pp-drop');

  function emit() {
    if (opts.onChange) opts.onChange(selected.slice());
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = selected.map((p, i) => `
      <span class="pp-chip${p.level === 'province' ? ' pp-chip-prov' : (p.level === 'country' ? ' pp-chip-country' : '')}" role="listitem">
        ${esc(placeLabel(p))}
        <button type="button" class="pp-x" data-i="${i}" title="移除" aria-label="移除 ${esc(p.name)}">×</button>
      </span>`).join('');
    chipsEl.querySelectorAll('.pp-x').forEach(b => b.onclick = () => {
      selected.splice(+b.dataset.i, 1); renderChips(); emit();
    });
  }

  function renderDrop(list) {
    if (!list.length) {
      drop.innerHTML = '<div class="pp-empty">未找到匹配的标准地名，试试城市名或拼音</div>';
      drop.style.display = 'block';
      return;
    }
    drop.innerHTML = list.map((p, i) => `
      <button type="button" class="pp-item" data-i="${i}" role="option">
        <span class="pp-item-name">${esc(p.name)}</span>
        <span class="pp-item-meta">${esc(levelTag(p))}${p.level === 'city' ? '' : ''}</span>
      </button>`).join('');
    drop.style.display = 'block';
    drop.querySelectorAll('.pp-item').forEach(b => b.onclick = () => add(list[+b.dataset.i]));
  }

  function add(p) {
    if (!p) return;
    if (selected.some(x => x.adcode === p.adcode)) { drop.style.display = 'none'; return; }
    if (selected.length >= max) { toast(`目的地最多 ${max} 个`); return; }
    selected.push({ adcode: p.adcode, name: p.name, province: p.province, country: p.country, level: p.level });
    input.value = '';
    drop.style.display = 'none';
    renderChips();
    emit();
    if (single) input.blur();
  }

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { drop.style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await api.get('/footprints/places?q=' + encodeURIComponent(q) + '&limit=' + (single ? 8 : 15));
        renderDrop((r && r.list) || []);
      } catch (e) { /* 静默：输入中频繁请求，失败不打断输入 */ }
    }, 180);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) input.dispatchEvent(new Event('input')); });
  container.addEventListener('click', (e) => { if (!e.target.closest('.pp-box')) drop.style.display = 'none'; });
  document.addEventListener('click', onDocClick);
  function onDocClick(e) { if (destroyed && !document.contains(container)) { document.removeEventListener('click', onDocClick); return; } if (!container.contains(e.target)) drop.style.display = 'none'; }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { drop.style.display = 'none'; input.blur(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = drop.querySelector('.pp-item');
      if (first && drop.style.display !== 'none') first.click();
    }
  });

  renderChips();
  return {
    getSelection: () => selected.slice(),
    setSelection(list) {
      selected = (Array.isArray(list) ? list : []).slice(0, max).map(p => ({
        adcode: p.adcode, name: p.name, province: p.province, country: p.country, level: p.level
      }));
      renderChips();
      emit();
    },
    destroy() { destroyed = true; container.innerHTML = ''; }
  };
}

/* 由选中列表生成镜像文本（与后端 recomputeDestMirror 同口径：简名以「 · 」连接） */
export function placesText(list) {
  return (Array.isArray(list) ? list : []).map(p => p.name).join(' · ');
}
