/* 路线 API：CRUD（owner 隔离 + 种子示例全员可见/只读）+ 统计 + AI行程规划
 * 鉴权：requireAuth 之后调用；req.user 已注入 */
'use strict';
const crypto = require('crypto');
const { fail, ok, created, escapeLike } = require('./http');
const dbModule = require('./db');
const { authFromReq } = require('./auth');
const aiService = require('./ai_service');
const { toCsv } = require('./csv');

const db = () => dbModule.db;
const fx = require('./fx');

/* 本位币（站点设置，默认 CNY） */
function homeCurrency() {
  const s = db().prepare('SELECT home_currency FROM site_settings WHERE id = 1').get();
  return (s && s.home_currency) || 'CNY';
}

/* 路由行投影列：与 db.js 单一来源，避免分叉缺列 */
const ROUTE_COLS = dbModule.ROUTE_COLS;

/* 个人导出 CSV 列头（与导入字段对应，可往返） */
const CSV_HEAD = ['name', 'year', 'type', 'daterange', 'start_date', 'end_date', 'days', 'people', 'dest',
  'currency', 'budget_total', 'budget_daily'].concat(dbModule.EXP_KEYS, ['scenic', 'hotel', 'notes']);

/* 查询本人+种子（含个人隐藏开关过滤种子）；返回全量行（统计用）。
 * 排序权威在服务端：按出发时间倒序（routeStartMs）。前端不得再对分页结果二次排序，
 * 否则会出现「页内按出发日排、页间按年+创建时间切」的跨页顺序错乱。
 * Array.prototype.sort 稳定 → 同出发时间沿用 SQL 的 year DESC, created_at DESC 次序。 */
function queryRoutes(userId, { year, q, hideSeed }) {
  const args = [userId];
  let where = `(owner_id = ?`;
  if (!hideSeed) where += ` OR is_seed = 1`;
  where += `)`;
  /* 隐藏系统示例：排除所有 is_seed=1 的示例路线（与所有者无关，
   * 否则种子路线归 admin 所有时，管理员勾选「隐藏系统示例」无效） */
  if (hideSeed) where += ` AND is_seed = 0`;
  if (year) { where += ` AND year = ?`; args.push(String(year)); }
  if (q) {
    where += ` AND (name LIKE ? ESCAPE '\\' OR dest LIKE ? ESCAPE '\\' OR scenic LIKE ? ESCAPE '\\')`;
    const like = `%${escapeLike(q)}%`; args.push(like, like, like);
  }
  return db().prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE ${where} ORDER BY year DESC, created_at DESC`).all(...args)
    .sort((a, b) => dbModule.routeStartMs(b) - dbModule.routeStartMs(a));
}

/* 列表（分页）：返回 {rows, total, page, pageSize} */
function listForUser(userId, { year, q, hideSeed, page, pageSize }) {
  const rows = queryRoutes(userId, { year, q, hideSeed });
  const total = rows.length;
  const lim = Math.min(200, Math.max(1, parseInt(pageSize) || 50));
  const pg = Math.max(1, parseInt(page) || 1);
  const slice = rows.slice((pg - 1) * lim, (pg - 1) * lim + lim);
  return { rows: slice, total, page: pg, pageSize: lim };
}

function findVisible(id, userId) {
  return db().prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE id = ? AND (owner_id = ? OR is_seed = 1)`)
    .get(id, userId) || null;
}

/* 批量取各路线的流水笔数（列表卡片徽标用） */
function expenseCounts(ids) {
  const out = {};
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  db().prepare(`SELECT route_id, COUNT(*) AS c FROM expenses WHERE route_id IN (${ph}) GROUP BY route_id`)
    .all(...ids).forEach(r => { out[r.route_id] = r.c; });
  return out;
}
/* 同行人计数：与人均口径统一（名单优先、人数兜底）配套，卡片人均按此计算 */
function travelerCounts(ids) {
  const out = {};
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  db().prepare(`SELECT route_id, COUNT(*) AS c FROM travelers WHERE route_id IN (${ph}) GROUP BY route_id`)
    .all(...ids).forEach(r => { out[r.route_id] = r.c; });
  return out;
}

