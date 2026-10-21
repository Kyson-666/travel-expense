/* api.js — fetch 封装 + 全局状态 + toast + 路由工具（ES Module） */
export const store = {
  user: null,      // GET /api/auth/me 结果
  site: { site_name: '旅行经费工作台', allow_register: true, register_mode: 'all', announce_text: '', home_currency: 'CNY', fx_rates: { CNY: 1 } },
  hideSeed: localStorage.getItem('te_hide_seed') === '1'
};
const OFFLINE_USER_KEY = 'te_offline_user';

export function toast(msg, ms = 2200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* 客户端可连接任意自托管服务器：
 * - 优先用用户手动配置的地址（localStorage te_server_url，对应「切换服务器」）；
 * - 其次用打包时内置的服务器地址（window.TE_BUILTIN_SERVER，仅安卓 APK 注入）；
 * - 都为空且当前在浏览器（非 Capacitor/WebView）环境下，自动使用页面 origin 作为同源服务器地址；
 * - Capacitor/APK 环境下无前两项则保持为空，进入 setup 由用户输入。 */
const BUILTIN_SERVER_URL = (typeof window !== 'undefined' && window.TE_BUILTIN_SERVER)
  ? String(window.TE_BUILTIN_SERVER).replace(/\/+$/, '') : '';
export const HAS_BUILTIN_SERVER = !!BUILTIN_SERVER_URL;

function isBrowserOrigin() {
  if (typeof window === 'undefined' || !window.location) return false;
  if (window.Capacitor || window.CapacitorNative || window.__CAPACITOR__) return false;
  const proto = window.location.protocol;
  return proto === 'http:' || proto === 'https:';
}

function getDefaultServerUrl() {
  if (!isBrowserOrigin()) return '';
  return (window.location.origin || '').replace(/\/+$/, '');
}

export function getServerUrl() {
  return (localStorage.getItem('te_server_url') || BUILTIN_SERVER_URL || getDefaultServerUrl() || '').replace(/\/+$/, '');
}
export function setServerUrl(u) {
  if (u) localStorage.setItem('te_server_url', u.replace(/\/+$/, ''));
  else localStorage.removeItem('te_server_url');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('te:server-change'));
}

async function request(method, path, body) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  /* 弱网下 30s 超时兜底，否则请求可能永远 pending（离线入队的分流条件无法触发）。 */
  const timeout = controller ? setTimeout(() => controller.abort(), 30000) : null;
  const opt = { method, credentials: 'include', mode: 'cors' };
  if (controller) opt.signal = controller.signal;
  if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(getServerUrl() + '/api' + path, opt);
  } catch (e) {
    /* 移动网络/证书/代理异常时 fetch 抛 TypeError；超时同样归为网络错误以便离线入队。 */
    const isNetwork = !e.status && (e.name === 'TypeError' || e.name === 'AbortError' || /failed to fetch|network|net::err/i.test(e.message));
    const msg = isNetwork
      ? (e.name === 'AbortError' ? '请求超时，请检查网络后重试' : '网络连接失败，请检查网络或该站点证书是否受信任')
      : (e.message || '请求失败');
    const err = new Error(msg);
    err.network = isNetwork;
    err.original = e;
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (!r.ok) {
    const err = new Error((data && data.msg) || ('请求失败 (' + r.status + ')'));
    err.status = r.status;
    err.code = data && data.code;
    throw err;
  }
  return data ? data.data : null;
}

/* 判断错误是否为「传输层网络失败」（fetch 抛错 / 超时），区别于业务错误：
 * 离线入队与降级判定的公共依据。offline.js 的退避判定在此基础上把 5xx 也视为可重试。 */
export function isNetworkError(e) { return !!(e && e.network); }

/* 前端错误上报 → 服务端日志（[client-error] 前缀，与访问日志同文件）。
 * 用于排查 CSP 拦截、图商 SDK 加载失败、前端运行时异常等「浏览器侧」问题。
 * 会话内最多 10 条（服务端另有每用户 10 条/分钟限频），字段截断。 */
let _errBudget = 10;
export function reportClientError(level, message, stack, context) {
  if (_errBudget <= 0) return;
  _errBudget--;
  try {
    fetch(getServerUrl() + '/api/log/client-error', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: level || 'error',
        message: String(message == null ? '' : message).slice(0, 500),
        stack: String(stack == null ? '' : stack).slice(0, 2000),
        context: context || null
      })
    }).catch(() => { /* 上报失败静默，绝不影响主流程 */ });
  } catch (e) { /* ignore */ }
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p)
};

/* 站点信息（公开接口，未登录也可拉；失败静默） */
export async function loadSite() {
  try {
    const s = await api.get('/public/site') || {};
    Object.assign(store.site, s);
  } catch (e) { /* ignore */ }
}

