/* 多用户版后端入口：http server + 路由分发 + 静态托管（前端由后端内置托管，单容器）
 * 启动：node app.js（默认 3000，DATA_DIR 默认 ../data）
 * 端口 3000 直出前端静态资源 + /api/* + /health + /share/:token */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const dbModule = require('./db');
const fx = require('./fx');
const { send, fail, readBody, parseUrl } = require('./http');
const auth = require('./auth');
const routesApi = require('./routes_api');
const adminApi = require('./admin_api');
const footprintApi = require('./footprint_api');
const appBundle = require('./app_bundle');
const appUpdate = require('./app_update');

let db;
try {
  db = dbModule.initDb();
} catch (e) {
  console.error('[fatal] DB 初始化失败，阻止启动：', e.message);
  process.exit(1);
}

/* ---------- 实时汇率：启动时刷新 + 定时刷新（仅配置 FX_API_URL 时启用） ---------- */
async function refreshFx() {
  if (!config.FX_API_URL) return;
  try {
    const ok = await fx.refreshFromApi(config.FX_API_URL, 4000);
    if (ok) console.log('[fx] 实时汇率已刷新');
  } catch (e) { console.error('[fx] 汇率刷新失败，使用静态兜底:', e.message); }
}
refreshFx();
const fxTimer = setInterval(refreshFx, config.FX_REFRESH_INTERVAL_MS);
fxTimer.unref(); // 不阻止进程退出

