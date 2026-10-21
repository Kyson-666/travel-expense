/* 冒烟测试：AI 行程规划 / 调整（v1.1.0）
 * 起真实服务（隔离 DATA_DIR）+ 本地 OpenAI 兼容 mock 承接模型请求，覆盖：
 *  - 权限门禁：未启用账号 403 AI_NOT_ENABLED；管理员配置与「测试连通性」
 *  - 参数校验：缺日期 / 缺目的地 / 天数无效 / 缺当前行程 / 缺调整指令
 *  - 结构化输出：AI 三节（行程 / 注意事项 / 美食推荐）→ {scenic, notes}
 *  - 兼容回退：模型未按约定输出时，整段视为行程、notes 为空（旧行为不回归）
 *  - 调整：history 按末尾 6 条截断；current_notes 透传给模型
 *  - 请求构造：/v1/chat/completions、Bearer 鉴权、model、stream=false
 *  - 审计：ai_plan_route / ai_chat_route 落库
 * 运行：node tests/smoke-ai.test.js
 * 退出码：0=全绿 1=有失败
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3921;
const MOCK_PORT = 3922;
const BASE = 'http://127.0.0.1:' + PORT;
const MOCK_BASE = 'http://127.0.0.1:' + MOCK_PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-ai-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

/* ---------- 本地 OpenAI 兼容 mock ---------- */
let MOCK_CONTENT = '';
const seen = [];
function startMock() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MOCK_CONTENT } }] }));
    });
  });
  return new Promise(r => srv.listen(MOCK_PORT, '127.0.0.1', () => r(srv)));
}

async function req(method, p, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + p, opt);
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

const PLAN_MOCK = `【行程】
Day1 抵达西宁；下午东关清真大寺；晚上莫家街夜市（住宿：西宁）
Day2 塔尔寺；下午青海湖；晚上黑马河看日落（住宿：黑马河）
Day3 茶卡盐湖；下午返西宁（住宿：西宁）

【注意事项】
- 青海湖沿线海拔约 3200 米，抵达当天避免剧烈运动
- 昼夜温差可达 15℃，即使夏季也要带冲锋衣
- 塔尔寺需着装得体，殿内禁止拍照
- 紫外线强，建议 SPF50+ 防晒并佩戴墨镜

【美食推荐】
- 莫家街夜市的烤羊肉串与手工酸奶
- 西宁酿皮（约 10 元/份，酸辣开胃）
- 青海土火锅（人均 60-80 元）
- 酥油茶与糌粑，适合补充热量`;

const PLAIN_MOCK = 'Day1 抵达西宁\nDay2 塔尔寺-青海湖';

const ADJUST_MOCK = `【行程】
Day1 抵达西宁；下午东关清真大寺（住宿：西宁）
Day2 塔尔寺；下午青海湖（住宿：黑马河）
Day3 茶卡盐湖；下午返西宁（住宿：西宁）

【注意事项】
- 已按你的要求增加高原反应相关提醒：抵达首日多休息、多饮水
- 昼夜温差大，携带冲锋衣

【美食推荐】
- 新增：手抓羊肉（人均 80 元）
- 莫家街烤肉串`;

const ADJUST_NO_NOTES = `【行程】
Day1 抵达西宁（住宿：西宁）
Day2 塔尔寺（住宿：西宁）`;

