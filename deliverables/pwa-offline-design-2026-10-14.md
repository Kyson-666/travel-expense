# PWA 离线记账 · 架构设计与实施规范

> 版本：v1（设计冻结稿） · 日期：2026-10-14
> 适用仓库：`travel-expense`（`hanyuestar/travel-expense`）
> 配套交互原型：[`proto-pwa-offline/`](./proto-pwa-offline/)（可双击打开，零依赖）
> 目标读者：接手实施的模型 / 工程师。本文是**唯一权威契约**，实现与本文件冲突时以本文件为准。

---

## 0. 一页概览

| 项 | 内容 |
|---|---|
| 一句话 | 让「记一笔」在**断网/弱网**下照常可用，恢复网络后自动、幂等、可观测地同步到服务端 |
| 范围（做） | 离线**查看**已缓存路线与流水；离线**新增**流水；离线**删除**本地待同步流水；自动重试与同步状态可见 |
| 范围（不做） | 离线编辑路线本体；离线 AI 规划；多端实时协同；离线编辑已同步的历史流水（见 §8 阶段 2） |
| 新增依赖 | **零**（无 Workbox、无 idb 库、无构建步骤）——沿用项目「原生 ES Modules + 后端内置托管」的既有风格 |
| 服务端改动 | 3 处：`insertExpense` 接受客户端 id、新增批量同步端点、`sw.js` 免缓存。**无表结构变更** |
| 关键风险 | 幂等性（防重复记账）、队列持久性、会话过期时的队列保全、切换服务器后的缓存串味 |
| 预估规模 | 新增 3 个前端文件 + 1 个 SW + manifest；改动 6 个文件；服务端约 120 行 |

---

## 1. 现状与硬约束（设计前提）

实施前必须理解以下既有约束，本设计的每一项决策都由它们推导而来。

| 约束 | 出处 | 对设计的影响 |
|---|---|---|
| **无前端构建步骤**，原生 ES Modules 直载 | `public/index.html` 引 `assets/main.js` | 不引入打包器；SW 与离线模块必须是可直接运行的 `.js` |
| 后端为 Node 原生 `http`，同时托管前端 | `server/app.js` | SW 与 manifest 由同一静态处理器下发；需为其定制 `Cache-Control` |
| 安卓壳为 Capacitor，WebView 源固定 `http://localhost` | `android-app/` | **SW 在安卓壳内不可依赖** → 离线队列必须放在应用层（见 §3 决策 1） |
| 客户端可「切换服务器」（`getServerUrl()`） | `public/assets/api.js` | 离线缓存必须**按服务器地址命名空间隔离** |
| 流水表 `expenses.id` 为 `TEXT PRIMARY KEY` | `server/db.js` | **无需改表**即可接受客户端生成的 id → 幂等的天然基础 |
| 分账须保证 Σnet = 0；无付款人流水计入 `unassigned` 并整体排除结算 | `server/db.js settle()` | 离线流水若引用的同行人已失效，可**安全降级为 unassigned**（不破坏不变量） |
| 日期一律本地函数，禁 `toISOString()` | 项目硬约束 | 离线流水的 `spent_on` 用本地日期生成 |
| `PUT` 为整体覆盖；未知字段被白名单静默丢弃 | `server/db.js bind()` | 同步端点必须**显式白名单**字段，不可透传整个 body |
| CSP：`default-src 'self'`；`script-src 'self'` | `server/app.js` | SW 与 manifest 均被现有 CSP 覆盖，**无需改 CSP**（见 §10.3） |

---