/* 全量去重年份（不受 year 过滤，确保年份胶囊完整）；hideSeed 时排除种子路线年份 */
function routesYears(res, userId, query) {
  const hideSeed = query.hideSeed === '1';
  const args = [userId];
  let where = `(owner_id = ?`;
  if (!hideSeed) where += ` OR is_seed = 1`;
  where += `)`;
  if (hideSeed) where += ` AND is_seed = 0`;
  const rows = db().prepare(`SELECT DISTINCT year FROM routes WHERE ${where} AND year IS NOT NULL AND year != ''`).all(...args);
  const years = rows.map(r => r.year).sort((a, b) => b.localeCompare(a));
  return ok(res, { years });
}

async function handle(req, res, url, body) {
  const user = authFromReq(req);
  if (!user) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });

  const { pathname, query } = url;
  const rest = pathname.slice('/api/routes'.length); // '' | '/xxx' | '/stats/summary' ...
  const method = req.method;

  /* 统计接口优先 */
  if (rest === '/stats/summary') return statsSummary(res, user, query);
  if (rest === '/stats/trend') return statsTrend(res, user, query);

  /* ---------- AI 行程规划 ---------- */
  if (rest === '/ai-plan' && method === 'POST') {
    /* 校验：当前用户是否被启用 AI 功能 */
    if (!dbModule.isAiEnabledUser(user.id)) {
      return fail(res, 403, '当前用户未启用 AI 行程规划功能', { code: 'AI_NOT_ENABLED' });
    }
    /* 校验：AI 配置是否已启用且完整 */
    const cfg = dbModule.getAiConfig();
    if (!cfg.enabled) return fail(res, 400, 'AI 功能未启用，请联系管理员');
    if (!cfg.api_base_url || !cfg.api_key || !cfg.model_id) {
      return fail(res, 400, 'AI 配置不完整，请联系管理员');
    }
    /* 参数校验 */
    const b = body || {};
    const startDate = String(b.start_date || '').trim();
    const endDate = String(b.end_date || '').trim();
    const dest = String(b.dest || '').trim();
    const days = parseInt(b.days, 10) || 0;
    if (!startDate || !endDate) return fail(res, 400, '请填写出行起止日期');
    if (!dest) return fail(res, 400, '请填写主要目的地');
    if (days <= 0) return fail(res, 400, '天数无效');
    try {
      /* 返回 { scenic, notes }：notes 为「注意事项 + 美食推荐」，前端回填到备注 */
      const r = await aiService.planItinerary(cfg, { startDate, endDate, dest, days });
      dbModule.audit(user.id, 'ai_plan_route', 'routes', null,
        `AI 规划行程：${dest}（${startDate} ~ ${endDate}，${days}天）`, req.socket.remoteAddress || '');
      return ok(res, { scenic: r.scenic, notes: r.notes });
    } catch (e) {
      return fail(res, 400, 'AI 行程规划失败：' + e.message);
    }
  }

  /* POST /api/routes/ai-chat 行程对话式调整：基于当前行程，按用户指令修改后返回完整行程 */
  if (rest === '/ai-chat' && method === 'POST') {
    if (!dbModule.isAiEnabledUser(user.id)) {
      return fail(res, 403, '当前用户未启用 AI 行程规划功能', { code: 'AI_NOT_ENABLED' });
    }
    const cfg = dbModule.getAiConfig();
    if (!cfg.enabled) return fail(res, 400, 'AI 功能未启用，请联系管理员');
    if (!cfg.api_base_url || !cfg.api_key || !cfg.model_id) {
      return fail(res, 400, 'AI 配置不完整，请联系管理员');
    }
    const b = body || {};
    const currentScenic = String(b.current_scenic || '').trim();
    const message = String(b.message || '').trim();
    const dest = String(b.dest || '').trim();
    const startDate = String(b.start_date || '').trim();
    const endDate = String(b.end_date || '').trim();
    const days = parseInt(b.days, 10) || 0;
    const history = Array.isArray(b.history) ? b.history : [];
    if (!currentScenic) return fail(res, 400, '缺少当前行程内容，请先生成或填写行程');
    if (!message) return fail(res, 400, '请输入调整要求');
    if (!dest) return fail(res, 400, '缺少主要目的地');
    if (!startDate || !endDate) return fail(res, 400, '请填写出行起止日期');
    if (days <= 0) return fail(res, 400, '天数无效');
    /* 历史对话长度限制，避免 prompt 过长 */
    const trimmedHistory = history.slice(-6);
    /* current_notes：当前备注内容（含上次生成的注意事项/美食推荐），供模型增量更新 */
    const currentNotes = String(b.current_notes || '').trim().slice(0, 4000);
    try {
      const r = await aiService.adjustItinerary(cfg, {
        currentScenic, currentNotes, message, dest, startDate, endDate, days, history: trimmedHistory
      });
      dbModule.audit(user.id, 'ai_chat_route', 'routes', null,
        `AI 调整行程：${dest}，指令：${message.slice(0, 50)}`, req.socket.remoteAddress || '');
      return ok(res, { scenic: r.scenic, notes: r.notes });
    } catch (e) {
      return fail(res, 400, 'AI 行程调整失败：' + e.message);
    }
  }

  /* GET /api/routes 列表（分页 + 服务端 year/q 过滤，与统计口径一致） */
  if (rest === '' && method === 'GET') {
    const hideSeed = query.hideSeed === '1';
    const { rows, total, page, pageSize } = listForUser(user.id, {
      year: query.year || '',
      q: query.q || '',
      hideSeed,
      page: query.page,
      pageSize: query.pageSize
    });
    /* 附上流水笔数（列表卡片徽标用），一次分组查询避免 N+1 */
    const ids = rows.map(r => r.id);
    const counts = expenseCounts(ids);
    const tcounts = travelerCounts(ids);
    const daysMap = dbModule.daysForRoutes(ids);
    return ok(res, {
      list: rows.map(r => Object.assign(dbModule.routeToJson(r), {
        expense_count: counts[r.id] || 0,
        traveler_count: tcounts[r.id] || 0,
        day_plans: daysMap[r.id] || []
      })),
      total, page, pageSize
    });
  }

  /* GET /api/routes/years —— 返回当前用户可见的全量去重年份（受 hideSeed 影响，不受 year 过滤）
   * 工作台年份筛选胶囊据此渲染，确保跨年数据多、分页时年份选项完整。 */
  if (rest === '/years' && method === 'GET') {
    return routesYears(res, user.id, query);
  }

  /* POST /api/routes 新建 */
  if (rest === '' && method === 'POST') {
    if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
    if (!String(body.name || '').trim()) return fail(res, 400, '请填写路线名称');
    const rec = dbModule.insertRoute(user.id, body, false);
    return created(res, rec);
  }

  /* DELETE /api/routes 清空本人全部 */
  if (rest === '' && method === 'DELETE') {
    db().prepare('DELETE FROM routes WHERE owner_id = ? AND is_seed = 0').run(user.id);
    return ok(res, true);
  }

  /* GET /api/routes/export?fmt=csv|json — 个人导出（仅本人数据，不含示例）
   * JSON 为**完整备份**：除路线字段外，还含按天行程（day_plans）、同行人（travelers）
   * 与逐笔流水（expenses，含分摊人），可与 /import 往返还原。
   * CSV 仍为 9 类汇总口径（Excel 友好），不含流水明细。 */
  if (rest === '/export' && method === 'GET') {
    const rows = queryRoutes(user.id, { year: query.year || '', q: '', hideSeed: true });
    if (query.fmt === 'json') {
      return ok(res, {
        count: rows.length,
        routes: rows.map(r => {
          const j = dbModule.routeToJson(r);
          const ledger = dbModule.exportLedger(r.id);
          j.day_plans = dbModule.listRouteDays(r.id);
          j.travelers = ledger.travelers;
          j.expenses = ledger.expenses;
          return j;
        })
      });
    }
    const head = CSV_HEAD;
    const data = rows.map(r => {
      const j = dbModule.routeToJson(r);
      return CSV_HEAD.map(h => {
        if (dbModule.EXP_KEYS.includes(h)) return dbModule.num(j.exp[h]);
        if (h === 'days' || h === 'people' || h === 'budget_total' || h === 'budget_daily') return dbModule.num(j[h]);
        return j[h];
      });
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="travel-expense.csv"'
    });
    return res.end(toCsv(head, data));
  }

  /* POST /api/routes/import — 个人 JSON 导入（新增为本人路线，仅白名单字段）
   * 去重键：名称 + 年份 + 目的地 + 起止日期（**不再只用名称+年份+目的地**，
   * 否则同名同年同目的地的不同行程会被误判重复而静默跳过）。
   * 若条目携带 travelers / expenses（新版完整备份），则一并还原流水与同行人。 */
  if (rest === '/import' && method === 'POST') {
    if (!body || !Array.isArray(body.routes)) return fail(res, 400, '格式应为 { routes: [...] }');
    if (body.routes.length > 2000) return fail(res, 400, '单次导入上限 2000 条');
    let created = 0, skipped = 0, duplicates = 0, travelersRestored = 0, expensesRestored = 0;
    const errors = [];
    /* 起止日期：与 db.bind() 同口径（优先结构化字段，回退 daterange 文本解析），
     * 保证「导入条目」与「库中已有行」的去重键可比。 */
    const effDates = (o) => {
      const dr = dbModule.parseDateRange(o.daterange, o.year);
      return {
        start: String(o.start_date || '').trim() || dr.start || '',
        end: String(o.end_date || '').trim() || dr.end || ''
      };
    };
    const dedupKey = (name, year, dest, start, end) =>
      [name, year, dest, start, end].map(v => String(v == null ? '' : v).trim()).join('|');

    /* 构建已存在的 key 集合用于去重 */
    const existing = new Set(
      db().prepare('SELECT name, year, dest, start_date, end_date FROM routes WHERE owner_id = ?').all(user.id)
        .map(r => dedupKey(r.name, r.year, r.dest, r.start_date, r.end_date))
    );
    const seenInBatch = new Set();
    body.routes.forEach((item, i) => {
      if (!item || typeof item !== 'object' || !String(item.name || '').trim()) {
        skipped++; errors.push('第 ' + (i + 1) + ' 条缺少名称，已跳过');
        return;
      }
      const d = effDates(item);
      const key = dedupKey(item.name, item.year, item.dest, d.start, d.end);
      if (existing.has(key) || seenInBatch.has(key)) {
        duplicates++;
        return;
      }
      seenInBatch.add(key);
      const hasLedger = Array.isArray(item.expenses) && item.expenses.length > 0;
      const clean = {
        name: String(item.name), year: String(item.year || ''), type: String(item.type || '自由行'),
        daterange: String(item.daterange || ''), start_date: String(item.start_date || ''), end_date: String(item.end_date || ''),
        days: parseInt(item.days) || 0, people: parseInt(item.people) || 0,
        dest: String(item.dest || ''), scenic: String(item.scenic || ''), hotel: String(item.hotel || ''),
        day_plans: Array.isArray(item.day_plans) ? item.day_plans : undefined,
        currency: String(item.currency || 'CNY'), budget_total: dbModule.num(item.budget_total), budget_daily: dbModule.num(item.budget_daily),
        /* 携带完整流水时，不再由 exp 生成「期初流水」——否则会与还原的流水重复计账 */
        exp: hasLedger ? {} : ((item.exp && typeof item.exp === 'object') ? item.exp : {}),
        notes: String(item.notes || '')
      };
      const rec = dbModule.insertRoute(user.id, clean, false);
      if (rec && rec.id && (Array.isArray(item.travelers) || Array.isArray(item.expenses))) {
        const r = dbModule.importLedger(rec.id, user.id, item.travelers, item.expenses);
        travelersRestored += r.travelers;
        expensesRestored += r.expenses;
      }
      existing.add(key);
      created++;
    });
    return ok(res, { created, skipped, duplicates, travelers: travelersRestored, expenses: expensesRestored, errors });
  }

  /* /:id 详情/更新/删除 + 子资源：share（只读分享）/ travelers / expenses / settle */
  if (rest.startsWith('/')) {
    const segs = rest.slice(1).split('/').map(s => decodeURIComponent(s));
    const id = segs[0];
    const sub = segs[1] || '';
    const subId = segs[2] || '';
    if (!id) return fail(res, 404, '路线不存在');
    /* 离线同步必须能把「路线已删除」作为逐笔结果返回，而不是整请求 404。
     * 限定仍需已登录；syncExpenseOps 会验证路线/owner，并且不暴露任何已有记录。 */
    if (sub === 'expenses' && subId === 'sync' && method === 'POST') {
      const row = findVisible(id, user.id);
      if (row && row.is_seed && user.role !== 'admin') {
        return fail(res, 403, '示例路线为系统数据，仅可查看', { code: 'FORBIDDEN' });
      }
      const canWrite = row && (row.owner_id === user.id || user.role === 'admin');
      if (!canWrite) {
        const ops = body && Array.isArray(body.ops) ? body.ops : [];
        if (ops.length > 200) return fail(res, 400, '单次最多同步 200 笔', { code: 'OPS_TOO_MANY' });
        return ok(res, { server_time: Date.now(), results: ops.map(op => ({
          op_id: String((op && op.op_id) || '').slice(0, 80), status: 'rejected',
          code: 'ROUTE_NOT_FOUND', message: '路线不存在或无权访问'
        })) });
      }
      /* 进入标准资源分发（继续执行下方 isOwn / seedReadonly 门禁） */
    }
    const row = findVisible(id, user.id);
    if (!row) return fail(res, 404, '路线不存在');

    /* 示例路线对普通用户只读；管理员可管理种子 */
    const isOwn = row.owner_id === user.id || user.role === 'admin';
    const seedReadonly = row.is_seed && user.role !== 'admin';

    /* ---------- 分享令牌管理：仅本人或管理员 ---------- */
    if (sub === 'share') {
      if (method === 'GET') {
        if (!isOwn) return fail(res, 403, '无权查看该路线的分享', { code: 'FORBIDDEN' });
        return ok(res, { token: dbModule.getShareToken(id) });
      }
      if (method === 'POST') {
        if (!isOwn) return fail(res, 403, '无权分享该路线', { code: 'FORBIDDEN' });
        const token = crypto.randomBytes(16).toString('hex');
        dbModule.setShareToken(id, token);
        return ok(res, { token });
      }
      if (method === 'DELETE') {
        if (!isOwn) return fail(res, 403, '无权取消该路线的分享', { code: 'FORBIDDEN' });
        dbModule.clearShareToken(id);
        return ok(res, true);
      }
      return fail(res, 404, '接口不存在');
    }

    /* ---------- 逐笔消费流水 + AA 分账 ----------
     * 读操作：与路线同样的可见性（本人 + 示例对全员可见）
     * 写操作：示例路线只读（普通用户）+ 非本人 403，与路线 CRUD 保持一致 */
    if (sub === 'travelers' || sub === 'expenses' || sub === 'settle') {
      if (method !== 'GET' && seedReadonly) {
        return fail(res, 403, '示例路线为系统数据，仅可查看', { code: 'FORBIDDEN' });
      }
      if (method !== 'GET' && !isOwn) {
        return fail(res, 403, '无权修改该路线的流水', { code: 'FORBIDDEN' });
      }
      const ip = req.socket.remoteAddress || '';
      try {
        /* ----- 结算 ----- */
        if (sub === 'settle') {
          if (method !== 'GET') return fail(res, 404, '接口不存在');
          return ok(res, dbModule.settle(id));
        }

        /* ----- 同行人 ----- */
        if (sub === 'travelers') {
          if (method === 'GET' && !subId) {
            return ok(res, { list: dbModule.listTravelers(id) });
          }
          if (method === 'POST' && !subId) {
            const raw = body && (Array.isArray(body.names) ? body.names : (body.name ? [body.name] : []));
            if (!raw.length) return fail(res, 400, '请填写同行人姓名');
            if (raw.length > 50) return fail(res, 400, '一次最多添加 50 人');
            const r = dbModule.addTravelers(id, row.owner_id, raw);
            dbModule.audit(user.id, 'add_travelers', 'routes', id, `新增同行人 ${r.created} 人`, ip);
            return ok(res, r);
          }
          if (method === 'PATCH' && subId) {
            if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
            const t = dbModule.updateTraveler(subId, id, body);
            if (!t) return fail(res, 404, '同行人不存在');
            return ok(res, t);
          }
          if (method === 'DELETE' && subId) {
            const force = query.force === '1';
            const r = dbModule.deleteTraveler(subId, id, force);
            if (!r.ok && r.code === 'NOT_FOUND') return fail(res, 404, '同行人不存在');
            if (!r.ok && r.code === 'IN_USE') {
              return fail(res, 409, `该同行人已被 ${r.affected} 笔流水引用`, { code: 'TRAVELER_IN_USE', affected: r.affected });
            }
            dbModule.audit(user.id, 'delete_traveler', 'routes', id, `删除同行人（影响 ${r.affected} 笔）`, ip);
            return ok(res, r);
          }
          return fail(res, 404, '接口不存在');
        }

        /* ----- 流水 ----- */
        if (method === 'GET' && !subId) {
          return ok(res, dbModule.listExpenses(id, {
            category: query.category || '', payer: query.payer || '',
            from: query.from || '', to: query.to || '',
            updatedSince: query.updated_since || 0,
            page: query.page, pageSize: query.pageSize
          }));
        }
        if (method === 'POST' && subId === 'sync') {
          if (!body || !Array.isArray(body.ops)) return fail(res, 400, '格式应为 { ops: [...] }', { code: 'INVALID_OPS' });
          if (body.ops.length > 200) return fail(res, 400, '单次最多同步 200 笔', { code: 'OPS_TOO_MANY' });
          const result = dbModule.syncExpenseOps(id, row.owner_id, body.ops);
          const accepted = result.results.filter(x => x.status === 'accepted' || x.status === 'duplicate' || x.status === 'degraded').length;
          if (body.ops.length) dbModule.audit(user.id, 'sync_expenses', 'routes', id, `离线同步 ${body.ops.length} 笔操作，成功 ${accepted} 笔`, ip);
          return ok(res, result);
        }
        if (method === 'POST' && !subId) {
          if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
          const rec = dbModule.insertExpense(id, row.owner_id, body);
          dbModule.audit(user.id, 'add_expense', 'routes', id, `记录流水 ${rec.category} ${rec.amount}`, ip);
          return created(res, rec);
        }
        if (method === 'POST' && subId === 'bulk-delete') {
          const n = dbModule.bulkDeleteExpenses(id, body && body.ids);
          dbModule.audit(user.id, 'bulk_delete_expenses', 'routes', id, `批量删除流水 ${n} 笔`, ip);
          return ok(res, { deleted: n });
        }
        if (method === 'PATCH' && subId) {
          if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
          const rec = dbModule.updateExpense(subId, id, body);
          if (!rec) return fail(res, 404, '流水不存在');
          dbModule.audit(user.id, 'update_expense', 'routes', id, `修改流水 ${rec.category} ${rec.amount}`, ip);
          return ok(res, rec);
        }
        if (method === 'DELETE' && subId) {
          const deleted = dbModule.deleteExpense(subId, id);
          if (deleted) dbModule.audit(user.id, 'delete_expense', 'routes', id, '删除一笔流水', ip);
          return ok(res, { deleted: deleted ? 1 : 0 });
        }
        return fail(res, 404, '接口不存在');
      } catch (e) {
        /* 校验类错误统一 400，并回传机器可读 code（避免落到全局 500） */
        /* 离线编辑乐观锁冲突：409 并附服务端当前记录（冲突处置面板「采用服务端」直接可用）。 */
        if (e && e.code === 'EDIT_CONFLICT') {
          return fail(res, 409, e.message, { code: e.code, server: e.server || null });
        }
        if (e && e.code && (/^(INVALID_|DUPLICATE_)/.test(e.code) || e.code === 'ID_CONFLICT' || e.code === 'OPS_TOO_MANY')) {
          const status = e.code === 'ID_CONFLICT' ? 409 : 400;
          return fail(res, status, e.message, { code: e.code });
        }
        throw e;
      }
    }

    /* ---------- 路线本体 ---------- */
    if (sub) return fail(res, 404, '接口不存在');

    if (method === 'GET') {
      return ok(res, Object.assign(dbModule.routeToJson(row), { day_plans: dbModule.listRouteDays(id) }));
    }

    if (seedReadonly) {
      return fail(res, 403, '示例路线为系统数据，仅可查看', { code: 'FORBIDDEN' });
    }

    if (method === 'PUT') {
      if (!isOwn) return fail(res, 403, '无权修改该路线', { code: 'FORBIDDEN' });
      if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
      if (!String(body.name || '').trim()) return fail(res, 400, '请填写路线名称');
      const rec = dbModule.updateRoute(id, row.owner_id, body);
      return ok(res, rec);
    }
    if (method === 'DELETE') {
      if (!isOwn) return fail(res, 403, '无权删除该路线', { code: 'FORBIDDEN' });
      db().prepare('DELETE FROM routes WHERE id = ?').run(id);
      return ok(res, true);
    }
  }

  return fail(res, 404, '接口不存在');
}

