/* 管理后台 API：总览/用户管理/封禁提权/邮件配置/站点设置/AI配置/审计日志
 * 全部需 requireAdmin（由 app.js 先校验 req.user.role） */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { fail, ok, escapeLike } = require('./http');
const { authFromReq, publicUser } = require('./auth');
const mailer = require('./mailer');
const dbModule = require('./db');
const aiService = require('./ai_service');
const mapService = require('./map_service');
const { toCsv } = require('./csv');

const db = () => dbModule.db;

const ONLINE_MS = config.ONLINE_WINDOW_MS;

/* 审计日志统一调用 db.audit（与 auth.js 共用单一实现，且写入失败不阻塞主流程） */

function userRow(u) {
  const online = !!db().prepare(
    'SELECT id FROM sessions WHERE user_id = ? AND last_active_at >= ? LIMIT 1').get(u.id, Date.now() - ONLINE_MS);
  const routeCount = db().prepare('SELECT COUNT(*) AS c FROM routes WHERE owner_id = ?').get(u.id).c;
  return Object.assign(publicUser(u), { online, route_count: routeCount });
}

async function handle(req, res, url, body) {
  const admin = authFromReq(req);
  if (!admin) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });
  if (admin.role !== 'admin') return fail(res, 403, '无权限', { code: 'FORBIDDEN' });

  const { pathname, query } = url;
  const rest = pathname.slice('/api/admin'.length);
  const method = req.method;
  const ip = req.socket.remoteAddress || '';

  /* ---------- 总览 ---------- */
  if (rest === '/overview' && method === 'GET') {
    const now = Date.now();
    const d7 = now - 7 * 864e5, d30 = now - 30 * 864e5;
    const userTotal = db().prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const routeTotal = db().prepare('SELECT COUNT(*) AS c FROM routes').get().c;
    const user7 = db().prepare('SELECT COUNT(*) AS c FROM users WHERE created_at >= ?').get(d7).c;
    const user30 = db().prepare('SELECT COUNT(*) AS c FROM users WHERE created_at >= ?').get(d30).c;
    const route7 = db().prepare('SELECT COUNT(*) AS c FROM routes WHERE created_at >= ?').get(d7).c;
    const route30 = db().prepare('SELECT COUNT(*) AS c FROM routes WHERE created_at >= ?').get(d30).c;
    const onlineUsers = db().prepare(
      'SELECT COUNT(DISTINCT user_id) AS c FROM sessions WHERE last_active_at >= ?').get(now - ONLINE_MS).c;
    let dbBytes = 0;
    try { dbBytes = fs.statSync(path.join(config.DATA_DIR, config.DB_FILE)).size; } catch (e) { /* ignore */ }
    return ok(res, { userTotal, routeTotal, user7, user30, route7, route30, onlineUsers, dbBytes });
  }

  /* ---------- 用户列表 ---------- */
  if (rest === '/users' && method === 'GET') {
    const q = (query.q || '').trim();
    const status = query.status || '';
    const role = query.role || '';
    const online = query.online === '1';
    const page = Math.max(1, parseInt(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || 20));

    let where = '1=1', args = [];
    if (q) {
      where += ' AND (username LIKE ? ESCAPE \'\\\' OR email LIKE ? ESCAPE \'\\\')';
      const like = `%${escapeLike(q)}%`;
      args.push(like, like);
    }
    if (status) { where += ' AND status = ?'; args.push(status); }
    if (role) { where += ' AND role = ?'; args.push(role); }
    /* online 过滤在 SQL 层用子查询实现，确保分页 total 与列表一致 */
    if (online) { where += ' AND id IN (SELECT DISTINCT user_id FROM sessions WHERE last_active_at >= ?)'; args.push(Date.now() - ONLINE_MS); }

    const total = db().prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where}`).get(...args).c;
    const rows = db().prepare(
      `SELECT * FROM users WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    const list = rows.map(userRow);
    return ok(res, { list, total, page, pageSize });
  }

  /* ---------- 单个用户操作 ---------- */
  const um = rest.match(/^\/users\/(\d+)\/(ban|unban|role)$/);
  if (um) {
    const targetId = parseInt(um[1], 10);
    const action = um[2];
    const target = db().prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return fail(res, 404, '用户不存在');
    if (targetId === admin.id && action !== 'role') return fail(res, 400, '不能对自己执行该操作');
    if (target.role === 'admin' && action === 'ban') return fail(res, 400, '不能封禁管理员');
    if (action === 'role' && targetId === admin.id) return fail(res, 400, '不能修改自己的角色');

    if (action === 'ban') {
      db().prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('banned', Date.now(), targetId);
      db().prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId); // 即时掉线
      db().prepare('UPDATE routes SET share_token = NULL WHERE owner_id = ?').run(targetId); // 作废旧分享链接
      dbModule.audit(admin.id, 'ban_user', 'user', String(targetId), `封禁用户 ${target.username || target.email}`, ip);
      return ok(res, true);
    }
    if (action === 'unban') {
      db().prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('active', Date.now(), targetId);
      dbModule.audit(admin.id, 'unban_user', 'user', String(targetId), `解封用户 ${target.username || target.email}`, ip);
      return ok(res, true);
    }
    if (action === 'role') {
      const newRole = body && body.role === 'admin' ? 'admin' : 'user';
      if (newRole === 'user') {
        const adminCount = db().prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
        if (adminCount <= 1) return fail(res, 400, '不能降级唯一管理员');
      }
      db().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(newRole, Date.now(), targetId);
      dbModule.audit(admin.id, 'role_change', 'user', String(targetId),
        `角色变更：${target.username || target.email} → ${newRole}`, ip);
      return ok(res, true);
    }
  }

  /* ---------- 邮件配置 ---------- */
  if (rest === '/email-config' && method === 'GET') {
    const c = db().prepare('SELECT * FROM email_config WHERE id = 1').get() || {};
    return ok(res, {
      smtp_host: c.smtp_host || '', smtp_port: c.smtp_port || 465,
      smtp_secure: !!c.smtp_secure, smtp_user: c.smtp_user || '',
      smtp_pass: c.smtp_pass ? '******' : '', from_name: c.from_name || '',
      from_address: c.from_address || '', enabled: !!c.enabled
    });
  }
  if (rest === '/email-config' && method === 'PUT') {
    const b = body || {};
    const cur = db().prepare('SELECT * FROM email_config WHERE id = 1').get() || {};
    const pass = b.smtp_pass && b.smtp_pass !== '******' ? String(b.smtp_pass) : (cur.smtp_pass || '');
    db().prepare(`UPDATE email_config SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass=?,
      from_name=?, from_address=?, enabled=?, updated_at=?, updated_by=? WHERE id=1`)
      .run(String(b.smtp_host || ''), parseInt(b.smtp_port) || 465, b.smtp_secure ? 1 : 0,
        String(b.smtp_user || ''), pass, String(b.from_name || ''), String(b.from_address || ''),
        b.enabled ? 1 : 0, Date.now(), admin.id);
    dbModule.audit(admin.id, 'update_mail_config', 'email_config', '1', '更新邮件服务器配置', ip);
    return ok(res, true);
  }
  if (rest === '/email-config/test' && method === 'POST') {
    try {
      const cfg = db().prepare('SELECT * FROM email_config WHERE id = 1').get() || {};
      await mailer.sendMail({
        to: admin.email || cfg.smtp_user,
        subject: '旅行经费工作台 — 测试邮件',
        text: '这是一封测试邮件，说明 SMTP 配置可用。'
      });
      dbModule.audit(admin.id, 'test_mail', 'email_config', '1', '发送测试邮件成功', ip);
      return ok(res, true);
    } catch (e) {
      return fail(res, 400, '测试邮件发送失败：' + e.message);
    }
  }

  /* ---------- 站点设置 ---------- */
  if (rest === '/site-settings' && method === 'GET') {
    const s = db().prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
    return ok(res, {
      site_name: s.site_name || '旅行经费工作台',
      allow_register: !!s.allow_register,
      register_mode: s.register_mode || 'all',
      announce_text: s.announce_text || '',
      home_currency: s.home_currency || 'CNY'
    });
  }
  if (rest === '/site-settings' && method === 'PUT') {
    const b = body || {};
    const home = (b.home_currency && /^[A-Za-z]{3}$/.test(b.home_currency)) ? b.home_currency.toUpperCase() : 'CNY';
    db().prepare(`UPDATE site_settings SET site_name=?, allow_register=?, register_mode=?, announce_text=?, home_currency=?, updated_at=?, updated_by=? WHERE id=1`)
      .run(String(b.site_name || '旅行经费工作台'), b.allow_register ? 1 : 0,
        ['all', 'email_only', 'username_only'].includes(b.register_mode) ? b.register_mode : 'all',
        String(b.announce_text || ''), home, Date.now(), admin.id);
    dbModule.audit(admin.id, 'update_site_settings', 'site_settings', '1', '更新站点设置', ip);
    return ok(res, true);
  }

  /* ---------- AI 配置 ---------- */
  if (rest === '/ai-config' && method === 'GET') {
    const c = dbModule.getAiConfig();
    const D = aiService.DEFAULT_PROMPTS;
    const enabledUserIds = dbModule.getAiEnabledUserIds();
    /* 返回已启用用户的简要信息（id+用户名+邮箱），方便前端回显 */
    const enabledUsers = enabledUserIds.length > 0
      ? db().prepare(`SELECT id, username, email FROM users WHERE id IN (${enabledUserIds.map(() => '?').join(',')})`)
          .all(...enabledUserIds)
      : [];
    return ok(res, {
      api_base_url: c.api_base_url,
      api_key: c.api_key ? '******' : '',
      model_id: c.model_id,
      enabled: c.enabled,
      skip_ssl_verify: c.skip_ssl_verify,
      /* 提示词：数据库为空时回填内置默认，保证编辑框始终展示当前生效内容 */
      plan_system_prompt: c.plan_system_prompt || D.plan_system_prompt,
      plan_user_prompt: c.plan_user_prompt || D.plan_user_prompt,
      chat_system_prompt: c.chat_system_prompt || D.chat_system_prompt,
      chat_user_prompt: c.chat_user_prompt || D.chat_user_prompt,
      default_prompts: D,
      enabled_users: enabledUsers.map(u => ({ id: u.id, username: u.username || '', email: u.email || '' }))
    });
  }
  if (rest === '/ai-config' && method === 'PUT') {
    const b = body || {};
    dbModule.saveAiConfig({
      api_base_url: b.api_base_url,
      api_key: b.api_key,
      model_id: b.model_id,
      enabled: !!b.enabled,
      skip_ssl_verify: !!b.skip_ssl_verify,
      plan_system_prompt: b.plan_system_prompt,
      plan_user_prompt: b.plan_user_prompt,
      chat_system_prompt: b.chat_system_prompt,
      chat_user_prompt: b.chat_user_prompt
    }, admin.id);
    dbModule.audit(admin.id, 'update_ai_config', 'ai_config', '1', '更新 AI 模型配置', ip);
    return ok(res, true);
  }
  /* ---------- 足迹地图底图配置（默认关闭；关闭时足迹页维持自绘点阵） ---------- */
  if (rest === '/map-config' && method === 'GET') {
    const c = dbModule.getMapConfig();
    return ok(res, {
      provider: c.provider || 'none',
      enabled: (c.provider || 'none') !== 'none',
      /* key 属浏览器公开值（配合图商域名白名单），但设置页仍脱敏展示，'******' 表示保持原值 */
      amap_key: c.amap_key ? '******' : '',
      amap_security: c.amap_security ? '******' : '',
      tencent_key: c.tencent_key ? '******' : '',
      updated_at: c.updated_at, updated_by: c.updated_by
    });
  }
  if (rest === '/map-config' && method === 'POST') {
    const b = body || {};
    if (!dbModule.MAP_PROVIDERS.has(String(b.provider || ''))) {
      return fail(res, 400, '地图类型不正确（应为 none / amap / tencent）');
    }
    dbModule.saveMapConfig({
      provider: b.provider,
      amap_key: b.amap_key,
      amap_security: b.amap_security,
      tencent_key: b.tencent_key
    }, admin.id);
    const c = dbModule.getMapConfig();
    dbModule.audit(admin.id, 'update_map_config', 'map_config', '1',
      '更新足迹地图配置（provider=' + (c.provider || 'none') + '）', ip);
    return ok(res, true);
  }
  if (rest === '/map-config/test' && method === 'POST') {
    const b = body || {};
    const provider = String(b.provider || '');
    const saved = dbModule.getMapConfig();
    /* '******' 表示沿用已保存的 key（未保存先测试：'******' 且无存值 → 视为未填写） */
    const resolveKey = (v, old) => (v && v !== '******') ? String(v).trim() : String(old || '').trim();
    let key = '';
    if (provider === 'amap') key = resolveKey(b.amap_key, saved.amap_key);
    else if (provider === 'tencent') key = resolveKey(b.tencent_key, saved.tencent_key);
    const result = await mapService.testMapKey({ provider, key });
    dbModule.audit(admin.id, 'test_map_config', 'map_config', '1',
      '足迹地图连通性测试（provider=' + provider + '）：' + (result.ok ? '成功' : '失败'), ip);
    return ok(res, result);
  }
  if (rest === '/ai-config/test' && method === 'POST') {
    try {
      /* 测试时使用请求体中的配置（允许未保存先测试），若未传则用已保存配置 */
      const b = body || {};
      let cfg;
      if (b.api_base_url || b.api_key || b.model_id) {
        cfg = {
          api_base_url: String(b.api_base_url || ''),
          api_key: String(b.api_key || ''),
          model_id: String(b.model_id || ''),
          skip_ssl_verify: !!b.skip_ssl_verify
        };
      } else {
        cfg = dbModule.getAiConfig();
      }
      if (!cfg.api_base_url || !cfg.api_key || !cfg.model_id) {
        return fail(res, 400, '请先填写 API 地址、密钥和模型 ID');
      }
      const result = await aiService.testConnection(cfg);
      dbModule.audit(admin.id, 'test_ai_config', 'ai_config', '1', 'AI 配置测试成功', ip);
      return ok(res, { ok: true, reply: result.reply });
    } catch (e) {
      return fail(res, 400, 'AI 接口测试失败：' + e.message);
    }
  }
  /* AI 启用用户：获取全部可选用户（含是否已启用标记） */
  if (rest === '/ai-config/users' && method === 'GET') {
    const enabledIds = new Set(dbModule.getAiEnabledUserIds());
    const users = db().prepare('SELECT id, username, email, role, status FROM users ORDER BY id ASC').all();
    return ok(res, {
      list: users.map(u => ({
        id: u.id,
        username: u.username || '',
        email: u.email || '',
        role: u.role,
        status: u.status,
        ai_enabled: enabledIds.has(u.id)
      }))
    });
  }
  /* AI 启用用户：更新启用列表（传入 user_ids 数组） */
  if (rest === '/ai-config/users' && method === 'PUT') {
    const b = body || {};
    const userIds = Array.isArray(b.user_ids) ? b.user_ids : [];
    /* 校验所有用户ID都存在 */
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      const found = db().prepare(`SELECT COUNT(*) AS c FROM users WHERE id IN (${placeholders})`).get(...userIds).c;
      if (found !== userIds.length) return fail(res, 400, '包含不存在的用户 ID');
    }
    dbModule.setAiEnabledUsers(userIds, admin.id);
    dbModule.audit(admin.id, 'update_ai_enabled_users', 'ai_enabled_users', null,
      `更新 AI 启用用户列表（${userIds.length} 人）`, ip);
    return ok(res, { count: userIds.length });
  }

  /* ---------- 全站数据导出（CSV，含归属用户名；审计留痕） ---------- */
  if (rest === '/export' && method === 'GET') {
    const rows = db().prepare(
      `SELECT u.username AS owner_name, r.* FROM routes r JOIN users u ON u.id = r.owner_id ORDER BY r.created_at DESC`).all();
    const head = ['owner_name'].concat(dbModule.ROUTE_COLS.split(',').map(s => s.trim()));
    const data = rows.map(r => head.map(h => {
      if (dbModule.EXP_KEYS.includes(h)) return dbModule.num(r[dbModule.EXP_COL[h]]);
      if (h === 'is_seed') return r[h] ? 1 : 0;
      if (h === 'owner_id') return r.owner_id;
      return r[h] == null ? '' : r[h];
    }));
    dbModule.audit(admin.id, 'export_routes', 'routes', null, '全站导出 CSV（' + rows.length + ' 条）', ip);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="all-routes.csv"'
    });
    return res.end(toCsv(head, data));
  }

  /* ---------- 数据库备份下载（WAL 合并后导出，审计留痕） ---------- */
  if (rest === '/db-backup' && method === 'GET') {
    const dbPath = path.join(config.DATA_DIR, config.DB_FILE);
    if (!fs.existsSync(dbPath)) return fail(res, 404, '数据库文件不存在');
    try { db().pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* WAL 可能不存在 */ }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    dbModule.audit(admin.id, 'db_backup', 'db', null, '下载数据库备份', ip);
    const data = fs.readFileSync(dbPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="travel-expense-backup-${stamp}.db"`
    });
    return res.end(data);
  }

  /* ---------- 审计日志 ---------- */
  if (rest === '/audit-logs' && method === 'GET') {
    const page = Math.max(1, parseInt(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || 20));
    let where = '1=1', args = [];
    if (query.action) { where += ' AND a.action = ?'; args.push(query.action); }
    if (query.from) { where += ' AND a.created_at >= ?'; args.push(parseInt(query.from)); }
    if (query.to) { where += ' AND a.created_at <= ?'; args.push(parseInt(query.to)); }
    const total = db().prepare(`SELECT COUNT(*) AS c FROM audit_logs a WHERE ${where}`).get(...args).c;
    /* JOIN users 获取操作人名称，避免全量加载用户到内存 */
    const rows = db().prepare(
      `SELECT a.*, COALESCE(u.username, u.email, '系统') AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    const list = rows.map(r => ({
      id: r.id, action: r.action, target_type: r.target_type, target_id: r.target_id,
      detail: r.detail, ip: r.ip, created_at: r.created_at,
      actor: r.actor_id != null ? r.actor_name : '系统'
    }));
    return ok(res, { list, total, page, pageSize });
  }

  return fail(res, 404, '接口不存在');
}

module.exports = { handle };