/* 拉取当前用户；失败返回 null */
export async function fetchMe() {
  try {
    store.user = await api.get('/auth/me');
    try { localStorage.setItem(OFFLINE_USER_KEY, JSON.stringify(store.user)); } catch (e) { /* storage may be unavailable */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('te:auth'));
    return store.user;
  } catch (e) {
    if (isNetworkError(e)) {
      /* 仅网络失败时允许使用最近一次已认证的公开用户资料进入离线只读/记账界面；
       * Cookie 与授权仍由服务端校验，队列在恢复网络后遇到 401 会保留。 */
      try { store.user = JSON.parse(localStorage.getItem(OFFLINE_USER_KEY) || 'null'); } catch (ignore) { store.user = null; }
      return store.user;
    }
    if (e && e.status === 401) { try { localStorage.removeItem(OFFLINE_USER_KEY); } catch (ignore) {} }
    store.user = null;
    return null;
  }
}

/* 登录 / 登出后的状态同步 */
export function applyAuth(user) {
  store.user = user;
  try {
    if (user) localStorage.setItem(OFFLINE_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(OFFLINE_USER_KEY);
  } catch (e) { /* storage may be unavailable */ }
  renderHeader();
  if (user && typeof window !== 'undefined') window.dispatchEvent(new Event('te:auth'));
}

export function renderHeader() {
  const u = store.user;
  const box = document.getElementById('userArea');
  if (!box) return;
  /* 足迹一级入口（登录态显示；移动端与个人中心菜单均有其它入口） */
  const fpLink = document.getElementById('footprintLink');
  if (fpLink) fpLink.style.display = u ? 'inline-flex' : 'none';
  if (u) {
    box.classList.remove('hidden');
    const name = u.username || u.email || ('#' + u.id);
    document.getElementById('userName').textContent = name;
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.style.display = u.role === 'admin' ? '' : 'none';
    /* 菜单头部：用户名 + 角色徽章 */
    const headName = document.getElementById('menuHeadName');
    if (headName) headName.textContent = name;
    const headRole = document.getElementById('menuHeadRole');
    if (headRole) headRole.textContent = u.role === 'admin' ? '管理员' : '用户';
  } else {
    box.classList.add('hidden');
  }
}

/* ---------- 路由 ---------- */
export function navigate(hash) {
  location.hash = hash;
}
/* 统一 html 转义（含单引号），charts.js / main.js 等共用此实现，避免各端转义字符集不一致 */
export function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* 金额格式化：dec 指定小数位（默认 2），尾零自动省略。
 * 零小数币种（日元/韩元等）由 fmtMoney 传 dec=0。 */
export function fmt(n, dec = 2) {
  const p = Math.pow(10, dec);
  n = Math.round((n || 0) * p) / p;
  return n.toLocaleString('zh-CN');
}

/* 9 类支出分类：前端唯一来源（服务端对应 db.js 的 EXP_KEYS，需保持同步） */
export const CATS = ['交通', '机票', '高铁', '住宿', '餐饮', '门票', '团费', '购物', '其他'];

/* 币种符号表唯一来源：store.site.currency_symbols（由 /api/public/site 从服务端 fx.CURRENCY_SYMBOLS 下发）。
 * 删除本地硬编码副本，避免与分享页分叉（如 IDR/PHP/VND/INR/RUB 缺失）。 */
export function curSymbol(c) {
  const sym = store.site.currency_symbols;
  return (sym && sym[(c || 'CNY').toUpperCase()]) || (c || 'CNY');
}
/** 零小数币种（兑现「日元/韩元金额无小数」的文档承诺）：按币种取 decimals */
const ZERO_DECIMAL_CUR = { JPY: 1, KRW: 1, VND: 1, IDR: 1 };
export function fmtMoney(n, cur) {
  const code = (cur || 'CNY').toUpperCase();
  return curSymbol(code) + fmt(n, ZERO_DECIMAL_CUR[code] ? 0 : 2);
}
/* 自由文本日期区间解析（前端唯一实现）：返回 {start, end} 的 YYYY-MM-DD 字符串。
 * 支持：完整日期区间 / 月日区间（跨年自动 +1）/ 单个完整日期 / 单个月日（需 year）。
 * 排序用起点（parseStart）与本函数同源，避免两套正则漂移。 */
export function parseDatesFromRange(dr, year) {
  if (!dr) return { start: '', end: '' };
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return {
    start: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`,
    end: `${m[4]}-${String(m[5]).padStart(2, '0')}-${String(m[6]).padStart(2, '0')}`
  };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) {
    const sm = +m[1], em = +m[3];
    const ey = em < sm ? +year + 1 : +year;
    return {
      start: `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`,
      end: `${ey}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`
    };
  }
  m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    return { start: d, end: d };
  }
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) {
    const d = `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    return { start: d, end: d };
  }
  return { start: '', end: '' };
}

/* 排序用起始时间：parseDatesFromRange 的起点（同源实现） */
export function parseStart(dr, year) {
  const r = parseDatesFromRange(dr, year);
  return r.start ? new Date(r.start + 'T00:00:00') : null;
}
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
