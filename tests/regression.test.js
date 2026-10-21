/* 全量回归测试：对照规格书 travel-expense-spec-multiusr-2026-08-18
 * 覆盖：db.js/config.js（§2 数据模型）、auth.js（§3/§4.2）、
 *       routes_api（§4.3）、admin_api（§4.4）、app.js（§1.2/§8）
 * 运行：node regression.test.js <BASE_URL>
 * 退出码：0=全绿 1=有失败
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3900';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const msg = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + msg); console.log('  ❌ ' + name + msg); }
}
function section(t) { console.log('\n■ ' + t); }

async function req(method, path, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') opt.body = body;          // 原始 body（非法 JSON 测试用）
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + path, opt);
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  let adminCookie = null, userCookie = null, user2Cookie = null;

  /* ================= db.js + config.js（§2 数据模型） ================= */
  section('T1 db.js/config.js — 建表与种子');
  const { status: hStatus } = await req('GET', '/health');
  check('健康检查 /health 200', hStatus === 200, hStatus);

  // 登录种子管理员
  let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
  check('种子管理员 admin/123456 可登录（§2.3）', r.status === 200 && r.json.ok && r.json.data.role === 'admin', r);
  check('种子管理员 force_reset=1（§8.3 首登强制改密）', r.json.data.force_reset === true, r.json && r.json.data);
  check('登录响应 Set-Cookie sid（§3.3）', /^sid=/.test(r.setCookie || ''), r.setCookie);
  adminCookie = r.setCookie;

  /* 强制改密：服务端硬门禁（仅前端跳转可被直接调 API 绕过） */
  r = await req('GET', '/api/routes', null, adminCookie);
  check('未改密时业务 API → 403 PASSWORD_RESET_REQUIRED（§8.3 服务端门禁）',
    r.status === 403 && r.json.code === 'PASSWORD_RESET_REQUIRED', r);
  r = await req('GET', '/api/auth/me', null, adminCookie);
  check('强制改密期间 /auth/me 放行（前端据此渲染引导页）',
    r.status === 200 && r.json.data.force_reset === true, r);
  r = await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);
  check('首登改密成功（§4.2 /password）', r.status === 200 && r.json.ok, r);
  r = await req('GET', '/api/auth/me', null, adminCookie);
  check('改密后 force_reset 清零（§6.6）', r.json.data.force_reset === false, r.json && r.json.data);

  // 种子路线全员可见
  r = await req('GET', '/api/routes', null, adminCookie);
  check('种子路线已导入且管理员可见（§2.3）', r.status === 200 && r.json.data.list.length >= 4, r);
  const seedIds = (r.json.data.list || []).filter(x => x.is_seed).map(x => x.id);
  check('种子路线 is_seed=1 全员可见', seedIds.length >= 4, seedIds);
  // 隐藏系统示例：种子路线归 admin 所有，原过滤仅排除非本人路线 → 管理员藏不掉（验收 bug）
  r = await req('GET', '/api/routes?hideSeed=1', null, adminCookie);
  check('隐藏系统示例：管理员 hideSeed=1 后示例路线被排除（回归）', r.status === 200 && r.json.data.list.length === 0, r);

  /* ================= mailer.js + auth.js（§3/§4.2） ================= */
  section('T4 mailer.js — 邮件未配置时发码');
  r = await req('POST', '/api/auth/send-code', { email: 'new@example.com', purpose: 'register' });
  check('send-code 未启用邮件 → 400 MAIL_DISABLED（§4.2/附录B）', r.status === 400 && r.json.code === 'MAIL_DISABLED', r);

  section('T2 auth.js — check-exists / 注册');
  r = await req('POST', '/api/auth/check-exists', { email: 'new@example.com' });
  check('check-exists 邮箱不存在 → {email:false}', r.status === 200 && r.json.data.email === false, r);
  r = await req('POST', '/api/auth/check-exists', { username: 'admin' });
  check('check-exists 用户名已存在 → {username:true}', r.status === 200 && r.json.data.username === true, r);

  // 账户名注册
  r = await req('POST', '/api/auth/register', { username: 'alice', password: 'alicepass123' });
  check('账户名注册成功 201（§3.1-B）', r.status === 201 && r.json.data.username === 'alice', r);
  check('账户名注册无邮箱 → email_verified=0', r.json.data.email_verified === false, r);
  check('注册自动登录 Set-Cookie（§3.1）', /^sid=/.test(r.setCookie || ''), r.setCookie);
  userCookie = r.setCookie;

  r = await req('POST', '/api/auth/register', { username: 'alice', password: 'x12345678' });
  check('重复用户名 → 409 USERNAME_TAKEN（§3.1 唯一性）', r.status === 409 && r.json.code === 'USERNAME_TAKEN', r);

  r = await req('POST', '/api/auth/register', { email: 'bob@example.com', username: 'bob', password: 'bobpass123' });
  check('邮箱+用户名注册（无验证码）→ 400 CODE_INVALID（§3.1-A 需码）', r.status === 400 && r.json.code === 'CODE_INVALID', r);

  r = await req('POST', '/api/auth/register', { email: 'bad-email', password: 'x12345678' });
  check('非法邮箱格式 → 400', r.status === 400, r);

  r = await req('POST', '/api/auth/register', { username: 'x', password: '' });
  check('空密码 → 400（§3.1）', r.status === 400, r);

  /* 邮箱注册（验证码已由编排脚本预注入 DB；REGISTER_CODE 为空则跳过） */
  const REGISTER_CODE = process.env.REGISTER_CODE || '';
  if (REGISTER_CODE) {
    r = await req('POST', '/api/auth/register', { email: 'carol@example.com', password: 'carolpass123', code: REGISTER_CODE });
    check('邮箱注册（有效验证码）→ 201 且 email_verified=1（§3.1-A）', r.status === 201 && r.json.data.email_verified === true, r);
    check('邮箱注册用户名自动生成（§3.1-A）', typeof r.json.data.username === 'string' && r.json.data.username.startsWith('carol'), r.json && r.json.data);
    user2Cookie = r.setCookie;

    // 重复用码
    r = await req('POST', '/api/auth/register', { email: 'carol2@example.com', password: 'carolpass123', code: REGISTER_CODE });
    check('验证码一次性：复用 → 400 CODE_INVALID（§7.4）', r.status === 400 && r.json.code === 'CODE_INVALID', r);

    // 邮箱+密码登录
    r = await req('POST', '/api/auth/login', { login: 'carol@example.com', password: 'carolpass123' });
    check('邮箱+密码登录成功（§3.2 方式3）', r.status === 200 && r.json.ok, r);
  } else {
    console.log('  ⏭  跳过邮箱注册验证码用例（未注入 REGISTER_CODE）');
  }

  /* 登录三方式 */
  section('T3 auth.js — 登录三方式 / 会话 / 封禁');
  r = await req('POST', '/api/auth/login', { login: 'alice', password: 'alicepass123' });
  check('账户名+密码登录成功（§3.2 方式1）', r.status === 200 && r.json.ok, r);
  check('登录响应返回用户信息', r.json.data && r.json.data.username === 'alice', r);

  r = await req('POST', '/api/auth/login', { login: 'alice', password: 'wrong' });
  check('密码错误 → 401 INVALID_CREDENTIAL 不区分（§3.2）', r.status === 401 && r.json.code === 'INVALID_CREDENTIAL', r);
  r = await req('POST', '/api/auth/login', { login: 'nosuchuser', password: 'whatever123' });
  check('账号不属于该服务器 → 404 ACCOUNT_NOT_FOUND（独立客户端可据此提示「该服务器无此账号」）', r.status === 404 && r.json.code === 'ACCOUNT_NOT_FOUND', r);

  // 邮箱+密码登录
  if (user2Cookie) {
    // 上面已在注册段验证过邮箱+密码登录，此处验证邮箱+错误密码
    r = await req('POST', '/api/auth/login', { login: 'carol@example.com', password: 'wrongpass' });
    check('邮箱+错误密码 → 401', r.status === 401, r);
  }

  // me
  r = await req('GET', '/api/auth/me', null, adminCookie);
  check('GET /me 返回当前用户（§4.2）', r.status === 200 && r.json.data.id && r.json.data.role === 'admin', r);
  r = await req('GET', '/api/auth/me');
  check('未登录 /me → 401 UNAUTHORIZED（§4.1）', r.status === 401 && r.json.code === 'UNAUTHORIZED', r);

  // 未登录访问业务接口
  r = await req('GET', '/api/routes');
  check('未登录 /api/routes → 401（§4.1）', r.status === 401, r);

  /* 封禁 */
  section('T3 auth.js — 封禁即时生效');
  r = await req('POST', '/api/admin/users/2/ban', null, adminCookie);
  check('管理员封禁 alice → ok（§3.5）', r.status === 200 && r.json.ok, r);
  r = await req('POST', '/api/auth/login', { login: 'alice', password: 'alicepass123' });
  check('封禁后登录 → 403 BANNED（§3.5 任何方式先判）', r.status === 403 && r.json.code === 'BANNED', r);
  r = await req('GET', '/api/auth/me', null, userCookie);
  check('封禁即时掉线：旧会话 401（§3.5 删全部会话）', r.status === 401, r);
  r = await req('POST', '/api/admin/users/2/unban', null, adminCookie);
  check('解封 → ok', r.status === 200 && r.json.ok, r);

  // 自我保护
  r = await req('POST', '/api/admin/users/1/ban', null, adminCookie);
  check('不能封禁自己（§3.5）', r.status === 400, r);
  r = await req('POST', '/api/admin/users/1/role', { role: 'user' }, adminCookie);
  check('不能修改自己角色（§5.7）', r.status === 400, r);

  /* 改密（首登改密已在文件开头完成，此处验证凭据切换与失败分支） */
  section('T3 auth.js — 改密与强制改密');
  r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
  check('旧密码失效 → 401', r.status === 401, r);
  r = await req('POST', '/api/auth/login', { login: 'admin', password: 'adminnew123' });
  check('新密码可登录', r.status === 200 && r.json.ok, r);
  adminCookie = r.setCookie;
  r = await req('POST', '/api/auth/password', { oldPassword: 'bad', newPassword: 'whatever123' }, adminCookie);
  check('原密码错误 → 400', r.status === 400, r);
  r = await req('POST', '/api/auth/password', { oldPassword: 'adminnew123', newPassword: 'short' }, adminCookie);
  check('新密码过短 → 400（§3.6 ≥8 位）', r.status === 400, r);

  /* 限流（用独立账号探测，避免污染 admin 登录桶） */
  section('T3 auth.js — 限流');
  let limited = false;
  for (let i = 0; i < 12; i++) {
    r = await req('POST', '/api/auth/login', { login: 'ratelimit_probe', password: 'wrong' });
    if (r.status === 429) { limited = true; break; }
  }
  check('登录连续失败 → 429 限流（§7.3）', limited, r);

  // logout
  r = await req('POST', '/api/auth/logout', null, adminCookie);
  check('登出 → ok（§3.3）', r.status === 200 && r.json.ok, r);
  r = await req('GET', '/api/auth/me', null, adminCookie);
  check('登出后会话失效 → 401', r.status === 401, r);

  /* 重新登录（后续用例需要） */
  r = await req('POST', '/api/auth/login', { login: 'admin', password: 'adminnew123' });
  check('admin 重新登录成功（后续用例前置）', r.status === 200 && r.json.ok, r);
  adminCookie = r.setCookie;

  /* ================= routes_api（§4.3） ================= */
  section('T5 routes_api — CRUD + owner 隔离 + 种子只读');
  // 新建（用 alice 重新登录）
  r = await req('POST', '/api/auth/login', { login: 'alice', password: 'alicepass123' });
  userCookie = r.setCookie;
  r = await req('POST', '/api/routes', {
    name: '我的川西之旅', year: '2026', type: '自由行', days: 6, people: 2,
    dest: '四川', scenic: 'Day1 成都\nDay2 四姑娘山', hotel: '山居',
    exp: { 交通: 500, 住宿: 1800, 餐饮: 900, 门票: 300 }
  }, userCookie);
  check('POST /api/routes 新建 → 201（§4.3）', r.status === 201 && r.json.data.id, r);
  const aliceRoute = r.json.data.id;
  check('新建返回 exp 对象兼容（附录A）', r.json.data.exp && r.json.data.exp['交通'] === 500, r.json.data);

  r = await req('POST', '/api/routes', { name: '', year: '2026' }, userCookie);
  check('空名称 → 400（必填校验）', r.status === 400, r);

  // 列表：本人 + 种子
  r = await req('GET', '/api/routes', null, userCookie);
  const aliceList = r.json.data.list;
  check('列表 = 本人路线 + 种子（§4.3 合并）', r.status === 200 && aliceList.length >= 5 && aliceList.some(x => x.id === aliceRoute) && aliceList.some(x => x.is_seed), r);

  // 详情
  r = await req('GET', '/api/routes/' + aliceRoute, null, userCookie);
  check('GET /:id 详情 → 200', r.status === 200 && r.json.data.name === '我的川西之旅', r);
  r = await req('GET', '/api/routes/nonexistent', null, userCookie);
  check('不存在路线 → 404（不暴露存在性）', r.status === 404, r);

  // 修改
  r = await req('PUT', '/api/routes/' + aliceRoute, { name: '川西环线', year: '2026', exp: { 交通: 600, 住宿: 2000 } }, userCookie);
  check('PUT 更新本人路线 → 200', r.status === 200 && r.json.data.name === '川西环线', r);

  // 种子只读
  r = await req('PUT', '/api/routes/' + seedIds[0], { name: '改种子', exp: {} }, userCookie);
  check('普通用户改种子 → 403（§4.3 种子只读）', r.status === 403, r);
  r = await req('DELETE', '/api/routes/' + seedIds[0], null, userCookie);
  check('普通用户删种子 → 403', r.status === 403, r);
  r = await req('PUT', '/api/routes/' + seedIds[0], { name: '种子改名', exp: {} }, adminCookie);
  check('管理员可管理种子（§4.3）', r.status === 200 && r.json.data.name === '种子改名', r);

  // 删除
  r = await req('DELETE', '/api/routes/' + aliceRoute, null, userCookie);
  check('DELETE 本人路线 → ok', r.status === 200 && r.json.ok, r);
  r = await req('GET', '/api/routes/' + aliceRoute, null, userCookie);
  check('删除后详情 404', r.status === 404, r);

  /* 统计 */
  section('T5 routes_api — 统计接口');
  r = await req('GET', '/api/routes/stats/summary', null, userCookie);
  check('stats/summary 返回汇总（§4.3）', r.status === 200 && typeof r.json.data.grand === 'number' && r.json.data.byYear && r.json.data.totalByCat, r);
  r = await req('GET', '/api/routes/stats/trend', null, userCookie);
  check('stats/trend 返回月度序列（§4.3）', r.status === 200 && Array.isArray(r.json.data), r);
  // 趋势图粒度回归（验收 bug）：全部→按年聚合（period 为 4 位年份），具体年份→按月聚合（period 为 YYYY-MM）
  const trendAll = (r.json && r.json.data) || [];
  check('stats/trend 全部：按年聚合（period 为 YYYY，无月份）', r.status === 200 && trendAll.length > 0 && trendAll.every(p => /^\d{4}$/.test(p.period)), r);
  if (trendAll.length > 0) {
    const yr = trendAll[0].period;
    r = await req('GET', '/api/routes/stats/trend?year=' + yr, null, userCookie);
    const trendYr = (r.json && r.json.data) || [];
    check('stats/trend year=' + yr + '：响应年份筛选且按月聚合（period 为 YYYY-MM）', r.status === 200 && trendYr.length > 0 && trendYr.every(p => new RegExp('^' + yr + '-\\d{2}$').test(p.period)), r);
  }

  /* 年份胶囊数据源 + 搜索口径一致性（验收 bug 回归）
   * 背景：年份胶囊曾仅取当前分页、搜索仅前端过滤，导致「列表已过滤、统计仍为全量」； */
  section('T5b routes_api — 年份接口 / 搜索口径一致性');
  r = await req('GET', '/api/routes/years', null, userCookie);
  const yrs = (r.json && r.json.data && r.json.data.years) || [];
  check('/routes/years 返回数组', r.status === 200 && Array.isArray(yrs), r);
  check('/routes/years 去重且倒序', yrs.length > 0 && new Set(yrs).size === yrs.length
    && JSON.stringify(yrs) === JSON.stringify(yrs.slice().sort((a, b) => b.localeCompare(a))), yrs);
  /* 与「当前」可见列表对比（前面的用例已删除本人路线，故须重新拉取而非复用旧快照） */
  r = await req('GET', '/api/routes?page=1&pageSize=50', null, userCookie);
  const freshList = (r.json && r.json.data && r.json.data.list) || [];
  const expectYears = Array.from(new Set(freshList.map(x => x.year).filter(Boolean))).sort((a, b) => b.localeCompare(a));
  check('/routes/years === 可见列表去重年份（不受分页/year 过滤影响）', JSON.stringify(yrs) === JSON.stringify(expectYears), { yrs, expectYears });
  r = await req('GET', '/api/routes/years?hideSeed=1', null, userCookie);
  const yrsNoSeed = (r.json && r.json.data && r.json.data.years) || [];
  check('/routes/years?hideSeed=1 为全量年份子集', r.status === 200 && Array.isArray(yrsNoSeed) && yrsNoSeed.every(y => yrs.indexOf(y) >= 0), { yrsNoSeed, yrs });

  /* 列表与统计必须消费同一 q：直接对比列表 total 与 stats/summary.count */
  const KW = '江南';
  r = await req('GET', '/api/routes?q=' + encodeURIComponent(KW) + '&page=1&pageSize=50', null, userCookie);
  const kwList = (r.json && r.json.data) || {};
  check('列表 q=' + KW + ' 命中 1 条（种子示例）', r.status === 200 && kwList.total === 1, kwList.total);
  r = await req('GET', '/api/routes/stats/summary', null, userCookie);
  const allSum = (r.json && r.json.data) || {};
  r = await req('GET', '/api/routes/stats/summary?q=' + encodeURIComponent(KW), null, userCookie);
  const kwSum = (r.json && r.json.data) || {};
  check('stats/summary 消费 q：count === 列表 total（口径一致）', r.status === 200 && kwSum.count === kwList.total, { count: kwSum.count, total: kwList.total });
  check('stats/summary 确实按 q 收窄（小于全量）', kwSum.count < allSum.count, { filtered: kwSum.count, all: allSum.count });
  r = await req('GET', '/api/routes/stats/trend?q=' + encodeURIComponent(KW), null, userCookie);
  const kwTrend = (r.json && r.json.data) || [];
  const kwTrendSum = kwTrend.reduce((a, p) => a + (p.total || 0), 0);
  check('stats/trend 消费 q：趋势总额 === summary grand（口径一致）', r.status === 200
    && Math.abs(kwTrendSum - (kwSum.grand || 0)) < 0.01, { kwTrendSum, grand: kwSum.grand });

  // 清空保留种子（破坏性操作需显式确认）
  r = await req('POST', '/api/routes', { name: '临时路线', year: '2026', exp: { 交通: 10 } }, userCookie);
  const tmpId = r.json.data.id;
  r = await req('DELETE', '/api/routes', null, userCookie);
  check('DELETE / 缺少确认 → 400 CONFIRM_REQUIRED', r.status === 400 && r.json.code === 'CONFIRM_REQUIRED', r);
  r = await req('GET', '/api/routes?hideSeed=1', null, userCookie);
  check('未确认时数据未被删除', r.json.data.list.length === 1, r.json && r.json.data.list.length);
  r = await req('DELETE', '/api/routes?confirm=DELETE_ALL', null, userCookie);
  check('DELETE / 清空本人全部 → ok（§4.3）', r.status === 200 && r.json.ok && r.json.data.deleted >= 1, r);
  r = await req('GET', '/api/routes?hideSeed=1', null, userCookie);
  check('清空后 hideSeed=1 本人为 0（种子保留）', r.json.data.list.length === 0, r);

  /* ================= admin_api（§4.4） ================= */
  section('T6 admin_api — 权限与全部模块');
  r = await req('GET', '/api/admin/overview', null, userCookie);
  check('非 admin 访问 /api/admin/* → 403 FORBIDDEN（§4.4）', r.status === 403 && r.json.code === 'FORBIDDEN', r);

  r = await req('GET', '/api/admin/overview', null, adminCookie);
  check('overview 平台统计（§5.1）', r.status === 200 && r.json.data.userTotal >= 2 && typeof r.json.data.dbBytes === 'number', r);

  r = await req('GET', '/api/admin/users', null, adminCookie);
  check('用户列表含 online/route_count（§5.2）', r.status === 200 && r.json.data.list.length >= 2 && 'online' in r.json.data.list[0] && 'route_count' in r.json.data.list[0], r);
  r = await req('GET', '/api/admin/users?q=alice', null, adminCookie);
  check('用户搜索 q=alice 过滤', r.status === 200 && r.json.data.list.every(u => (u.username || '').includes('alice') || (u.email || '').includes('alice')), r);
  r = await req('GET', '/api/admin/users?status=banned', null, adminCookie);
  check('状态筛选 status=banned', r.status === 200 && r.json.data.list.every(u => u.status === 'banned'), r);
  r = await req('GET', '/api/admin/users?page=1&pageSize=1', null, adminCookie);
  check('分页 pageSize=1 → list 长度 1', r.status === 200 && r.json.data.list.length === 1 && r.json.data.total >= 2, r);

  // 提权/降级
  r = await req('POST', '/api/admin/users/2/role', { role: 'admin' }, adminCookie);
  check('设为管理员（§5.7 提权）', r.status === 200 && r.json.ok, r);
  r = await req('POST', '/api/admin/users/2/role', { role: 'user' }, adminCookie);
  check('取消管理员（非唯一）', r.status === 200 && r.json.ok, r);
  r = await req('POST', '/api/admin/users/999/role', { role: 'admin' }, adminCookie);
  check('不存在用户 → 404', r.status === 404, r);

  /* 邮件配置 */
  section('T6 admin_api — 邮件配置 / 站点设置 / 审计');
  r = await req('GET', '/api/admin/email-config', null, adminCookie);
  check('email-config 读取（§5.3）', r.status === 200 && r.json.data && 'enabled' in r.json.data, r);
  r = await req('PUT', '/api/admin/email-config', {
    smtp_host: 'smtp.example.com', smtp_port: 465, smtp_secure: true,
    smtp_user: 'test@example.com', smtp_pass: 'secret123', enabled: true,
    from_name: '旅行', from_address: 'test@example.com'
  }, adminCookie);
  check('email-config 保存 → ok（§5.3）', r.status === 200 && r.json.ok, r);
  r = await req('GET', '/api/admin/email-config', null, adminCookie);
  check('密码脱敏 ******（§7.7）', r.status === 200 && r.json.data.smtp_pass === '******', r.json.data);
  r = await req('PUT', '/api/admin/email-config', {
    smtp_host: 'smtp.example.com', smtp_port: 465, smtp_secure: true,
    smtp_user: 'test@example.com', smtp_pass: '******', enabled: true
  }, adminCookie);
  check('保存 ****** 不覆盖原密码（§5.3）', r.status === 200, r);
  r = await req('POST', '/api/admin/email-config/test', null, adminCookie);
  check('测试邮件接口可调用（失败也返回中文错误，§5.3）', r.status === 400 && /失败/.test(r.json.msg), r);

  // 发码现在应走真实 SMTP（会失败但错误信息明确）
  r = await req('POST', '/api/auth/send-code', { email: 'new@example.com', purpose: 'register' });
  check('启用邮件后 send-code 尝试发送（本机无 SMTP → 400 MAIL_ERROR）', r.status === 400 && /失败|未配置/.test(r.json.msg), r);

  /* 站点设置 */
  r = await req('GET', '/api/admin/site-settings', null, adminCookie);
  check('site-settings 读取（§5.4）', r.status === 200 && r.json.data.site_name === '旅行经费工作台', r);
  r = await req('PUT', '/api/admin/site-settings', {
    site_name: '回归测试站', allow_register: false, register_mode: 'email_only', announce_text: '欢迎'
  }, adminCookie);
  check('site-settings 保存 → ok（§5.4）', r.status === 200 && r.json.ok, r);
  r = await req('GET', '/api/public/site');
  check('公开接口反映站点设置（§4.1）', r.status === 200 && r.json.data.site_name === '回归测试站' && r.json.data.allow_register === false, r);
  r = await req('POST', '/api/auth/register', { username: 'banned_reg', password: 'whatever123' });
  check('关闭注册后注册 → 403（§5.4 开放注册开关）', r.status === 403, r);

  /* 审计日志 */
  r = await req('GET', '/api/admin/audit-logs', null, adminCookie);
  check('审计日志列表（§5.6）', r.status === 200 && r.json.data.list.length >= 1, r);
  const auditActs = new Set((r.json.data.list || []).map(l => l.action));
  check('审计含 ban_user（§5.6 动作记录）', auditActs.has('ban_user'), auditActs);

  /* ================= app.js（路由/公开接口） ================= */
  section('T6 app.js — 路由分发与兜底');
  r = await req('GET', '/api/nonexistent');
  check('未知 API → 404', r.status === 404, r);
  r = await req('GET', '/api/public/site');
  check('/api/public/site 无需登录（§4.1）', r.status === 200, r);
  r = await req('POST', '/api/routes', '{bad json', null);
  check('非法 JSON → 400', r.status === 400, r);

  /* ================= 汇总 ================= */
  console.log('\n══════════════════════════════════');
  console.log(`总用例：${pass + fail}  通过：${pass}  失败：${fail}`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('✅ 全量回归通过');
  process.exit(0);
}

main().catch(e => { console.error('测试脚本异常：', e); process.exit(2); });
