/* offline.js — IndexedDB 离线队列、缓存与同步引擎
 * SW 只缓存应用外壳；业务队列由应用层管理，Android Capacitor 不依赖 SW。
 */
import { api, getServerUrl, store } from './api.js';

const DB_NAME = 'te-offline';
const DB_VERSION = 1;
const MAX_BATCH = 200;
const MAX_ATTEMPTS = 8;
const MAX_RETRY_MS = 60000;
const SERVER_KEY = normalizeServerKey(getServerUrl());

function normalizeServerKey(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}
function currentUserId() {
  return store && store.user && store.user.id != null ? String(store.user.id) : 'anonymous';
}
function cachePrefix(serverKey = SERVER_KEY) { return `${normalizeServerKey(serverKey)}|${currentUserId()}`; }
function uid(prefix) {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return (prefix || 'o') + Date.now().toString(36) + Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
/* 流水载荷白名单清洗：入队/更新共用，避免把乐观锁等控制字段混入业务字段。 */
function sanitizePayload(payload) {
  return {
    category: String(payload.category || ''), amount: Number(payload.amount),
    spent_on: String(payload.spent_on || ''), title: String(payload.title || ''), note: String(payload.note || ''),
    payer_id: payload.payer_id || null, parts: Array.isArray(payload.parts) ? [...new Set(payload.parts.map(String))] : []
  };
}
function isNetworkError(e) { return !!(e && (e.network || !e.status || e.status >= 500)); }
function isAuthError(e) { return !!(e && (e.status === 401 || e.status === 403)); }
function retryDelay(attempts) {
  const base = Math.min(1000 * Math.pow(2, Math.max(0, attempts - 1)), MAX_RETRY_MS);
  return Math.max(250, Math.round(base * (0.8 + Math.random() * 0.4)));
}

export class MemoryAdapter {
  constructor() { this.stores = new Map(); }
  _store(name) { if (!this.stores.has(name)) this.stores.set(name, new Map()); return this.stores.get(name); }
  async get(name, key) { return clone(this._store(name).get(key)); }
  async put(name, value) { const key = value.key ?? value.op_id ?? value.k; this._store(name).set(key, clone(value)); return key; }
  async delete(name, key) { this._store(name).delete(key); }
  async all(name) { return Array.from(this._store(name).values(), clone); }
  async clear(name) { this._store(name).clear(); }
}

export class IndexedDBAdapter {
  constructor(db) { this.db = db; }
  static open() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('IndexedDB 不可用'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('queue')) {
          const s = db.createObjectStore('queue', { keyPath: 'op_id' });
          s.createIndex('by_server_route', ['server_key', 'route_id'], { unique: false });
          s.createIndex('by_status', 'status', { unique: false });
          s.createIndex('by_created', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('cache_routes')) {
          const s = db.createObjectStore('cache_routes', { keyPath: 'key' });
          s.createIndex('by_server', 'server_key', { unique: false });
        }
        if (!db.objectStoreNames.contains('cache_expenses')) {
          const s = db.createObjectStore('cache_expenses', { keyPath: 'key' });
          s.createIndex('by_server_route', ['server_key', 'route_id'], { unique: false });
        }
        if (!db.objectStoreNames.contains('cache_meta')) {
          const s = db.createObjectStore('cache_meta', { keyPath: 'key' });
          s.createIndex('by_server', 'server_key', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      request.onsuccess = () => resolve(new IndexedDBAdapter(request.result));
      request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
      request.onblocked = () => reject(new Error('IndexedDB 升级被其他页面阻塞'));
    });
  }
  _request(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      let result;
      let failed = false;
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => { result = clone(req.result); };
      req.onerror = () => { failed = true; reject(req.error || new Error('IndexedDB 请求失败')); };
      tx.oncomplete = () => { if (!failed) resolve(result); };
      tx.onabort = () => { if (!failed) reject(tx.error || new Error('IndexedDB 事务失败')); };
      tx.onerror = () => { if (!failed) reject(tx.error || new Error('IndexedDB 事务失败')); };
    });
  }
  async all(name) { return this._request(name, 'readonly', (s) => s.getAll()); }
  get(name, key) { return this._request(name, 'readonly', s => s.get(key)); }
  put(name, value) { const key = value.key ?? value.op_id ?? value.k; return this._request(name, 'readwrite', s => s.put(value)).then(() => key); }
  delete(name, key) { return this._request(name, 'readwrite', s => s.delete(key)); }
  all(name) { return this._request(name, 'readonly', s => s.getAll()); }
  clear(name) { return this._request(name, 'readwrite', s => s.clear()); }
}

