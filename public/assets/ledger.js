/* ledger.js — 逐笔消费流水 + AA 分账（前端）
 *
 * 职责边界：本模块只负责「某条路线」的流水与结算 UI，
 * 通过参数接收 route 对象与 onChanged 回调，不持有全局路由状态，
 * 因此可被 app.js 的路线详情弹层直接调用。
 *
 * 与后端的分工：
 *   · 9 类花费（routes.exp_*）由服务端按流水自动汇总，前端不再手工提交
 *   · 存在后端的金额一律为**路线币种**金额，前端不做换算
 */
import { api, store, toast, esc, fmt, fmtMoney, curSymbol, CATS, isNetworkError } from './api.js';
import { COLORS, totalOf } from './charts.js';
import { getOfflineEngine, createClientId } from './offline.js';

/* 同行人头像配色（唯一来源）：与 9 类花费配色（charts.COLORS）语义不同，独立维护 */
const TV_COLORS = ['#60a5fa', '#3b82f6', '#06b6d4', '#f59e0b', '#ef6b5e', '#a78bfa', '#ec4899', '#fb923c', '#94a3b8'];
const QUICK_AMOUNTS = [50, 100, 200, 500, 1000];

const st = {
  route: null,          /* 当前路线 */
  list: [],             /* 当前流水列表（服务端筛选后） */
  summary: null,        /* 列表汇总 {total, amount, byCategory} */
  travelers: [],        /* 当前路线的同行人名单（每次进入页签强制按路线重载，防跨路线串线） */
  tvReadOnly: false,    /* 示例路线对普通用户只读（隐藏添加/改名/标记/移除） */
  catFilter: '全部',
  editingId: null,      /* 正在编辑的流水 id（null=新增） */
  draft: null,          /* 记一笔草稿 */
  onChanged: null       /* 流水变化后的回调（刷新卡片/统计/详情页签） */
};
let watchedOffline = null;
let syncRefreshTimer = null;

function watchOfflineSync() {
  const offline = getOfflineEngine();
  if (!offline || watchedOffline === offline) return;
  watchedOffline = offline;
  const refresh = (detail) => {
    const rid = detail && (detail.route_id || (detail.op && detail.op.route_id));
    if (!st.route || String(st.route.id) !== String(rid)) return;
    clearTimeout(syncRefreshTimer);
    syncRefreshTimer = setTimeout(() => {
      if (typeof st.onChanged === 'function') st.onChanged();
    }, 250);
  };
  /* synced：本地操作已落库；failed/conflict：行上要显示「需处理/冲突」标记；
   * cache-updated：增量补拉合并了其他端的变更。 */
  offline.on('synced', refresh);
  offline.on('failed', refresh);
  offline.on('conflict', refresh);
  offline.on('resolved', refresh);
  offline.on('cache-updated', refresh);
}

