# 交互原型 · PWA 离线记账

配套设计文档：[`../pwa-offline-design-2026-10-14.md`](../pwa-offline-design-2026-10-14.md)
（该文档是**唯一权威契约**：架构决策、API 契约、冲突策略、实施清单、验收标准均在其中）

> **用途**：评审「离线记一笔 → 恢复网络自动同步」的交互与状态机，并**可交互地**演示四类同步结果
> （接受 / 判为重复 / 自动降级 / 被拒绝）与网络失败退避。
> 纯前端演示，数据在内存中，**刷新即重置**，不连接任何后端、不使用 IndexedDB。

## 打开方式

直接双击 `index.html` 即可（无需服务端、无需构建、无需安装依赖）。

## 建议验证路径

1. 观察初始态：2 条已同步流水、指示条隐藏、队列为空。
2. **在线直发**：点「记一笔」保存 → 观察日志显示「在线直发，未经过队列」。
3. **离线记账**：右上角关掉「在线」→ 再记 2 笔 → 观察
   - 顶部橙色指示条「离线 · 已缓存 N 条流水 · 2 笔待同步」
   - 新行带**虚线边框 + 「待同步」胶囊**，总花费后附「含 2 笔待同步」
   - 点「同步队列」查看队列项（含客户端幂等 id）
4. **恢复网络**：打开「在线」→ 自动同步 → 队列归零、指示条消失、服务端恰好 +2。
5. **幂等**：点「重放上一批（演示幂等）」→ 服务端条数**不变**，日志出现「判为重复（幂等）」。
6. **自动降级**：故障注入选「付款人已不存在」→ 记一笔 → 观察该笔 `payer_id` 置空、
   分摊清空、记为 unassigned（**金额不丢**，Σnet 不变量不被破坏）。
7. **被拒绝**：故障注入选「路线已被删除」→ 记一笔 → 该笔**保留在队列**（状态 failed），
   日志与结果列表均标注 —— 验证「绝不静默丢弃」。
8. **退避重试**：离线记一笔 → 故障注入切「网络失败」→ 打开「在线」→ 观察 attempts 递增与
   「Xs 后重试」倒计时，退避到期后自动重试。
9. **本地消解**：离线记一笔 → **点击那条待同步行**（模拟删除）→ 恢复网络 →
   观察日志「本地消解（未发起任何网络请求）」且服务端条数不变。

## 覆盖范围

| 类别 | 内容 |
|---|---|
| **引擎状态机** | `IDLE` / `SYNCING` / `BACKOFF` 三态与指示条联动；退避 1s→2s→4s→8s |
| **幂等** | 客户端生成 `id`；重放同批判为 `duplicate`，服务端不产生重复数据 |
| **乐观 UI** | 投影列表（服务端缓存 ⊕ 队列）；待同步行虚线 + 胶囊；总花费含待同步提示 |
| **队列** | 队列面板、逐项状态、客户端幂等 id、丢弃操作 |
| **冲突与降级** | `accepted` / `duplicate` / `degraded`（同行人失效降级 unassigned）/ `rejected`（保留队列） |
| **网络异常** | 指数退避、attempts 计数、退避倒计时 |
| **本地消解** | 「新增后即删除」两条一起丢弃，不发网络请求 |
| **提交分流** | 在线直发优先；网络类失败才落入队列（同一 id → 天然幂等） |

## 设计约束

严格复用 `public/styles.css` 的既有元素、组件与颜色，不引入新视觉语言：

| 项 | 做法 |
|---|---|
| 样式来源 | `styles.css` 是 `public/styles.css` 的**逐字节副本**（已校验一致） |
| 复用组件 | `.panel` `.kv` `.led` `.led-day` `.chip` `.pill` `.mask` `.sheet` `.field` `.btn*` `.banner` `.toast` `.switch` `.hint` `.mono` `.empty` |
| 颜色 | 全部走既有 CSS 变量（`--primary` `--danger` `--accent` `--line` `--muted`…）；类目色沿用 `charts.js` 的 `COLORS` |
| 新增样式 | 仅集中在 `proto.css`，**不覆盖任何既有类**，文件末尾附「落地合并说明」 |
| 依赖 | 零新增（无框架、无构建、无 IndexedDB） |

## 真机验证

```bash
node verify-prototype.js        # 42 条断言，全绿
# 未装 Playwright 内核时可用 CHROME_BIN 指定：
CHROME_BIN="/c/Program Files/Google/Chrome/Application/chrome.exe" node verify-prototype.js
```