/* ---------- 安全响应头（所有响应统一设置） ---------- */
function buildSecurityHeaders() {
  /* 开启跨域客户端（安卓 APP 等独立客户端）时放宽 connect-src：
     WebView 内的 SPA 需向用户自托管的 https 服务器发起跨域请求。
     WebView 本身不加载本服务的 CSP（SPA 由 capacitor://localhost 提供），
     此处放宽同时覆盖「浏览器内配置远程服务器」的客户端场景。 */
  const connectSrc = config.ALLOWED_ORIGINS.length > 0
    ? "connect-src 'self' https:;"
    : "connect-src 'self';";
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    /* CSP：script 仅同源（ES Modules 无内联脚本）；style 允许内联（大量 style 属性）；
       frame-ancestors 'none' 等价 X-Frame-Options DENY
       分享页需要内联脚本（导出图片功能），分享页单独设置 CSP */
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ${connectSrc} frame-ancestors 'none'`
  };
  if (config.COOKIE_SECURE) {
    h['Strict-Transport-Security'] = `max-age=${config.HSTS_MAX_AGE}; includeSubDomains`;
  }
  return h;
}
function applySecurityHeaders(res) {
  const h = buildSecurityHeaders();
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

/* ---------- CORS：仅当配置 ALLOWED_ORIGINS 时启用（默认关闭，保持同源 Web 应用不变） ----------
 * 回显请求 Origin（支持带凭证的跨域）；OPTIONS 预检直接 204。 */
function applyCors(req, res) {
  if (config.ALLOWED_ORIGINS.length === 0) return false;
  const origin = (req.headers.origin || '').toLowerCase();
  if (!origin) return false;
  const allowAll = config.ALLOWED_ORIGINS.includes('*');
  if (!allowAll && !config.ALLOWED_ORIGINS.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  /* 必须覆盖前端实际用到的全部写方法：修改流水 / 同行人走 PATCH，
   * 缺 PATCH 会导致 APP（跨域）预检失败、fetch 抛 TypeError（浏览器同源无预检故不受影响）。 */
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/* ---------- 访问日志 ---------- */
function accessLog(req, res, startMs, statusCode) {
  if (!config.ACCESS_LOG) return;
  const dur = Date.now() - startMs;
  const ip = req.socket.remoteAddress || '-';
  console.log(`${ip} - ${req.method} ${req.url} -> ${statusCode} (${dur}ms)`);
}

/* 同源校验：写操作需 Origin/Referer 与 Host 同域；无来源头放行（curl/服务端调用）
 * 若配置 TRUSTED_HOSTS，则额外校验 Host 必须在可信列表中（防 Host 头伪造） */
function sameOrigin(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const host = (req.headers.host || '').toLowerCase();
  if (!host) return true;
  /* 跨域客户端来源：命中 ALLOWED_ORIGINS 视为可信，放行写操作（配合 CORS 头） */
  const origin = (req.headers.origin || '').toLowerCase();
  if (config.ALLOWED_ORIGINS.length > 0 && origin &&
      (config.ALLOWED_ORIGINS.includes('*') || config.ALLOWED_ORIGINS.includes(origin))) {
    return true;
  }
  /* 可信主机校验：配置后 Host 必须匹配可信域名（含端口） */
  if (config.TRUSTED_HOSTS.length > 0 && !config.TRUSTED_HOSTS.includes(host)) {
    return false;
  }
  const referer = req.headers.referer;
  if (!origin && !referer) return true;
  const sameHost = (u) => { try { return new URL(u).host.toLowerCase() === host; } catch { return false; } };
  if (origin) return sameHost(origin);
  return sameHost(referer);
}

/* 初始密码强制修改：服务端硬门禁
 * 前端仅做页面跳转（app.js / auth.js），直接调用 API 可完全绕过，故必须在服务端拦截。
 * 放行范围：
 *   · /api/auth/*        —— 改密、登出、me（前端据此渲染引导页）、登录/注册/验证码
 *   · /api/public/*      —— 登录页与应用启动所需的站点信息
 *   · /api/app/*         —— APP 热更新与应用包下载（启动时尚无登录态）
 * 其余 /api/* 在 force_reset=1 时统一 403，前端据 code 跳转「设置新密码」。 */
function passwordResetBlocked(req, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/api/auth/')) return false;
  if (url.pathname.startsWith('/api/public/')) return false;
  if (url.pathname.startsWith('/api/app/')) return false;
  const u = auth.authFromReq(req);
  return !!(u && u.force_reset);
}

const server = http.createServer(async (req, res) => {
  const startMs = Date.now();
  applySecurityHeaders(res);
  /* CORS 预检/跨域头：若命中 ALLOWED_ORIGINS，OPTIONS 在此直接结束 */
  if (applyCors(req, res)) { accessLog(req, res, startMs, 204); return; }
  const url = parseUrl(req.url || '/');

  /* 健康检查（含 DB 连通性校验） */
  if (url.pathname === '/health') {
    let dbOk = false;
    try { db.prepare('SELECT 1').get(); dbOk = true; } catch (e) { /* db 不可用 */ }
    const status = dbOk ? 200 : 503;
    accessLog(req, res, startMs, status);
    return send(res, status, { ok: dbOk, ts: Date.now(), db: dbOk ? 'ok' : 'error' });
  }

  /* CSRF 同源加固：写操作（非 GET/HEAD/OPTIONS）要求 Origin/Referer 与 Host 同域
   * 无来源头（curl / 服务端调用 / 同源老客户端）放行，避免阻断合法请求与测试 */
  if (!sameOrigin(req)) {
    accessLog(req, res, startMs, 403);
    return fail(res, 403, '跨站请求被拒绝', { code: 'BAD_ORIGIN' });
  }

  /* 初始密码未修改时，除 auth/public/app 外的 API 一律拒绝（见 passwordResetBlocked 注释） */
  if (passwordResetBlocked(req, url)) {
    accessLog(req, res, startMs, 403);
    return fail(res, 403, '请先修改初始密码后再使用', { code: 'PASSWORD_RESET_REQUIRED' });
  }

  /* 公开站点信息（无需登录） */
  if (url.pathname === '/api/public/site') {
    const s = readSiteSettings();
    accessLog(req, res, startMs, 200);
    return send(res, 200, {
      ok: true,
      data: {
        site_name: s.site_name || '旅行经费工作台',
        allow_register: !!s.allow_register,
        register_mode: s.register_mode || 'all',
        announce_text: s.announce_text || '',
        home_currency: s.home_currency || 'CNY',
        fx_rates: fx.ratesToCny,
        /* 币种符号表的唯一来源（fx.CURRENCY_SYMBOLS），前端复用避免与分享页分叉 */
        currency_symbols: fx.CURRENCY_SYMBOLS
      }
    });
  }

  /* 客户端探测：独立客户端（安卓 APP / 切换服务器）调用，确认该地址是 travel-expense 服务。
   * 返回结构与 /api/public/site 一致：data 内包业务字段。 */
  if (url.pathname === '/api/public/server-check') {
    const s = readSiteSettings();
    accessLog(req, res, startMs, 200);
    return send(res, 200, {
      ok: true,
      data: {
        isTravelExpense: true,
        site_name: s.site_name || '旅行经费工作台',
        allow_register: !!s.allow_register,
        register_mode: s.register_mode || 'all'
      }
    });
  }

  /* 只读分享页：/share/:token（无需登录，纯服务端渲染 + 转义）
   * 分享页单独设置 CSP，允许内联脚本（导出图片功能需要） */
  const shareM = url.pathname.match(/^\/share\/([A-Za-z0-9]+)$/);
  if (shareM) {
    const r = dbModule.findRouteByShareToken(shareM[1]);
    if (!r) { accessLog(req, res, startMs, 404); return send(res, 404, { ok: false, msg: '分享不存在或已失效' }); }
    /* 分享页 CSP：允许内联脚本（导出图片），允许 data: 图片（导出预览） */
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    accessLog(req, res, startMs, 200);
    return res.end(renderSharePage(r));
  }

  /* APP 热更新（web 层）：公开 GET 接口，APP 启动时尚无登录态。
   * /api/app/manifest 返回 web 文件指纹清单；/api/app/file?path= 下发单个文件。 */
  if (url.pathname === '/api/app/manifest' && req.method === 'GET') {
    try {
      const manifest = appBundle.getManifest();
      accessLog(req, res, startMs, 200);
      /* 追加 apk 段：服务端未提供 APK 时为 null，APP 端据此完全静默、只走 web 热更新 */
      return send(res, 200, { ok: true, data: Object.assign({}, manifest, { apk: appUpdate.apkInfo() }) });
    } catch (e) {
      console.error('[app-manifest error]', e);
      accessLog(req, res, startMs, 500);
      return fail(res, 500, '清单生成失败');
    }
  }
  if (url.pathname === '/api/app/file' && req.method === 'GET') {
    const relPath = url.query && url.query.path ? String(url.query.path) : '';
    const full = appBundle.resolveSafeFile(relPath);
    if (!full) { accessLog(req, res, startMs, 404); return fail(res, 404, '文件不存在'); }
    const ext = path.extname(full).toLowerCase();
    const data = fs.readFileSync(full);
    /* 热更新文件不缓存（每次都应校验指纹），保证更新即时生效 */
    res.writeHead(200, {
      'Content-Type': appBundle.MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    accessLog(req, res, startMs, 200);
    return res.end(data);
  }

  /* APP 包（APK）自更新：公开流式下载 + 管理端上传/删除。
   * 上传是原始字节流（APK 约 4MB，超过 readBody 的 2MB JSON 限制），
   * 故这些端点必须在通用 /api/ 分支（含 readBody）之前处理。 */
  if (url.pathname === '/api/app/apk' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!appUpdate.apkInfo()) { accessLog(req, res, startMs, 404); return fail(res, 404, '服务端未提供 APK'); }
    accessLog(req, res, startMs, 200);
    return appUpdate.streamApk(req, res);
  }
  if (url.pathname === '/api/admin/apk') {
    const admin = auth.authFromReq(req);
    if (!admin) { accessLog(req, res, startMs, 401); return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' }); }
    if (admin.role !== 'admin') { accessLog(req, res, startMs, 403); return fail(res, 403, '无权限', { code: 'FORBIDDEN' }); }
    const apkIp = req.socket.remoteAddress || '';
    if (req.method === 'GET') {
      accessLog(req, res, startMs, 200);
      return send(res, 200, { ok: true, data: { apk: appUpdate.apkInfo(), maxSize: appUpdate.MAX_APK } });
    }
    if (req.method === 'POST') {
      try {
        const r = await appUpdate.saveApkFrom(req, {
          versionCode: url.query.versionCode,
          versionName: url.query.versionName,
          notes: url.query.notes
        });
        dbModule.audit(admin.id, 'upload_apk', 'app', 'apk',
          '上传新版 APK（versionCode ' + r.versionCode + ' / ' + Math.round(r.size / 1048576) + ' MB）', apkIp);
        accessLog(req, res, startMs, 200);
        return send(res, 200, { ok: true, data: r });
      } catch (e) {
        accessLog(req, res, startMs, 400);
        return fail(res, 400, e.message || '上传失败');
      }
    }
    if (req.method === 'DELETE') {
      const r = appUpdate.deleteApk();
      if (r.deleted) dbModule.audit(admin.id, 'delete_apk', 'app', 'apk', '删除服务端 APK（APP 端不再提示更新）', apkIp);
      accessLog(req, res, startMs, 200);
      return send(res, 200, { ok: true, data: r });
    }
    accessLog(req, res, startMs, 405);
    return fail(res, 405, '方法不支持');
  }

  /* API 路由 */
  if (url.pathname.startsWith('/api/')) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      accessLog(req, res, startMs, 400);
      return fail(res, 400, '请求体解析失败');
    }
    try {
      if (url.pathname.startsWith('/api/auth/')) {
        return await auth.handle(req, res, url, body);
      }
      if (url.pathname.startsWith('/api/routes')) {
        return await routesApi.handle(req, res, url, body);
      }
      if (url.pathname.startsWith('/api/footprints')) {
        return await footprintApi.handle(req, res, url, body);
      }
      if (url.pathname.startsWith('/api/admin')) {
        return await adminApi.handle(req, res, url, body);
      }
      accessLog(req, res, startMs, 404);
      return fail(res, 404, '接口不存在');
    } catch (e) {
      console.error('[api error]', url.pathname, e);
      accessLog(req, res, startMs, 500);
      return fail(res, 500, '服务器内部错误');
    }
  }

  /* 静态资源：由后端内置托管（单容器部署，无需 nginx） */
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  if (fs.existsSync(PUBLIC_DIR)) {
    let f = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC_DIR)) { accessLog(req, res, startMs, 403); return send(res, 403, { ok: false, msg: 'forbidden' }); }
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.webmanifest': 'application/manifest+json; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
      };
      /* index 与 SW/manifest 不缓存，确保页面和缓存策略可立即更新；其他静态资源短缓存。 */
      const cacheControl = ['.html', '.webmanifest'].includes(ext) || url.pathname === '/sw.js'
        ? 'no-cache' : 'public, max-age=300';
      const data = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
      accessLog(req, res, startMs, 200);
      return res.end(data);
    }
    accessLog(req, res, startMs, 404);
    return send(res, 404, { ok: false, msg: 'not found' });
  }
  accessLog(req, res, startMs, 404);
  return send(res, 404, { ok: false, msg: 'not found' });
});

server.listen(config.PORT, () => {
  console.log(`[travel-expense] 多用户后端启动 :${config.PORT}，DB=${path.join(config.DATA_DIR, config.DB_FILE)}`);
});

/* ---------- 优雅关闭：SIGTERM/SIGINT → 关闭空闲连接 → 停止接受新连接 → 关闭 DB → 退出 ---------- */
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，开始优雅关闭...`);
  /* 主动关闭空闲（keep-alive）连接：Node 18 的 undici fetch 会在连接池中保留
     keep-alive socket，导致 server.close() 阻塞无法完成，从而在 500ms 内
     未退出就被新实例误判为「服务已停」。closeIdleConnections 仅断开空闲
     连接，不中断正在处理的请求。Node 18.2+ 提供该方法。 */
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  else if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => {
    try { db.close(); } catch (e) { /* ignore */ }
    console.log('[shutdown] 服务已关闭');
    process.exit(0);
  });
  /* 兜底：10 秒后强制退出 */
  setTimeout(() => { console.error('[shutdown] 优雅关闭超时，强制退出'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/* ---------- 只读分享页渲染 ---------- */
function esc(s) {
  return (s === null || s === undefined ? '' : String(s)).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* JPY 用 JP¥ 区分 CNY 的 ¥；日元无小数 */
const JPY_ZERO_DECIMAL = new Set(['JPY', 'KRW']);
function money(n, cur) {
  /* 符号表直接复用 fx.CURRENCY_SYMBOLS（前端经 /api/public/site 下发同一份），删除本地私有副本 */
  const curUp = (cur || 'CNY').toUpperCase();
  const s = fx.CURRENCY_SYMBOLS[curUp] || (cur || 'CNY');
  const v = parseFloat(n);
  const fracDigits = JPY_ZERO_DECIMAL.has(curUp) ? 0 : 2;
  const num = isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: fracDigits, minimumFractionDigits: 0 }) : '0';
  return s + num;
}

/* 站点设置读取（/api/public/site 与 /api/public/server-check 共用，避免重复查询） */
function readSiteSettings() {
  return db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
}
function renderSharePage(r) {
  const rows = [];
  const row = (k, v) => `<tr><td class="k">${esc(k)}</td><td>${v}</td></tr>`;
  const t = dbModule.EXP_KEYS.reduce((s, c) => s + dbModule.num(r.exp[c]), 0);
  rows.push(row('年份 / 类型', esc(r.year || '') + (r.type ? ' · ' + esc(r.type) : '')));
  rows.push(row('出行日期', esc(r.daterange || '') + (r.days ? '（' + esc(r.days) + '天）' : '')));
  rows.push(row('目的地', r.dest ? esc(r.dest) : '—'));
  rows.push(row('住宿', r.hotel ? '<span style="white-space:pre-wrap">' + esc(r.hotel) + '</span>' : '—'));
  rows.push(row('总花费', money(t, r.currency)));
  if (dbModule.num(r.budget_total) > 0) {
    const b = dbModule.num(r.budget_total);
    const over = t > b;
    rows.push(row('预算', money(b, r.currency) + (over ? ` <span class="over">（超支 ${money(t - b, r.currency)}）</span>` : `（剩余 ${money(b - t, r.currency)}）`)));
  }
  const expRows = dbModule.EXP_KEYS
    .filter(c => dbModule.num(r.exp[c]) > 0)
    .map(c => `<tr><td class="k">${esc(c)}</td><td>${money(r.exp[c], r.currency)}</td></tr>`).join('');

  /* AA 结算方案：有同行人时随分享页一并展示，方便旅行结束后在群里对账。
   * 口径与详情页「结算」页签完全一致（同一 dbModule.settle），不做二次加工。
   * 结算失败不阻断分享主体（分享页仍需可用）。 */
  let settleHtml = '';
  try {
    const s = dbModule.settle(r.id);
    if (s && s.rows && s.rows.length) {
      const body = s.rows.map(x => {
        const cls = x.net > 0.005 ? 'recv' : (x.net < -0.005 ? 'pay' : '');
        /* 符号在币种之前（−¥3,450），与详情页「结算」页签一致 */
        const sign = x.net > 0.005 ? '+' : (x.net < -0.005 ? '−' : '');
        return `<tr><td class="k">${esc(x.name)}${x.is_self ? ' <span class="me">本人</span>' : ''}</td>` +
          `<td>${money(x.paid, r.currency)}</td><td>${money(x.owed, r.currency)}</td>` +
          `<td class="${cls}">${sign}${money(Math.abs(x.net), r.currency)}</td></tr>`;
      }).join('');
      const transfers = s.transfers.length
        ? s.transfers.map(x => `<div class="tf"><span>${esc(x.from_name)}</span><span class="arrow">→</span><span>${esc(x.to_name)}</span><b>${money(x.amount, r.currency)}</b></div>`).join('')
        : '<div class="tf tf-clear">已结清，无需转账</div>';
      const caliber = '差额为正=应收（他人欠我），为负=应付。' +
        (s.summary.unassigned > 0 ? `未指定付款人的 ${money(s.summary.unassigned, r.currency)} 不参与结算。` : '');
      settleHtml = `<div class="exp"><h2>AA 结算方案</h2>
        <table class="settle"><thead><tr><th>同行人</th><th>实付</th><th>应负担</th><th>差额</th></tr></thead>
        <tbody>${body}</tbody></table>
        <div class="tf-title">最少转账方案（${s.transfers.length} 笔）</div>
        ${transfers}
        <div class="caliber">${caliber}</div>
      </div>`;
    }
  } catch (e) { /* 结算不可用时静默跳过该区块 */ }

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(r.name)} · 旅行经费分享</title>
<style>
  body{margin:0;background:#f4f8f6;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2d2b}
  .wrap{max-width:640px;margin:0 auto;padding:28px 16px 60px}
  .card{background:#fff;border:1px solid #dcebe6;border-radius:16px;padding:22px;box-shadow:0 4px 18px rgba(31,45,43,.06)}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#6b7d79;font-size:13px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:9px 4px;border-bottom:1px dashed #e3efeb;vertical-align:top}
  td.k{color:#6b7d79;width:110px;white-space:nowrap}
  .over{color:#d64545;font-weight:600}
  .exp{margin-top:16px}
  .exp h2{font-size:15px;margin:0 0 6px}
  .pre{white-space:pre-wrap;word-break:break-word;background:#f7fbfa;border-radius:10px;padding:10px;font-size:13px;line-height:1.7;margin-top:6px}
  .foot{text-align:center;color:#9db4ae;font-size:12px;margin-top:22px}
  .export-bar{display:flex;justify-content:center;gap:10px;margin-top:18px}
  .export-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;background:#4a90d9;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit}
  .export-btn:hover{background:#3a7bc8}
  .export-btn:disabled{background:#aaa;cursor:not-allowed}
  .export-btn svg{width:16px;height:16px}
  /* AA 结算方案（分享页）：与详情页「结算」页签同口径 —— 绿为应收、红为应付 */
  .settle th{text-align:right;font-weight:500;color:#6b7d79;font-size:12px;padding:4px}
  .settle th:first-child{text-align:left}
  .settle td{text-align:right;white-space:nowrap}
  .settle td.k{text-align:left;white-space:normal;width:auto}
  .recv{color:#2e7d5b;font-weight:600}
  .pay{color:#d64545;font-weight:600}
  .me{display:inline-block;background:#e8f4ef;color:#3a7d64;border-radius:6px;padding:0 5px;font-size:11px;margin-left:4px}
  .tf-title{margin-top:14px;font-size:13px;color:#6b7d79}
  .tf{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-top:6px;background:#f7fbfa;border-radius:9px;font-size:13px}
  .tf b{margin-left:auto;color:#1f2d2b}
  .tf .arrow{color:#9db4ae}
  .tf-clear{justify-content:center;color:#6b7d79}
  .caliber{margin-top:10px;color:#9db4ae;font-size:12px;line-height:1.6}
</style></head><body><div class="wrap">
  <div class="card" id="shareCard">
    <h1>${esc(r.name)}</h1>
    <div class="sub">${esc(r.dest || '旅行路线')} · 只读分享</div>
    <table>${rows.join('')}</table>
    ${r.scenic ? `<div class="exp"><h2>景点路线</h2><div class="pre">${esc(r.scenic)}</div></div>` : ''}
    <div class="exp"><h2>花费明细（${t > 0 ? money(t, r.currency) : '暂无'}）</h2>
      ${expRows ? `<table>${expRows}</table>` : '<div class="pre">暂无花费数据</div>'}
    </div>
    ${settleHtml}
    ${r.notes ? `<div class="exp"><h2>备注</h2><div class="pre">${esc(r.notes)}</div></div>` : ''}
  </div>
  <div class="export-bar">
    <button class="export-btn" id="exportBtn" onclick="exportAsImage()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      导出为图片
    </button>
  </div>
  <div class="foot">由旅行经费工作台生成 · 数据可能随时更新</div>
</div>
<script src="/assets/html2canvas.min.js"></script>
<script>
function exportAsImage() {
  var btn = document.getElementById('exportBtn');
  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 生成中…';
  var card = document.getElementById('shareCard');
  html2canvas(card, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    logging: false
  }).then(function(canvas) {
    var link = document.createElement('a');
    var name = (document.querySelector('h1').textContent || '旅行路线').replace(/[\\\\/:*?"<>|]/g, '_');
    link.download = name + '_' + new Date().toISOString().slice(0,10) + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 导出为图片';
  }).catch(function(err) {
    alert('导出失败：' + (err.message || err));
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 导出为图片';
  });
}
</script>
</body></html>`;
}
