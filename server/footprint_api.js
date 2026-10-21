/* 足迹点亮 API：/api/footprints
 * 字典搜索 / 地图点阵数据 / 成就汇总 / 待标注路线 / 路线外手动点亮
 * 鉴权：requireAuth 之后调用；req 由 authFromReq 注入 user。owner 隔离在 db 层。 */
'use strict';
const { fail, ok } = require('./http');
const dbModule = require('./db');
const { authFromReq } = require('./auth');

async function handle(req, res, url, body) {
  const user = authFromReq(req);
  if (!user) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });

  const { pathname, query } = url;
  const rest = pathname.slice('/api/footprints'.length);
  const method = req.method;

  /* GET /places?q= — 标准地名搜索（汉字模糊 + 拼音/首字母前缀，市优先） */
  if (rest === '/places' && method === 'GET') {
    return ok(res, { list: dbModule.searchPlaces(query.q, query.limit) });
  }

  /* GET /map — 点阵地图数据：全国省/市中心点 + 点亮状态 + 统计 */
  if (rest === '/map' && method === 'GET') {
    return ok(res, dbModule.footprintMapData(user.id));
  }

  /* GET /summary — 计数 / 年度回顾 / 成就（服务端唯一口径） */
  if (rest === '/summary' && method === 'GET') {
    return ok(res, dbModule.footprintSummary(user.id));
  }

  /* GET /pending — 待标注路线（无目的地选择的本人路线，引导补选） */
  if (rest === '/pending' && method === 'GET') {
    return ok(res, { list: dbModule.pendingRoutes(user.id) });
  }

  /* POST /manual — 路线外点亮（出差/路过/探亲）。body: { place: adcode|简名, date?: YYYY-MM-DD }
   * 字典外地名一律拒绝（AI 幻觉地名在此被裁决）；重复点亮幂等返回 already=true。 */
  if (rest === '/manual' && method === 'POST') {
    const b = body || {};
    const ref = b.place || b.adcode || b.name || '';
    if (!String(ref).trim()) return fail(res, 400, '请选择要点亮的地名');
    try {
      const r = dbModule.manualLit(user.id, ref, b.date, req.socket.remoteAddress || '');
      return ok(res, r);
    } catch (e) {
      if (e && e.code === 'INVALID_PLACE') return fail(res, 400, e.message, { code: e.code });
      throw e;
    }
  }

  return fail(res, 404, '接口不存在');
}

module.exports = { handle };
