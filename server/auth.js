/* 认证与授权：注册（邮箱/账户名）、登录（三方式）、会话、封禁、改密
 * 依赖 db.js / http.js / mailer.js / config.js */
'use strict';
const crypto = require('crypto');
const config = require('./config');
const { fail, ok, created, parseCookies } = require('./http');
const mailer = require('./mailer');
const dbModule = require('./db');

const db = () => dbModule.db;

/* ---------- 密码 ---------- */
/* 哈希统一使用 db.scryptHash（单一实现，避免与 db.js 重复） */
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = Buffer.from(hash, 'hex');
  const t = Buffer.from(dbModule.scryptHash(password, salt), 'hex');
  return h.length === t.length && crypto.timingSafeEqual(h, t);
}

/* ---------- 工具 ---------- */
function genCode() {
  // 验证码必须用密码学安全随机源，杜绝 Math.random 可预测性
  return String(crypto.randomInt(0, Math.pow(10, config.CODE_DIGITS))).padStart(config.CODE_DIGITS, '0');
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u, aiEnabled) {
  return {
    id: u.id, username: u.username, email: u.email, role: u.role,
    status: u.status, email_verified: !!u.email_verified,
    force_reset: !!u.force_reset, created_at: u.created_at,
    last_login: u.last_login != null ? u.last_login : null,
    ai_enabled: !!aiEnabled
  };
}

/* 简单内存限流：key -> {count, resetAt}（进程内即可，重启清零） */
const rateBuckets = new Map();
let lastRateCleanup = 0;
function cleanupRateBuckets() {
  const now = Date.now();
  if (now - lastRateCleanup < 5 * 60 * 1000) return; // 每 5 分钟最多清理一次
  lastRateCleanup = now;
  for (const [key, b] of rateBuckets) {
    if (b.resetAt <= now) rateBuckets.delete(key);
  }
}
function rateLimit(key, limit, windowMs) {
  cleanupRateBuckets();
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, b); }
  b.count += 1;
  return b.count <= limit;
}

/* ---------- 会话 ---------- */
function createSession(userId, ip, ua) {
  const now = Date.now();
  const sid = crypto.randomBytes(32).toString('hex');
  db().prepare('INSERT INTO sessions (id, user_id, created_at, last_active_at, ip, ua) VALUES (?,?,?,?,?,?)')
    .run(sid, userId, now, now, ip || null, ua || null);
  return sid;
}
function deleteSession(sid) {
  if (sid) db().prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}
function touchSession(sid) {
  if (sid) db().prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sid);
}
function setCookie(res, sid, maxAgeMs) {
  /* 独立客户端（安卓 APP）以跨源方式携带会话 Cookie，需 SameSite=None；
   * SameSite=None 必须配合 Secure，故仅在 COOKIE_SECURE=true（HTTPS）时启用。 */
  const attr = config.COOKIE_SECURE ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie',
    `sid=${sid}; HttpOnly${attr}; Path=/; Max-Age=${Math.round(maxAgeMs / 1000)}`);
}
function clearCookie(res) {
  const attr = config.COOKIE_SECURE ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie', `sid=; HttpOnly${attr}; Path=/; Max-Age=0`);
}

/* 读取会话并返回用户；失败返回 null（不抛错）
 * 服务端 TTL 校验：超过 SESSION_TTL_MS 无活动则会话失效并删除
 * 单请求内缓存：app.js 的强制改密门禁与各业务 handler 会先后调用，避免重复查库与重复
 * touchSession（每次 touch 都是一次 WAL 写入）。 */
function authFromReq(req) {
  if (req._authUserCache !== undefined) return req._authUserCache;
  req._authUserCache = null;
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = db().prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s) return null;
  /* 服务端会话过期校验（滑动窗口：距最后活动超过 TTL 则失效） */
  if (Date.now() - s.last_active_at > config.SESSION_TTL_MS) {
    deleteSession(sid);
    return null;
  }
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u || u.status !== 'active') return null;
  touchSession(sid);
  req._sid = sid;
  req.user = u;
  req._authUserCache = u;
  return u;
}