async function main() {
  const mock = await startMock();
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 250));
  }
  check('服务启动 /health 200', up);
  if (!up) { console.log('服务未启动，中止'); srv.kill(); mock.close(); process.exit(1); }

  try {
    section('解析器单元校验（不依赖服务）');
    const ai = require(path.join(__dirname, '..', 'server', 'ai_service.js'));
    let p = ai.parseAiItinerary(PLAN_MOCK);
    check('三节输出 → scenic 仅含行程', p.scenic.startsWith('Day1') && !p.scenic.includes('注意事项'), p.scenic.slice(0, 40));
    check('三节输出 → notes 含注意事项与美食推荐', p.notes.includes('【注意事项】') && p.notes.includes('【美食推荐】'), p.notes.slice(0, 40));
    p = ai.parseAiItinerary(PLAIN_MOCK);
    check('未按约定输出 → 整段作为行程、notes 为空（兼容回退）', p.scenic === PLAIN_MOCK && p.notes === '', { s: p.scenic.slice(0, 20), n: p.notes });
    p = ai.parseAiItinerary('【行程】Day1 抵达\n【美食推荐】\n- 手抓羊肉');
    check('行内标记也能正确切分', p.scenic === 'Day1 抵达' && p.notes.includes('手抓羊肉'), p);
    p = ai.parseAiItinerary('## 行程\nDay1 到达\n## 注意事项\n- 带伞');
    check('兼容 markdown 风格的标题', p.scenic === 'Day1 到达' && p.notes.includes('带伞'), p);
    p = ai.parseAiItinerary('');
    check('空输入不抛异常', p.scenic === '' && p.notes === '');
    p = ai.parseAiItinerary(`【行程】\nDay1 A\n【注意事项】\n\n\n- x\n\n\n【美食推荐】\n- y`);
    check('多余空行被压缩', !/\n{3,}/.test(p.notes), JSON.stringify(p.notes));

    section('登录与 AI 门禁');
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie = r.setCookie;
    check('管理员登录', r.status === 200 && !!adminCookie, r.status);
    /* 首登强制改密已在服务端强制：先改为测试密码，后续业务请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);
    r = await req('POST', '/api/auth/register', { username: 'aiuser', password: 'test1234' });
    let userCookie = r.setCookie;
    if (!userCookie) { r = await req('POST', '/api/auth/login', { login: 'aiuser', password: 'test1234' }); userCookie = r.setCookie; }
    check('普通用户注册/登录', (r.status === 200 || r.status === 201) && !!userCookie, r.status);

    const planBody = { start_date: '2026-07-01', end_date: '2026-07-03', dest: '西宁、青海湖', days: 3 };
    r = await req('POST', '/api/routes/ai-plan', planBody, userCookie);
    check('未启用 AI 的账号调用 ai-plan → 403 AI_NOT_ENABLED', r.status === 403 && r.json.code === 'AI_NOT_ENABLED', r.status + ' ' + (r.json && r.json.code));
    r = await req('POST', '/api/routes/ai-chat', { current_scenic: 'x', message: 'y', dest: 'z', start_date: 'a', end_date: 'b', days: 1 }, userCookie);
    check('未启用 AI 的账号调用 ai-chat → 403 AI_NOT_ENABLED', r.status === 403 && r.json.code === 'AI_NOT_ENABLED', r.status);

    section('AI 配置');
    r = await req('PUT', '/api/admin/ai-config', { api_base_url: MOCK_BASE, api_key: 'sk-test-key', model_id: 'mock-model', enabled: true, skip_ssl_verify: false }, adminCookie);
    check('保存 AI 配置 → 200', r.status === 200, r.status);
    MOCK_CONTENT = '正常';
    r = await req('POST', '/api/admin/ai-config/test', {}, adminCookie);
    check('「测试连通性」真实打到 mock', r.status === 200 && r.json.data.reply === '正常', r.json && r.json.data);
    r = await req('GET', '/api/auth/me', null, adminCookie);
    const adminId = r.json.data.id;
    r = await req('PUT', '/api/admin/ai-config/users', { user_ids: [adminId] }, adminCookie);
    check('启用管理员 AI 权限', r.status === 200 && r.json.data.count === 1, r.json && r.json.data);

    section('AI 规划');
    seen.length = 0;
    MOCK_CONTENT = PLAN_MOCK;
    r = await req('POST', '/api/routes/ai-plan', planBody, adminCookie);
    check('ai-plan 返回 200', r.status === 200, r.status + ' ' + JSON.stringify(r.json).slice(0, 90));
    const plan = r.json && r.json.data;
    check('scenic 只含按天行程（3 天）', plan && plan.scenic.split('\n').filter(Boolean).length === 3, plan && plan.scenic);
    check('notes 含注意事项与美食推荐两节', plan && plan.notes.includes('【注意事项】') && plan.notes.includes('【美食推荐】'), plan && plan.notes.slice(0, 50));
    check('notes 已排除行程内容', plan && !plan.notes.includes('Day1'), plan && plan.notes.slice(0, 30));
    const mv = seen[0] || {};
    check('请求打到 /v1/chat/completions（自动补 /v1）', mv.url === '/v1/chat/completions', mv.url);
    check('请求带 Bearer 鉴权', mv.auth === 'Bearer sk-test-key', mv.auth);
    check('请求体 model 正确且 stream=false', mv.body && mv.body.model === 'mock-model' && mv.body.stream === false, mv.body && mv.body.model);
    check('提示词要求输出三个小节', mv.body && /【行程】/.test(mv.body.messages[1].content) && /【注意事项】/.test(mv.body.messages[1].content) && /【美食推荐】/.test(mv.body.messages[1].content));

    section('AI 规划参数校验');
    r = await req('POST', '/api/routes/ai-plan', { start_date: '2026-07-01', end_date: '2026-07-03', days: 3 }, adminCookie);
    check('缺目的地 → 400 且提示明确', r.status === 400 && /目的地/.test(r.json.msg), r.json && r.json.msg);
    r = await req('POST', '/api/routes/ai-plan', { dest: '西宁', days: 3 }, adminCookie);
    check('缺起止日期 → 400', r.status === 400 && /日期/.test(r.json.msg), r.json && r.json.msg);
    r = await req('POST', '/api/routes/ai-plan', { start_date: '2026-07-01', end_date: '2026-07-03', dest: '西宁', days: 0 }, adminCookie);
    check('天数无效 → 400', r.status === 400 && /天数/.test(r.json.msg), r.json && r.json.msg);

    section('AI 调整');
    seen.length = 0;
    MOCK_CONTENT = ADJUST_MOCK;
    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 抵达西宁\nDay2 塔尔寺\nDay3 茶卡盐湖',
      current_notes: '【注意事项】\n- 注意防晒',
      message: '补充高原反应提醒并推荐手抓羊肉',
      dest: '西宁、青海湖', start_date: '2026-07-01', end_date: '2026-07-03', days: 3, history: []
    }, adminCookie);
    check('ai-chat 返回 200', r.status === 200, r.status + ' ' + JSON.stringify(r.json).slice(0, 90));
    const adj = r.json && r.json.data;
    check('调整后 scenic 为完整行程（3 天）', adj && adj.scenic.split('\n').filter(Boolean).length === 3, adj && adj.scenic);
    check('调整后 notes 含更新后的美食推荐', adj && adj.notes.includes('手抓羊肉'), adj && adj.notes.slice(0, 60));
    check('current_notes 已透传给模型', seen[0] && /注意防晒/.test(seen[0].body.messages[1].content));

    seen.length = 0;
    MOCK_CONTENT = ADJUST_NO_NOTES;
    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 X', message: '把第二天精简一下', dest: '西宁',
      start_date: '2026-07-01', end_date: '2026-07-02', days: 2, history: []
    }, adminCookie);
    check('模型未输出注意事项时 notes 为空（不覆盖用户备注）', r.status === 200 && r.json.data.notes === '', r.json && r.json.data && r.json.data.notes);

    seen.length = 0;
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'HIST' + i }));
    MOCK_CONTENT = ADJUST_NO_NOTES;
    await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 X', message: '再精简', dest: '西宁',
      start_date: '2026-07-01', end_date: '2026-07-02', days: 2, history
    }, adminCookie);
    const sentStr = JSON.stringify(seen[0] && seen[0].body);
    const histCount = history.filter(h => sentStr.includes(h.content)).length;
    check('history 按末尾 6 条截断', histCount === 6, histCount + '/10');

    section('AI 调整参数校验');
    r = await req('POST', '/api/routes/ai-chat', { message: 'x', dest: 'y', start_date: 'a', end_date: 'b', days: 1 }, adminCookie);
    check('缺当前行程 → 400', r.status === 400 && /当前行程/.test(r.json.msg), r.json && r.json.msg);
    r = await req('POST', '/api/routes/ai-chat', { current_scenic: 'x', dest: 'y', start_date: 'a', end_date: 'b', days: 1 }, adminCookie);
    check('缺调整要求 → 400', r.status === 400 && /调整要求/.test(r.json.msg), r.json && r.json.msg);

    section('模型不可达时的错误提示');
    MOCK_CONTENT = '';
    r = await req('PUT', '/api/admin/ai-config', { api_base_url: 'http://127.0.0.1:3999', api_key: 'k', model_id: 'm', enabled: true }, adminCookie);
    check('切到不可达地址的配置写入成功', r.status === 200, r.status);
    r = await req('POST', '/api/routes/ai-plan', planBody, adminCookie);
    check('接口不可达 → 400 且给出可读原因', r.status === 400 && /AI 行程规划失败/.test(r.json.msg), { status: r.status, msg: r.json && r.json.msg });
    /* 复原配置，避免影响后续断言 */
    MOCK_CONTENT = PLAN_MOCK;
    await req('PUT', '/api/admin/ai-config', { api_base_url: MOCK_BASE, api_key: 'sk-test-key', model_id: 'mock-model', enabled: true, skip_ssl_verify: false }, adminCookie);

    section('审计日志');
    r = await req('GET', '/api/admin/audit-logs?page=1&pageSize=200', null, adminCookie);
    const logs = (r.json && r.json.data && (r.json.data.list || r.json.data)) || [];
    const actions = logs.map(l => l.action);
    check('ai_plan_route 已入审计', actions.includes('ai_plan_route'), [...new Set(actions)].slice(0, 10));
    check('ai_chat_route 已入审计', actions.includes('ai_chat_route'));
    check('test_ai_config / update_ai_config 已入审计', actions.includes('test_ai_config') && actions.includes('update_ai_config'));
  } finally {
    srv.kill();
    mock.close();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== AI 冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