/* ---------- 统计 ---------- */
const CATS = dbModule.EXP_KEYS; // ['交通','机票',...]

function statsSummary(res, user, query) {
  const hideSeed = query.hideSeed === '1';
  const year = query.year || '';
  /* 搜索关键字需与列表同源过滤，否则「列表已过滤、统计仍为全量」口径不一致 */
  const q = query.q || '';
  const home = homeCurrency();
  const rows = queryRoutes(user.id, { year, q, hideSeed });
  const byYear = {};
  const totals = {};
  CATS.forEach(c => (totals[c] = 0));
  let grand = 0, count = 0, days = 0;
  for (const r of rows) {
    const y = r.year || '未标注';
    if (!byYear[y]) byYear[y] = { year: y, count: 0, days: 0, total: 0, exp: {} };
    const e = dbModule.routeToJson(r).exp;
    const cur = r.currency || 'CNY';
    let t = 0;
    for (const c of CATS) {
      const conv = fx.convert(dbModule.num(e[c]), cur, home).value;
      byYear[y].exp[c] = (byYear[y].exp[c] || 0) + conv;
      totals[c] += conv; t += conv;
    }
    byYear[y].total += t; byYear[y].count += 1; byYear[y].days += (r.days || 0);
    grand += t; count += 1; days += (r.days || 0);
  }
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  let budgetTotal = 0;
  for (const r of rows) budgetTotal += fx.convert(dbModule.num(r.budget_total), r.currency || 'CNY', home).value;
  const remaining = budgetTotal - grand;
  return ok(res, {
    grand, count, days,
    totalByCat: totals,
    byYear: years.map(y => byYear[y]),
    years,
    homeCurrency: home,
    budgetTotal,
    remaining,
    overBudget: grand > budgetTotal && budgetTotal > 0
  });
}