class OfflineEngine {
  constructor(adapter, transport, serverKey, fixedServerKey) {
    this.store = adapter;
    this.transport = transport;
    this.serverKey = normalizeServerKey(serverKey);
    this.fixedServerKey = !!fixedServerKey;
    this.listeners = new Map();
    this._state = { phase: 'IDLE', online: typeof navigator === 'undefined' ? true : navigator.onLine, blocked: '', syncing: false };
    this.syncCapable = null;
    this.syncPromise = null;
    this.initialized = false;
    this.serverTimeOffset = 0;
    this._retryTimer = null;
  }
  on(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); return () => this.listeners.get(event)?.delete(fn); }
  emit(event, detail) { for (const fn of this.listeners.get(event) || []) { try { fn(detail); } catch (e) { console.error('[offline listener]', e); } } }
  state() { return { ...this._state }; }
  _emitChange() { this.emit('change', this.state()); }

  async init() {
    if (this.initialized) return this;
    const queue = await this.store.all('queue');
    const offsetRow = await this.store.get('meta', `${this.serverKey}|server_time_offset`);
    this.serverTimeOffset = Number(offsetRow && offsetRow.v) || 0;
    for (const op of queue) {
      if (op.server_key === this.serverKey && op.status === 'inflight') {
        op.status = 'pending';
        op.next_retry_at = 0;
        await this.store.put('queue', op);
      }
    }
    this.initialized = true;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => false);
    window.addEventListener('online', () => { this._state.online = true; this._state.blocked = ''; this._emitChange(); this.syncNow(); });
    window.addEventListener('offline', () => { this._state.online = false; this._state.phase = 'IDLE'; this._emitChange(); });
    window.addEventListener('te:auth', () => { this._state.blocked = ''; this._state.online = navigator.onLine; this.syncNow(); });
    window.addEventListener('te:server-change', () => { this.refreshServerKey(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.syncNow(); });
    this._scheduleRetry();
    this._emitChange();
    if (this._state.online) this.syncNow();
    return this;
  }
  refreshServerKey() {
    if (this.fixedServerKey) return false;
    const next = normalizeServerKey(getServerUrl());
    if (next === this.serverKey) return false;
    this.serverKey = next;
    this.syncCapable = null;
    this._state.blocked = '';
    this._state.phase = 'IDLE';
    this._emitChange();
    return true;
  }

  async listQueue(routeId) {
    this.refreshServerKey();
    const all = await this.store.all('queue');
    return all.filter(x => x.server_key === this.serverKey && x.user_id === currentUserId() && (!routeId || x.route_id === String(routeId)))
      .sort((a, b) => a.created_at - b.created_at);
  }
  async queueCount(routeId) { return (await this.listQueue(routeId)).length; }

  async enqueueExpense(routeId, payload) {
    this.refreshServerKey();
    const clientId = payload.id || uid('e');
    const safe = sanitizePayload(payload);
    const op = {
      op_id: uid('o'), server_key: this.serverKey, user_id: currentUserId(), route_id: String(routeId),
      type: 'expense.create', client_id: clientId, payload: safe,
      created_at: Date.now(), attempts: 0, next_retry_at: 0, status: 'pending', last_error: null
    };
    await this.store.put('queue', op);
    await this._invalidateRouteCache(routeId);
    this.emit('queued', clone(op));
    this._emitChange();
    if (this._state.online) this.syncNow();
    return { op, clientId };
  }

  async enqueueDelete(routeId, expenseId, expense) {
    this.refreshServerKey();
    const pending = (await this.listQueue(routeId)).find(x => x.type === 'expense.create' && x.client_id === String(expenseId) && x.status !== 'failed');
    if (pending) {
      await this.store.delete('queue', pending.op_id);
      await this._invalidateRouteCache(routeId);
      this.emit('local-resolve', { route_id: String(routeId), client_id: String(expenseId) });
      this._emitChange();
      return { local: true };
    }
    const op = {
      op_id: uid('o'), server_key: this.serverKey, user_id: currentUserId(), route_id: String(routeId), type: 'expense.delete',
      client_id: String(expenseId), payload: expense ? { category: expense.category, amount: expense.amount, title: expense.title } : {},
      created_at: Date.now(), attempts: 0, next_retry_at: 0, status: 'pending', last_error: null
    };
    await this.store.put('queue', op);
    await this._invalidateRouteCache(routeId);
    this._emitChange();
    if (this._state.online) this.syncNow();
    return { op, local: false };
  }

  /* 离线编辑已同步流水（阶段 2）：base_updated_at 乐观锁。
   * 若该笔仍处于「未同步的新增」，直接就地改写其载荷（不产生 update op，无并发面）；
   * 否则入队 expense.update，由服务端比对版本戳，不一致则返回 conflict 交冲突面板处置。 */
  async enqueueUpdate(routeId, expenseId, payload, baseUpdatedAt) {
    this.refreshServerKey();
    const pendingNew = (await this.listQueue(routeId))
      .find(x => x.type === 'expense.create' && x.client_id === String(expenseId) && x.status !== 'failed');
    if (pendingNew) {
      pendingNew.payload = Object.assign({}, pendingNew.payload, sanitizePayload(payload));
      await this.store.put('queue', pendingNew);
      this.emit('queued', clone(pendingNew));
      this._emitChange();
      if (this._state.online) this.syncNow();
      return { op: pendingNew, merged: true };
    }
    const safe = sanitizePayload(payload);
    if (Number(baseUpdatedAt) > 0) safe.base_updated_at = Number(baseUpdatedAt);
    const op = {
      op_id: uid('o'), server_key: this.serverKey, user_id: currentUserId(), route_id: String(routeId),
      type: 'expense.update', client_id: String(expenseId), payload: safe,
      created_at: Date.now(), attempts: 0, next_retry_at: 0, status: 'pending', last_error: null, conflict: null
    };
    await this.store.put('queue', op);
    await this._invalidateRouteCache(routeId);
    this.emit('queued', clone(op));
    this._emitChange();
    if (this._state.online) this.syncNow();
    return { op, merged: false };
  }

  async removeQueued(opId) {
    const op = await this.store.get('queue', opId);
    if (!op || op.server_key !== this.serverKey || op.status === 'inflight') return false;
    await this.store.delete('queue', opId);
    await this._invalidateRouteCache(op.route_id);
    this._emitChange();
    return true;
  }

  async saveExpensesCache(routeId, data) {
    this.refreshServerKey();
    const key = `${cachePrefix(this.serverKey)}|${routeId}`;
    await this.store.put('cache_expenses', {
      key, server_key: this.serverKey, user_id: currentUserId(), route_id: String(routeId),
      list: clone(data.list || []), total: Number(data.total || 0), amount: Number(data.amount || 0),
      byCategory: clone(data.byCategory || {}),
      /* 增量拉取游标（服务端时间戳）：全量响应带 server_time，增量响应带 watermark。 */
      watermark: Number(data.watermark || 0) || Number(data.server_time || 0) || 0,
      fetched_at: Date.now()
    });
  }
  async upsertCachedExpense(routeId, record) {
    const cached = await this.getExpensesCache(routeId);
    if (!cached || !record) return;
    const list = [record, ...(cached.list || []).filter(e => String(e.id) !== String(record.id))];
    const amount = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const byCategory = {};
    for (const e of list) byCategory[e.category] = (byCategory[e.category] || 0) + (Number(e.amount) || 0);
    await this.saveExpensesCache(routeId, { ...cached, list, total: list.length, amount, byCategory });
  }
  async removeCachedExpense(routeId, expenseId) {
    const cached = await this.getExpensesCache(routeId);
    if (!cached) return;
    const list = (cached.list || []).filter(e => String(e.id) !== String(expenseId));
    const amount = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const byCategory = {};
    for (const e of list) byCategory[e.category] = (byCategory[e.category] || 0) + (Number(e.amount) || 0);
    await this.saveExpensesCache(routeId, { ...cached, list, total: list.length, amount, byCategory });
  }
  async getExpensesCache(routeId) { this.refreshServerKey(); return this.store.get('cache_expenses', `${cachePrefix(this.serverKey)}|${routeId}`); }
  async saveRouteCache(qs, data) {
    this.refreshServerKey();
    const q = String(qs || '');
    const key = `${cachePrefix(this.serverKey)}|${q}`;
    await this.store.put('cache_routes', { key, server_key: this.serverKey, user_id: currentUserId(), qs: q, data: clone(data), fetched_at: Date.now() });
  }
  async getRouteCache(qs) { this.refreshServerKey(); return this.store.get('cache_routes', `${cachePrefix(this.serverKey)}|${String(qs || '')}`); }
  /* 离线筛选兜底：枚举当前用户在该服务端已缓存的路线列表快照（loadRoutes 精确 qs 未命中时
   * 取 total 最大的一份做本地过滤）。无任何缓存返回 []。 */
  async listRouteCaches() {
    this.refreshServerKey();
    const prefix = cachePrefix(this.serverKey) + '|';
    const all = (await this.store.all('cache_routes')) || [];
    return all
      .filter((r) => r && r.user_id === currentUserId() && String(r.key || '').indexOf(prefix) === 0)
      .map((r) => ({ qs: r.qs || '', data: r.data || {}, fetched_at: r.fetched_at || 0 }));
  }
  async getMeta(name) {
    this.refreshServerKey();
    const row = await this.store.get('cache_meta', `${cachePrefix(this.serverKey)}|${name}`);
    return row ? clone(row.value) : null;
  }
  async setMeta(name, value) { this.refreshServerKey(); return this.store.put('cache_meta', { key: `${cachePrefix(this.serverKey)}|${name}`, server_key: this.serverKey, user_id: currentUserId(), name, value: clone(value), fetched_at: Date.now() }); }

  async project(routeId, serverList) {
    const cached = Array.isArray(serverList) ? serverList : ((await this.getExpensesCache(routeId)) || {}).list || [];
    const queue = await this.listQueue(routeId);
    const deletes = new Set(queue.filter(o => o.type === 'expense.delete').map(o => o.client_id));
    /* 待同步 / 冲突的编辑：以本地目标值覆盖对应行（含 failed：冲突项要让用户看到本地版本才能二选一）。 */
    const updates = new Map();
    for (const op of queue) if (op.type === 'expense.update') updates.set(op.client_id, op);
    const rows = cached
      .filter(e => !deletes.has(String(e.id)))
      .map(e => {
        const op = updates.get(String(e.id));
        if (!op) return { ...e, pending: false };
        const local = Object.assign({}, op.payload);
        delete local.base_updated_at;
        return { ...e, ...local, pending: true, pending_status: op.status, _op_id: op.op_id };
      });
    for (const op of queue) {
      if (op.type !== 'expense.create' || deletes.has(op.client_id)) continue;
      rows.push({ ...op.payload, id: op.client_id, pending: true, pending_status: op.status, _op_id: op.op_id, created_at: op.created_at });
    }
    rows.sort((a, b) => {
      const ad = a.spent_on || '', bd = b.spent_on || '';
      if (ad !== bd) return ad < bd ? 1 : -1;
      return Number(b.created_at || 0) - Number(a.created_at || 0);
    });
    return rows;
  }

  /* 增量拉取（阶段 2）：以缓存 watermark（服务端时间戳）为游标补拉变更行并合并。
   * 删除类变更无墓碑，由「打开台账时的全量刷新」兜底对账。 */
  async refreshExpensesIncremental(routeId) {
    const cached = await this.getExpensesCache(routeId);
    if (!cached || !Number(cached.watermark)) return null;
    const r = await this.transport.get(`/routes/${encodeURIComponent(routeId)}/expenses?updated_since=${Number(cached.watermark)}`);
    if (!r || !Array.isArray(r.list)) return null;
    const list = Array.isArray(cached.list) ? cached.list.slice() : [];
    for (const row of r.list) {
      const i = list.findIndex(e => String(e.id) === String(row.id));
      if (i >= 0) list[i] = row; else list.push(row);
    }
    const amount = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const byCategory = {};
    for (const e of list) byCategory[e.category] = (byCategory[e.category] || 0) + (Number(e.amount) || 0);
    await this.saveExpensesCache(routeId, {
      ...cached, list, total: list.length, amount, byCategory,
      watermark: Number(r.watermark) || Number(cached.watermark)
    });
    this.emit('cache-updated', { route_id: String(routeId), changed: r.list.length });
    return { merged: r.list.length };
  }

  /* 冲突处置（阶段 2）：保留本地 → 以服务端当前版本戳为新 base 重投（等效覆盖服务端）；
   * 采用服务端 → 用冲突结果携带的服务端记录覆盖缓存，丢弃本地改动。 */
  async resolveConflictKeepLocal(opId) {
    const op = await this.store.get('queue', opId);
    if (!op || op.server_key !== this.serverKey) return false;
    const serverAt = op.conflict && op.conflict.server && Number(op.conflict.server.updated_at);
    if (!(serverAt > 0)) return false;
    op.payload.base_updated_at = serverAt;
    op.status = 'pending'; op.attempts = 0; op.next_retry_at = 0; op.last_error = null; op.conflict = null;
    await this.store.put('queue', op);
    this.emit('resolved', { route_id: op.route_id, op_id: opId, choice: 'local' });
    this._emitChange();
    if (this._state.online) this.syncNow();
    return true;
  }
  async resolveConflictUseServer(opId) {
    const op = await this.store.get('queue', opId);
    if (!op || op.server_key !== this.serverKey) return false;
    const rec = op.conflict && op.conflict.server;
    if (rec) await this.upsertCachedExpense(op.route_id, rec);
    await this.store.delete('queue', opId);
    this.emit('resolved', { route_id: op.route_id, op_id: opId, choice: 'server' });
    this._emitChange();
    return true;
  }

  /* 清理读缓存（阶段 2）：只清缓存与游标，**绝不动待同步队列**。 */
  async clearCaches() {
    const q = await this.listQueue();
    await this.store.clear('cache_routes');
    await this.store.clear('cache_expenses');
    await this.store.clear('cache_meta');
    this.emit('cache-cleared', { kept_ops: q.length });
    this._emitChange();
    return { kept: q.length };
  }

  async storageEstimate() {
    try {
      return (navigator.storage && navigator.storage.estimate) ? await navigator.storage.estimate() : null;
    } catch (e) { return null; }
  }

  async _invalidateRouteCache(routeId) {
    /* 队列作为投影层叠加在原始服务端缓存上，不要把投影结果写回缓存，
     * 否则下一次 project() 会把 pending 创建项重复叠加。 */
    this.emit('cache-dirty', { route_id: String(routeId) });
  }

  async _probeSync(routeId) {
    if (this.syncCapable !== null) return this.syncCapable;
    try {
      const r = await this.transport.post(`/routes/${encodeURIComponent(routeId)}/expenses/sync`, { ops: [] });
      this.syncCapable = !!(r && Array.isArray(r.results));
    } catch (e) {
      if (e.status === 404 || e.status === 405) this.syncCapable = false;
      else if (e.status === 400) this.syncCapable = true;
      else throw e;
    }
    return this.syncCapable;
  }

  async _syncGroup(routeId, ops) {
    const supported = await this._probeSync(routeId);
    if (supported) {
      const wire = ops.map(op => ({
        op_id: op.op_id, type: op.type, client_id: op.client_id,
        ...(op.type === 'expense.create' || op.type === 'expense.update' ? { data: op.payload } : {})
      }));
      try {
        const response = await this.transport.post(`/routes/${encodeURIComponent(routeId)}/expenses/sync`, { ops: wire });
        const results = response.results || [];
        results.server_time = response.server_time || 0;
        return results;
      } catch (e) {
        /* 探测曾通过、如今 404/405：服务端被回滚到旧版（设计 §16.4）→ 能力标记失效，
         * 走下方安全降级路径，绝不退化为非幂等逐笔写入。其余错误照常上抛给退避逻辑。 */
        if (!(e && (e.status === 404 || e.status === 405))) throw e;
        this.syncCapable = false;
      }
    }
    /* 旧服务端兼容：不能使用“旧端点自动生成 id，再拿客户端 id 重放”的方案——
       旧端点会忽略客户端 id，网络响应丢失后会产生重复流水。若该客户端 id 尚未落库，
       队列标记 blocked 并保留，由用户先升级服务端后再重试；已有记录才可判 duplicate。 */
    let existing = new Map();
    try {
      let page = 1, total = Infinity;
      while (existing.size < total && page <= 4) {
        const r = await this.transport.get(`/routes/${encodeURIComponent(routeId)}/expenses?pageSize=500&page=${page++}`);
        for (const e of r.list || []) existing.set(String(e.id), e);
        total = Number(r.total) || 0;
        if (!(r.list || []).length) break;
      }
    } catch (e) { throw e; }
    const results = [];
    for (const op of ops) {
      if (op.type === 'expense.create') {
        const found = existing.get(op.client_id);
        if (found) {
          const same = found.category === op.payload.category && Number(found.amount) === Number(op.payload.amount) &&
            (found.spent_on || '') === (op.payload.spent_on || '') && (found.title || '') === (op.payload.title || '') &&
            (found.note || '') === (op.payload.note || '') && (found.payer_id || null) === (op.payload.payer_id || null) &&
            JSON.stringify((found.parts || []).slice().sort()) === JSON.stringify((op.payload.parts || []).slice().sort());
          results.push(same ? { op_id: op.op_id, status: 'duplicate', id: op.client_id } : { op_id: op.op_id, status: 'conflict', code: 'ID_CONFLICT', message: '旧服务端中同一流水 id 内容不一致' });
          continue;
        }
        results.push({ op_id: op.op_id, status: 'rejected', code: 'SERVER_UPGRADE_REQUIRED', message: '该服务器尚不支持离线幂等同步。请先升级服务端；此笔仍安全保存在本机队列。' });
      } else {
        const found = existing.get(op.client_id);
        if (!found) { results.push({ op_id: op.op_id, status: 'accepted', id: op.client_id }); continue; }
        /* 同样不向旧服务端发删除：若响应丢失而旧服务端无幂等保证，需由新版 sync 执行。 */
        results.push({ op_id: op.op_id, status: 'rejected', code: 'SERVER_UPGRADE_REQUIRED', message: '请先升级服务端后再同步删除；操作仍保存在本机队列。' });
      }
    }
    return results;
  }

  async syncNow(options = {}) {
    if (this.syncPromise) return this.syncPromise;
    if (!this.initialized) await this.init();
    if (!this._state.online || (typeof navigator !== 'undefined' && !navigator.onLine)) return { skipped: 'offline' };
    this.syncPromise = this._sync(options).finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  async _sync({ manual = false } = {}) {
    this._state.syncing = true;
    this._state.phase = 'SYNCING';
    this._state.blocked = '';
    this._emitChange();
    try {
      let queue = await this.listQueue();
      const now = Date.now();
      queue = queue.filter(o => (o.status === 'pending' && o.next_retry_at <= now) || (manual && o.status === 'failed'));
      if (!queue.length) return { synced: 0 };

      /* create + delete 尚未离开本机：两条 op 一并消解，不发网络请求。 */
      const byClient = new Map();
      for (const op of queue) if (op.type === 'expense.create' && op.status === 'pending') byClient.set(op.client_id, op);
      const localDeletes = new Set(queue.filter(o => o.type === 'expense.delete' && byClient.has(o.client_id)).map(o => o.client_id));
      for (const id of localDeletes) {
        const create = byClient.get(id);
        const del = queue.find(o => o.type === 'expense.delete' && o.client_id === id);
        await this.store.delete('queue', create.op_id);
        await this.store.delete('queue', del.op_id);
        this.emit('local-resolve', { route_id: create.route_id, client_id: id });
      }
      queue = queue.filter(o => !localDeletes.has(o.client_id));

      const groups = new Map();
      for (const op of queue) { if (!groups.has(op.route_id)) groups.set(op.route_id, []); groups.get(op.route_id).push(op); }
      let synced = 0;
      for (const [routeId, allOps] of groups) {
        for (let off = 0; off < allOps.length; off += MAX_BATCH) {
          const batch = allOps.slice(off, off + MAX_BATCH);
          for (const op of batch) { op.status = 'inflight'; await this.store.put('queue', op); }
          this._emitChange();
          try {
            const response = await this._syncGroup(routeId, batch);
            if (response.server_time) {
              this.serverTimeOffset = Number(response.server_time) - Date.now();
              await this.store.put('meta', { k: `${this.serverKey}|server_time_offset`, v: this.serverTimeOffset });
            }
            const resultById = new Map(response.map(r => [r.op_id, r]));
            for (const op of batch) {
              const r = resultById.get(op.op_id) || { status: 'rejected', code: 'MISSING_RESULT', message: '服务端未返回该操作结果' };
              if (['accepted', 'duplicate', 'degraded'].includes(r.status)) {
                if (op.type === 'expense.delete') {
                  await this.removeCachedExpense(routeId, op.client_id);
                } else if (r.server_record) {
                  await this.upsertCachedExpense(routeId, r.server_record);
                } else if (op.type === 'expense.create') {
                  const record = {
                    id: op.client_id, route_id: routeId, ...op.payload,
                    ...(r.status === 'degraded' ? { payer_id: null, parts: [], split_mode: 'none' } : {}),
                    currency: 'CNY', is_opening: false, created_at: (r.created_at || Date.now() + this.serverTimeOffset)
                  };
                  await this.upsertCachedExpense(routeId, record);
                } else if (op.type === 'expense.update') {
                  /* 无 server_record（仅旧服务端 duplicate 分支）：以本地目标值更新缓存，避免停留在旧值。 */
                  const cachedNow = await this.getExpensesCache(routeId);
                  const row = cachedNow && (cachedNow.list || []).find(e => String(e.id) === op.client_id);
                  if (row) {
                    const local = Object.assign({}, op.payload);
                    delete local.base_updated_at;
                    await this.upsertCachedExpense(routeId, Object.assign({}, row, local));
                  }
                }
                await this.store.delete('queue', op.op_id);
                synced++;
                if (r.status === 'degraded') this.emit('degraded', { op, result: r });
                this.emit('synced', { op, result: r });
              } else {
                op.status = 'failed'; op.last_error = { code: r.code || r.status, message: r.message || r.status, at: Date.now() };
                /* 编辑冲突（阶段 2）：保留服务端记录供冲突面板二选一（保留本地 / 采用服务端）。 */
                if (r.status === 'conflict') {
                  op.conflict = { code: r.code || 'EDIT_CONFLICT', server: r.server || null };
                  this.emit('conflict', { op: clone(op), result: r });
                }
                await this.store.put('queue', op);
                this.emit('failed', { op, result: r });
                if (r.code === 'SERVER_UPGRADE_REQUIRED') {
                  this._state.blocked = 'server_upgrade_required';
                  this._state.phase = 'BLOCKED';
                }
              }
            }
          } catch (e) {
            if (isAuthError(e)) {
              for (const op of batch) { op.status = 'pending'; op.last_error = { code: 'SESSION_EXPIRED', message: e.message, at: Date.now() }; await this.store.put('queue', op); }
              this._state.blocked = 'session_expired';
              this._state.phase = 'BLOCKED';
              this.emit('blocked', { reason: 'session_expired', error: e });
              return { synced, blocked: 'session_expired' };
            }
            for (const op of batch) {
              op.attempts += 1;
              if (op.attempts >= MAX_ATTEMPTS) {
                op.status = 'failed';
              } else {
                op.status = 'pending';
                op.next_retry_at = Date.now() + retryDelay(op.attempts);
              }
              op.last_error = { code: e.code || (e.status ? `HTTP_${e.status}` : 'NETWORK'), message: e.message || '同步失败', at: Date.now() };
              await this.store.put('queue', op);
            }
            this._state.phase = isNetworkError(e) ? 'BACKOFF' : 'BACKOFF';
            this.emit('sync-error', { route_id: routeId, error: e, ops: batch });
            if (isNetworkError(e)) break;
          }
        }
      }
      /* 同步有成效 → 对已有缓存的路线做一次增量补拉（合并其他端变更；删除由下次全量刷新兜底）。 */
      if (synced > 0) {
        for (const routeId of groups.keys()) {
          try { await this.refreshExpensesIncremental(routeId); } catch (e) { /* 增量失败不影响同步主流程 */ }
        }
      }
      const left = await this.listQueue();
      this._state.phase = left.length ? (this._state.blocked ? 'BLOCKED' : 'BACKOFF') : 'IDLE';
      const offset = this.serverTimeOffset;
      await this.store.put('meta', { k: `${this.serverKey}|last_sync_at`, v: Date.now() });
      this._scheduleRetry();
      return { synced, remaining: left.length, server_time_offset: offset };
    } finally {
      this._state.syncing = false;
      this._emitChange();
    }
  }

  _scheduleRetry() {
    clearTimeout(this._retryTimer);
    if (!this.initialized || !this._state.online || this._state.blocked) return;
    this.listQueue().then(q => {
      const pending = q.filter(op => op.status === 'pending');
      if (!pending.length) return;
      const next = Math.min(...pending.map(op => op.next_retry_at || 0));
      const delay = Math.max(250, next - Date.now());
      this._retryTimer = setTimeout(() => this.syncNow(), delay);
    }).catch(() => {});
  }
}

let singleton = null;
let adapterPromise = null;

export async function createOfflineEngine(options = {}) {
  let adapter = options.adapter;
  if (!adapter) adapter = await IndexedDBAdapter.open();
  const key = options.serverKey === undefined ? SERVER_KEY : options.serverKey;
  const engine = new OfflineEngine(adapter, options.transport || api, key, options.serverKey !== undefined);
  if (options.init !== false) await engine.init();
  return engine;
}

export async function initOffline(options = {}) {
  if (singleton) return singleton;
  try {
    adapterPromise = IndexedDBAdapter.open();
    singleton = await createOfflineEngine({ ...options, adapter: options.adapter || await adapterPromise });
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(x => singleton.emit('storage', x)).catch(() => {});
    }
    return singleton;
  } catch (e) {
    console.warn('[offline] IndexedDB 不可用，离线记账已关闭：', e.message);
    singleton = null;
    return null;
  }
}

export function getOfflineEngine() { return singleton; }
export function isOfflineReady() { return !!singleton; }
export function getServerKey() { return SERVER_KEY; }
export function createClientId() { return uid('e'); }
export const offlineTest = { uid, retryDelay, normalizeServerKey, isNetworkError, isAuthError };
