/* admin.js — 管理后台（总览/用户/邮件/站点/AI配置/审计） */
import { store, toast, api, esc, fmt, fmtTime } from './api.js';

const NAV = [
  ['overview', '平台总览', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>'],
  ['users', '用户管理', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>'],
  ['ai', 'AI 配置', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-1v1a4 4 0 0 1-8 0v-1H7a3 3 0 0 1-3-3v-1a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4z"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/></svg>'],
  ['map', '地图配置', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/></svg>'],
  ['email', '邮件配置', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>'],
  ['site', '站点设置', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'],
  ['app', 'APP 更新', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>'],
  ['audit', '审计日志', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>']
];

export function renderAdmin() {
  const seg = currentAdminSeg();
  const main = document.getElementById('view');
  main.innerHTML = `
    <div class="wrap">
      <div class="admin-layout">
        <div class="admin-nav">
          ${NAV.map(n => `<div class="anav ${seg === n[0] ? 'active' : ''}" data-aseg="${n[0]}">${n[1]}</div>`).join('')}
          <div class="anav" data-aseg="back" style="color:var(--muted)">← 返回工作台</div>
        </div>
        <div class="admin-content" id="adminContent"></div>
      </div>
    </div>`;
  document.querySelectorAll('[data-aseg]').forEach(el => {
    el.onclick = () => {
      if (el.dataset.aseg === 'back') { location.hash = '#/workbench'; return; }
      location.hash = '#/admin/' + el.dataset.aseg;
    };
  });
  loadAdminPage(seg);
}

function currentAdminSeg() {
  const m = location.hash.match(/#\/admin\/([a-z]+)/);
  return m ? m[1] : 'overview';
}

function loadAdminPage(seg) {
  const box = document.getElementById('adminContent');
  if (!box) return;
  if (seg === 'overview') renderOverview(box);
  else if (seg === 'users') renderUsers(box);
  else if (seg === 'ai') renderAiConfig(box);
  else if (seg === 'map') renderMapConfig(box);
  else if (seg === 'email') renderEmail(box);
  else if (seg === 'site') renderSite(box);
  else if (seg === 'app') renderAppUpdate(box);
  else if (seg === 'audit') renderAudit(box);
  else box.innerHTML = '<div class="empty">页面不存在</div>';
}

/* ---------- 总览 ---------- */
async function renderOverview(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api.get('/admin/overview');
    const cards = [
      ['用户总数', d.userTotal], ['在线用户', d.onlineUsers], ['路线总数', d.routeTotal],
      ['近 7 日新增用户', '+' + d.user7], ['近 7 日新增路线', '+' + d.route7],
      ['近 30 日新增用户', '+' + d.user30], ['近 30 日新增路线', '+' + d.route30],
      ['数据库大小', (d.dbBytes / 1024).toFixed(1) + ' KB']
    ];
    box.innerHTML = `
      <h2>平台总览</h2>
      <div class="stat-cards">${cards.map(c => `<div class="stat"><div class="v">${c[1]}</div><div class="l">${c[0]}</div></div>`).join('')}</div>
      <div class="panel">
        <h3>快捷入口</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-line" data-goto="users">用户管理</button>
          <button class="btn btn-line" data-goto="ai">AI 配置</button>
          <button class="btn btn-line" data-goto="email">邮件配置</button>
          <button class="btn btn-line" data-goto="site">站点设置</button>
          <button class="btn btn-line" data-goto="audit">审计日志</button>
          <button class="btn btn-line" data-goto="app">APP 更新</button>
          <button class="btn btn-line" id="adminExportBtn">导出全站 CSV</button>
          <button class="btn btn-line" id="adminBackupBtn">备份数据库</button>
        </div>
      </div>`;
    box.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { location.hash = '#/admin/' + b.dataset.goto; });
    box.querySelector('#adminBackupBtn').onclick = async () => {
      try {
        const r = await fetch('/api/admin/db-backup', { credentials: 'same-origin' });
        if (!r.ok) { const j = await r.json().catch(() => null); throw new Error((j && j.msg) || '备份失败'); }
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'travel-expense-backup-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15) + '.db';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('数据库备份已下载');
      } catch (e) { toast('备份失败：' + e.message); }
    };
    box.querySelector('#adminExportBtn').onclick = async () => {
      try {
        const r = await fetch('/api/admin/export?fmt=csv', { credentials: 'same-origin' });
        if (!r.ok) { const j = await r.json().catch(() => null); throw new Error((j && j.msg) || '导出失败'); }
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'all-routes.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { toast('导出失败：' + e.message); }
    };
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------- APP 更新（安卓安装包分发：APP 端自更新的数据源） ---------- */
async function renderAppUpdate(box) {
  let data;
  try { data = await api.get('/admin/apk'); }
  catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const info = data && data.apk;
  const maxSize = (data && data.maxSize) || 0;
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  box.innerHTML = `
    <h2>APP 更新</h2>
    <div class="panel">
      <h3>服务端当前的安卓安装包</h3>
      ${info ? `
        <div class="kv"><span class="k">版本</span><span class="v">${esc(info.versionName || '未命名')}（versionCode ${info.versionCode}）</span></div>
        <div class="kv"><span class="k">大小 / 发布时间</span><span class="v">${mb(info.size)} · ${info.publishedAt ? fmtTime(info.publishedAt) : '—'}</span></div>
        <div class="kv"><span class="k">sha256</span><span class="v" style="font-size:12px;word-break:break-all">${esc(info.sha256)}</span></div>
        ${info.notes ? `<div class="kv"><span class="k">更新说明</span><span class="v">${esc(info.notes)}</span></div>` : ''}
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
          <button class="btn btn-line btn-sm" id="apkDownload">下载当前 APK</button>
          <button class="btn btn-danger btn-sm" id="apkDelete">删除（APP 端将不再提示更新）</button>
        </div>` : `
        <div class="empty">尚未上传 APK —— 此时 APP 端不会提示原生包更新，只走 web 层静默热更新。</div>`}
    </div>
    <div class="panel">
      <h3>上传新版 APK</h3>
      <div class="hint" style="margin-bottom:10px">
        从 GitHub Release 下载 <b>app-release.apk</b>；若一并选中同批的 <b>app-release.json</b> 会自动填写版本号。
        versionCode 必须<b>大于</b>用户设备已装版本，APP 才会弹更新提示。单文件上限 ${mb(maxSize)}。
      </div>
      <div class="field"><label>APK 文件 <span class="hint">可同时选 .json 自动填版本</span></label>
        <input type="file" id="apkFile" accept=".apk,.json,application/vnd.android.package-archive" multiple></div>
      <div class="field"><label>versionCode <span class="hint">整数，见 Release 说明或构建日志</span></label>
        <input id="apkVc" inputmode="numeric" placeholder="例如 10007"></div>
      <div class="field"><label>版本名 <span class="hint">展示给用户</span></label>
        <input id="apkVn" placeholder="例如 1.0.7"></div>
      <div class="field"><label>更新说明 <span class="hint">可选，会显示在 APP 的更新弹窗中</span></label>
        <input id="apkNotes" placeholder="例如：新增 APP 内自动更新"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="btn btn-primary" id="apkUpload">上传并生效</button>
      </div>
    </div>`;

  const fileEl = box.querySelector('#apkFile');
  const vcEl = box.querySelector('#apkVc');
  const vnEl = box.querySelector('#apkVn');
  const notesEl = box.querySelector('#apkNotes');
  let apkBlob = null;

  fileEl.onchange = async () => {
    apkBlob = null;
    const files = Array.from(fileEl.files || []);
    const apk = files.find(f => /\.apk$/i.test(f.name));
    const meta = files.find(f => /\.json$/i.test(f.name));
    if (apk) apkBlob = apk;
    if (meta) {
      try {
        const j = JSON.parse(await meta.text());
        if (j.versionCode) vcEl.value = String(j.versionCode);
        if (j.versionName) vnEl.value = String(j.versionName);
        if (j.notes && !notesEl.value) notesEl.value = String(j.notes).slice(0, 200);
        toast('已从 ' + meta.name + ' 读取版本信息');
      } catch (e) { toast('元数据文件解析失败：' + e.message); }
    }
  };

  if (box.querySelector('#apkDownload')) {
    box.querySelector('#apkDownload').onclick = () => { location.href = '/api/app/apk'; };
  }
  if (box.querySelector('#apkDelete')) {
    box.querySelector('#apkDelete').onclick = async () => {
      if (!confirm('删除服务端 APK？删除后 APP 端不再提示原生包更新（已装的 APP 不受影响）。')) return;
      try { await api.del('/admin/apk'); toast('已删除'); renderAppUpdate(box); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  }
  box.querySelector('#apkUpload').onclick = async () => {
    if (!apkBlob) return toast('请先选择 .apk 文件');
    const vc = parseInt(vcEl.value, 10) || 0;
    if (!(vc > 0)) return toast('请填写正确的 versionCode（正整数）');
    const btn = box.querySelector('#apkUpload');
    btn.disabled = true;
    btn.textContent = '上传中…';
    try {
      const qs = new URLSearchParams({ versionCode: String(vc), versionName: vnEl.value.trim(), notes: notesEl.value.trim() });
      const r = await fetch('/api/admin/apk?' + qs.toString(), {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' }, body: apkBlob
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.msg) || ('上传失败 (' + r.status + ')'));
      toast('已上传 versionCode ' + vc + '，APP 端下次启动将提示更新');
      renderAppUpdate(box);
    } catch (e) {
      toast('上传失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '上传并生效';
    }
  };
}

/* ---------- 用户管理 ---------- */
let userPage = 1;
async function renderUsers(box) {
  box.innerHTML = `<h2>用户管理</h2>
    <div class="toolbar">
      <div class="grow"><input id="u_q" placeholder="搜索用户名 / 邮箱"></div>
      <select id="u_status" style="width:auto"><option value="">全部状态</option><option value="active">正常</option><option value="banned">已封禁</option></select>
      <select id="u_role" style="width:auto"><option value="">全部角色</option><option value="admin">管理员</option><option value="user">普通用户</option></select>
      <button class="btn btn-line" id="u_search">查询</button>
    </div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>用户名</th><th>邮箱</th><th>角色</th><th>注册时间</th><th>在线</th><th>状态</th><th>路线数</th><th>最后登录</th><th>操作</th></tr></thead>
      <tbody id="u_body"><tr><td colspan="9" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <div class="pager" id="u_pager"></div>`;

  const search = async () => {
    const q = document.getElementById('u_q').value.trim();
    const status = document.getElementById('u_status').value;
    const role = document.getElementById('u_role').value;
    await loadUserPage(box, { q, status, role });
  };
  document.getElementById('u_search').onclick = () => { userPage = 1; search(); };
  document.getElementById('u_q').addEventListener('keydown', e => { if (e.key === 'Enter') { userPage = 1; search(); } });
  await search();
}

async function loadUserPage(box, filter) {
  const me = store.user;
  const qs = new URLSearchParams({ page: userPage, pageSize: 20 });
  if (filter.q) qs.set('q', filter.q);
  if (filter.status) qs.set('status', filter.status);
  if (filter.role) qs.set('role', filter.role);
  const body = document.getElementById('u_body');
  try {
    const d = await api.get('/admin/users?' + qs.toString());
    const totalPages = Math.max(1, Math.ceil(d.total / 20));
    if (!d.list.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty">暂无用户</td></tr>';
    } else {
      body.innerHTML = d.list.map(u => `<tr>
        <td><strong>${esc(u.username || '—')}</strong>${u.id === me.id ? ' <span class="pill pill-ok">我</span>' : ''}</td>
        <td>${esc(u.email || '—')}</td>
        <td>${u.role === 'admin' ? '<span class="pill pill-admin">管理员</span>' : '<span class="pill pill-user">用户</span>'}</td>
        <td style="white-space:nowrap">${fmtTime(u.created_at).slice(0, 10)}</td>
        <td><span class="dot ${u.online ? 'on' : 'off'}"></span>${u.online ? '在线' : '离线'}</td>
        <td>${u.status === 'banned' ? '<span class="pill pill-ban">已封禁</span>' : '<span class="pill pill-ok">正常</span>'}</td>
        <td>${u.route_count}</td>
        <td style="white-space:nowrap">${u.last_login ? fmtTime(u.last_login).slice(0, 10) : '<span style="color:#9aa">从未登录</span>'}</td>
        <td><div class="ops">
          ${u.status === 'banned'
            ? `<button class="btn btn-sm btn-line" data-act="unban" data-id="${u.id}" data-name="${esc(u.username || u.email)}">解封</button>`
            : (u.id !== me.id && u.role !== 'admin' ? `<button class="btn btn-sm btn-danger" data-act="ban" data-id="${u.id}" data-name="${esc(u.username || u.email)}">禁止</button>` : '')}
          ${u.id !== me.id
            ? (u.role === 'admin'
              ? `<button class="btn btn-sm btn-line" data-act="degrade" data-id="${u.id}" data-name="${esc(u.username || u.email)}">取消管理员</button>`
              : `<button class="btn btn-sm btn-line" data-act="promote" data-id="${u.id}" data-name="${esc(u.username || u.email)}">设为管理员</button>`)
            : ''}
        </div></td></tr>`).join('');
    }
    const pager = document.getElementById('u_pager');
    pager.innerHTML = `<button class="btn btn-sm" ${userPage <= 1 ? 'disabled' : ''} id="u_prev">上一页</button>
      <span>${userPage} / ${totalPages}（共 ${d.total} 人）</span>
      <button class="btn btn-sm" ${userPage >= totalPages ? 'disabled' : ''} id="u_next">下一页</button>`;
    const pv = document.getElementById('u_prev');
    const nx = document.getElementById('u_next');
    if (pv) pv.onclick = () => { if (userPage > 1) { userPage--; loadUserPage(box, filter); } };
    if (nx) nx.onclick = () => { if (userPage < totalPages) { userPage++; loadUserPage(box, filter); } };
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)}</td></tr>`;
  }
}

async function handleUserAction(btn) {
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const name = btn.dataset.name;
  const ip = '/admin/users/' + id + '/' + (act === 'ban' ? 'ban' : act === 'unban' ? 'unban' : 'role');
  if (act === 'ban') {
    if (!confirm(`确定禁止用户「${name}」？该用户将立即掉线且无法登录。`)) return;
  } else if (act === 'promote') {
    if (!confirm(`确定将「${name}」设为管理员？其将获得后台全部权限。`)) return;
  } else if (act === 'degrade') {
    if (!confirm(`确定取消「${name}」的管理员身份？`)) return;
  }
  try {
    await api.post(ip, act === 'promote' ? { role: 'admin' } : act === 'degrade' ? { role: 'user' } : undefined);
    toast(act === 'ban' ? '已封禁' : act === 'unban' ? '已解封' : act === 'promote' ? '已设为管理员' : '已取消管理员');
    renderAdmin();
  } catch (e) { toast(e.message); }
}

/* ---------- 地图配置（足迹底图增强） ---------- */
async function renderMapConfig(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let cfg;
  try { cfg = await api.get('/admin/map-config'); }
  catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const prov = cfg.provider || 'none';
  box.innerHTML = `<h2>足迹地图配置</h2>
    <div class="hint" style="margin-bottom:12px">默认关闭 —— 足迹页使用自绘点阵示意（不含行政边界线，合规风险最低）。
      接入图商后足迹地图改为真实底图渲染（点亮标记/省名标注/缩放拖动），底图由持牌图商输出，领土要素合规。
      <b>地图展示本身不消耗 Key 的 REST 调用配额</b>，仅在管理员点击「测试连通性」时产生一次 REST 校验。
      请自行前往对应开放平台申请 <b>Web 端（JS API）</b> Key，并绑定你自托管站点的域名白名单。</div>
    <div class="admin-form">
      <div class="field"><label>地图类型 <span class="hint">默认关闭；开启后所有登录用户的足迹页生效</span></label>
        <select id="map_provider">
          <option value="none" ${prov === 'none' ? 'selected' : ''}>关闭（自绘点阵示意）</option>
          <option value="amap" ${prov === 'amap' ? 'selected' : ''}>高德地图（JS API 2.0）</option>
          <option value="tencent" ${prov === 'tencent' ? 'selected' : ''}>腾讯地图（GL JS）</option>
        </select></div>
      <div class="field" id="map_amap_rows" style="display:${prov === 'amap' ? '' : 'none'}">
        <div class="field"><label>高德 Key <span class="hint">${cfg.amap_key ? '已设置，留空/****** 保持不变' : ' lbs.amap.com → 应用管理 → 创建 Key，类型务必选「Web端(JS API)」'}</span></label>
          <input id="map_amap_key" placeholder="${cfg.amap_key ? '******' : '在高德开放平台申请的 Web端(JS API) Key'}"></div>
        <div class="field"><label>高德安全密钥 securityJsCode <span class="hint">${cfg.amap_security ? '已设置，保持不变' : '2021-12 起申请的 Key 必须配套（应用详情 → securityJsCode）'}</span></label>
          <input id="map_amap_security" placeholder="${cfg.amap_security ? '******' : 'securityJsCode'}"></div>
        <div class="hint">测试连通性走 Web 服务通道：若返回「PLAT_NOMATCH 属预期现象」说明 Key 类型正确（JS API Key），以足迹页实际加载为准；返回 INVALID_USER_KEY 才是 Key 本身错误。</div>
      </div>
      <div class="field" id="map_tencent_rows" style="display:${prov === 'tencent' ? '' : 'none'}">
        <label>腾讯地图 Key <span class="hint">${cfg.tencent_key ? '已设置，保持不变' : ' lbs.qq.com → 控制台 → 创建 Key，并勾选「WebServiceAPI」产品 + 域名白名单'}</span></label>
        <input id="map_tencent_key" placeholder="${cfg.tencent_key ? '******' : '在腾讯位置服务控制台申请的 Key'}">
        <div class="hint">测试连通性需该 Key 勾选「WebServiceAPI」；若 Key 启用了域名白名单，服务端测试可能返回「已识别但被白名单拒绝」——属预期，以足迹页实际加载为准。</div>
      </div>
      <div class="auth-actions" style="flex-direction:row">
        <button class="btn btn-line" id="map_test">测试连通性</button>
        <button class="btn btn-primary" id="map_save">保存配置</button>
      </div>
      <div id="map_test_result" style="margin-top:10px"></div>
    </div>`;

  const provSel = document.getElementById('map_provider');
  provSel.onchange = () => {
    document.getElementById('map_amap_rows').style.display = provSel.value === 'amap' ? '' : 'none';
    document.getElementById('map_tencent_rows').style.display = provSel.value === 'tencent' ? '' : 'none';
  };
  const currentKey = () => {
    const p = provSel.value;
    if (p === 'amap') return { provider: 'amap', amap_key: document.getElementById('map_amap_key').value };
    if (p === 'tencent') return { provider: 'tencent', tencent_key: document.getElementById('map_tencent_key').value };
    return { provider: 'none' };
  };

  document.getElementById('map_test').onclick = async () => {
    const btn = document.getElementById('map_test');
    const out = document.getElementById('map_test_result');
    btn.disabled = true; btn.textContent = '测试中…';
    out.innerHTML = '<div class="hint">正在向图商发起校验（约 1-3 秒）…</div>';
    try {
      /* 测试时 '******' 输入框留空 → 服务端自动沿用已保存 key */
      const p = provSel.value;
      const body = { provider: p };
      if (p === 'amap') body.amap_key = document.getElementById('map_amap_key').value || '******';
      if (p === 'tencent') body.tencent_key = document.getElementById('map_tencent_key').value || '******';
      const res = await api.post('/admin/map-config/test', body);
      out.innerHTML = res && res.ok
        ? '<div class="banner" style="margin:0">✓ ' + esc(res.message) + '</div>'
        : '<div class="banner" style="margin:0;background:#fcebeb;border-color:#f0b3b3">✗ ' + esc((res && res.message) || '测试失败') + '</div>';
    } catch (e) {
      out.innerHTML = '<div class="banner" style="margin:0;background:#fcebeb;border-color:#f0b3b3">✗ ' + esc(e.message || '测试失败') + '</div>';
    } finally { btn.disabled = false; btn.textContent = '测试连通性'; }
  };

  document.getElementById('map_save').onclick = async () => {
    try {
      const body = Object.assign({
        amap_key: document.getElementById('map_amap_key') ? document.getElementById('map_amap_key').value : '',
        amap_security: document.getElementById('map_amap_security') ? document.getElementById('map_amap_security').value : '',
        tencent_key: document.getElementById('map_tencent_key') ? document.getElementById('map_tencent_key').value : ''
      }, currentKey());
      /* '******' 语义由后端处理：输入框为空时也视为保持原值（传 '******'） */
      if (provSel.value === 'amap') {
        if (!body.amap_key) body.amap_key = cfg.amap_key ? '******' : '';
        if (!body.amap_security) body.amap_security = cfg.amap_security ? '******' : '';
      }
      if (provSel.value === 'tencent' && !body.tencent_key) body.tencent_key = cfg.tencent_key ? '******' : '';
      await api.post('/admin/map-config', body);
      toast('地图配置已保存' + (provSel.value === 'none' ? '（已关闭底图增强）' : '，足迹页刷新后生效'));
      renderMapConfig(box);
    } catch (e) { toast('保存失败：' + e.message); }
  };
}

/* ---------- AI 配置 ---------- */
async function renderAiConfig(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let cfg, users;
  try {
    [cfg, users] = await Promise.all([
      api.get('/admin/ai-config'),
      api.get('/admin/ai-config/users')
    ]);
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const enabledIds = new Set((cfg.enabled_users || []).map(u => u.id));
  box.innerHTML = `<h2>AI 模型配置</h2>
    <div class="admin-form">
      <div class="field"><label>API 接口地址 <span class="hint">OpenAI 兼容格式，如 https://api.openai.com/v1</span></label>
        <input id="ai_base_url" value="${esc(cfg.api_base_url)}" placeholder="https://api.openai.com/v1"></div>
      <div class="field"><label>API 密钥 <span class="hint">${cfg.api_key ? '已设置，留空保持不变' : ''}</span></label>
        <input id="ai_api_key" type="password" placeholder="${cfg.api_key ? '******' : 'sk-...'}"></div>
      <div class="field"><label>模型 ID <span class="hint">如 gpt-4o-mini、qwen-plus、deepseek-chat</span></label>
        <input id="ai_model_id" value="${esc(cfg.model_id)}" placeholder="gpt-4o-mini"></div>
      <div class="field"><label class="switch"><input type="checkbox" id="ai_enabled" ${cfg.enabled ? 'checked' : ''}> 启用 AI 行程规划功能</label></div>
      <div class="field"><label class="switch"><input type="checkbox" id="ai_skip_ssl" ${cfg.skip_ssl_verify ? 'checked' : ''}> 跳过 SSL 证书验证 <span class="hint">内网/自签名证书（如 Synology NAS）时开启</span></label></div>
      <div class="auth-actions" style="flex-direction:row">
        <button class="btn btn-line" id="ai_test">测试连接</button>
        <button class="btn btn-primary" id="ai_save">保存配置</button>
      </div>
    </div>
    <div style="height:24px"></div>
    <h3 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">AI 规划提示词
      <button class="btn btn-sm btn-line" id="ai_reset_prompts" type="button">恢复默认提示词</button>
    </h3>
    <div class="hint" style="margin-bottom:10px">自定义提示词可获得不同风格、详略与侧重的规划结果。模板中的 <code>{占位符}</code> 会在调用时自动替换为实际内容；修改后点击上方「保存配置」生效。留空则使用内置默认。</div>
    <div class="panel" style="padding:16px">
      <div class="field">
        <label>行程规划 · 系统提示词（角色设定）</label>
        <textarea id="ai_plan_sys" rows="2" style="font-family:monospace;font-size:12px;line-height:1.5">${esc(cfg.plan_system_prompt)}</textarea>
      </div>
      <div class="field">
        <label>行程规划 · 用户提示词模板
          <span class="hint">可用占位符：{dest} 目的地、{startDate} 开始日期、{endDate} 结束日期、{days} 天数</span></label>
        <textarea id="ai_plan_user" rows="15" style="font-family:monospace;font-size:12px;line-height:1.5">${esc(cfg.plan_user_prompt)}</textarea>
      </div>
      <div class="field">
        <label>对话调整 · 系统提示词（角色设定）</label>
        <textarea id="ai_chat_sys" rows="2" style="font-family:monospace;font-size:12px;line-height:1.5">${esc(cfg.chat_system_prompt)}</textarea>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>对话调整 · 用户提示词模板
          <span class="hint">可用占位符：{currentScenic} 当前行程、{currentNotes} 当前备注、{message} 调整要求、{dest}、{startDate}、{endDate}、{days}</span></label>
        <textarea id="ai_chat_user" rows="17" style="font-family:monospace;font-size:12px;line-height:1.5">${esc(cfg.chat_user_prompt)}</textarea>
      </div>
    </div>
    <div style="height:24px"></div>
    <h3>启用 AI 功能的用户</h3>
    <div class="hint" style="margin-bottom:10px">勾选后，对应用户在路线编辑页面将看到「AI 规划」按钮，可一键生成行程路线。</div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th style="width:50px"><input type="checkbox" id="ai_check_all"></th><th>用户名</th><th>邮箱</th><th>角色</th><th>状态</th></tr></thead>
      <tbody id="ai_user_body">
        ${(users.list || []).map(u => `<tr>
          <td><input type="checkbox" class="ai_user_cb" data-id="${u.id}" ${enabledIds.has(u.id) ? 'checked' : ''} ${u.status === 'banned' ? 'disabled' : ''}></td>
          <td><strong>${esc(u.username || '—')}</strong></td>
          <td>${esc(u.email || '—')}</td>
          <td>${u.role === 'admin' ? '<span class="pill pill-admin">管理员</span>' : '<span class="pill pill-user">用户</span>'}</td>
          <td>${u.status === 'banned' ? '<span class="pill pill-ban">已封禁</span>' : '<span class="pill pill-ok">正常</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无用户</td></tr>'}
      </tbody>
    </table></div>
    <div class="auth-actions" style="flex-direction:row;margin-top:12px">
      <button class="btn btn-primary" id="ai_save_users">保存启用用户</button>
    </div>`;

  /* 全选/取消全选 */
  const checkAll = document.getElementById('ai_check_all');
  if (checkAll) {
    checkAll.onchange = () => {
      document.querySelectorAll('.ai_user_cb:not(:disabled)').forEach(cb => { cb.checked = checkAll.checked; });
    };
  }

  /* 测试连接：使用当前表单中的配置（未保存也可测试） */
  document.getElementById('ai_test').onclick = async () => {
    const btn = document.getElementById('ai_test');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const res = await api.post('/admin/ai-config/test', {
        api_base_url: document.getElementById('ai_base_url').value.trim(),
        api_key: document.getElementById('ai_api_key').value,
        model_id: document.getElementById('ai_model_id').value.trim(),
        skip_ssl_verify: document.getElementById('ai_skip_ssl').checked
      });
      toast('连接成功！模型回复：' + (res && res.reply ? res.reply : '正常'));
    } catch (e) {
      toast(e.message || '测试失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  };

  /* 保存配置（含提示词） */
  document.getElementById('ai_save').onclick = async () => {
    try {
      await api.put('/admin/ai-config', {
        api_base_url: document.getElementById('ai_base_url').value.trim(),
        api_key: document.getElementById('ai_api_key').value,
        model_id: document.getElementById('ai_model_id').value.trim(),
        enabled: document.getElementById('ai_enabled').checked,
        skip_ssl_verify: document.getElementById('ai_skip_ssl').checked,
        plan_system_prompt: document.getElementById('ai_plan_sys').value,
        plan_user_prompt: document.getElementById('ai_plan_user').value,
        chat_system_prompt: document.getElementById('ai_chat_sys').value,
        chat_user_prompt: document.getElementById('ai_chat_user').value
      });
      toast('AI 配置已保存');
    } catch (e) { toast(e.message); }
  };

  /* 恢复默认提示词：用后端下发的 default_prompts 回填（仍需点保存才会持久化） */
  document.getElementById('ai_reset_prompts').onclick = () => {
    const d = cfg.default_prompts || {};
    if (!d.plan_system_prompt) { toast('未获取到默认提示词'); return; }
    if (!confirm('确定把四个提示词恢复为内置默认？恢复后需点击「保存配置」生效。')) return;
    document.getElementById('ai_plan_sys').value = d.plan_system_prompt || '';
    document.getElementById('ai_plan_user').value = d.plan_user_prompt || '';
    document.getElementById('ai_chat_sys').value = d.chat_system_prompt || '';
    document.getElementById('ai_chat_user').value = d.chat_user_prompt || '';
    toast('已恢复为默认提示词，请点击「保存配置」');
  };

  /* 保存启用用户 */
  document.getElementById('ai_save_users').onclick = async () => {
    const userIds = Array.from(document.querySelectorAll('.ai_user_cb:checked')).map(cb => parseInt(cb.dataset.id, 10));
    try {
      await api.put('/admin/ai-config/users', { user_ids: userIds });
      toast('已保存启用用户列表（' + userIds.length + ' 人）');
    } catch (e) { toast(e.message); }
  };
}

/* ---------- 邮件配置 ---------- */
async function renderEmail(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let cfg;
  try { cfg = await api.get('/admin/email-config'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<h2>邮件服务器配置</h2>
    <div class="admin-form">
      <div class="form-row">
        <div class="field"><label>SMTP 主机</label><input id="m_host" value="${esc(cfg.smtp_host)}" placeholder="smtp.example.com"></div>
        <div class="field" style="flex:0 0 110px"><label>端口</label><input id="m_port" value="${cfg.smtp_port}" inputmode="numeric"></div>
      </div>
      <div class="field"><label>加密方式</label>
        <select id="m_secure">
          <option value="1" ${cfg.smtp_secure ? 'selected' : ''}>SSL/TLS（465）</option>
          <option value="0" ${!cfg.smtp_secure ? 'selected' : ''}>STARTTLS（587）</option>
        </select></div>
      <div class="form-row">
        <div class="field"><label>账号</label><input id="m_user" value="${esc(cfg.smtp_user)}"></div>
        <div class="field"><label>密码 <span class="hint">${cfg.smtp_pass ? '已设置，留空保持不变' : ''}</span></label>
          <input id="m_pass" type="password" placeholder="${cfg.smtp_pass ? '******' : 'SMTP 密码'}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>发件人名称</label><input id="m_from_name" value="${esc(cfg.from_name)}" placeholder="旅行经费工作台"></div>
        <div class="field"><label>发件人地址</label><input id="m_from_addr" value="${esc(cfg.from_address)}" placeholder="noreply@example.com"></div>
      </div>
      <div class="field"><label class="switch"><input type="checkbox" id="m_enabled" ${cfg.enabled ? 'checked' : ''}> 启用邮件发送（发送验证码）</label></div>
      <div class="auth-actions" style="flex-direction:row">
        <button class="btn btn-line" id="m_test">发送测试邮件</button>
        <button class="btn btn-primary" id="m_save">保存配置</button>
      </div>
    </div>`;
  document.getElementById('m_save').onclick = async () => {
    const body = {
      smtp_host: document.getElementById('m_host').value.trim(),
      smtp_port: parseInt(document.getElementById('m_port').value) || 465,
      smtp_secure: document.getElementById('m_secure').value === '1',
      smtp_user: document.getElementById('m_user').value.trim(),
      smtp_pass: document.getElementById('m_pass').value,
      from_name: document.getElementById('m_from_name').value.trim(),
      from_address: document.getElementById('m_from_addr').value.trim(),
      enabled: document.getElementById('m_enabled').checked
    };
    try { await api.put('/admin/email-config', body); toast('配置已保存'); } catch (e) { toast(e.message); }
  };
  document.getElementById('m_test').onclick = async () => {
    const btn = document.getElementById('m_test');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try { await api.post('/admin/email-config/test'); toast('测试邮件发送成功'); }
    catch (e) { toast(e.message); }
    btn.disabled = false;
    btn.textContent = '发送测试邮件';
  };
}

/* ---------- 站点设置 ---------- */
async function renderSite(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let s;
  try { s = await api.get('/admin/site-settings'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<h2>站点设置</h2>
    <div class="admin-form">
      <div class="field"><label>站点名称</label><input id="s_name" value="${esc(s.site_name)}"></div>
      <div class="field"><label class="switch"><input type="checkbox" id="s_reg" ${s.allow_register ? 'checked' : ''}> 开放注册</label>
        <div class="hint">关闭后注册入口隐藏，仅管理员可在后台处理</div></div>
      <div class="field"><label>注册方式</label>
        <select id="s_mode">
          <option value="all" ${s.register_mode === 'all' ? 'selected' : ''}>全部（邮箱 + 账户名）</option>
          <option value="email_only" ${s.register_mode === 'email_only' ? 'selected' : ''}>仅邮箱</option>
          <option value="username_only" ${s.register_mode === 'username_only' ? 'selected' : ''}>仅账户名</option>
        </select></div>
      <div class="field"><label>首页公告横幅 <span class="hint">留空不显示</span></label>
        <textarea id="s_announce" placeholder="欢迎使用…">${esc(s.announce_text)}</textarea></div>
      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="s_save">保存设置</button>
      </div>
    </div>`;
  document.getElementById('s_save').onclick = async () => {
    const body = {
      site_name: document.getElementById('s_name').value.trim() || '旅行经费工作台',
      allow_register: document.getElementById('s_reg').checked,
      register_mode: document.getElementById('s_mode').value,
      announce_text: document.getElementById('s_announce').value
    };
    try {
      await api.put('/admin/site-settings', body);
      Object.assign(store.site, body);
      toast('设置已保存');
    } catch (e) { toast(e.message); }
  };
}

/* ---------- 审计日志 ---------- */
let auditPage = 1;
async function renderAudit(box) {
  box.innerHTML = `<h2>操作审计日志</h2>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>详情</th><th>IP</th></tr></thead>
      <tbody id="a_body"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <div class="pager" id="a_pager"></div>`;
  await loadAuditPage();
}

async function loadAuditPage() {
  const body = document.getElementById('a_body');
  try {
    const d = await api.get('/admin/audit-logs?page=' + auditPage + '&pageSize=20');
    const totalPages = Math.max(1, Math.ceil(d.total / 20));
    if (!d.list.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">暂无审计记录</td></tr>';
    } else {
      body.innerHTML = d.list.map(l => `<tr>
        <td style="white-space:nowrap">${fmtTime(l.created_at)}</td>
        <td>${esc(l.actor)}</td>
        <td><span class="pill pill-admin">${esc(l.action)}</span></td>
        <td>${esc(l.target_type || '—')}</td>
        <td>${esc(l.detail || '—')}</td>
        <td class="mono">${esc(l.ip || '—')}</td></tr>`).join('');
    }
    const pager = document.getElementById('a_pager');
    pager.innerHTML = `<button class="btn btn-sm" ${auditPage <= 1 ? 'disabled' : ''} id="a_prev">上一页</button>
      <span>${auditPage} / ${totalPages}（共 ${d.total} 条）</span>
      <button class="btn btn-sm" ${auditPage >= totalPages ? 'disabled' : ''} id="a_next">下一页</button>`;
    const pv = document.getElementById('a_prev');
    const nx = document.getElementById('a_next');
    if (pv) pv.onclick = () => { if (auditPage > 1) { auditPage--; loadAuditPage(); } };
    if (nx) nx.onclick = () => { if (auditPage < totalPages) { auditPage++; loadAuditPage(); } };
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`;
  }
}

/* 页面级事件委托（用户管理表格操作按钮） */
export function bindAdminEvents() {
  const view = document.getElementById('view');
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn && ['ban', 'unban', 'promote', 'degrade'].includes(btn.dataset.act)) {
      handleUserAction(btn);
    }
  });
}