function statsTrend(res, user, query) {
  const hideSeed = query.hideSeed === '1';
  const year = query.year || '';
  /* 同 statsSummary：趋势图亦须消费搜索关键字，保持与列表同源 */
  const q = query.q || '';
  const home = homeCurrency();
  const rows = queryRoutes(user.id, { year, q, hideSeed });
  // 筛选全部年份 → 按年聚合，呈现年消费趋势（标签为具体年份，如 2024）
  if (!year) {
    const byYear = {};
    for (const r of rows) {
      let key = null;
      if (r.start_date) key = r.start_date.slice(0, 4);
      else { const d = parseDate(r.daterange, r.year); if (d) key = String(d.year); }
      /* 趋势图按时间轴聚合，无法定位年份的路线（空 year 且无法解析日期）不属于时间序列，跳过 */
      if (!key) continue;
      const t = dbModule.routeToJson(r).exp;
      const cur = r.currency || 'CNY';
      let sum = 0;
      for (const c of CATS) sum += fx.convert(dbModule.num(t[c]), cur, home).value;
      if (!byYear[key]) byYear[key] = { period: key, label: key, total: 0 };
      byYear[key].total += sum;
    }
    const years = Object.keys(byYear).sort();
    return ok(res, years.map(y => byYear[y]));
  }
  // 筛选具体年份 → 按该年月份聚合，呈现月消费趋势（标签为 MM月）
  const byMonth = {};
  for (const r of rows) {
    let key = null;
    if (r.start_date) key = r.start_date.slice(0, 7);
    else { const d = parseDate(r.daterange, r.year); if (d) key = d.year + '-' + String(d.month).padStart(2, '0'); }
    if (!key) continue;
    const t = dbModule.routeToJson(r).exp;
    const cur = r.currency || 'CNY';
    let sum = 0;
    for (const c of CATS) sum += fx.convert(dbModule.num(t[c]), cur, home).value;
    if (!byMonth[key]) byMonth[key] = { period: key, label: key.slice(5) + '月', total: 0 };
    byMonth[key].total += sum;
  }
  const months = Object.keys(byMonth).sort();
  return ok(res, months.map(m => byMonth[m]));
}

/* 解析 daterange 起始日（兼容 M/D 与 YYYY/M/D） */
function parseDate(dr, year) {
  if (!dr) return null;
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2] };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return { year: +year, month: +m[1] };
  return null;
}

module.exports = { handle };
