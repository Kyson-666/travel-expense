/* main.js — 入口：hash 路由 + 守卫 + 全局事件（ES Module） */
import { store, toast, api, navigate, fetchMe, applyAuth, renderHeader, getServerUrl, setServerUrl, HAS_BUILTIN_SERVER, esc } from './api.js';
import { initAuth, renderLogin, renderRegister } from './auth.js';
import { loadRoutes, loadYears, renderWorkbench, renderStats, renderProfile, bindFormEvents } from './app.js';
import { renderAdmin, bindAdminEvents } from './admin.js';
import { initOffline } from './offline.js';
import { mountOfflineUI, mountInstallGuide } from './offline-ui.js';

function registerServiceWorker() {
  /* Capacitor 安卓壳由原生 BridgeWebViewClient 提供资源且走原生热更新；不注册 SW，避免旧缓存掩盖热更新。 */
  if (window.Capacitor || window.CapacitorNative || window.__CAPACITOR__) return;
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      if (reg.waiting) toast('有新版本可用，请刷新页面');
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (worker) worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本可用，请刷新页面');
        });
      });
    }).catch(() => { /* SW 不可用不得影响在线/离线记账引擎 */ });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}


async function guard() {
  const route = location.hash || '#/workbench';
  const u = store.user;

  /* 服务器设置页：未登录也可访问（用于首次连接自托管服务器）。
   * 若已内置服务器地址（打包时注入），则无需用户连接，重定向到登录。 */
  if (route.startsWith('#/setup')) {
    if (HAS_BUILTIN_SERVER) { navigate('/login'); return false; }
    return true;
  }

  if (route.startsWith('#/login') || route.startsWith('#/register')) {
    if (u) { navigate('/workbench'); return false; }
    return true;
  }
  if (!u) { navigate('/login'); return false; }
  if (route.startsWith('#/admin') && u.role !== 'admin') { toast('无权限'); navigate('/workbench'); return false; }
  return true;
}

/* 首次启动或切换服务器：连接自托管服务器 */
async function renderSetup() {
  const view = document.getElementById('view');
  const cur = getServerUrl();
  view.innerHTML = `
    <div class="auth-card">
      <h1>连接你的服务器</h1>
      <p class="muted">输入你部署的「旅行经费工作台」服务器地址。登录后，账号与全部路线数据将自动与该服务器云端同步。</p>
      ${cur ? `<p class="muted">当前服务器：<code>${esc(cur)}</code></p>` : ''}
      <label>服务器地址</label>
      <input id="setupUrl" class="inp" placeholder="https://travel.example.com" value="${cur ? esc(cur) : ''}" />
      <div id="setupErr" class="err"></div>
      <button id="setupBtn" class="btn btn-primary btn-block">连接并继续</button>
    </div>`;
  document.getElementById('setupBtn').onclick = async () => {
    const v = document.getElementById('setupUrl').value.trim().replace(/\/+$/, '');
    if (!v) { document.getElementById('setupErr').textContent = '请输入服务器地址'; return; }
    setServerUrl(v);
    try {
      const r = await api.get('/public/server-check');
      if (!r || !r.isTravelExpense) throw new Error('该地址不是有效的旅行经费服务器');
      navigate('/login');
    } catch (e) {
      setServerUrl('');
      document.getElementById('setupErr').textContent = (e && e.message) ? e.message : '无法连接该服务器，请检查地址或网络';
    }
  };
}

async function render() {
  if (!(await guard())) return;
  const route = location.hash || '#/workbench';
  /* 未配置服务器时，强制进入连接页（仅服务器设置页除外） */
  if (!getServerUrl() && !route.startsWith('#/setup')) { navigate('/setup'); return; }
  renderHeader();   // 同步顶部用户区（已登录显示菜单，未登录隐藏）

  if (route.startsWith('#/setup')) { renderSetup(); return; }
  if (route.startsWith('#/login')) { renderLogin(); return; }
  if (route.startsWith('#/register')) { renderRegister(); return; }
  if (route.startsWith('#/profile')) { renderProfile(); return; }
  if (route.startsWith('#/admin')) { renderAdmin(); return; }

  /* 默认工作台：年份胶囊依赖全量年份接口，与列表并行拉取 */
  await Promise.all([loadRoutes(), loadYears()]);
  renderWorkbench();
  renderStats();
}

async function init() {
  /* 顶部固定骨架在 index.html 中；先拉站点信息与登录态 */
  await initAuth();
  await fetchMe();
  renderHeader();
  bindHeaderEvents();
  bindFormEvents();
  bindAdminEvents();
  const offline = await initOffline();
  if (offline) mountOfflineUI(offline);
  mountInstallGuide();
  registerServiceWorker();

  window.addEventListener('hashchange', render);
  await render();
  /* 会话在离线启动时可能仅由 localStorage 恢复；登录接口成功后 api.js 会发 te:auth，触发队列续传。 */

  /* 心跳：每 5 分钟刷新在线状态 */
  setInterval(async () => {
    if (store.user) { await fetchMe(); }
  }, 5 * 60 * 1000);
}

function bindHeaderEvents() {
  document.getElementById('logoutBtn').onclick = async () => {
    try { await api.post('/auth/logout'); } catch (e) { /* ignore */ }
    store.user = null;
    try { localStorage.removeItem('te_offline_user'); } catch (e) { /* ignore */ }
    renderHeader();
    navigate('/login');
  };
  document.getElementById('userMenuBtn').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('userMenu').classList.toggle('open');
  };
  document.getElementById('profileLink').onclick = () => { document.getElementById('userMenu').classList.remove('open'); navigate('/profile'); };
  document.getElementById('adminLink').onclick = () => { document.getElementById('userMenu').classList.remove('open'); navigate('/admin/overview'); };
  const switchBtn = document.getElementById('switchServerBtn');
  if (switchBtn) {
    if (HAS_BUILTIN_SERVER) {
      /* 服务器地址已内置，用户无需也不能切换 */
      switchBtn.style.display = 'none';
    } else {
      switchBtn.onclick = () => { document.getElementById('userMenu').classList.remove('open'); setServerUrl(''); navigate('/setup'); };
    }
  }
  document.getElementById('homeLink').onclick = () => navigate('/workbench');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) document.getElementById('userMenu').classList.remove('open');
  });
}

init();