/* ---------- 小工具 ---------- */
function maskOpen(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
function maskClose(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
function tvColor(t) {
  const i = Math.max(0, st.travelers.findIndex(x => x.id === (t && t.id ? t.id : t)));
  return TV_COLORS[(i < 0 ? 0 : i) % TV_COLORS.length];
}
function initial(name) { return String(name || '?').replace(/^我（|）$/g, '').slice(0, 1); }
function findTraveler(id) { return st.travelers.find(t => t.id === id) || null; }

/* 人均分母：优先同行人名单，名单为空回退路线登记人数 */
function headcount() {
  if (st.travelers.length) return st.travelers.length;
  return parseInt(st.route && st.route.people, 10) || 0;
}

/* ---------- 数据加载 ---------- */
async function loadTravelers(route) {
  const offline = getOfflineEngine();
  try {
    const r = await api.get('/routes/' + encodeURIComponent(route.id) + '/travelers');
    st.travelers = (r && r.list) || [];
    if (offline) await offline.setMeta('travelers:' + route.id, st.travelers);
    return st.travelers;
  } catch (e) {
    if (offline && isNetworkError(e)) {
      st.travelers = (await offline.getMeta('travelers:' + route.id)) || [];
      if (st.travelers.length || route.is_seed) return st.travelers;
    }
    throw e;
  }
}

async function loadExpenses(route, catFilter) {
  const offline = getOfflineEngine();
  const p = new URLSearchParams();
  /* 本地缓存必须保存完整列表；类目筛选在投影后本地执行，避免缓存被筛选响应覆盖。 */
  p.set('pageSize', '500');
  const qs = p.toString();
  let r;
  try {
    const base = '/routes/' + encodeURIComponent(route.id) + '/expenses';
    r = await api.get(base + '?' + qs + '&page=1');
    const all = (r && r.list) ? r.list.slice() : [];
    const total = Number(r && r.total) || all.length;
    let page = 2;
    while (all.length < total) {
      const next = await api.get(base + '?' + qs + '&page=' + page++);
      const rows = (next && next.list) || [];
      if (!rows.length) break;
      all.push(...rows);
    }
    r = { ...r, list: all, total: all.length };
    if (offline) await offline.saveExpensesCache(route.id, r);
  } catch (e) {
    if (!offline || !isNetworkError(e)) throw e;
    r = await offline.getExpensesCache(route.id);
    if (!r) throw new Error('该路线尚无本地缓存。请先联网打开一次流水页，再使用离线记账。');
  }
  const projected = offline ? await offline.project(route.id, r.list || []) : (r.list || []);
  const cat = catFilter === undefined ? st.catFilter : catFilter;
  st.list = cat && cat !== '全部' ? projected.filter(x => x.category === cat) : projected;
  if (offline) {
    const routeExp = {};
    for (const item of projected) routeExp[item.category] = (routeExp[item.category] || 0) + (Number(item.amount) || 0);
    st.route.exp = routeExp;
  }
  if (cat && cat !== '全部') {
    const amount = st.list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    st.summary = { total: st.list.length, amount, byCategory: { [cat]: amount }, cached: !!r.fetched_at && !navigator.onLine };
  } else {
    const queue = offline ? await offline.listQueue(route.id) : [];
    const added = queue.filter(x => x.type === 'expense.create').reduce((s, x) => s + (Number(x.payload.amount) || 0), 0);
    const removed = queue.filter(x => x.type === 'expense.delete').reduce((s, x) => s + (Number(x.payload.amount) || 0), 0);
    const byCategory = { ...(r.byCategory || {}) };
    queue.filter(x => x.type === 'expense.create').forEach(x => { byCategory[x.payload.category] = (byCategory[x.payload.category] || 0) + (Number(x.payload.amount) || 0); });
    queue.filter(x => x.type === 'expense.delete').forEach(x => { byCategory[x.payload.category] = Math.max(0, (byCategory[x.payload.category] || 0) - (Number(x.payload.amount) || 0)); });
    st.summary = { total: Math.max(0, Number(r.total || 0) + queue.filter(x => x.type === 'expense.create').length - queue.filter(x => x.type === 'expense.delete').length), amount: Math.max(0, Number(r.amount || 0) + added - removed), byCategory, cached: !!r.fetched_at && !navigator.onLine };
  }
  return st;
}

/* ---------- 流水页签 ---------- */
export async function renderLedgerTab(container, route, onChanged) {
  st.route = route;
  st.onChanged = onChanged || null;
  watchOfflineSync();
  container.innerHTML = '<div class="empty">加载流水…</div>';
  try {
    /* 必须按当前路线强制加载同行人：名单是模块级状态，条件加载会导致跨路线串线 */
    await loadTravelers(route);
    await loadExpenses(route);
  } catch (e) {
    container.innerHTML = '<div class="empty">流水加载失败：' + esc(e.message) + '</div>';
    return;
  }
  paintLedger(container);
}

function paintLedger(container) {
  const route = st.route;
  const cur = route.currency || 'CNY';
  const total = st.summary ? st.summary.amount : 0;
  const n = st.summary ? st.summary.total : 0;
  const hc = headcount();

  /* 类目筛选胶囊：仅列出实际用到的类目，减少噪音 */
  const used = CATS.filter(c => st.list.some(e => e.category === c));
  let h = '';
  h += `<div class="toolbar" style="margin:0 0 10px">
    <div class="chip-row grow">
      ${['全部'].concat(used).map(c => `<div class="chip${st.catFilter === c ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</div>`).join('')}
    </div>
    <button class="btn btn-sm" id="lgTravelers">同行人（${st.travelers.length}）</button>
    <button class="btn btn-primary" id="lgAdd"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>记一笔</button>
  </div>`;

  h += `<div class="panel" style="box-shadow:none;padding:12px;margin-bottom:12px">
    <div class="kv"><span class="k">${st.catFilter === '全部' ? '全部流水' : st.catFilter + '（筛选）'}</span><span class="v">${n} 笔 · ${fmtMoney(total, cur)}</span></div>
    <div class="kv"><span class="k">路线总花费 / 人均</span><span class="v">${fmtMoney(totalOf(route), cur)}${hc > 0 ? ' · 人均 ' + fmtMoney(totalOf(route) / hc, cur) : ''}</span></div>
  </div>`;

  if (!n) {
    h += st.catFilter === '全部'
      ? `<div class="empty">还没有流水，记下第一笔吧 ✈<div class="led-empty-actions"><button class="btn btn-sm btn-primary" id="lgAdd2">＋ 记一笔</button></div></div>`
      : '<div class="empty">该分类下暂无流水</div>';
    container.innerHTML = h;
    bindLedger(container, false);
    return;
  }

  /* 按日期倒序分组，组头显示当日小计 */
  const days = {};
  st.list.forEach(e => { const k = e.spent_on || '__none__'; (days[k] || (days[k] = [])).push(e); });
  Object.keys(days).sort((a, b) => (a === '__none__' ? '' : a) < (b === '__none__' ? '' : b) ? 1 : -1).forEach(day => {
    const sum = days[day].reduce((s, e) => s + (e.amount || 0), 0);
    h += `<div class="led-day">${day === '__none__' ? '未标注日期' : esc(day.replace(/-/g, '/'))} · ${fmtMoney(sum, cur)}</div>`;
    days[day].forEach(e => { h += ledgerRow(e, cur); });
  });

  container.innerHTML = h;
  bindLedger(container, true);
}

function ledgerRow(e, cur) {
  const payer = findTraveler(e.payer_id);
  const parts = (e.parts || []).map(findTraveler).filter(Boolean);
  let share;
  if (e.is_opening) share = '期初结转 · 不参与分摊';
  else if (!parts.length) share = '未计入分摊（仅记录实付）';
  else if (parts.length === 1) share = '仅 ' + esc(parts[0].name) + ' 承担';
  else if (parts.length === st.travelers.length && st.travelers.length) share = parts.length + ' 人平分';
  else share = parts.length + ' 人分摊 · 非全员';
  const pendingBadge = e.pending
    ? `<span class="pill ${e.pending_status === 'inflight' ? 'pill-syncing' : (e.pending_status === 'failed' ? 'pill-rejected' : 'pill-pending')}">${e.pending_status === 'inflight' ? '同步中' : (e.pending_status === 'failed' ? '需处理' : '待同步')}</span>`
    : '';
  return `<div class="led${e.pending ? ' pending' : ''}" data-exp="${esc(e.id)}"${e.pending ? ' data-pending="1"' : ''}>
    <span class="sw" style="background:${COLORS[e.category] || '#94a3b8'}"></span>
    <div class="t">
      <div class="n">${esc(e.title || e.category)} ${pendingBadge}</div>
      <div class="m">
        <span>${esc(e.category)}</span><span>·</span>
        <span>${payer ? esc(payer.name) + ' 付' : '未指定付款人'}</span>
        <span class="led-share">${share}</span>
      </div>
    </div>
    <span class="amt">${fmtMoney(e.amount, cur)}</span>
  </div>`;
}


function bindLedger(container, hasRows) {
  const add = container.querySelector('#lgAdd') || container.querySelector('#lgAdd2');
  if (add) add.onclick = () => openExpenseSheet(st.route, null, st.onChanged);
  const tv = container.querySelector('#lgTravelers');
  if (tv) tv.onclick = () => openTravelersSheet(st.route, st.onChanged);
  container.querySelectorAll('[data-cat]').forEach(c => {
    c.onclick = async () => {
      st.catFilter = c.dataset.cat;
      try { await loadExpenses(st.route, st.catFilter); } catch (e) { return toast('加载失败：' + e.message); }
      paintLedger(container);
    };
  });
  if (!hasRows) return;
  container.querySelectorAll('.led[data-exp]').forEach(el => {
    el.onclick = async () => {
      if (el.dataset.pending === '1') {
        const offline = getOfflineEngine();
        if (!offline) return toast('离线存储不可用，无法安全处理待同步流水');
        const item = st.list.find(x => String(x.id) === el.dataset.exp);
        const ops = await offline.listQueue(st.route.id);
        const op = ops.find(x => String(x.client_id) === String(el.dataset.exp));
        if (op && op.type === 'expense.update') {
          if (!confirm('撤销这笔尚未同步的修改？（恢复为服务器上的当前内容）')) return;
          try {
            await offline.removeQueued(op.op_id);
            toast('已撤销本地修改');
            await refreshAfterChange();
          } catch (e) { toast('撤销失败：' + e.message); }
          return;
        }
        if (!confirm('删除这笔尚未同步的流水？')) return;
        try {
          await offline.enqueueDelete(st.route.id, el.dataset.exp, item);
          toast('已从本机待同步列表移除');
          await refreshAfterChange();
        } catch (e) { toast('删除失败：' + e.message); }
        return;
      }
      el.dataset.exp && openExpenseSheet(st.route, el.dataset.exp, st.onChanged);
    };
  });
}

/* ---------- 结算页签 ---------- */
export async function renderSettleTab(container, route, onChanged) {
  st.route = route;
  st.onChanged = onChanged || null;
  container.innerHTML = '<div class="empty">加载结算…</div>';
  let data, travelers;
  try {
    travelers = await loadTravelers(route);
    data = await api.get('/routes/' + encodeURIComponent(route.id) + '/settle');
  } catch (e) {
    container.innerHTML = '<div class="empty">结算加载失败：' + esc(e.message) + '</div>';
    return;
  }
  if (!travelers.length) {
    container.innerHTML = `<div class="empty">还没有同行人，先登记名单才能做 AA 结算
      <div class="led-empty-actions"><button class="btn btn-sm btn-primary" id="stAddTv">添加同行人</button></div></div>`;
    const b = container.querySelector('#stAddTv');
    if (b) b.onclick = () => openTravelersSheet(route, onChanged);
    return;
  }
  const cur = route.currency || 'CNY';
  const rows = data.rows || [];
  const transfers = data.transfers || [];
  const sum = data.summary || {};

  let h = `<div class="panel" style="box-shadow:none;padding:14px;margin-bottom:12px">
    <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>每人实付 / 应负担</h3>
    <div class="table-wrap" style="box-shadow:none">
      <table class="tbl" style="min-width:auto">
        <thead><tr><th>同行人</th><th style="text-align:right">实付</th><th style="text-align:right">应负担</th><th style="text-align:right">差额</th></tr></thead>
        <tbody>${rows.map(x => `<tr>
          <td><span class="tv-row"><span class="tv ${x.is_self ? 'tv-me' : ''}" style="background:${tvColor(x)}">${esc(initial(x.name))}</span>${esc(x.name)}${x.is_self ? ' <span class="pill pill-user">我</span>' : ''}</span></td>
          <td style="text-align:right">${fmtMoney(x.paid, cur)}</td>
          <td style="text-align:right">${fmtMoney(x.owed, cur)}</td>
          <td style="text-align:right" class="settle-net ${x.net >= 0 ? 'net-plus' : 'net-minus'}">${x.net >= 0 ? '+' : '−'}${fmtMoney(Math.abs(x.net), cur)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="caliber">实付合计 ${fmtMoney(sum.paid || 0, cur)} · 应负担合计 ${fmtMoney(sum.owed || 0, cur)}${caliberNote(sum, cur)}</div>
  </div>`;

  h += `<div class="panel" style="box-shadow:none;padding:14px">
    <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>最少转账方案 <span class="hint" style="font-weight:400">共 ${transfers.length} 笔</span></h3>
    ${transfers.length ? transfers.map(t => `<div class="tf">
        <span class="tv tv-sm" style="background:${tvColor({ id: t.from })}">${esc(initial(t.from_name))}</span>
        <span>${esc(t.from_name)}</span><span class="arrow">→</span>
        <span class="tv tv-sm" style="background:${tvColor({ id: t.to })}">${esc(initial(t.to_name))}</span>
        <span>${esc(t.to_name)}</span>
        <span class="amt">${fmtMoney(t.amount, cur)}</span>
      </div>`).join('') : '<div class="empty">账已平，无需转账 🎉</div>'}
    <div class="caliber">转账笔数 ≤ 人数 − 1；金额四舍五入到分，差额小于 0.01 时视为已平。</div>
  </div>`;

  h += `<div class="toolbar" style="margin-top:12px">
    <button class="btn btn-sm" id="stTravelers">管理同行人</button>
    <button class="btn btn-sm" id="stGoLedger">去记流水</button>
  </div>`;

  container.innerHTML = h;
  const a = container.querySelector('#stTravelers');
  if (a) a.onclick = () => openTravelersSheet(route, onChanged);
  /* 「去记流水」的跳转由 app.js 在 renderSettleTab 完成后统一绑定（需操作详情页签状态） */
}

/* 口径说明：未指定付款人 / 未纳入分摊的金额必须显式告知，否则数字对不上会让人困惑 */
function caliberNote(sum, cur) {
  const parts = [];
  if (sum.unassigned > 0) parts.push(`其中有 ${fmtMoney(sum.unassigned, cur)} 未指定付款人（含历史期初数据），不参与结算`);
  if (sum.not_split > 0) parts.push(`${fmtMoney(sum.not_split, cur)} 为未计入分摊的自付支出，由付款人自行承担`);
  return parts.length ? '；' + parts.join('；') : '；账目完整闭合';
}

/* ---------- 记一笔 ---------- */

/* 本地「今天」（YYYY-MM-DD）。不能用 toISOString()——它按 UTC 取日期，
 * 东八区凌晨 0–8 点会取到「昨天」。 */
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
/* 记账默认日期：默认「今天」；若今天不在行程区间内（行程未开始 / 已结束），
 * 取区间内最近的一天。此前默认取「行程第一天」，导致流水大量扎堆在首日。 */
function defaultSpentOn(route) {
  const t = todayISO();
  const s = (route && route.start_date) || '';
  const e = (route && route.end_date) || '';
  if (s && t < s) return s;
  if (e && t > e) return e;
  return t;
}

export async function openExpenseSheet(route, expenseId, onChanged) {
  st.route = route;
  st.onChanged = onChanged || null;
  /* 强制按本路线加载同行人：st.travelers 是模块级状态，直接用会跨路线串线 */
  try { await loadTravelers(route); } catch (e) { return toast('加载失败：' + e.message); }
  if (!st.travelers.length && !(parseInt(route.people, 10) > 0)) {
    toast('请先添加同行人');
    return openTravelersSheet(route, onChanged);
  }
  const cur = route.currency || 'CNY';
  const editing = expenseId ? st.list.find(x => x.id === expenseId) : null;
  st.editingId = editing ? editing.id : null;

  const ts = st.travelers;
  const self = ts.find(t => t.is_self) || ts[0];
  st.draft = editing
    ? {
        amount: editing.amount, category: editing.category, spent_on: editing.spent_on || '',
        title: editing.title || '', note: editing.note || '',
        payer_id: editing.payer_id || (self ? self.id : null),
        parts: (editing.parts || []).slice()
      }
    : {
        amount: '', category: '餐饮',
        spent_on: defaultSpentOn(route),
        title: '', note: '',
        payer_id: self ? self.id : null,
        parts: ts.map(t => t.id)
      };

  document.getElementById('e_title').textContent = editing ? '编辑流水' : '记一笔';
  document.getElementById('e_cur').textContent = curSymbol(cur);
  document.getElementById('e_del').style.display = editing ? '' : 'none';
  document.getElementById('e_quick').innerHTML = QUICK_AMOUNTS.map(q => `<div class="chip" data-q="${q}">${curSymbol(cur)}${fmt(q)}</div>`).join('');
  paintCats();
  paintPayers();
  paintParts();

  document.getElementById('e_amount').value = st.draft.amount;
  document.getElementById('e_date').value = st.draft.spent_on;
  document.getElementById('e_name').value = st.draft.title;
  document.getElementById('e_note').value = st.draft.note;

  bindExpenseSheet();
  syncHint();
  maskOpen('expMask');
  setTimeout(() => { const a = document.getElementById('e_amount'); if (a) a.focus(); }, 120);
}

function paintCats() {
  document.getElementById('e_cats').innerHTML = CATS.map(c => {
    const on = st.draft.category === c;
    return `<div class="chip${on ? ' active' : ''}" data-c="${esc(c)}">
      <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${COLORS[c]};margin-right:5px"></span>${esc(c)}</div>`;
  }).join('');
  document.querySelectorAll('#e_cats [data-c]').forEach(el => {
    el.onclick = () => {
      st.draft.category = el.dataset.c;
      document.querySelectorAll('#e_cats .chip').forEach(x => x.classList.toggle('active', x === el));
    };
  });
}

function paintPayers() {
  document.getElementById('e_payer').innerHTML = st.travelers.map(t => {
    const on = st.draft.payer_id === t.id;
    return `<div class="chip${on ? ' active' : ''}" data-p="${esc(t.id)}">
      <span class="tv tv-sm" style="background:${tvColor(t)};margin-right:4px">${esc(initial(t.name))}</span>${esc(t.name)}</div>`;
  }).join('');
  document.querySelectorAll('#e_payer [data-p]').forEach(el => {
    el.onclick = () => {
      st.draft.payer_id = el.dataset.p;
      document.querySelectorAll('#e_payer .chip').forEach(x => x.classList.toggle('active', x === el));
      syncHint();
    };
  });
}

function paintParts() {
  document.getElementById('e_parts').innerHTML = st.travelers.map(t => {
    const on = st.draft.parts.includes(t.id);
    return `<div class="chip has-tick${on ? ' active' : ''}" data-s="${esc(t.id)}">${on ? '<span class="tick">✓</span>' : ''}${esc(t.name)}</div>`;
  }).join('');
  document.querySelectorAll('#e_parts [data-s]').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.s, i = st.draft.parts.indexOf(id);
      if (i >= 0) st.draft.parts.splice(i, 1); else st.draft.parts.push(id);
      paintParts();
    };
  });
  syncHint();
}

function syncHint() {
  const cur = (st.route && st.route.currency) || 'CNY';
  const amount = parseFloat(st.draft.amount) || 0;
  const n = st.draft.parts.length;
  const h = document.getElementById('e_hint');
  if (!h) return;
  const payer = findTraveler(st.draft.payer_id);
  if (!(amount > 0)) {
    h.className = 'split-hint';
    h.textContent = n ? `已选 ${n} 人参与分摊，输入金额后显示每人应付` : '未选择分摊人：这笔只记录实付，不计入任何人的应分担';
    if (!n) h.className = 'split-hint warn';
    return;
  }
  if (!n) {
    h.className = 'split-hint warn';
    h.textContent = '⚠ 未选择分摊人：这笔将不计入任何人的应分担（仅记录实付）';
    return;
  }
  h.className = 'split-hint';
  h.innerHTML = `${n} 人平分，每人 <b style="font-size:15px">${fmtMoney(amount / n, cur)}</b>${payer ? ' · 由 ' + esc(payer.name) + ' 垫付' : ''}`;
}

function bindExpenseSheet() {
  const amount = document.getElementById('e_amount');
  amount.oninput = () => { st.draft.amount = amount.value; syncHint(); };
  const date = document.getElementById('e_date');
  date.onchange = () => { st.draft.spent_on = date.value; };
  const name = document.getElementById('e_name');
  name.oninput = () => { st.draft.title = name.value; };
  const note = document.getElementById('e_note');
  note.oninput = () => { st.draft.note = note.value; };

  document.querySelectorAll('#e_quick [data-q]').forEach(el => {
    el.onclick = () => { st.draft.amount = el.dataset.q; amount.value = el.dataset.q; syncHint(); };
  });
  document.getElementById('e_all').onclick = () => { st.draft.parts = st.travelers.map(t => t.id); paintParts(); };
  document.getElementById('e_none').onclick = () => { st.draft.parts = []; paintParts(); };
  document.getElementById('e_save').onclick = saveExpense;
  document.getElementById('e_del').onclick = deleteExpense;
}

async function saveExpense() {
  const route = st.route;
  const amount = parseFloat(st.draft.amount);
  if (!(amount > 0)) return toast('请填写大于 0 的金额');
  const clientId = st.editingId ? null : createClientId();
  const payload = {
    ...(clientId ? { id: clientId } : {}),
    spent_on: st.draft.spent_on || '',
    category: st.draft.category,
    amount,
    title: st.draft.title,
    note: st.draft.note,
    payer_id: st.draft.payer_id,
    parts: st.draft.parts
  };
  const base = '/routes/' + encodeURIComponent(route.id) + '/expenses';
  const offline = getOfflineEngine();
  try {
    if (st.editingId) {
      /* 阶段 2：编辑已同步流水 —— 在线直发（携带 base_updated_at 乐观锁）；
       * 网络类失败 → 落队列离线编辑；409 编辑冲突 → 以队列冲突态进入二选一面板（不静默覆盖）。 */
      const cached = offline ? await offline.getExpensesCache(route.id) : null;
      const cachedRow = cached && (cached.list || []).find(x => String(x.id) === String(st.editingId));
      const baseAt = Number(cachedRow && cachedRow.updated_at) || 0;
      if (!navigator.onLine) {
        if (!offline) return toast('本机离线存储不可用，无法安全保存待同步修改；请恢复网络后重试');
        await offline.enqueueUpdate(route.id, st.editingId, payload, baseAt);
        toast('已离线保存修改，恢复网络后将自动同步');
      } else {
        try {
          const rec = await api.patch(base + '/' + encodeURIComponent(st.editingId), baseAt ? { ...payload, base_updated_at: baseAt } : payload);
          if (offline) await offline.upsertCachedExpense(route.id, rec);
          toast('已保存');
        } catch (e) {
          if (e && e.status === 409 && e.code === 'EDIT_CONFLICT' && offline) {
            await offline.enqueueUpdate(route.id, st.editingId, payload, baseAt);
            await offline.syncNow();
            return toast('该笔已在其他端被修改，请在「同步队列」中选择保留哪一侧');
          }
          if (!(e && isNetworkError(e)) || !offline) throw e;
          await offline.enqueueUpdate(route.id, st.editingId, payload, baseAt);
          toast('网络异常，修改已保存到本机待同步队列');
        }
      }
    } else {
      try {
        const rec = await api.post(base, payload);
        if (offline) await offline.upsertCachedExpense(route.id, rec);
        toast(`已记一笔 ${fmtMoney(amount, route.currency || 'CNY')}`);
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        if (!offline) throw new Error('本机离线存储不可用，无法安全保存待同步流水；请恢复网络后重试');
        /* clientId 在第一次在线尝试前已生成，失败入队沿用同一个 id，保证重放幂等。 */
        await offline.enqueueExpense(route.id, payload);
        toast('网络异常，本笔已离线保存，恢复网络后自动同步');
      }
    }
  } catch (e) {
    return toast(e.message);
  }
  maskClose('expMask');
  await refreshAfterChange();
}

async function deleteExpense() {
  if (!st.editingId) return;
  if (!navigator.onLine) return toast('离线阶段暂不支持删除已同步流水；原数据未改变');
  if (!confirm('删除这笔流水？')) return;
  try {
    await api.del('/routes/' + encodeURIComponent(st.route.id) + '/expenses/' + encodeURIComponent(st.editingId));
    const offline = getOfflineEngine();
    if (offline) await offline.removeCachedExpense(st.route.id, st.editingId);
  } catch (e) { return toast(e.message); }
  toast('已删除');
  maskClose('expMask');
  await refreshAfterChange();
}

/* 流水变化后：通知外层统一刷新。
 * 页签重渲染由 app.js 的 reloadAfterMutation 按当前页签全量完成（此处不再手动 paintLedger，
 * 避免用 st.route 的旧聚合值画出一帧滞后数据） */
async function refreshAfterChange() {
  if (typeof st.onChanged === 'function') await st.onChanged();
}

/* ---------- 同行人管理 ---------- */
export async function openTravelersSheet(route, onChanged) {
  st.route = route;
  st.onChanged = onChanged || null;
  /* 示例路线对普通用户只读：名单可看，添加/改名/标记/移除隐藏（服务端同样 403，这里提前收敛） */
  st.tvReadOnly = !!(route.is_seed && store.user && store.user.role !== 'admin');
  try { await loadTravelers(route); } catch (e) { return toast('加载失败：' + e.message); }
  paintTravelers();
  maskOpen('tvMask');
}

function paintTravelers() {
  const route = st.route;
  const ts = st.travelers;
  const people = parseInt(route.people, 10) || 0;
  const el = (id) => document.getElementById(id);
  el('t_people').textContent = people ? people + ' 人' : '未填写';
  el('t_count').textContent = ts.length + ' 人' + (people && ts.length && people !== ts.length ? '（与人数不一致）' : '');
  const ro = st.tvReadOnly;
  /* 只读态：隐藏批量添加输入区（HTML 里整块控制） */
  const addField = document.querySelector('#tvMask .field:has(#t_new)');
  if (addField) addField.style.display = ro ? 'none' : '';
  el('t_list').innerHTML = ts.length ? ts.map(t => `<div class="tv-item">
      <span class="tv" style="background:${tvColor(t)}">${esc(initial(t.name))}</span>
      <span class="tv-name">${esc(t.name)}${t.is_self ? ' <span class="pill pill-user">我</span>' : ''}</span>
      ${ro ? '' : `<button class="btn btn-sm" data-edit="${esc(t.id)}">改</button>
      ${t.is_self ? '' : `<button class="btn btn-sm" data-self="${esc(t.id)}">设为我</button>`}
      <button class="btn btn-sm btn-danger" data-del="${esc(t.id)}">移除</button>`}
    </div>`).join('') : (ro ? '<div class="empty">该示例路线暂无同行人</div>' : '<div class="empty">还没有同行人</div>');

  document.querySelectorAll('#t_list [data-edit]').forEach(b => {
    b.onclick = async () => {
      const t = findTraveler(b.dataset.edit);
      const name = prompt('修改姓名', t ? t.name : '');
      if (name === null) return;
      if (!String(name).trim()) return toast('姓名不能为空');
      try { await api.patch('/routes/' + encodeURIComponent(st.route.id) + '/travelers/' + encodeURIComponent(b.dataset.edit), { name: String(name).trim() }); }
      catch (e) { return toast(e.message); }
      await loadTravelers(st.route); paintTravelers(); if (st.onChanged) await st.onChanged();
    };
  });
  document.querySelectorAll('#t_list [data-self]').forEach(b => {
    b.onclick = async () => {
      try { await api.patch('/routes/' + encodeURIComponent(st.route.id) + '/travelers/' + encodeURIComponent(b.dataset.self), { is_self: true }); }
      catch (e) { return toast(e.message); }
      await loadTravelers(st.route); paintTravelers();
      toast('已标记为「我」');
    };
  });
  document.querySelectorAll('#t_list [data-del]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.del;
      const doDelete = async (force) => {
        try {
          await api.del('/routes/' + encodeURIComponent(st.route.id) + '/travelers/' + encodeURIComponent(id) + (force ? '?force=1' : ''));
        } catch (e) {
          if (e.status === 409) {
            if (!confirm(`该同行人已被 ${e.affected || '若干'} 笔流水引用。\n\n删除后：其作为付款人的流水将变为「未指定付款人」，其分摊份额会被移除（该笔改由剩余分摊人平摊）。\n\n确定继续？`)) return false;
            return doDelete(true);
          }
          toast(e.message);
          return false;
        }
        return true;
      };
      if (await doDelete(false)) {
        toast('已移除');
        await loadTravelers(st.route); paintTravelers();
        if (st.onChanged) await st.onChanged();
      }
    };
  });

  const addBtn = document.getElementById('t_add');
  addBtn.onclick = async () => {
    const input = document.getElementById('t_new');
    const raw = input.value.trim();
    if (!raw) return toast('请输入姓名');
    const names = raw.split(/[,，、\s]+/).filter(Boolean);
    try { await api.post('/routes/' + encodeURIComponent(st.route.id) + '/travelers', { names }); }
    catch (e) { return toast(e.message); }
    input.value = '';
    await loadTravelers(st.route);
    paintTravelers();
    if (st.onChanged) await st.onChanged();
    toast(`已添加 ${names.length} 位同行人`);
  };
}