- 方式：复用本机 Chrome/Chromium 内核 + CDP 协议直连（Node 22 内置 `WebSocket`，**零依赖**）
- 交互一律走**真实 UI 路径**（点按钮、填表单），断言只读 `window.__proto` 暴露的状态 ——
  避免「测的是函数而不是界面」
- 截图：`shots/01-initial.png` … `shots/09-local-resolve.png`

| 分组 | 断言数 | 覆盖 |
|---|---|---|
| A 初始态 | 4 | 渲染、队列空、指示条隐藏、无待同步行 |
| B 在线直发 | 3 | 服务端 +1、**不产生队列项**、界面同步 |
| C 离线记账与自动同步 | 12 | 离线条、入队、投影、虚线行、计数、队列面板、恢复网络自动同步、**服务端恰好 +2** |
| D 幂等重放 | 3 | 重放后条数不变、日志「判为重复」、结果含 duplicate |
| E 同行人失效降级 | 5 | 数据未丢、payer 置空、parts 清空、split_mode=none、结果含 degraded |
| F 路线已删除 | 4 | **队列保留**、状态 failed、结果含 rejected、指示条仍提示 |
| G 网络失败退避 | 5 | 入队、pending 保留、attempts 递增、退避时刻、日志含「退避」 |
| H 本地消解 | 5 | 新增后即删、队列清空、**服务端未新增**、日志含「本地消解」 |
| I 健壮性 | 1 | 全流程无未捕获 JS 错误 |

## 文件清单

| 文件 | 说明 |
|---|---|
| `index.html` | 交互原型主体（内联演示数据、模拟服务端与同步引擎） |
| `styles.css` | `public/styles.css` 逐字节副本 |
| `proto.css` | 仅新增组件样式 + 落地合并说明 |
| `verify-prototype.js` | 真机验证脚本（42 条断言，可重复运行） |
| `icon.svg` | PWA 图标设计源（用于生成 192/512/maskable PNG） |
| `shots/` | 9 张界面截图留档 |

## 与原型的边界（重要）

本原型**模拟**了服务端行为，落地时由真实服务端承担：

| 原型内 | 落地时 |
|---|---|
| `S.server`（内存数组） | `expenses` 表 + `recomputeRouteAgg()` |
| `applyCreate()` 内的重复/降级判定 | 服务端 `syncExpenseOps()`（设计文档 §6.2） |
| `S.queue`（内存数组） | IndexedDB `queue` 对象仓（设计文档 §4.1） |
| `sleep()` 模拟网络延迟 | 真实 `fetch` + 超时与 `AbortController` |
| 无持久化 | IndexedDB + `navigator.storage.persist()` |

**原型未覆盖**（属阶段 2，见设计文档 §11）：离线编辑已同步流水、冲突处置面板、
Background Sync、增量拉取、Service Worker 外壳缓存。

## 图标（`icon.svg`）

设计源复用页头 logo 的纸飞机路径（`M3 11l19-9-9 19-2-8-8-2z`），底色为项目主色渐变
（`#15a98c → #1cc3a3`）。文件内有两个图层：

- `#standard` —— 常规图标（圆角方形底，图形满幅），用于 `icon-192.png` / `icon-512.png`
- `#maskable` —— 安全区版本（图形缩到 60% 居中），用于 `maskable-512.png`
  （Android 会按系统形状裁切，满幅图形会被切掉边缘）

栅格化（实施时执行，任选其一；注意 `#maskable` 图层默认 `display:none`，需先生成再切换）：

```bash
# 方案一：sharp-cli（Node）
npx -y sharp-cli -i icon.svg -o public/icons/icon-512.png resize 512 512
npx -y sharp-cli -i icon.svg -o public/icons/icon-192.png resize 192 192

# 方案二：ImageMagick
magick -background none icon.svg -resize 512x512 public/icons/icon-512.png
magick -background none icon.svg -resize 192x192 public/icons/icon-192.png
```

> 图标总体积建议控制在 100KB 以内 —— 安卓热更新是**全量下载** `public/` 下所有文件，
> 图标过大会抬高每次更新的流量（详见设计文档 §16.2）。

## 维护提示

- 修改 `index.html` 后请重跑 `verify-prototype.js`，确认 42 条断言仍全绿。
- `styles.css` 必须与 `public/styles.css` 保持逐字节一致；后者变更时同步覆盖：
  `cp public/styles.css deliverables/proto-pwa-offline/styles.css`