/* ---------- 校验码 ---------- */
function issueCode(email, purpose) {
  const now = Date.now();
  // 清理该邮箱该用途的所有过期码（防止表无限增长）
  db().prepare('DELETE FROM verification_codes WHERE email = ? AND purpose = ? AND expires_at < ?')
    .run(email, purpose, now);
  // 作废旧码（未消费的）
  db().prepare('UPDATE verification_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0').run(email, purpose);
  const code = genCode();
  db().prepare('INSERT INTO verification_codes (email, purpose, code, expires_at, consumed, created_at) VALUES (?,?,?,?,0,?)')
    .run(email, purpose, code, now + config.CODE_TTL_MS, now);
  return code;
}
function consumeCode(email, purpose, code) {
  const row = db().prepare(
    'SELECT * FROM verification_codes WHERE email = ? AND purpose = ? AND code = ? AND consumed = 0 ORDER BY id DESC LIMIT 1')
    .get(email, purpose, String(code).trim());
  if (!row) return false;
  if (row.expires_at < Date.now()) return false;
  db().prepare('UPDATE verification_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return true;
}

/* ---------- 审计日志（auth 内部用） ---------- */
/* 统一调用 db.audit（与 admin_api 共用单一实现，且写入失败不阻塞主流程） */

/* ---------- 路由 ---------- */
async function handle(req, res, url, body) {
  const { pathname, query } = url;
  const p = pathname.slice('/api/auth/'.length);

  switch (p) {
    /* 发送验证码 */
    case 'send-code': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const email = String((body.email || '').trim());
      if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
      const purpose = body.purpose === 'login' ? 'login' : 'register';
      if (purpose === 'register') {
        const dup = db().prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (dup) return fail(res, 409, '该邮箱已被使用', { code: 'EMAIL_TAKEN' });
      } else {
        const u = db().prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (!u) return fail(res, 400, '该邮箱未注册');
      }
      const ip = req.socket.remoteAddress || '';
      if (!rateLimit('sendcode:' + ip, config.RATE_LIMIT.sendCode, config.RATE_LIMIT.windowMs)) {
        return fail(res, 429, '发送过于频繁，请稍后再试');
      }
      const mailCfg = db().prepare('SELECT * FROM email_config WHERE id = 1').get() || {};
      if (!mailCfg.enabled || !mailCfg.smtp_host) {
        return fail(res, 400, '邮件服务未配置', { code: 'MAIL_DISABLED' });
      }
      const code = issueCode(email, purpose);
      try {
        await mailer.sendVerificationCode(email, code, purpose);
      } catch (e) {
        return fail(res, 400, '邮件发送失败：' + e.message, { code: 'MAIL_ERROR' });
      }
      return ok(res, { sent: true, ttl: Math.round(config.CODE_TTL_MS / 60000) });
    }

    /* 防呆查重 */
    case 'check-exists': {
      const out = {};
      const email = String((body.email || '').trim());
      if (email) {
        if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
        out.email = !!db().prepare('SELECT id FROM users WHERE email = ?').get(email);
      }
      const username = String((body.username || '').trim());
      if (username) out.username = !!db().prepare('SELECT id FROM users WHERE username = ?').get(username);
      return ok(res, out);
    }

    /* 注册 */
    case 'register': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const email = String((body.email || '').trim());
      const username = String((body.username || '').trim());
      const password = String(body.password || '');
      const code = String((body.code || '').trim());

      const settings = db().prepare('SELECT * FROM site_settings WHERE id = 1').get();
      if (settings && !settings.allow_register) return fail(res, 403, '注册已关闭，请联系管理员');
      const mode = (settings && settings.register_mode) || 'all';
      if (mode === 'email_only' && !email) return fail(res, 400, '当前仅支持邮箱注册');
      if (mode === 'username_only' && !username) return fail(res, 400, '当前仅支持账户名注册');
      if (!email && !username) return fail(res, 400, '邮箱或账户名至少填一个');
      if (!password) return fail(res, 400, '请设置密码');

      if (email) {
        if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
        if (db().prepare('SELECT id FROM users WHERE email = ?').get(email)) {
          return fail(res, 409, '该邮箱已被使用', { code: 'EMAIL_TAKEN' });
        }
        if (!consumeCode(email, 'register', code)) {
          return fail(res, 400, '验证码错误或已过期', { code: 'CODE_INVALID' });
        }
      }
      let finalName = username;
      if (!finalName && email) {
        finalName = email.split('@')[0].replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '') || 'user';
        if (db().prepare('SELECT id FROM users WHERE username = ?').get(finalName)) {
          finalName = finalName + '_' + crypto.randomBytes(2).toString('hex');
        }
      }
      if (finalName && db().prepare('SELECT id FROM users WHERE username = ?').get(finalName)) {
        return fail(res, 409, '该账户名已被使用', { code: 'USERNAME_TAKEN' });
      }

      const now = Date.now();
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = dbModule.scryptHash(password, salt);
      let userId;
      try {
        const info = db().prepare(
          'INSERT INTO users (username, email, password_hash, password_salt, role, status, email_verified, force_reset, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)')
          .run(finalName || null, email || null, hash, salt, 'user', 'active', email ? 1 : 0, now, now);
        userId = info.lastInsertRowid;
      } catch (e) {
        /* UNIQUE 约束竞态：并发注册同邮箱/用户名 → 返回 409 而非 500 */
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return fail(res, 409, '该邮箱或账户名已被使用', { code: 'TAKEN' });
        }
        throw e;
      }
      const sid = createSession(userId, req.socket.remoteAddress, req.headers['user-agent']);
      setCookie(res, sid, config.SESSION_TTL_MS);
      /* 注册即首次活跃，写入最后登录时间（与登录口径一致，便于后台判断活跃度） */
      db().prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), userId);
      const u = db().prepare('SELECT * FROM users WHERE id = ?').get(userId);
      return created(res, publicUser(u, false));
    }

    /* 登录：{login, password?|code?} */
    case 'login': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const login = String((body.login || '').trim());
      const password = String(body.password || '');
      const code = String((body.code || '').trim());
      if (!login) return fail(res, 400, '请输入登录名');
      const ip = req.socket.remoteAddress || '';
      /* 双重限流：按 IP+用户名（精准防单账户爆破）+ 按 IP（防跨用户名撞库） */
      if (!rateLimit('login:' + ip + ':' + login, config.RATE_LIMIT.login, config.RATE_LIMIT.windowMs)) {
        return fail(res, 429, '尝试次数过多，请 10 分钟后再试');
      }
      if (!rateLimit('loginip:' + ip, config.RATE_LIMIT.loginByIp, config.RATE_LIMIT.windowMs)) {
        return fail(res, 429, '该 IP 尝试过于频繁，请稍后再试');
      }

      let user = db().prepare('SELECT * FROM users WHERE username = ?').get(login)
        || db().prepare('SELECT * FROM users WHERE email = ?').get(login);
      /* 独立客户端（安卓 APP）需要先确认账号是否归属于该服务器：
       * 账号不存在返回 404 ACCOUNT_NOT_FOUND，与密码错的 401 INVALID_CREDENTIAL 区分。
       * 自托管场景下服务器为用户自有，放开账号枚举风险可接受。 */
      if (!user) return fail(res, 404, '该服务器不存在此账号', { code: 'ACCOUNT_NOT_FOUND' });
      if (user.status === 'banned') return fail(res, 403, '禁止用户登录', { code: 'BANNED' });

      let credentialOk = false;
      if (code) {
        credentialOk = consumeCode(user.email || '', 'login', code);
      } else {
        credentialOk = verifyPassword(password, user.password_salt, user.password_hash);
      }
      if (!credentialOk) return fail(res, 401, '账号或密码错误', { code: 'INVALID_CREDENTIAL' });

      const sid = createSession(user.id, ip, req.headers['user-agent']);
      setCookie(res, sid, config.SESSION_TTL_MS);
      /* 记录最后登录时间（用于后台判断用户活跃度） */
      db().prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
      /* 重新取一次，保证返回给前端的 last_login 与数据库一致（否则会落后一次） */
      const u = db().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (u.role === 'admin') {
        dbModule.audit(u.id, 'admin_login', 'user', String(u.id), u.username, ip);
      }
      return ok(res, publicUser(u, dbModule.isAiEnabledUser(u.id)));
    }

    /* 登出 */
    case 'logout': {
      const u = authFromReq(req);
      const sid = parseCookies(req).sid;
      if (u && u.role === 'admin') {
        dbModule.audit(u.id, 'admin_logout', 'user', String(u.id), u.username, req.socket.remoteAddress || '');
      }
      deleteSession(sid);
      clearCookie(res);
      return ok(res, true);
    }

    /* 当前用户 */
    case 'me': {
      const u = authFromReq(req);
      if (!u) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });
      return ok(res, publicUser(u, dbModule.isAiEnabledUser(u.id)));
    }

    /* 改密 */
    case 'password': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const u = authFromReq(req);
      if (!u) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 8) return fail(res, 400, '新密码至少 8 位');
      if (!verifyPassword(oldPassword, u.password_salt, u.password_hash)) {
        return fail(res, 400, '原密码不正确');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = dbModule.scryptHash(newPassword, salt);
      db().prepare('UPDATE users SET password_hash = ?, password_salt = ?, force_reset = 0, updated_at = ? WHERE id = ?')
        .run(hash, salt, Date.now(), u.id);
      return ok(res, true);
    }

    default:
      return fail(res, 404, '接口不存在');
  }
}

module.exports = { handle, authFromReq, publicUser, verifyPassword, createSession, deleteSession, clearCookie };