## 2. 系统架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  浏览器 / Capacitor WebView（应用层，同一套代码）                      │
│                                                                      │
│  ┌────────────┐   ┌──────────────────────────────────────────────┐   │
│  │  UI 层      │   │  offline.js（离线引擎，纯 ES Module）          │   │
│  │ ledger.js   │──▶│                                              │   │
│  │ offline-ui  │   │  ┌──────────┐  ┌──────────┐  ┌───────────┐  │   │
│  └────────────┘   │  │ 队列 Queue│  │ 读缓存    │  │ 同步器     │  │   │
│        ▲          │  │ (待同步)  │  │ Cache    │  │ Syncer    │  │   │
│        │          │  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │   │
│        │          │       └───────┬─────┘              │        │   │
│        │          │         ┌─────▼─────┐        ┌─────▼─────┐  │   │
│        │          │         │ Storage   │        │ Transport │  │   │
│        │          │         │ Adapter   │        │ (fetch)   │  │   │
│        │          │         └─────┬─────┘        └─────┬─────┘  │   │
│        │          └───────────────┼────────────────────┼────────┘   │
│        │                          │                    │            │
│        │              ┌───────────▼────────┐   ┌───────▼─────────┐  │
│        │              │ IndexedDB          │   │  HTTP /api/*    │  │
│        │              │ te-offline         │   └─────────────────┘  │
│        │              └────────────────────┘                        │
│  ┌─────┴──────────────────────────┐                                 │
│  │ Service Worker（sw.js）         │  ← 仅「应用外壳」缓存，不碰 API  │
│  │  · precache app shell          │                                 │
│  │  · 导航回退 index.html          │                                 │
│  └────────────────────────────────┘                                 │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  服务端（Node http + better-sqlite3）                                 │
│  POST /api/routes/:id/expenses        ← 新增：接受客户端 id（幂等）    │
│  POST /api/routes/:id/expenses/sync   ← 新增：批量幂等同步            │
│  DELETE /api/routes/:id/expenses/:eid ← 调整：删除幂等（不存在=成功）  │
└──────────────────────────────────────────────────────────────────────┘
```

**分层职责边界（实施时不可越界）**

| 层 | 职责 | 明确不做 |
|---|---|---|
| `sw.js` | 预缓存静态外壳、离线打开页面、导航回退 | **不拦截 `/api/*`**、不参与业务写入 |
| `offline.js` | 队列、读缓存、同步编排、重试退避、投影计算 | 不直接操作 DOM |
| `offline-ui.js` | 离线指示条、同步面板、行级「待同步」标记 | 不直接读写 IndexedDB |
| `ledger.js` | 「记一笔」提交分流、渲染合并后的投影列表 | 不感知重试策略 |

---

## 3. 核心架构决策（含否决方案）

> 每条决策都给出理由与否决方案。**实施时不要重新论证**，如确有异议请在 PR 中引用本节编号讨论。

### 决策 1：离线队列放在**应用层**，不依赖 Service Worker

- **理由**：安卓壳（Capacitor）的 WebView 由本地 bundle 提供页面，SW 支持不稳定且无意义；若把队列放进 SW，安卓端将完全失去离线记账能力。同时 SW 生命周期不可控（浏览器可随时终止），承载业务队列会导致「写到一半被杀」。
- **否决方案**：Workbox Background Sync 队列。→ 引入依赖、且同样受 SW 生命周期与安卓兼容性限制。
- **结论**：SW 只做外壳缓存；队列与缓存统一由 `offline.js` 管理，浏览器 PWA 与安卓壳**共用同一套逻辑**。

### 决策 2：幂等性靠**客户端生成流水 id**

- **理由**：`expenses.id` 已是 `TEXT PRIMARY KEY`，接受客户端 id 是**零成本**的幂等键。重试、重复提交、批量重放全部自然收敛。
- **否决方案**：服务端下发幂等令牌（需新增表/列）；请求指纹去重（金额+时间相同会误判为重复，反而丢数据）。
- **结论**：客户端在**入队前**生成 id（沿用服务端 `uid('e')` 的格式），该 id 贯穿队列、投影 UI 与最终落库。

### 决策 3：冲突面**主动压缩到接近零**

- **理由**：路线为 owner 隔离（每人只见自己的路线），同账号多端并发写同一路线的概率极低。为不存在的冲突场景引入合并逻辑（CRDT / 三路合并）是过度设计。
- **结论**：阶段 1 只支持**离线新增**与**离线删除本地待同步项**（后者甚至不需要网络）。离线编辑已同步流水推迟到阶段 2，用 `base_updated_at` 乐观锁实现。

### 决策 4：同步用**批量端点**，不用逐笔 POST

- **理由**：弱网下 N 次往返 = N 次失败机会；批量端点能一次性给出逐笔结果，省电省流量，且便于服务端在**单事务**内保证一致性。
- **结论**：`POST /api/routes/:id/expenses/sync`，单次上限 200 笔。

### 决策 5：读缓存按**服务器地址命名空间隔离**

- **理由**：项目支持「切换服务器」。若不隔离，切到 B 服务器后会读到 A 服务器的缓存，造成**静默的数据串味**。
- **结论**：所有缓存键与队列记录均带 `server_key`（= `getServerUrl()` 的规范化值），读写时强制过滤。

### 决策 6：同行人失效时**自动降级为 unassigned**，不丢数据

- **理由**：离线期间该同行人可能已被删除（或整条路线被删）。若直接拒绝，用户的记账数据就丢了。而项目的结算口径已经支持「无付款人 → 计入 `unassigned` → 整体排除结算」，**Σnet = 0 的不变量不被破坏**。
- **结论**：付款人/分摊人失效时，保留金额与类目，`payer_id` 置空、`parts` 清空（`split_mode='none'`），并标记 `degraded: true`，UI 明确提示用户去修正。**路线本身不存在**时则无法降级，标记 `rejected: route_not_found` 并保留在队列中由用户处置。

### 决策 7：存储层抽象为 `StorageAdapter` 接口

- **理由**：IndexedDB 在 Node 测试环境不可用。把存储抽象成接口（IndexedDB 实现 + 内存实现），**同步引擎的全部逻辑可在 Node 下零依赖单测**，无需 `fake-indexeddb`。
- **结论**：`offline.js` 内部依赖 `StorageAdapter`，测试注入 `MemoryAdapter`；端到端另用项目既有的 CDP 脚本方式（见 §13）。

---

## 4. 数据模型（IndexedDB）

**库名**：`te-offline` · **版本**：`1` · 升级策略：`onupgradeneeded` 内按 `oldVersion` 顺序迁移（与项目「幂等迁移」风格一致）。

### 4.1 `queue`（待同步队列）

| 字段 | 类型 | 说明 |
|---|---|---|
| `op_id` | string (PK) | 操作 id，客户端生成（`o` + 时间36 + 随机） |
| `server_key` | string | 服务器命名空间（决策 5） |
| `route_id` | string | 目标路线 |
| `type` | string | `expense.create` \| `expense.delete`（阶段 2 增加 `expense.update`） |
| `client_id` | string | 目标流水 id（**幂等键**） |
| `payload` | object | `type=create` 时的流水字段白名单快照 |
| `created_at` | number | 入队时刻（本地时钟），重放顺序依据 |
| `attempts` | number | 已尝试次数 |
| `next_retry_at` | number | 下次可重试时刻（指数退避） |
| `status` | string | `pending` \| `inflight` \| `failed` |
| `last_error` | object\|null | `{ code, message, at }` |

索引：`by_server_route`（`[server_key, route_id]`）、`by_status`（`status`）、`by_created`（`created_at`）

### 4.2 `cache_routes`（列表读缓存）

`{ key: '<server_key>|<qs>', server_key, qs, data: {list,total,page,pageSize}, fetched_at }`
索引：`by_server`（`server_key`）

### 4.3 `cache_expenses`（每路线流水缓存）

`{ key: '<server_key>|<route_id>', server_key, route_id, list: [...], total, fetched_at }`
索引：`by_server_route`（`[server_key, route_id]`）

### 4.4 `cache_meta`（单条元数据 / 站点信息）

`{ key: '<server_key>|<name>', server_key, name, value, fetched_at }`
用于缓存 `/api/public/site`（`fx_rates`、`currency_symbols`、`home_currency`）与 `route detail`。

### 4.5 `meta`（全局，非命名空间）

`{ k: 'schema' | 'server_time_offset' | 'last_sync_at', v }`

---

## 5. 同步引擎

### 5.1 状态机

```
                    ┌───────────────────────────────┐
                    │                               │
        ┌───────────▼──────────┐   online 事件 /    ┌┴──────────────┐
        │        IDLE          │   启动 / 可见性    │   SYNCING     │
        │  队列为空或无网络     │───────────────────▶│ 批量重放中     │
        └───────────▲──────────┘                    └───────┬───────┘
                    │                                       │
                    │  队列已空                              │ 全部 op 终结
                    └───────────────────────────────────────┤
                                                            │
                    ┌───────────────────┐   有可重试 op      │
                    │     BACKOFF       │◀──────────────────┤
                    │ 退避等待（1→60s）  │                   │
                    └─────────┬─────────┘                   │
                              │ 退避到期                      │ 存在不可重试 op
                              └──────────────────────────────▶┌──────────────┐
                                                              │   BLOCKED    │
                                                              │ 需用户处置    │
                                                              │（会话过期/    │
                                                              │ 路线已删）    │
                                                              └──────────────┘
```

**状态语义**

| 状态 | 触发条件 | UI 表现 |
|---|---|---|
| `IDLE` | 队列为空，或 `navigator.onLine === false` | 无指示 / 显示离线条 |
| `SYNCING` | 正在批量重放 | 指示条显示「同步中…」+ 进度 |
| `BACKOFF` | 网络类失败，等待退避 | 显示「N 笔待同步 · 将在 Xs 后重试」 |
| `BLOCKED` | 出现 `401`（会话过期）或 `route_not_found` | 顶部醒目提示 + 「去处理」入口 |

### 5.2 重放算法（伪代码）

```
async function sync() {
  if (state !== IDLE || !navigator.onLine) return
  state = SYNCING
  ops = queue.list({ server_key, status: pending|failed, next_retry_at <= now, order: created_at ASC })
  if (ops.length === 0) { state = IDLE; return }

  // 1) 本地消解：delete 命中尚未同步的 create → 两条一起丢弃，无需网络
  ops = localResolve(ops)

  // 2) 按 route_id 分组，逐组调用批量端点（单组上限 200）
  for (group of groupBy(ops, 'route_id')) {
    markInflight(group)
    try {
      resp = await POST(`/api/routes/${group.route_id}/expenses/sync`,
                        { ops: group.map(toWire), client_time: Date.now() })
      applyResults(resp.results)     // 逐笔终结：accepted/duplicate → done；conflict/rejected → 见 §8
      applyServerTime(resp.server_time)   // 计算并持久化时钟偏移
    } catch (e) {
      if (isAuthError(e)) { markBlocked(group, 'session_expired'); state = BLOCKED; return }
      if (isNetworkError(e)) { backoff(group); state = BACKOFF; scheduleRetry(); return }
      markFailed(group, e)           // 5xx / 解析失败 → 可重试
    }
  }
  state = queue.isEmpty() ? IDLE : BACKOFF
}
```

**退避参数**：`delay = min(1000 * 2^attempts, 60000)`，抖动 ±20%，最大尝试 8 次后转 `failed`（仍可由用户手动重试）。

**同步触发点**（全部接入，缺一不可）：

1. 应用启动（`main.js` 初始化完成后）
2. `window.addEventListener('online')`
3. `document.visibilitychange` → 变为可见
4. 队列新增后立即尝试一次
5. 用户手动「立即同步」
6. 可选：`registration.sync.register('te-expense-sync')`（**仅作为增强，必须能在不支持时优雅降级**）

### 5.3 投影层（乐观 UI 的核心）

UI 渲染的流水列表 = **服务端缓存** 经 **队列投影** 后的结果：

```
projected(serverList, queue) =
    serverList
      .filter(e => !queue.hasPendingDelete(e.id))          // 减去待删
      .map(e => ({ ...e, pending: false }))
  ∪ queue.pendingCreates()
      .filter(op => !queue.hasPendingDelete(op.client_id)) // 新增后又删掉的不显示
      .map(op => ({ ...op.payload, id: op.client_id, pending: true, _op_id: op.op_id }))
  → 按 spent_on DESC, created_at DESC 排序（与服务端 listExpenses 同口径）
```

**硬性要求**：投影必须**复用服务端同款排序口径**，否则在线/离线切换时列表顺序会跳动。

---

## 6. 服务端 API 契约

### 6.1 `POST /api/routes/:id/expenses`（既有端点，扩展）

新增**可选** `id` 字段（客户端幂等键）。

```jsonc
// Request
{ "id": "e1a2b3c4d5", "category": "餐饮", "amount": 128.5,
  "spent_on": "2026-10-14", "title": "晚饭", "note": "",
  "payer_id": "txxxx", "parts": ["txxxx", "tyyyy"] }

// 200/201 Response（id 已存在且字段一致 → 幂等成功，返回既有记录）
{ "ok": true, "data": { "id": "e1a2b3c4d5", ... } }

// 409（id 已存在但字段不同）
{ "ok": false, "msg": "该流水已存在且内容不一致", "code": "ID_CONFLICT" }
```

**校验规则**：`id` 必须匹配 `/^[A-Za-z0-9_-]{8,64}$/`，否则忽略并使用服务端生成的 id（**向后兼容**：老客户端不传 id，行为完全不变）。

### 6.2 `POST /api/routes/:id/expenses/sync`（新增）

```jsonc
// Request
{
  "client_time": 1760400000000,
  "ops": [
    { "op_id": "o111", "type": "expense.create", "client_id": "e1a2b3c4d5",
      "data": { "category": "餐饮", "amount": 128.5, "spent_on": "2026-10-14",
                "title": "晚饭", "note": "", "payer_id": "txxxx", "parts": ["txxxx"] } },
    { "op_id": "o112", "type": "expense.delete", "client_id": "e9z8y7x6" }
  ]
}

// 200 Response —— 逐笔结果，顺序与请求一致
{
  "ok": true,
  "data": {
    "server_time": 1760400005123,
    "results": [
      { "op_id": "o111", "status": "accepted", "id": "e1a2b3c4d5" },
      { "op_id": "o111", "status": "duplicate" },                          // 幂等重放
      { "op_id": "o111", "status": "degraded", "id": "e1a2b3c4d5",
        "code": "TRAVELER_MISSING", "message": "付款人已不存在，已记为未指定付款人" },
      { "op_id": "o111", "status": "rejected", "code": "ROUTE_NOT_FOUND" },
      { "op_id": "o111", "status": "conflict", "code": "ID_CONFLICT",
        "server": { "id": "e1a2b3c4d5", "amount": 100 } }                 // 仅阶段 2 需要
    ]
  }
}
```

**状态枚举**：`accepted` | `duplicate` | `degraded` | `conflict` | `rejected`
**客户端终结规则**：`accepted`/`duplicate`/`degraded` → 从队列移除（`degraded` 额外弹一次提示）；`conflict`/`rejected` → 转 `failed` 并**停止自动重试**，交用户处置。

**幂等实现要点**（`server/db.js`）

```
syncExpenseOps(routeId, ownerId, ops):
  单事务内逐条处理：
    create:
      若 id 已存在 → 比对白名单字段（category/amount/spent_on/title/note/payer_id/split_mode/parts）
                      一致 → duplicate；不一致 → conflict
      否则 → 校验同行人；付款人/分摊人缺失 → 降级为 (payer_id=null, parts=[], split_mode='none') + degraded
              插入（client_id 即 id）→ accepted
    delete:
      存在 → 删除 → accepted；不存在 → accepted（幂等）
  事务尾部 recomputeRouteAgg(routeId) 一次（不要逐笔调用）
```

**注意**：`ops` 上限 200；超出返回 `400 OPS_TOO_MANY`。**不得**把 `data` 直接透传给 `insertExpense`，必须走白名单（与 `ROUTE_COLS` 同风格），防止 `is_opening` / `owner_id` 被伪造。

### 6.3 `DELETE /api/routes/:id/expenses/:eid`（既有端点，调整）

目标流水不存在时由 `404` 改为 **`200 { deleted: 0 }`**（幂等删除）。这是**行为变更**，需在 README 变更记录中说明；前端现有调用不依赖 404 语义，风险低。

---

## 7. 前端接入点

### 7.1 新增文件

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `public/assets/offline.js` | 引擎：存储适配器、队列、缓存、同步器、投影 | `initOffline()`, `enqueueExpense()`, `deleteExpenseOffline()`, `readCached()`, `project()`, `syncNow()`, `on('change', cb)`, `state()` |
| `public/assets/offline-ui.js` | 指示条 / 同步面板 / 行标记 | `mountOfflineUI()` |
| `public/sw.js` | 应用外壳缓存 | — |
| `public/manifest.webmanifest` | PWA 清单 | — |

### 7.2 改动文件

| 文件 | 改动 | 注意 |
|---|---|---|
| `public/assets/api.js` | 新增 `isNetworkError(e)` 导出；`request()` 增加 `timeout` 与 `AbortController`（弱网下 30s 超时，否则永远 pending） | 不改既有错误文案（`smoke-cors` 与 UI 依赖它） |
| `public/assets/ledger.js` | `openExpenseSheet` 的保存路径分流：**先在线直发，网络类失败则入队**；渲染时用 `project()` 结果 | 客户端 id **必须在直发前生成**，否则重试不幂等 |
| `public/assets/main.js` | 启动时 `registerSW()` + `initOffline()` + `mountOfflineUI()` | SW 注册失败必须静默（安卓壳内必然失败） |
| `public/index.html` | `<link rel="manifest">`、`<meta name="theme-color">`、离线指示条容器 | 指示条默认 `display:none`，避免在线时闪一下 |
| `server/app.js` | `/sw.js` 与 `/manifest.webmanifest` 响应头设 `Cache-Control: no-cache` | 否则 SW 更新被 5 分钟缓存拖住 |
| `server/routes_api.js` / `server/db.js` | §6 的三处契约变更 | — |

### 7.3 「记一笔」提交分流（关键代码骨架）

```js
export async function submitExpense(routeId, draft) {
  const clientId = uid('e');                 // ① 幂等键先生成
  const payload = pickWhitelist(draft);      // ② 只带白名单字段
  const online = navigator.onLine && offlineReady();

  if (online) {
    try {
      const rec = await api.post(`/routes/${routeId}/expenses`, { id: clientId, ...payload });
      cacheExpenseUpsert(routeId, rec);       // ③ 成功后写回读缓存，避免下次打开又请求
      return { ok: true, synced: true, rec };
    } catch (e) {
      if (!isNetworkError(e)) throw e;        // 业务错误照常抛给 UI
      // 网络类失败 → 落到队列（同一 clientId，天然幂等）
    }
  }
  await enqueueExpense({ routeId, clientId, payload });
  return { ok: true, synced: false };
}
```

---

## 8. 冲突与降级策略总表

| # | 场景 | 判定依据 | 策略 | UI 表现 |
|---|---|---|---|---|
| 1 | 重放时 id 已存在、字段一致 | 白名单字段全等 | `duplicate` → 移除 op | 无感（视为成功） |
| 2 | 重放时 id 已存在、字段不同 | 任一字段不等 | `conflict` → 停止重试 | 「同步冲突」入口，二选一（阶段 2） |
| 3 | 付款人 / 分摊人已不存在 | 同行人查询未命中 | `degraded` → 降级 unassigned，**保留金额** | 一次性提示「N 笔已记为未指定付款人，请修正」 |
| 4 | 路线已被删除 | `routes` 未命中 | `rejected: route_not_found` → 停止重试，**保留队列** | 「该路线已删除，N 笔待处置」+ 可导出/丢弃 |
| 5 | 会话过期（401） | 响应 401 | **保留队列**，暂停同步 | 顶部「登录已过期，登录后自动继续同步」 |
| 6 | 账号被封禁（403） | 响应 403 | 保留队列，暂停同步 | 同上 |
| 7 | 类目非法 / 金额 ≤ 0 | 服务端校验 | `rejected: invalid_*` → 停止重试 | 列出问题项，允许编辑后重试 |
| 8 | 服务端 5xx / 网络中断 | — | 退避重试（最多 8 次） | 「N 笔待同步 · 重试中」 |
| 9 | 离线删除一个**尚未同步**的新增 | 队列内本地判定 | 两条一起丢弃，**不发网络请求** | 无感 |

> **设计原则**：**宁可降级，不可丢数据**。任何 `rejected` 都必须保留在队列中，由用户显式处置（导出 / 修正 / 丢弃），绝不静默删除。

---

## 9. Service Worker 策略

### 9.1 缓存策略

| 资源 | 策略 | 理由 |
|---|---|---|
| 导航请求（`mode: 'navigate'`） | **网络优先 → 失败回退缓存 index.html** | 保证拿到新版；离线仍可打开 |
| `/assets/*.js`、`/styles.css` | **stale-while-revalidate** | 首屏秒开 + 后台更新 |
| `/assets/html2canvas.min.js` | 预缓存（体积大但分享导出需要） | — |
| `/api/*` | **完全不拦截**（直接 `return;` 放行） | 业务缓存由 `offline.js` 负责（决策 1） |
| `/share/*` | 不拦截 | 分享页由服务端渲染，无离线需求 |
| 跨域请求 | 不拦截 | — |

### 9.2 版本与更新

- SW 文件内嵌 `const VERSION = '<构建时或手写常量>'`；`activate` 时清理非当前版本的缓存。
- `install` → `skipWaiting()`；`activate` → `clients.claim()`。
- `index.html` 已设 `Cache-Control: no-cache`，SW 脚本需**同样设为 `no-cache`**（§7.2）。
- 检测到新 SW 时，UI 顶部提示「有新版本，点击刷新」——**不静默强制刷新**，避免用户正在填表时被打断。

### 9.2.1 **安卓壳内必须跳过 SW 注册**（硬性要求）

安卓壳已由**原生热更新**（`MainActivity.java`）与本地 assets 提供完整的外壳离线能力，**不需要也不应该**注册 Service Worker：

```js
export function registerSW() {
  /* Capacitor/安卓壳：不注册 —— 壳内 WebView 由原生 shouldInterceptRequest 提供资源，
   * SW 注册不可靠；且外壳离线由原生热更新已覆盖。注册失败也不得影响主流程。 */
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (window.Capacitor || window.__CAPACITOR__) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 静默 */ });
  });
}
```

> **理由**：Capacitor 的资源由 `BridgeWebViewClient.shouldInterceptRequest` 从本地目录拦截提供，SW 的注册与拦截在该路径下不可靠；一旦注册成功却缓存了过期资源，反而会**掩盖原生热更新的效果**（热更新换了目录，SW 仍回旧缓存）。跳过注册是唯一稳妥的选择。

### 9.3 PWA 清单

```jsonc
// public/manifest.webmanifest
{
  "name": "旅行路线 · 经费台",
  "short_name": "经费台",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f3fbf9",
  "theme_color": "#15a98c",
  "lang": "zh-CN",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

图标设计源：复用页头 SVG（纸飞机 `M3 11l19-9-9 19-2-8-8-2z`）置于 `--primary` 渐变圆角底。**maskable 版本需留 20% 安全边距**。原型目录内已附 `icon.svg` 设计源。

---

## 10. 安全与兼容性

### 10.1 认证

- 会话为 `HttpOnly` Cookie，SW 与离线队列**都不接触凭据**；同步请求由浏览器自动带 Cookie。
- 401 时**保留队列**（§8 #5），登录成功后自动继续 —— 这是最容易写错的一点。

### 10.2 队列数据的敏感度

队列与读缓存含用户记账数据，存于 IndexedDB（同源隔离）。建议启动时调用 `navigator.storage.persist()` 申请持久化，避免被浏览器在存储压力下清理；`navigator.storage.estimate()` 用于容量提示。

### 10.3 CSP（**结论：无需修改**）

| 指令 | 现有值 | SW / manifest 是否放行 |
|---|---|---|
| `script-src` | `'self'` | ✅ SW 脚本同源（`worker-src` 缺省回退到 `child-src` → `script-src`） |
| `default-src` | `'self'` | ✅ `manifest-src` 缺省回退到此 |
| `connect-src` | `'self'`（跨域客户端模式含 `https:`） | ✅ 同步请求同源 |

> 建议（非必需）：显式补 `worker-src 'self'; manifest-src 'self'` 以增强可读性，但**不要**为离线功能放宽任何既有指令。

### 10.4 兼容性矩阵

| 环境 | SW | IndexedDB | 离线记账 | 说明 |
|---|---|---|---|---|
| 桌面/移动浏览器（HTTPS 或 localhost） | ✅ | ✅ | ✅ 完整 | — |
| 浏览器 + HTTP 非 localhost | ❌（浏览器限制） | ✅ | ⚠️ 仅队列，无外壳缓存 | 需在 UI 说明 |
| 安卓壳（Capacitor） | ❌/不稳定 | ✅ | ✅ 完整 | **本设计的核心保障场景** |
| 隐私模式 | ⚠️ | ⚠️ 可能受限 | ⚠️ 降级为内存队列 | 检测失败则退化为「在线直发」 |

---

## 11. 分阶段实施计划

### 阶段 1 —— MVP（建议一次交付）

- [ ] 服务端：`insertExpense` 接受 `id`；`syncExpenseOps()`；`/expenses/sync` 端点；`DELETE` 幂等化
- [ ] `offline.js`：`StorageAdapter`（IndexedDB + Memory）、队列 CRUD、`project()`、同步器（含退避与 401 保全）
- [ ] `ledger.js` 分流；`main.js` 初始化；`offline-ui.js` 指示条 + 行标记
- [ ] `sw.js` 外壳缓存；`manifest.webmanifest` + 图标；`/sw.js` 免缓存
- [ ] 测试：`smoke-offline.test.js`（服务端）+ 同步引擎单测（Memory 适配器）

### 阶段 2 —— 完善

- [ ] 离线**编辑**已同步流水（`base_updated_at` 乐观锁 → `conflict` 走二选一面板）
- [ ] 冲突处置面板（保留本地 / 采用服务端 / 导出）
- [ ] Background Sync 增强（不支持时静默降级）
- [ ] 增量拉取：`GET /api/routes/:id/expenses?updated_since=<ts>`
- [ ] 存储用量与「清理缓存」入口

### 阶段 3 —— 可选

- [ ] 安装引导（`beforeinstallprompt` 自定义 UI）
- [ ] 离线队列的跨设备可见性（不推荐：需服务端存储，破坏「纯客户端队列」的简单性）

---

## 12. 文件清单与责任边界

```
public/
├─ sw.js                      [新增] 应用外壳缓存（不碰 /api/*）
├─ manifest.webmanifest       [新增] PWA 清单
├─ icons/                     [新增] icon-192 / icon-512 / maskable-512
└─ assets/
   ├─ offline.js              [新增] 引擎：存储/队列/缓存/同步器/投影
   ├─ offline-ui.js           [新增] 指示条、同步面板、行标记
   ├─ api.js                  [改动] isNetworkError 导出、超时
   ├─ ledger.js               [改动] 提交分流 + 投影渲染
   └─ main.js                 [改动] SW 注册 + 引擎初始化
server/
├─ app.js                     [改动] /sw.js 与 manifest 免缓存
├─ routes_api.js              [改动] sync 端点、幂等 delete
└─ db.js                      [改动] insertExpense(id)、syncExpenseOps()
tests/
└─ smoke-offline.test.js      [新增] 服务端幂等/批量/降级/幂等删除
```

**`demo/index.html`（单用户 localStorage 版）不在本次范围**：其数据本就在本地，无同步语义；如需一致性，仅在 README 注明「演示版无离线同步概念」。

---

## 13. 测试计划与验收标准

### 13.1 服务端（`tests/smoke-offline.test.js`，沿用既有冒烟脚本风格）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 同一 `id` 重复 POST 两次 | 第二次返回既有记录，`expenses` 总数仍为 1 |
| 2 | 同一 `id` 但金额不同 | `409 ID_CONFLICT`，服务端数据不被覆盖 |
| 3 | 批量 sync：3 笔新增 + 1 笔重复 | `results` 顺序与请求一致；`accepted×3`（含重复判为 `duplicate`）；总数正确 |
| 4 | sync 中付款人已被删除 | `degraded`；该笔 `payer_id=null`、`split_mode='none'`；**Σnet 仍为 0** |
| 5 | sync 中路线已删除 | `rejected: ROUTE_NOT_FOUND`，无副作用 |
| 6 | delete 不存在的流水 | `200 { deleted: 0 }`（幂等） |
| 7 | `ops` 超过 200 | `400 OPS_TOO_MANY` |
| 8 | 伪造 `is_opening` / `owner_id` | 被白名单丢弃，落库值为默认 |
| 9 | 非法 `id` 字符集 | 忽略该 id，服务端自行生成，请求仍成功 |

### 13.2 同步引擎单测（Node + MemoryAdapter，零依赖）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 入队 → 同步成功 | 队列清空，投影恢复为服务端数据 |
| 2 | 网络失败 → 退避 | `attempts` 递增，`next_retry_at` 符合指数退避（±抖动） |
| 3 | 401 → BLOCKED | 队列**长度不变**，状态为 BLOCKED |
| 4 | 新增后离线删除 | 两条 op 同时消失，且**未发起任何网络请求** |
| 5 | `degraded` 结果 | op 移除，触发一次 `degraded` 事件 |
| 6 | 切换服务器 | 队列与缓存按 `server_key` 隔离，互不可见 |

### 13.3 端到端（项目既有 CDP 脚本方式）

用本机 Chromium 内核 + CDP（`--headless`）走一遍：登录 → 打开路线 → **断网** → 记 3 笔 → 观察「待同步 3」→ **恢复网络** → 观察归零且服务端流水 +3 → 再断网重复记同一笔（模拟重放）→ 断言不重复。

### 13.4 验收标准（Definition of Done）

1. 断网状态下连续记 5 笔，恢复网络后服务端**恰好**新增 5 笔（不多不少）。
2. 断网 → 记 1 笔 → 杀掉页面 → 重新打开 → 该笔仍在队列且可同步成功。
3. 同步失败时用户**能看见**待同步数量与原因；`401` 后重新登录能自动继续。
4. 在线/离线切换时，流水列表**顺序不跳动**（投影与服务端排序同口径）。
5. `node tests/run-all.js` 全绿（含新增脚本），且**既有 12 个脚本无回归**。
6. 安卓壳内离线记一笔可用（SW 不可用不影响）。

---

## 14. 风险与开放问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 浏览器在存储压力下清理 IndexedDB | 队列丢失 | `navigator.storage.persist()`；队列非空时 UI 明示「请勿清理浏览器数据」 |
| R2 | 客户端时钟偏差 | `spent_on` 与排序异常 | `spent_on` 由用户选择/本地日期；`created_at` 以服务端时间为准；持久化 `server_time_offset` 供展示 |
| R3 | 用户在多端同时离线记账同一路线 | 顺序与合并歧义 | 阶段 1 接受 LWW 语义；因 owner 隔离，实际概率极低 |
| R4 | 队列积压导致一次 sync 超时 | 同步反复失败 | 单组上限 200，超时 30s，按组独立成败 |
| R5 | 安卓壳内 WebView 被系统回收 | 队列状态丢失 | IndexedDB 已持久化；启动时从存储重建状态（**不要把状态只放内存**） |

**开放问题（需产品决策，实施时按默认值走）**

1. `degraded`（同行人失效）是否需要**强制用户确认**？→ 默认：自动降级 + 事后提示。
2. 冲突（场景 #2）默认保留哪一侧？→ 默认：**保留服务端**，本地版本留档可导出。
3. 离线删除已同步的流水是否开放？→ 默认：**阶段 1 不开放**（避免引入「删除后又被服务端改回」的语义纠缠）。

---

## 15. 实施提示（易错点清单）

1. **幂等键必须在「第一次尝试之前」生成**，而不是在入队时——否则在线直发失败再入队会产生两个 id。
2. **不要在 SW 里拦截 `/api/*`**，否则离线队列与 SW 缓存会形成两套真相。
3. **`recomputeRouteAgg` 在 sync 事务末尾调用一次**，不要逐笔调用（当前 `insertExpense` 是逐笔调用的，批量场景需重构）。
4. **`project()` 的排序必须与服务端 `listExpenses` 同口径**（`spent_on DESC, created_at DESC`），否则列表跳动。
5. **401 绝不能清空队列** —— 这是最容易被写错、后果最严重的一点。
6. **缓存键必须带 `server_key`**，否则切换服务器后读到旧服务器数据。
7. **SW 注册失败必须静默**（安卓壳内必然失败），不得影响主流程。
8. **`/sw.js` 必须免缓存**，否则 SW 更新被 `max-age=300` 拖住。
9. **不要给离线功能放宽任何 CSP 指令**（§10.3 已证明不需要）。
10. **不要复用 `days` 字段名**（项目血泪硬约束），同步 payload 里若需要按天字段一律用 `day_plans`。

---

## 16. 发布影响：能否热更新？是否需要重发 APK？

> 本节结论基于对 `android-app/android/app/src/main/java/com/hanyuestar/travelexpense/MainActivity.java`（原生热更新实现）与 `server/app_bundle.js`（清单/下发端点）的实际代码核实。

### 16.1 结论

| 交付面 | 是否需要重发 APK | 说明 |
|---|---|---|
| **安卓 APP（web 层）** | **不需要** | 全部改动都在 `public/` 下，走既有原生热更新下发 |
| **浏览器 PWA** | 不需要「重装」 | 刷新即得新版；SW 与 manifest 由浏览器自动安装 |
| **服务端** | **必须升级**（Docker 镜像） | 新增 `/expenses/sync` 端点与幂等 id 支持，无法靠客户端绕过 |
| **原生 launcher 图标** | 仅当要改时才需要 | mipmap 属原生资源；本次不动，PWA 图标在 `public/icons/` 可热更新 |

**一句话**：本设计**零原生改动**，因此**不需要用户重新下载 APK**；但**服务端必须先升级**。

### 16.2 热更新机制的实际行为（核实结果）

`MainActivity.checkUpdate()` 的行为：

1. 启动时（`onCreate`）后台线程拉取 `GET /api/app/manifest`；
2. 与本地 `.manifest.json` 的 `version` 比对，不一致才继续；
3. **全量下载**清单内**每一个文件**到 `www-new/`，逐文件 sha256 校验；
4. 把 `TE_BUILTIN_SERVER` 重新注入下载后的 `index.html`；
5. **原子替换**目录（`www` → `www-old` → 新目录 → `www`，失败自动回滚）；
6. `bridge.setServerBasePath()` 热刷新 + Toast「已更新到最新版本」；
7. 任何异常都**保留当前可用版本**，下次启动重试。

**关键推论（对本设计有利）**：

- 清单来自 `appBundle.getManifest()`，它**递归遍历 `public/` 全部文件**并计算 sha256，聚合哈希即 `version`。
  → **新增文件（`sw.js`、`manifest.webmanifest`、`assets/offline.js`、`icons/*`）会自动进入清单并被下发**，无需改动服务端热更新代码。
- 因为是「全量下载 + 原子替换」，**新增/删除文件天然被正确处理**（不存在增量清单的遗漏问题）。
- 下载路径有安全校验（拒绝 `..`、前导 `/`、反斜杠），与本设计新增文件的路径风格一致。

**代价**：全量下载意味着**新增图标会增大每次更新流量**。建议图标总体积控制在 100KB 以内（单色 SVG 转 PNG 即可）。

### 16.3 必须遵守的两条硬约束

#### 约束 A：安卓壳内**不注册 Service Worker**

否则会**掩盖热更新**：原生热更新已把资源根切到新目录，而 SW 仍可能从旧缓存回资源，导致「更新了却没生效」这类极难排查的问题。实现方式见 §9.2.1（`window.Capacitor` 存在时直接跳过注册）。

#### 约束 B：客户端必须做**服务端能力探测与降级**

热更新可能**先于**服务端升级到达用户设备（用户重启 APP 即可拿到新 web 层，而 NAS 上的镜像可能还是旧版）。此时 `/expenses/sync` 会返回 `404`。必须降级：

```js
let syncCapable = null;              // null=未探测, true/false=已探测
async function probeSyncCapability(routeId) {
  if (syncCapable !== null) return syncCapable;
  try {
    // 空 ops 探测：旧服务端 → 404；新服务端 → 200 且 results 为空数组
    const r = await api.post(`/routes/${routeId}/expenses/sync`, { ops: [] });
    syncCapable = !!(r && Array.isArray(r.results));
  } catch (e) {
    syncCapable = !(e && (e.status === 404 || e.status === 405));
  }
  return syncCapable;
}
```

- **支持**：走批量 `/sync`（首选路径）。
- **不支持**（旧服务端只接受逐笔 API、且忽略客户端 `id`）：**不得自动逐笔 POST / DELETE**。旧接口不提供幂等保证，响应丢失后的重放会产生重复流水或不确定删除结果。
  - 若待同步创建 id 已在旧服务端流水中且白名单字段完全一致，可安全判为 `duplicate` 并出队。
  - 其余创建/删除 op 返回本地 `SERVER_UPGRADE_REQUIRED`，标记 `failed` 并保留队列；UI 明示「请先升级服务器」，升级后点击「立即同步」再走批量幂等端点。
  - 这比「假装兼容」更安全：宁可暂缓同步，也不破坏「恰好一次」与数据不丢失保证。
- 探测结果缓存在内存（不持久化），并随切换服务器清空，避免每次同步都多一次请求。

> 该降级路径是**必须实现**的，否则会出现「APP 更新了但记不了账」的严重事故。

### 16.4 建议的发布顺序

```
1. 服务端先行：发布新镜像（含 /expenses/sync 与幂等 id）
      ↓  确认 /health 正常、旧客户端无回归
2. 再让客户端到达：用户重启 APP → 原生热更新拉取新 web 层
      ↓  （浏览器用户刷新即可）
3. 观察：待同步队列是否正常清空、服务端流水数是否恰好增加
```

**回滚策略**：服务端回滚镜像即可；客户端 web 层无法「回滚到旧版」（热更新只前进），因此**新 web 层必须能安全面对旧服务端**（即 §16.3 约束 B：能力探测后阻止非幂等写入并保留队列，待服务器升级后再同步）。这是发布顺序不可颠倒的根本原因。

### 16.5 交付清单的发布面标注

| 文件 | 交付面 | 热更新可达 |
|---|---|---|
| `public/sw.js` | web | ✅（但安卓壳不注册） |
| `public/manifest.webmanifest` | web | ✅ |
| `public/icons/*.png` | web | ✅ |
| `public/assets/offline.js` | web | ✅ |
| `public/assets/offline-ui.js` | web | ✅ |
| `public/assets/{api,ledger,main}.js` | web | ✅ |
| `public/index.html` | web | ✅（注意 `TE_BUILTIN_SERVER` 会被原生重注入，不要手写该脚本） |
| `server/{app,routes_api,db}.js` | **服务端** | ❌ 需更新镜像 |
| `tests/smoke-offline.test.js` | 仓库 | — |
