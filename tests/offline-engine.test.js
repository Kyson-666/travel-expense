/* Node 零依赖测试：offline.js 同步引擎（MemoryAdapter）
 * 将浏览器 ES Module 源码注入 vm，测试同一生产逻辑，无 fake-indexeddb。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const sourcePath = path.join(__dirname, '..', 'public', 'assets', 'offline.js');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace("import { api, getServerUrl, store } from './api.js';", "const api = {}; const getServerUrl = () => 'https://test.invalid'; const store = { user: { id: 1 } };");
source = source.replace(/\bexport\s+(?=(?:class|async\s+function|function|const)\b)/g, '');
source += '\n;globalThis.__exports = { MemoryAdapter, createOfflineEngine, offlineTest, store };';

const listeners = new Map();
const context = {
  console,
  crypto: crypto.webcrypto,
  navigator: { onLine: false, storage: { persist: async () => true, estimate: async () => ({}) } },
  window: { addEventListener: (name, fn) => listeners.set('window:' + name, fn) },
  document: { hidden: false, addEventListener: (name, fn) => listeners.set('document:' + name, fn) },
  setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set, Array, Object, Number, String, Error,
  globalThis: null
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: sourcePath });
const { MemoryAdapter, createOfflineEngine, store } = context.__exports;

let passed = 0, failed = 0;
function check(name, condition, extra) {
  if (condition) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra === undefined ? '' : ' got=' + JSON.stringify(extra))); }
}

async function main() {
  const adapter = new MemoryAdapter();
  let mode = 'accept';
  let requests = 0;
  const stored = new Map();
  const transport = {
    get: async (url) => {
      if (mode === 'incremental' && String(url).includes('updated_since=100')) {
        return { list: [{ id: 'e-inc-01', route_id: 'r3', category: '餐饮', amount: 77, spent_on: '2026-10-01', title: '新值', note: '', payer_id: null, parts: [], updated_at: 200 }], total: 1, incremental: true, watermark: 200, server_time: 999 };
      }
      return { list: [] };
    },
    del: async () => ({ deleted: 1 }),
    post: async (url, body) => {
      requests++;
      if (mode === 'network') { const e = new Error('network down'); e.network = true; throw e; }
      if (mode === 'auth') { const e = new Error('unauthorized'); e.status = 401; throw e; }
      if (mode === 'legacy' && url.endsWith('/expenses/sync')) { const e = new Error('not found'); e.status = 404; throw e; }
      if (mode === 'conflict' && url.endsWith('/expenses/sync') && Array.isArray(body.ops) && body.ops.length) {
        return { server_time: Date.now(), results: body.ops.map(op => ({
          op_id: op.op_id, status: 'conflict', code: 'EDIT_CONFLICT', message: '已在其他端修改',
          server: { id: op.client_id, route_id: 'r2', category: '餐饮', amount: 999, spent_on: '2026-10-10', title: '服务端版本', note: '', payer_id: 't1', parts: ['t1'], created_at: 111, updated_at: 999 }
        })) };
      }
      if (url.endsWith('/expenses/sync')) {
        return { server_time: Date.now(), results: body.ops.map(op => {
          if (mode === 'degraded') return { op_id: op.op_id, status: 'degraded', code: 'TRAVELER_MISSING' };
          if (mode === 'rejected') return { op_id: op.op_id, status: 'rejected', code: 'ROUTE_NOT_FOUND' };
          if (stored.has(op.client_id)) return { op_id: op.op_id, status: 'duplicate' };
          stored.set(op.client_id, op.data || {});
          return { op_id: op.op_id, status: 'accepted', id: op.client_id };
        }) };
      }
      return { id: body.id, ...body };
    }
  };
  const engine = await createOfflineEngine({ adapter, transport, serverKey: 'https://server-a.test', init: false });
  await engine.init();

  await engine.enqueueExpense('r1', { id: 'e-client-0001', category: '餐饮', amount: 10, spent_on: '2026-10-14', title: '离线项', payer_id: 't1', parts: ['t1'] });
  check('离线新增持久化为 pending 队列项', (await engine.listQueue('r1')).length === 1);
  const projection = await engine.project('r1', []);
  check('投影包含一条 pending 流水', projection.length === 1 && projection[0].pending === true && projection[0].id === 'e-client-0001', projection);

  const otherServer = await createOfflineEngine({ adapter, transport, serverKey: 'https://server-b.test', init: false });
  check('切换服务器后看不到其他命名空间队列', (await otherServer.listQueue()).length === 0);
  store.user = { id: 2 };
  check('同一服务器切换账号后看不到前一账号的队列', (await engine.listQueue()).length === 0);
  store.user = { id: 1 };
  check('切回原账号仍能访问其待同步队列', (await engine.listQueue()).length === 1);

  mode = 'network';
  context.navigator.onLine = true;
  engine._state.online = true;
  await engine.syncNow();
  let q = await engine.listQueue('r1');
  check('网络错误保留队列', q.length === 1);
  check('网络错误递增 attempts 并安排退避', q[0].attempts === 1 && q[0].next_retry_at > Date.now(), q[0]);

  mode = 'accept';
  q[0].next_retry_at = 0;
  await adapter.put('queue', q[0]);
  const before = requests;
  await engine.syncNow();
  check('恢复后成功同步并清空队列', (await engine.listQueue('r1')).length === 0);
  check('成功同步时至少调用一次批量端点', requests > before);
  check('服务端只记录一次 client id', stored.size === 1);

  context.navigator.onLine = false;
  engine._state.online = false;
  await engine.enqueueExpense('r1', { id: 'e-client-0002', category: '门票', amount: 20, spent_on: '2026-10-14', title: '授权过期项', payer_id: 't1', parts: ['t1'] });
  mode = 'auth';
  const countBefore401 = (await engine.listQueue('r1')).length;
  context.navigator.onLine = true;
  engine._state.online = true;
  await engine.syncNow();
  check('401 后状态 BLOCKED', engine.state().phase === 'BLOCKED' && engine.state().blocked === 'session_expired', engine.state());
  check('401 后队列保留不清空', (await engine.listQueue('r1')).length === countBefore401);

  mode = 'degraded';
  engine._state.blocked = '';
  engine._state.online = true;
  const q401 = await engine.listQueue('r1');
  for (const op of q401) { op.next_retry_at = 0; await adapter.put('queue', op); }
  let degradedEvents = 0;
  engine.on('degraded', () => degradedEvents++);
  await engine.syncNow();
  check('degraded 终结队列并发事件', (await engine.listQueue('r1')).length === 0 && degradedEvents === 1, degradedEvents);

  context.navigator.onLine = false;
  engine._state.online = false;
  await engine.enqueueExpense('r1', { id: 'e-client-0003', category: '交通', amount: 5, spent_on: '2026-10-14', title: '本地消解', payer_id: 't1', parts: ['t1'] });
  const requestBeforeLocalDelete = requests;
  await engine.enqueueDelete('r1', 'e-client-0003', { category: '交通', amount: 5, title: '本地消解' });
  check('新增后离线删除本地消解两项', (await engine.listQueue('r1')).length === 0);
  check('本地消解未调用网络', requests === requestBeforeLocalDelete, { before: requestBeforeLocalDelete, after: requests });

  context.navigator.onLine = false;
  engine._state.online = false;
  await engine.enqueueExpense('r1', { id: 'e-client-0004', category: '购物', amount: 9, spent_on: '2026-10-14', title: '被拒绝项', payer_id: 't1', parts: ['t1'] });
  mode = 'rejected';
  context.navigator.onLine = true;
  engine._state.online = true;
  await engine.syncNow();
  q = await engine.listQueue('r1');
  check('rejected 操作留在队列且转 failed', q.length === 1 && q[0].status === 'failed', q[0]);
  mode = 'accept';
  await engine.syncNow({ manual: true });
  check('手动重试可处理 failed 项', (await engine.listQueue('r1')).length === 0);

  /* ---------- 旧服务端降级（设计 §16.3 约束 B）：绝不发起非幂等写入 ---------- */
  context.navigator.onLine = false;
  engine._state.online = false;
  await engine.enqueueExpense('r1', { id: 'e-client-legacy1', category: '餐饮', amount: 66, spent_on: '2026-10-14', title: '旧服务端项', payer_id: 't1', parts: ['t1'] });
  mode = 'legacy';
  context.navigator.onLine = true;
  engine._state.online = true;
  await engine.syncNow();
  q = await engine.listQueue('r1');
  check('旧服务端：不发起非幂等写入，队列保留为 failed',
    q.length === 1 && q[0].status === 'failed' && q[0].last_error && q[0].last_error.code === 'SERVER_UPGRADE_REQUIRED',
    q[0] && { status: q[0].status, err: q[0].last_error });
  check('旧服务端：状态机置为 BLOCKED(server_upgrade_required)',
    engine.state().phase === 'BLOCKED' && engine.state().blocked === 'server_upgrade_required', engine.state());
  check('旧服务端：服务端被回滚后能力标记失效（探测缓存翻转）', engine.syncCapable === false, engine.syncCapable);

  /* 服务端升级后：清空能力探测缓存（等价切换服务器后的重新探测）→ 手动同步走批量幂等端点 */
  mode = 'accept';
  engine.syncCapable = null;
  engine._state.blocked = '';
  await engine.syncNow({ manual: true });
  check('服务端升级后手动同步成功并清空队列', (await engine.listQueue('r1')).length === 0);

  /* ---------- 阶段 2：离线编辑、冲突处置、增量合并、清理缓存 ---------- */
  await engine.saveExpensesCache('r2', {
    list: [{ id: 'e-synced-01', route_id: 'r2', category: '餐饮', amount: 100, spent_on: '2026-10-10', title: '已同步项', note: '', payer_id: 't1', parts: ['t1'], created_at: 111, updated_at: 111 }],
    total: 1, amount: 100, byCategory: { '餐饮': 100 }, watermark: 500
  });
  context.navigator.onLine = false;
  engine._state.online = false;
  await engine.enqueueUpdate('r2', 'e-synced-01', { category: '餐饮', amount: 120, spent_on: '2026-10-10', title: '已同步项', note: '', payer_id: 't1', parts: ['t1'] }, 111);
  const projU = await engine.project('r2');
  check('离线编辑进入投影（本地值 + pending）', projU.length === 1 && projU[0].amount === 120 && projU[0].pending === true, projU[0]);
  check('投影不泄露 base_updated_at 控制字段', !('base_updated_at' in projU[0]), Object.keys(projU[0]));
  const qU = (await engine.listQueue('r2')).find(o => o.type === 'expense.update');
  check('update op 携带 base_updated_at', !!qU && qU.payload.base_updated_at === 111, qU && qU.payload);

  mode = 'accept';
  context.navigator.onLine = true;
  engine._state.online = true;
  await engine.syncNow();
  const cachedAfterSync = ((await engine.getExpensesCache('r2')) || {}).list.find(e => e.id === 'e-synced-01');
  check('离线编辑同步成功并清空队列', (await engine.listQueue('r2')).length === 0);
  check('同步后缓存写回目标值（不残留旧值）', cachedAfterSync && cachedAfterSync.amount === 120, cachedAfterSync && cachedAfterSync.amount);

  /* 冲突 → 保留本地（以服务端版本戳重投） */
  context.navigator.onLine = false; engine._state.online = false;
  await engine.enqueueUpdate('r2', 'e-synced-01', { category: '餐饮', amount: 150, spent_on: '2026-10-10', title: '已同步项', note: '', payer_id: 't1', parts: ['t1'] }, 111);
  mode = 'conflict';
  context.navigator.onLine = true; engine._state.online = true;
  await engine.syncNow();
  let qc = await engine.listQueue('r2');
  check('冲突保留在队列且附带服务端记录', qc.length === 1 && qc[0].status === 'failed' && !!(qc[0].conflict && qc[0].conflict.server) && qc[0].conflict.server.updated_at === 999, qc[0] && qc[0].conflict);
  mode = 'accept';
  context.navigator.onLine = false; engine._state.online = false;
  const keep = await engine.resolveConflictKeepLocal(qc[0].op_id);
  const afterKeep = (await engine.listQueue('r2'))[0];
  check('保留本地：重置为 pending 且 base 采用服务端版本戳', keep && !!afterKeep && afterKeep.status === 'pending' && afterKeep.payload.base_updated_at === 999, afterKeep && { s: afterKeep.status, b: afterKeep.payload && afterKeep.payload.base_updated_at });
  context.navigator.onLine = true; engine._state.online = true;
  await engine.syncNow();
  check('保留本地重投后队列清空', (await engine.listQueue('r2')).length === 0);

  /* 冲突 → 采用服务端（丢弃本地，缓存写回服务端记录） */
  context.navigator.onLine = false; engine._state.online = false;
  await engine.enqueueUpdate('r2', 'e-synced-01', { category: '餐饮', amount: 160, spent_on: '2026-10-10', title: '已同步项', note: '', payer_id: 't1', parts: ['t1'] }, 111);
  mode = 'conflict';
  context.navigator.onLine = true; engine._state.online = true;
  await engine.syncNow();
  qc = await engine.listQueue('r2');
  check('第二次冲突同样进入待处置态', qc.length === 1 && qc[0].status === 'failed' && !!qc[0].conflict, qc[0] && qc[0].status);
  const adopt = await engine.resolveConflictUseServer(qc[0].op_id);
  const cachedR2 = ((await engine.getExpensesCache('r2')) || {}).list.find(e => e.id === 'e-synced-01');
  check('采用服务端：冲突项移除且缓存写入服务端记录', adopt && (await engine.listQueue('r2')).length === 0 && !!cachedR2 && cachedR2.amount === 999, cachedR2 && cachedR2.amount);

  /* 增量拉取合并 */
  mode = 'incremental';
  await engine.saveExpensesCache('r3', { list: [{ id: 'e-inc-01', route_id: 'r3', category: '餐饮', amount: 10, spent_on: '2026-10-01', title: '旧值', note: '', payer_id: null, parts: [] }], total: 1, amount: 10, byCategory: { '餐饮': 10 }, watermark: 100 });
  const inc = await engine.refreshExpensesIncremental('r3');
  const cache3 = await engine.getExpensesCache('r3');
  check('增量拉取合并变更行并推进游标', !!inc && inc.merged === 1 && !!cache3 && cache3.watermark === 200 && cache3.list[0].amount === 77, cache3 && { w: cache3.watermark, a: cache3.list[0].amount });
  mode = 'accept';

  /* 清理缓存不动队列 */
  context.navigator.onLine = false; engine._state.online = false;
  await engine.enqueueExpense('r2', { id: 'e-keep-01', category: '交通', amount: 5, spent_on: '2026-10-14', title: '保留项', payer_id: 't1', parts: ['t1'] });
  const cleared = await engine.clearCaches();
  const stillQueued = await engine.listQueue('r2');
  const cacheGone = await engine.getExpensesCache('r2');
  check('清理缓存：队列不受影响（绝不删待同步数据）', cleared.kept === 1 && stillQueued.length === 1, { cleared, queued: stillQueued.length });
  check('清理缓存：读缓存与游标已清空', !cacheGone, cacheGone);

  console.log(`\n===== 离线引擎单测：${passed} 通过 / ${failed} 失败 =====`);
  if (failed) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
