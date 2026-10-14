/* offline-ui.js — 离线状态条与同步队列面板 */
import { esc, toast } from './api.js';

let mounted = false;
let engine = null;
let unsubs = [];

function icon(name) {
  if (name === 'sync') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3"/></svg>';
  if (name === 'spin') return '<svg class="offline-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
}

export function mountOfflineUI(offline) {
  if (mounted || !offline) return;
  engine = offline;
  mounted = true;
  const bar = document.getElementById('offlineBar');
  if (!bar) return;
  bar.innerHTML = `<span id="offlineIcon">${icon('off')}</span><span id="offlineText"></span><span class="offline-spacer"></span><button id="offlineAction" type="button">查看队列</button>`;
  const panel = document.createElement('div');
  panel.id = 'offlinePanel';
  panel.className = 'offline-panel';
  panel.innerHTML = `<div class="offline-panel-card"><div class="offline-panel-head"><div><b>同步队列</b><span id="offlineQueueCount" class="pill pill-pending"></span></div><button id="offlineClose" type="button" aria-label="关闭">×</button></div><div id="offlineQueueList"></div><div class="offline-panel-foot"><span id="offlineStorage">存储用量读取中…</span><button id="offlineClear" type="button">清理缓存</button></div><div class="offline-panel-actions"><button id="offlineExport" class="btn btn-line btn-sm" type="button">导出队列</button><button id="offlineRetryAll" class="btn btn-primary btn-sm" type="button">立即同步</button></div></div>`;
  document.body.appendChild(panel);

  const render = () => renderOfflineStatus(engine, bar, panel);
  unsubs.push(engine.on('change', render));
  unsubs.push(engine.on('queued', op => {
    render();
    toast(navigator.onLine ? `网络异常，已保存到本机待同步队列：${op.payload.category} ${op.payload.amount}` : `已离线保存：${op.payload.category} ${op.payload.amount}`);
  }));
  unsubs.push(engine.on('degraded', () => toast('有流水的同行人已失效，已保留金额并记为未指定付款人')));
  unsubs.push(engine.on('blocked', () => toast('登录已过期，待同步数据已保留；登录后将继续同步')));
  unsubs.push(engine.on('conflict', () => { render(); toast('有 1 笔编辑冲突待处理，打开「同步队列」可二选一'); }));
  unsubs.push(engine.on('resolved', () => render()));
  unsubs.push(engine.on('failed', ({ result }) => { if (result && result.status === 'rejected') toast(result.message || '有同步项目需要处理'); }));

  bar.querySelector('#offlineAction').onclick = () => { renderQueue(engine, panel); panel.classList.add('open'); refreshStorage(engine, panel); };
  panel.querySelector('#offlineClose').onclick = () => panel.classList.remove('open');
  panel.querySelector('#offlineRetryAll').onclick = async () => {
    panel.classList.remove('open');
    await engine.syncNow({ manual: true });
  };
  /* 导出队列（设计 §8 #4「可导出/丢弃」）：拒绝/待处置的操作先留档再丢弃，绝不静默丢数据。 */
  panel.querySelector('#offlineExport').onclick = async () => {
    const ops = await engine.listQueue();
    if (!ops.length) return toast('队列为空，无需导出');
    const ts = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), server: engine.serverKey, ops }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `travel-expense-queue-${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`已导出 ${ops.length} 笔待同步操作`);
  };
  panel.addEventListener('click', e => { if (e.target === panel) panel.classList.remove('open'); });
  /* 清理读缓存（阶段 2）：只清缓存与游标，待同步队列绝不删除（文案显式说明）。 */
  panel.querySelector('#offlineClear').onclick = async () => {
    const ops = await engine.listQueue();
    const msg = ops.length
      ? `清理后需联网重新加载路线与流水；待同步的 ${ops.length} 笔操作不受影响。确认清理缓存？`
      : '清理后需联网重新加载路线与流水。确认清理缓存？';
    if (!confirm(msg)) return;
    await engine.clearCaches();
    await refreshStorage(engine, panel);
    await renderQueue(engine, panel);
    toast('缓存已清理');
  };
  render();
}

function fmtBytes(n) {
  if (!(n >= 0)) return '';
  return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : (n / 1048576).toFixed(1) + ' MB';
}
async function refreshStorage(engine, panel) {
  const el = panel.querySelector('#offlineStorage');
  if (!el) return;
  const est = await engine.storageEstimate();
  el.textContent = (est && est.usage != null)
    ? `本机离线数据约 ${fmtBytes(est.usage)}` + (est.quota ? ` · 配额 ${fmtBytes(est.quota)}` : '')
    : '存储用量不可用';
}

/* PWA 安装引导（阶段 3）：捕获 beforeinstallprompt，提供一次性的安装入口。
 * 已安装（standalone）/ Capacitor 壳内跳过；用户关闭后记忆不再打扰；不支持时静默降级。 */
export function mountInstallGuide() {
  if (typeof window === 'undefined') return;
  try {
    if (window.Capacitor || window.__CAPACITOR__) return;
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return;
    if (localStorage.getItem('te_install_dismissed') === '1') return;
  } catch (e) { return; }
  let deferred = null;
  const bar = document.createElement('div');
  bar.className = 'install-bar';
  bar.innerHTML = '<span class="install-text">把「经费台」装到桌面：离线也能记账，打开更快</span>' +
    '<button id="installGo" type="button">安装</button><button id="installNo" type="button" aria-label="关闭">×</button>';
  const hide = () => bar.classList.remove('show');
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    if (!bar.parentNode) document.body.insertBefore(bar, document.body.firstChild);
    bar.classList.add('show');
  });
  bar.querySelector('#installGo').onclick = async () => {
    if (!deferred) return;
    hide();
    try { deferred.prompt(); await deferred.userChoice; } catch (e) { /* 取消或环境不支持 */ }
    deferred = null;
  };
  bar.querySelector('#installNo').onclick = () => {
    hide();
    try { localStorage.setItem('te_install_dismissed', '1'); } catch (e) { /* ignore */ }
  };
  window.addEventListener('appinstalled', () => {
    hide();
    try { localStorage.setItem('te_install_dismissed', '1'); } catch (e) { /* ignore */ }
  });
}

async function renderOfflineStatus(offline, bar, panel) {
  if (!offline || !bar) return;
  const s = offline.state();
  const items = await offline.listQueue();
  const count = items.length;
  bar.className = 'offline-bar';
  const text = bar.querySelector('#offlineText');
  const iconBox = bar.querySelector('#offlineIcon');
  const action = bar.querySelector('#offlineAction');
  if (!s.online) {
    bar.classList.add('show', 'offline');
    iconBox.innerHTML = icon('off');
    text.textContent = `离线模式${count ? ` · ${count} 笔待同步` : ' · 可查看已缓存数据并继续记账'}`;
    action.textContent = count ? '查看队列' : '离线说明';
    action.style.display = '';
  } else if (s.syncing) {
    bar.classList.add('show', 'syncing');
    iconBox.innerHTML = icon('spin');
    text.textContent = `正在同步 · 剩余 ${count} 笔`;
    action.style.display = 'none';
  } else if (s.blocked || count) {
    const hasConflict = items.some(x => x.conflict);
    bar.classList.add('show', s.blocked ? 'blocked' : 'pending');
    iconBox.innerHTML = icon('sync');
    text.textContent = s.blocked === 'session_expired'
      ? `登录已过期 · ${count} 笔待同步，重新登录后继续`
      : s.blocked === 'server_upgrade_required'
        ? `${count} 笔待同步 · 请先升级服务器以安全同步`
        : `${count} 笔待同步${hasConflict ? ' · 有编辑冲突待处理' : (items.some(x => x.status === 'failed') ? ' · 有项目需要处理' : '')}`;
    action.textContent = items.some(x => x.status === 'failed') ? '查看并重试' : '立即同步';
    action.style.display = '';
  } else {
    action.style.display = 'none';
  }
  await renderQueue(offline, panel);
}

async function renderQueue(offline, panel) {
  if (!offline || !panel) return;
  const list = panel.querySelector('#offlineQueueList');
  const countEl = panel.querySelector('#offlineQueueCount');
  const ops = await offline.listQueue();
  countEl.textContent = `${ops.length} 笔`;
  if (!ops.length) { list.innerHTML = '<div class="offline-queue-empty">队列为空，所有记账均已同步。</div>'; return; }
  const typeLabel = (t) => t === 'expense.delete' ? '删除流水' : (t === 'expense.update' ? '修改流水' : '新增流水');
  list.innerHTML = ops.map(op => {
    const status = op.status === 'inflight' ? '同步中' : (op.conflict ? '编辑冲突' : (op.status === 'failed' ? '需处理' : '待同步'));
    const title = op.type === 'expense.delete' ? '删除流水' : `${typeLabel(op.type)} · ${op.payload.category} · ${op.payload.title || '无事项'}`;
    const amount = op.type === 'expense.delete' ? '' : `¥${Number(op.payload.amount || 0).toLocaleString('zh-CN')}`;
    const detail = op.conflict
      ? '该笔已在其他端被修改，请选择保留哪一侧（可先「导出队列」留档）'
      : (op.last_error ? esc(op.last_error.message || op.last_error.code) : `记录于 ${new Date(op.created_at).toLocaleString()}`);
    const actions = (op.conflict && op.conflict.server)
      ? `<div class="offline-queue-actions"><button type="button" data-keep="${esc(op.op_id)}">保留本地</button><button type="button" data-adopt="${esc(op.op_id)}">采用服务端</button></div>`
      : `<div class="offline-queue-actions"><button type="button" data-remove="${esc(op.op_id)}" ${op.status === 'inflight' ? 'disabled' : ''}>移除</button></div>`;
    return `<div class="offline-queue-item"><div class="offline-queue-main"><div class="offline-queue-title">${esc(title)} <span class="pill ${op.status === 'failed' ? 'pill-rejected' : 'pill-pending'}">${status}</span></div><div class="offline-queue-detail">${detail}</div></div><b>${amount}</b>${actions}</div>`;
  }).join('');
  list.querySelectorAll('[data-remove]').forEach(button => {
    button.onclick = async () => {
      const op = ops.find(x => x.op_id === button.dataset.remove);
      if (!op) return;
      const msg = op.status === 'failed'
        ? '该操作同步失败。移除后将从本机队列中删除，且不会写入服务器。确认移除？'
        : '该笔尚未同步到服务器。移除后本机记录将被丢弃，且不会写入服务器。确认移除？';
      if (!confirm(msg)) return;
      await offline.removeQueued(op.op_id);
      await renderQueue(offline, panel);
    };
  });
  /* 冲突处置（阶段 2）：保留本地 = 以服务端当前版本戳重投；采用服务端 = 丢弃本地改动。 */
  list.querySelectorAll('[data-keep]').forEach(button => {
    button.onclick = async () => {
      const ok = await offline.resolveConflictKeepLocal(button.dataset.keep);
      if (!ok) return toast('无法保留本地版本（缺少服务端版本戳），请改用「采用服务端」或移除');
      toast('已选择保留本地，将立即重新同步');
      await renderQueue(offline, panel);
    };
  });
  list.querySelectorAll('[data-adopt]').forEach(button => {
    button.onclick = async () => {
      if (!confirm('采用服务端版本？本机对该笔的修改将被丢弃（可先「导出队列」留档）。')) return;
      await offline.resolveConflictUseServer(button.dataset.adopt);
      toast('已采用服务端版本');
      await renderQueue(offline, panel);
    };
  });
}
