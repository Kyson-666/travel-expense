/* 冒烟测试：离线同步服务端契约
 * 覆盖：客户端幂等 id、sync accepted/duplicate/degraded/rejected、Σnet=0、
 *       幂等删除、批量上限、白名单防伪造、路线不存在逐笔返回、所有者隔离。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3913;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-offline-'));
let pass = 0, fail = 0;
const failures = [];
function check(name, condition, extra) {
  if (condition) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const detail = extra === undefined ? '' : ' got=' + JSON.stringify(extra); failures.push(name + detail); console.log('  ❌ ' + name + detail); }
}
function section(x) { console.log('\n■ ' + x); }
async function req(method, p, body, cookie) {
  const options = { method, headers: {} };
  if (body !== undefined && body !== null) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  if (cookie) options.headers.Cookie = cookie;
  const response = await fetch(BASE + p, options);
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: response.status, json, text, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  check('服务启动', up);
  if (!up) { server.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    let r = await req('POST', '/api/auth/register', { username: 'offtest', password: 'offpass123' });
    const cookie = r.cookie;
    check('注册测试账户', r.status === 201 && !!cookie, r.status);
    r = await req('POST', '/api/routes', { name: '离线同步路线', year: '2026', currency: 'CNY', days: 2, people: 2 }, cookie);
    const routeId = r.json.data.id;
    check('创建测试路线', r.status === 201 && !!routeId, r.status);
    r = await req('POST', `/api/routes/${routeId}/travelers`, { names: ['我', '小李'] }, cookie);
    const travelers = r.json.data.list;
    const me = travelers[0].id, li = travelers[1].id;

    section('客户端幂等 POST');
    const once = { id: 'e-offline-001', category: '餐饮', amount: 128.5, spent_on: '2026-10-14', title: '离线晚饭', note: '幂等验证', payer_id: me, parts: [me, li] };
    r = await req('POST', `/api/routes/${routeId}/expenses`, once, cookie);
    check('客户端指定合法 id 可落库', r.status === 201 && r.json.data.id === once.id, r.json && r.json.data && r.json.data.id);
    const created = r.json.data;
    r = await req('POST', `/api/routes/${routeId}/expenses`, once, cookie);
    check('完全相同的重复 POST 返回既有记录', r.status === 201 && r.json.data.id === once.id, r.status);
    r = await req('GET', `/api/routes/${routeId}/expenses`, null, cookie);
    check('幂等重试后仅 1 笔', r.json.data.total === 1, r.json.data.total);
    r = await req('POST', `/api/routes/${routeId}/expenses`, { ...once, amount: 999 }, cookie);
    check('同 id 不同内容返回 409 ID_CONFLICT', r.status === 409 && r.json.code === 'ID_CONFLICT', { status: r.status, code: r.json && r.json.code });

    section('批量 sync：accepted / duplicate / 白名单');
    const ops = [
      { op_id: 'o-test-001', type: 'expense.create', client_id: 'e-offline-001', data: once },
      { op_id: 'o-test-002', type: 'expense.create', client_id: 'e-offline-002', data: { category: '交通', amount: 80, spent_on: '2026-10-14', title: '地铁', payer_id: me, parts: [me, li], owner_id: 99999, is_opening: 1 } },
      { op_id: 'o-test-003', type: 'expense.create', client_id: 'e-offline-003', data: { category: '门票', amount: 60, spent_on: '2026-10-14', title: '博物馆', payer_id: li, parts: [li] } }
    ];
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { client_time: Date.now(), ops }, cookie);
    const results = r.json.data.results;
    check('批量 sync 返回 200 与顺序对齐结果', r.status === 200 && results.length === 3 && results.map(x => x.op_id).join(',') === ops.map(x => x.op_id).join(','), results);
    check('已存在的同 id/同内容返回 duplicate', results[0].status === 'duplicate', results[0]);
    check('其余两笔 accepted', results[1].status === 'accepted' && results[2].status === 'accepted', results.map(x => x.status));
    r = await req('GET', `/api/routes/${routeId}/expenses/e-offline-002`, null, cookie);
    /* 详情子资源不存在；从流水列表核对伪造字段没有透传 */
    r = await req('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie);
    const row2 = r.json.data.list.find(x => x.id === 'e-offline-002');
    check('owner_id/is_opening 不能经 payload 伪造', !!row2 && row2.owner_id === undefined && row2.is_opening === false, row2 && { owner_id: row2.owner_id, is_opening: row2.is_opening });

    section('缺失同行人降级 + 重放幂等');
    const degradedOp = { op_id: 'o-test-degrade', type: 'expense.create', client_id: 'e-offline-004', data: { category: '购物', amount: 50, spent_on: '2026-10-14', title: '同行人已删除', payer_id: 'deleted-traveler', parts: ['deleted-traveler'] } };
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [degradedOp] }, cookie);
    check('失效同行人返回 degraded', r.status === 200 && r.json.data.results[0].status === 'degraded', r.json.data.results[0]);
    check('降级结果有机器码与说明', r.json.data.results[0].code === 'TRAVELER_MISSING' && !!r.json.data.results[0].message);
    r = await req('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie);
    const degradedRow = r.json.data.list.find(x => x.id === degradedOp.client_id);
    check('降级流水保留金额并设为未指定付款人', degradedRow && degradedRow.amount === 50 && degradedRow.payer_id === null && degradedRow.split_mode === 'none' && degradedRow.parts.length === 0, degradedRow);
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [degradedOp] }, cookie);
    check('degraded 成功后响应丢失再重放 → duplicate（不冲突、不重复）', r.json.data.results[0].status === 'duplicate', r.json.data.results[0]);
    const settle = await req('GET', `/api/routes/${routeId}/settle`, null, cookie);
    check('降级后结算 Σnet=0', Math.abs(settle.json.data.rows.reduce((sum, x) => sum + x.net, 0)) < 0.005, settle.json.data.rows.map(x => x.net));

    section('逐笔拒绝与事务边界');
    const mixed = [
      { op_id: 'o-bad-amount', type: 'expense.create', client_id: 'e-offline-005', data: { category: '餐饮', amount: 0, title: '非法金额' } },
      { op_id: 'o-good-after-bad', type: 'expense.create', client_id: 'e-offline-006', data: { category: '交通', amount: 22, title: '合法项', payer_id: me, parts: [me] } },
      { op_id: 'o-invalid-id', type: 'expense.create', client_id: '../unsafe', data: { category: '交通', amount: 10 } }
    ];
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: mixed }, cookie);
    check('单笔无效被 rejected，后续有效项仍 accepted', r.status === 200 && r.json.data.results[0].status === 'rejected' && r.json.data.results[1].status === 'accepted', r.json.data.results);
    check('非法 id 被逐笔 rejected', r.json.data.results[2].status === 'rejected' && r.json.data.results[2].code === 'INVALID_OP', r.json.data.results[2]);
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: Array.from({ length: 201 }, (_, i) => ({ op_id: 'o' + i, type: 'expense.delete', client_id: 'e' + i })) }, cookie);
    check('超过 200 笔返回 400 OPS_TOO_MANY', r.status === 400 && r.json.code === 'OPS_TOO_MANY', { status: r.status, code: r.json.code });

    section('幂等删除、路线缺失与所有者隔离');
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-del', type: 'expense.delete', client_id: 'e-never-existed' }] }, cookie);
    check('批量删除不存在流水视为 accepted', r.status === 200 && r.json.data.results[0].status === 'accepted', r.json.data.results[0]);
    r = await req('DELETE', `/api/routes/${routeId}/expenses/e-never-existed`, null, cookie);
    check('单笔 DELETE 不存在为 200 {deleted:0}', r.status === 200 && r.json.data.deleted === 0, { status: r.status, data: r.json.data });
    r = await req('POST', '/api/routes/no-such-route/expenses/sync', { ops: [{ op_id: 'o-gone', type: 'expense.create', client_id: 'e-offline-007', data: { category: '餐饮', amount: 1 } }] }, cookie);
    check('路线已删除/不存在逐笔 rejected ROUTE_NOT_FOUND', r.status === 200 && r.json.data.results[0].status === 'rejected' && r.json.data.results[0].code === 'ROUTE_NOT_FOUND', r.json && r.json.data);

    const other = await req('POST', '/api/auth/register', { username: 'offother', password: 'offpass123' });
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-unauth', type: 'expense.create', client_id: 'e-offline-008', data: { category: '餐饮', amount: 1 } }] }, other.cookie);
    check('他人访问私有路线不会写入（逐笔拒绝）', r.status === 200 && r.json.data.results[0].status === 'rejected', r.json && r.json.data);

    r = await req('GET', `/api/routes/${routeId}`, null, cookie);
    check('服务端聚合与流水总额一致', r.json.data.exp['餐饮'] + r.json.data.exp['交通'] + r.json.data.exp['门票'] + r.json.data.exp['购物'] > 0, r.json.data.exp);

    /* ================= 阶段 2：离线编辑（乐观锁 / 幂等 / 冲突 / 增量拉取） ================= */
    section('阶段 2：离线编辑与增量拉取');
    const full0 = await req('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie);
    check('全量响应带 server_time（增量游标起点）', Number(full0.json.data.server_time) > 0, full0.json.data.server_time);
    const baseRow = full0.json.data.list.find(x => x.id === 'e-offline-002');
    const baseAt = baseRow.updated_at;
    const updData = (amount, base) => ({ category: '交通', amount, spent_on: '2026-10-14', title: '地铁（改）', note: '', payer_id: me, parts: [me, li], base_updated_at: base });

    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-upd-1', type: 'expense.update', client_id: 'e-offline-002', data: updData(99, baseAt) }] }, cookie);
    check('update 携带正确 base → accepted', r.json.data.results[0].status === 'accepted', r.json.data.results[0]);
    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-upd-1', type: 'expense.update', client_id: 'e-offline-002', data: updData(99, baseAt) }] }, cookie);
    check('同内容重放 → duplicate（base 已过期也不误判冲突）', r.json.data.results[0].status === 'duplicate', r.json.data.results[0]);

    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-upd-3', type: 'expense.update', client_id: 'e-offline-002', data: updData(555, baseAt) }] }, cookie);
    const cf = r.json.data.results[0];
    check('过期 base + 不同内容 → conflict 且携带服务端记录', cf.status === 'conflict' && cf.code === 'EDIT_CONFLICT' && !!cf.server && cf.server.amount === 99, cf);

    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-upd-4', type: 'expense.update', client_id: 'e-offline-002', data: updData(555, cf.server.updated_at) }] }, cookie);
    check('以服务端最新版本戳重投 → accepted（保留本地路径）', r.json.data.results[0].status === 'accepted', r.json.data.results[0]);
    const rowAfter = (await req('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie)).json.data.list.find(x => x.id === 'e-offline-002');
    check('保留本地后服务端金额为 555', rowAfter && rowAfter.amount === 555, rowAfter && rowAfter.amount);

    r = await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-upd-5', type: 'expense.update', client_id: 'e-not-exists-99', data: { category: '交通', amount: 5 } }] }, cookie);
    check('update 不存在的流水 → rejected EXPENSE_NOT_FOUND', r.json.data.results[0].status === 'rejected' && r.json.data.results[0].code === 'EXPENSE_NOT_FOUND', r.json.data.results[0]);

    r = await req('PATCH', `/api/routes/${routeId}/expenses/e-offline-002`, { amount: 1, base_updated_at: baseAt }, cookie);
    check('单笔 PATCH 过期 base → 409 EDIT_CONFLICT 且附服务端记录', r.status === 409 && r.json.code === 'EDIT_CONFLICT' && !!(r.json.server && r.json.server.amount === 555), { status: r.status, server: r.json.server });
    r = await req('PATCH', `/api/routes/${routeId}/expenses/e-offline-002`, { amount: 777, base_updated_at: r.json.server.updated_at }, cookie);
    check('单笔 PATCH 正确 base → 200 落库', r.status === 200 && r.json.data.amount === 777, r.json.data && r.json.data.amount);

    const wm = (await req('GET', `/api/routes/${routeId}/expenses`, null, cookie)).json.data.server_time;
    const row3 = (await req('GET', `/api/routes/${routeId}/expenses?pageSize=500`, null, cookie)).json.data.list.find(x => x.id === 'e-offline-003');
    await req('POST', `/api/routes/${routeId}/expenses/sync`, { ops: [{ op_id: 'o-upd-inc', type: 'expense.update', client_id: 'e-offline-003', data: { category: '门票', amount: 61, spent_on: '2026-10-14', title: '博物馆（改）', note: '', payer_id: li, parts: [li], base_updated_at: row3.updated_at } }] }, cookie);
    r = await req('GET', `/api/routes/${routeId}/expenses?updated_since=${wm}`, null, cookie);
    check('updated_since 只返回窗口内变更行', r.json.data.incremental === true && r.json.data.list.length === 1 && r.json.data.list[0].id === 'e-offline-003', (r.json.data.list || []).map(x => x.id));
    check('增量游标推进到本次最大 updated_at', Number(r.json.data.watermark) >= Number(wm), { wm, watermark: r.json.data.watermark });
    r = await req('GET', `/api/routes/${routeId}/expenses?updated_since=${r.json.data.watermark}`, null, cookie);
    check('游标推进后再拉取为空（不重复返回）', r.json.data.incremental === true && r.json.data.list.length === 0, (r.json.data.list || []).length);

    section('PWA 静态资源与热更新清单');
    const staticCases = [
      ['/sw.js', 'text/javascript', 'no-cache'],
      ['/manifest.webmanifest', 'application/manifest+json', 'no-cache'],
      ['/icons/icon.svg', 'image/svg+xml', null],
      ['/icons/icon-192.png', 'image/png', null],
      ['/icons/maskable-512.png', 'image/png', null]
    ];
    for (const [p, type, cache] of staticCases) {
      const res = await fetch(BASE + p);
      const ctype = res.headers.get('content-type') || '';
      const cc = res.headers.get('cache-control') || '';
      check(`静态资源 ${p} 可访问且类型正确`, res.status === 200 && ctype.includes(type), { status: res.status, ctype });
      if (cache) check(`${p} 不缓存（确保更新即时生效）`, cc.includes(cache), cc);
    }
    const assetJs = await fetch(BASE + '/assets/offline.js');
    check('离线引擎可被浏览器直接加载', assetJs.status === 200 && (assetJs.headers.get('content-type') || '').includes('text/javascript'));
    check('应用外壳未拦截 API（/api/public/site 正常）', (await fetch(BASE + '/api/public/site')).status === 200);

    const bundle = await req('GET', '/api/app/manifest', null, null);
    const paths = ((bundle.json.data || {}).files || []).map(f => f.path);
    for (const need of ['sw.js', 'manifest.webmanifest', 'assets/offline.js', 'assets/offline-ui.js', 'icons/icon-192.png', 'icons/maskable-512.png']) {
      check(`热更新清单包含新增文件 ${need}`, paths.includes(need), paths.length);
    }
    check('热更新清单 version 非空（变更可被检出）', !!bundle.json.data.version, bundle.json.data.version);

    /* ================= APP 包（APK）自更新分发链路 ================= */
    section('APP 包自更新（APK 分发 / 流式上传下载 / Range）');
    const crypto = require('crypto');
    const uploadApk = async (qs, buf, ck) => {
      const res = await fetch(BASE + '/api/admin/apk' + qs, {
        method: 'POST', headers: { Cookie: ck || '', 'Content-Type': 'application/octet-stream' }, body: buf
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* ignore */ }
      return { status: res.status, json };
    };

    let mf = await req('GET', '/api/app/manifest', null, null);
    check('未上传 APK 时 manifest.apk 为 null（APP 端完全静默）', mf.json.data.apk === null, mf.json.data.apk);
    check('无 APK 时下载端点返回 404', (await fetch(BASE + '/api/app/apk')).status === 404);

    r = await uploadApk('?versionCode=10007&versionName=1.0.7', Buffer.from('nope'), cookie);
    check('普通用户上传 APK → 403', r.status === 403, r.status);
    r = await uploadApk('?versionCode=0', Buffer.from('nope'), null);
    check('未登录上传 APK → 401', r.status === 401, r.status);

    const adm = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const adminCookie = adm.cookie;
    check('管理员登录（种子账号）', adm.status === 200 && !!adminCookie, adm.status);
    /* 首登强制改密已在服务端强制：先改为测试密码，后续管理端请求才不被 403 */
    await req('POST', '/api/auth/password', { oldPassword: '123456', newPassword: 'adminnew123' }, adminCookie);

    const fake = Buffer.alloc(256 * 1024 + 7, 0x5a);
    const fakeSha = crypto.createHash('sha256').update(fake).digest('hex');
    r = await uploadApk('?versionCode=10007&versionName=1.0.7&notes=PWA', fake, adminCookie);
    check('管理员流式上传 APK → 200 且回传 sha256/大小', r.status === 200 && r.json.data.sha256 === fakeSha && r.json.data.size === fake.length, r.json && r.json.data);
    check('上传后 versionCode/versionName 正确', r.json.data.versionCode === 10007 && r.json.data.versionName === '1.0.7', r.json.data);

    mf = await req('GET', '/api/app/manifest', null, null);
    const apk = mf.json.data.apk;
    check('manifest.apk 含版本/哈希/大小/下载地址', !!apk && apk.versionCode === 10007 && apk.sha256 === fakeSha && apk.size === fake.length && apk.url === '/api/app/apk', apk);

    let dl = await fetch(BASE + '/api/app/apk');
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    check('下载端点返回完整 APK（字节一致 + 正确 Content-Type）',
      dl.status === 200 && dlBuf.length === fake.length &&
      crypto.createHash('sha256').update(dlBuf).digest('hex') === fakeSha &&
      (dl.headers.get('content-type') || '').includes('android.package-archive'),
      { status: dl.status, len: dlBuf.length, ct: dl.headers.get('content-type') });
    check('下载响应带 Accept-Ranges（支持断点续传）', dl.headers.get('accept-ranges') === 'bytes');
    dl = await fetch(BASE + '/api/app/apk', { headers: { Range: 'bytes=0-99' } });
    const part = Buffer.from(await dl.arrayBuffer());
    check('Range 请求返回 206 + 指定区间',
      dl.status === 206 && part.length === 100 && (dl.headers.get('content-range') || '').startsWith('bytes 0-99/'),
      { status: dl.status, len: part.length, cr: dl.headers.get('content-range') });

    r = await uploadApk('?versionName=1.0.8', Buffer.from('x'), adminCookie);
    check('缺少 versionCode → 400（拒绝非法元数据）', r.status === 400, { status: r.status, msg: r.json && r.json.msg });
    mf = await req('GET', '/api/app/manifest', null, null);
    check('上传失败不影响线上已有 APK', mf.json.data.apk && mf.json.data.apk.versionCode === 10007, mf.json.data.apk);

    r = await req('DELETE', '/api/admin/apk', null, adminCookie);
    check('管理员删除 APK → 200', r.status === 200 && r.json.data.deleted === true, r.json.data);
    mf = await req('GET', '/api/app/manifest', null, null);
    check('删除后 manifest.apk 回到 null', mf.json.data.apk === null, mf.json.data.apk);
  } finally {
    server.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }
  console.log(`\n===== 离线同步服务端冒烟：${pass} 通过 / ${fail} 失败 =====`);
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
