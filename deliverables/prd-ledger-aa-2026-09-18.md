# PRD · 逐笔消费流水 + AA 分账（travel-expense）

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0（草案，待评审） |
| 日期 | 2026-09-18 |
| 目标版本 | **v1.1.0**（新增能力，向后兼容，无需数据迁移） |
| 关联原型 | `deliverables/proto-ledger-aa/index.html`（真机 41 条断言全绿） |
| 状态 | **待确认**——请先评审可行性与交互，确认后再进入实现 |
| 影响面 | 新增 3 张表 + 1 个字段；既有统计 / 导出 / 分享链路**零改动** |

---

## 0. 结论先行

1. **能力缺口在数据层**：`routes` 表只有 9 个聚合金额列（`exp_traffic`…`exp_other`），既无逐笔明细，也无「同行人」实体。因此「哪天花超了」「哪笔最贵」「谁该付谁多少」在现有结构下**无法回答**，只能事后一次性填 9 个总数。
2. **实现路径的关键是「物化聚合」**：`expenses` 明细表为真源，`routes.exp_*` 退化为**由流水同事务回写的物化聚合值**。这样统计接口 `/api/routes/stats/*`、CSV/JSON 导出导入、只读分享页、9 类明细展示**全部不需要改动**，风险面极小。
3. **模式可开关、可回退**：以 `routes.ledger_mode` 控制「手动汇总 / 逐笔流水」两态。开启时保留现有 9 列现值、关闭时把聚合值回写为手动值，**流水数据永不因切模式而删除**，不存在迁移失败导致数据丢失的路径。

---

## 0.1 实施记录（2026-09-20 更新）

本文档原为**设计稿**。实际实施时按评审意见与工程约束做了 4 处调整，**以下以实施为准**：

| # | 设计稿 | 实际实施 | 原因 |
|---|---|---|---|
| 1 | `routes.ledger_mode` 双态开关（手动汇总 / 逐笔流水），表单 9 类输入在流水模式下只读 | **取消模式开关**：一律为流水口径，不设任何切换入口与按钮；路线表单**移除** 9 类花费输入格，改为「由逐笔流水自动汇总」提示 + 「去记流水」直达 | 用户评审意见：统一一种模式，避免双态带来的认知与数据口径负担 |
| 2 | 「手动 → 流水」由用户点按钮触发；不自动生成期初流水 | **首次启动自动迁移**：`migrateAggregatesToOpening()` 把所有已有路线的 9 类金额转为「期初（历史数据）」流水（`split_mode='none'`、无付款人、幂等） | 取消开关后必须保证老数据金额与统计口径不变，且不应让用户逐个手工处理 |
| 3 | 结算：`Σpaid == Σowed`（含本人自付部分） | **修正为账恒平**：无付款人的流水（期初 / 未指定）**整体排除**在结算之外并计入 `unassigned`；`split_mode='none'` 由付款人自担并计入 `self_borne`；`net = paid − (owed + selfBorne)`，保证 **Σnet = 0** | 原设计在存在自付/期初时会出现 Σnet ≠ 0（账不平），转账方案无法收敛 |
| 4 | AI 规划仅产出按天行程 | **AI 规划同时产出「注意事项」与「美食推荐」**，结构化解析为 `{scenic, notes}`；行程 → 景点路线，提示 + 美食 → 备注（已有内容则追加、幂等不重复）；AI 调整亦支持增量更新备注 | 用户新增需求：把路线注意事项与美食推荐落到备注 |

**实测结论（实施后）**：
- 全量回归 **9 个脚本全绿**（新增 `tests/smoke-ledger.test.js` 56 条、`tests/smoke-ai.test.js` 39 条，后者用本地 OpenAI 兼容 mock，无需真实密钥）
- 正式前端真机 CDP 端到端 **35 条断言全绿**；单用户演示版 `demo/index.html` **21 条断言全绿**
- 原 14.2 的 5 个冲突点已全部落地处理：`ledger_mode` 不复存在（C1 消失）；`updateRoute` **不再写入 `exp_*`**（由 `recomputeRouteAgg()` 独占维护，C3 的「PUT 清空聚合值」路径被彻底关闭）；前端不再提交 `exp`（C2/C4 保持既有 `exp` 嵌套契约不变）

> 未实施项：`expense_parts.weight`（按份数分摊）仍为预留字段，未暴露 UI。

### 发布验证（2026-09-20）

| 项 | 结果 |
|---|---|
| 代码 | main `375af36`（本地与远端一致）；wiki `6b10bc4` |
| 全量回归 | `node tests/run-all.js` → **9 个脚本全绿** |
| 正式前端真机 CDP | **35 条断言全绿**（含「页面无任何模式切换」专项断言） |
| 演示版真机 CDP | **21 条断言全绿** |
| Docker 镜像 | `v1.1.0` 已发布至 **ghcr.io/kyson-666/travel-expense** 与 **kyson666/travel-expense**，`linux/amd64 + linux/arm64` 双架构，`latest` 已指向 v1.1.0 |
| GitHub Release | `v1.1.0`（id `392280916`），附件 `app-debug.apk`（3,862,047 字节）已上传 |
| APK 工作流 | `Build Android APK` → success |

---

## 1. 背景与问题定义

### 1.1 现状（已核验）

| 项 | 现状 |
|---|---|
| 花费粒度 | `routes` 表 9 列聚合值（`server/db.js:63-65`），`EXP_KEYS`/`EXP_COL` 见 `db.js:11-13` |
| 同行人 | 仅 `routes.people` 一个整数，无名单实体 |
| 汇聚链路 | `totalOf()` 前端汇总（`charts.js:15`）、`/api/routes/stats/summary`+`/trend`（服务端本位币聚合）、CSV 导出（`routes_api.js:200`）、管理员全站导出（`admin_api.js:277`）、分享页服务端渲染（`app.js:176`） |
| 分类唯一来源 | 前端 `CATS`（`api.js:150`）须与后端 `EXP_KEYS`（`db.js:11`）同步 |

### 1.2 缺口与影响

| 用户诉求 | 现状表现 | 影响 |
|---|---|---|
| 「这 13680 是怎么花出去的？」 | 只能看到 9 个总数 | 复盘时无法定位异常，记账变成「填表」 |
| 「哪天花超了？」 | 无日期维度 | 无法做日均/超支归因 |
| 「小王该给我多少钱？」 | 无付款人/分摊概念 | 多人出行必须另外用计算器或第三方 App，数据割裂 |
| 「这笔是为谁花的？」 | 无从表达 | 只能全按人均摊，个体差异（如仅 2 人去的景点）无法体现 |

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 成功判据 |
|---|---|---|
| G1 | 可按笔记录消费（日期 / 类目 / 金额 / 事项 / 备注） | 一条路线可录入 ≥1 笔流水并列表回看、编辑、删除 |
| G2 | 9 类金额由流水自动汇总，与既有统计口径一致 | 流水汇总值 == `/stats/summary` 的分类值 == 卡片/详情/CSV 数值 |
| G3 | 支持同行人名单与「谁付 / 谁分摊」 | 每人实付、应分担、差额可算且闭合 |
| G4 | 给出可直接执行的结算方案 | 转账笔数 ≤ 人数−1，金额合计等于应收差额 |
| G5 | 不破坏任何既有能力 | 既有 7 个测试脚本全绿；无流水路线行为与现在完全一致 |

### 2.2 非目标（本期明确不做）

| # | 不做 | 原因 / 去向 |
|---|---|---|
| N1 | 票据/发票图片上传 | 需引入文件存储与体积治理，独立立项（附录 C-1） |
| N2 | 逐笔多币种 + 逐笔汇率 | 本期沿路线币种；逐笔换算需历史汇率快照，成本高（附录 C-2） |
| N3 | 按份数/百分比差异化分摊 | 仅在 `expense_parts.weight` **预留字段**，不暴露 UI |
| N4 | 多用户协同编辑同一路线 | 涉及权限模型重构，独立立项（附录 C-3） |
| N5 | 真正的「已结清」状态流转 | 本期只出方案，不做状态机与凭证（附录 C-4） |
| N6 | 修改 `people` 字段语义 | 保持只读展示 + 不一致提示，不自动改写用户输入 |

---

## 3. 核心设计决策

### D1 · 物化聚合（决定整个方案的风险面）

`expenses` 为明细真源；`routes.exp_*` 为**物化聚合**，在流水增删改的同一事务内回写。

```
expenses(明细)  --同事务回写-->  routes.exp_* (物化聚合)  -->  既有全部下游链路(零改动)
```

- 回写实现：`AGG(f)` 辅助函数（9 类各 `SUM(amount)`，按 `route_id` 分组），写流水后调用一次。
- 收益：`totalOf()`、`/stats/*`、CSV/JSON 导出、管理员导出、分享页、9 类明细、预算条**全部不感知流水表**。
- 代价：聚合值可能与明细短暂不一致（极端并发）；用 `better-sqlite3` 的同步事务 + `BEGIN IMMEDIATE` 规避。

### D2 · 非破坏性模式开关

| 动作 | 行为 |
|---|---|
| 开启（manual → ledger） | 现有 9 列值**原样保留**在 `routes.exp_*`；`ledger_mode=1`；UI 上 9 类输入框转为只读（标注「由 N 笔流水汇总」） |
| 关闭（ledger → manual） | 把当前聚合值回写为手动值（数据等价）；`ledger_mode=0`；**流水行保留不删**，再次开启即恢复 |
| 既有数据 | 默认 `ledger_mode=0`，升级后行为与现在**完全一致** |

> 反向迁移（降级到旧版本）：旧代码只读写 `routes.exp_*`，天然忽略新表与新字段，可直接回滚镜像。

### D3 · 分摊语义三态

| 态 | 存储 | 语义 | 参与 AA 计算 |
|---|---|---|---|
| 全员平分 | `split_mode='equal'`，`parts` = 全部同行人 | 默认 | ✅ 每人 `amount/n` |
| 部分人分摊 | `split_mode='equal'`，`parts` ⊊ 名单 | 如「仅 2 人去的景点」 | ✅ 每人 `amount/len(parts)` |
| 纯记录（不参与分摊） | `split_mode='none'`，`parts` 为空 | 如「我自己买的特产」 | ❌ 只计实付，不产生任何人的应分担 |

> 三态在 UI 上分别呈现为「N 人平分 / N 人分摊 · 非全员 / 未选择分摊人（橙色告警）」，避免把两种「自付」混为一谈。

### D4 · 人均分母口径

`人均 = 总额 / N`，其中 `N` 优先取**同行人名单长度**，名单为空时回退 `routes.people`。

- 名单与 `people` 不一致时，**仅提示不自动改**（`同行人` 弹层显示「6 人（与人数不一致）」）。
- 理由：`people` 是用户手输的业务值，静默改写会造成「我明明填了 4」的困惑。

---

## 4. 数据模型

### 4.1 关系

```
users(1) ──< routes(1) ──< travelers(1) ──< expense_parts
                            └──< expenses ──┘
                   └── exp_traffic...exp_other（物化聚合，见 D1）
```

### 4.2 DDL（沿用 `db.js` 既有风格：`CREATE TABLE IF NOT EXISTS` + `addColumn` 幂等迁移）

```sql
/* 路线新增模式开关（幂等：加入 db.js:118-126 的 addColumn 列表，兼容老库） */
ALTER TABLE routes ADD COLUMN ledger_mode INTEGER NOT NULL DEFAULT 0;   -- 0=手动汇总 1=逐笔流水

/* 同行人 */
CREATE TABLE IF NOT EXISTS travelers (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,        -- 记账人本人（每路线至多 1 个）
  linked_user_id INTEGER,                    -- 可选：关联本系统账号（本期不用）
  sort_no INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_travelers_route ON travelers(route_id);

/* 流水 */
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  spent_on TEXT NOT NULL,                    -- YYYY-MM-DD
  category TEXT NOT NULL,                    -- 必须 ∈ EXP_KEYS（服务端校验）
  amount REAL NOT NULL DEFAULT 0,            -- 原币金额（与 routes.currency 一致）
  currency TEXT DEFAULT 'CNY',               -- 快照路线币种（路线改币种时不影响历史笔）
  title TEXT,                                -- 事项/商户
  note TEXT,
  payer_id TEXT,                             -- 付款人 → travelers.id
  split_mode TEXT NOT NULL DEFAULT 'equal',  -- equal | none
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payer_id) REFERENCES travelers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_route_day ON expenses(route_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_expenses_route_cat ON expenses(route_id, category);

/* 分摊参与人 */
CREATE TABLE IF NOT EXISTS expense_parts (
  expense_id TEXT NOT NULL,
  traveler_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,            -- 预留：按份数分摊（本期恒为 1，不暴露 UI）
  PRIMARY KEY (expense_id, traveler_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (traveler_id) REFERENCES travelers(id) ON DELETE CASCADE
);
```

### 4.3 关键字段说明

| 表.字段 | 类型 | 必填 | 校验 / 默认 | 说明 |
|---|---|---|---|---|
| `routes.ledger_mode` | INT | 是 | 默认 0 | 0=手动 9 类汇总（与现状一致）；1=由流水派生 |
| `expenses.spent_on` | TEXT | 是 | `YYYY-MM-DD`，正则校验 | 允许落在行程日期之外（如提前买的机票），仅提示不阻断 |
| `expenses.category` | TEXT | 是 | 必须 ∈ `EXP_KEYS` | 越界 → `400 INVALID_CATEGORY` |
| `expenses.amount` | REAL | 是 | `> 0`，最多 2 位小数 | 0 或负数 → `400 INVALID_AMOUNT` |
| `expenses.currency` | TEXT | 否 | 默认继承 `routes.currency` | 快照，避免路线改币种后历史笔被重新换算 |
| `expenses.payer_id` | TEXT | 否 | 必须属于同路线 travelers | 付款人被删 → `SET NULL`，结算时按「未指定付款人」单独提示 |
| `expenses.split_mode` | TEXT | 是 | `equal` / `none` | 见 D3 |
| `expense_parts.weight` | REAL | 是 | 默认 1 | 本期不用，为「按份数分摊」预留 |

### 4.4 `routes.exp_*` 的角色变化

| 状态 | 角色 | 写入者 |
|---|---|---|
| `ledger_mode=0` | **唯一真源**（手动输入） | 用户（现有表单） |
| `ledger_mode=1` | **物化聚合**（派生只读） | 服务端（流水增删改后同事务回写） |

---

## 5. 结算算法规格

### 5.1 输入 / 输出

- **输入**：某路线的 `travelers` 名单 + `expenses`（含 `payer_id` / `split_mode` / `parts`）
- **输出**：`rows[{ traveler, paid, owed, net }]` + `transfers[{ from, to, amount }]`

### 5.2 计算步骤

1. 初始化 `paid[t]=0`、`owed[t]=0`
2. 遍历每笔流水（金额 `a`）：
   - `paid[payer] += a`（付款人不在名单时忽略并计入 `unassigned` 计数）
   - `split_mode='none'` → **跳过**（纯记录，不产生应分担）
   - 否则 `owed[p] += a / len(parts)`（`parts` 为空则视为全员）
3. `net[t] = paid[t] − owed[t]`
4. **贪心配对**：`net>0` 为债权人、`net<0` 为债务人，各按金额降序，最大债务人 → 最大债权人，冲抵至一方归零

### 5.3 伪码

```js
function settle(routeId) {
  const ts = travelers(routeId);
  const paid = {}, owed = {};
  ts.forEach(t => { paid[t.id] = 0; owed[t.id] = 0; });

  for (const e of expenses(routeId)) {
    if (paid[e.payer_id] !== undefined) paid[e.payer_id] += e.amount;
    if (e.split_mode === 'none') continue;              // 纯记录：只计实付
    const parts = e.parts.length ? e.parts : ts.map(t => t.id);
    const per = e.amount / parts.length;
    parts.forEach(id => { if (owed[id] !== undefined) owed[id] += per; });
  }

  const rows = ts.map(t => ({ ...t, paid: paid[t.id], owed: owed[t.id], net: paid[t.id] - owed[t.id] }));

  // 贪心：笔数 ≤ 人数 − 1
  const C = rows.filter(r => r.net >  0.005).map(r => ({ ...r, v:  r.net })).sort((a,b) => b.v - a.v);
  const D = rows.filter(r => r.net < -0.005).map(r => ({ ...r, v: -r.net })).sort((a,b) => b.v - a.v);
  const transfers = [];
  for (let i = 0, j = 0; i < C.length && j < D.length; ) {
    const m = Math.min(C[i].v, D[j].v);
    if (m > 0.005) transfers.push({ from: D[j].id, to: C[i].id, amount: m });
    C[i].v -= m; D[j].v -= m;
    if (C[i].v < 0.005) i++;
    if (D[j].v < 0.005) j++;
  }
  return { rows, transfers };
}
```

### 5.4 精度规则

| 规则 | 取值 |
|---|---|
| 计算精度 | 全量用浮点累加，**仅在展示与冲抵判定时**以「分」为阈值 |
| 冲抵阈值 | `0.005`（半分）——小于此值的差额视为已平 |
| 展示 | 金额四舍五入到分（沿用 `fmt()` 的 `toLocaleString('zh-CN')`） |
| 余差处理 | 贪心结束时若仍有 `|残差| < 0.01`，吸收进最后一笔转账，**不产生 1 分钱孤儿转账** |
| 已知局限 | 不使用记账本位币的最小单位（如 JPY 无小数），本期统一按 2 位小数处理并在文档标注 |

### 5.5 示例（对应原型内置数据，可逐项核对）

4 人 · 13 笔 · 总额 ¥13,680（其中 1 笔 ¥1,350 仅我承担、1 笔 ¥280 两人分摊）

| 同行人 | 实付 | 应分担 | 差额 |
|---|---|---|---|
| 我（Kyson） | ¥8,530 | ¥4,502.50 | **+¥4,027.50** |
| 阿May | ¥980 | ¥3,152.50 | −¥2,172.50 |
| 老陈 | ¥1,850 | ¥3,012.50 | −¥1,162.50 |
| 小王 | ¥2,320 | ¥3,012.50 | −¥692.50 |

结算方案（3 笔 = 4−1，已由原型断言 C3/C4 验证）：
阿May → 我 ¥2,172.50；老陈 → 我 ¥1,162.50；小王 → 我 ¥692.50

### 5.6 不变量（应作为测试断言）

| # | 不变量 |
|---|---|
| I1 | `Σ paid == Σ amount`（全部流水金额之和；`payer` 缺失的笔除外，需单独暴露） |
| I2 | `Σ net == 0`（阈值内） |
| I3 | `Σ transfers.amount == Σ |net| / 2 == Σ 债权额` |
| I4 | `transfers.length ≤ 人数 − 1` |
| I5 | 仅当存在 `split_mode='none'` 时 `Σ paid ≠ Σ owed`，其差额 == 纯自付总额 |

---

## 6. 接口契约

### 6.1 通用约定（沿用既有实现）

| 项 | 约定 | 依据 |
|---|---|---|
| 响应 | `ok(res,d)` → 200 `{ok:true,data}`；`created(res,d)` → 201；`fail(res,c,msg,extra)` → `{ok:false,msg,...}` | `server/http.js:4-14` |
| 鉴权 | 未登录 → `401 {code:'UNAUTHORIZED'}` | `routes_api.js:74` |
| 归属 | 非本人且非可见 → **`404 路线不存在`**（不泄露存在性）；可见但无权写 → `403 {code:'FORBIDDEN'}` | `routes_api.js:248-291` |
| 示例数据 | `is_seed=1` 且非管理员 → `403 示例路线为系统数据，仅可查看` | `routes_api.js:279` |
| 写防护 | 全部写操作经 `sameOrigin()` 同源校验 → `403 {code:'BAD_ORIGIN'}` | `app.js:94,134` |
| 挂载点 | 复用 `/api/routes/*` 前缀，落在 `routes_api.js` 的 `rest` 分发链内，**不新增顶层路由** | `routes_api.js:77` |

### 6.2 同行人接口

| 方法 | 路径 | 入参 | 出参 `data` | 权限 |
|---|---|---|---|---|
| GET | `/api/routes/:id/travelers` | — | `{list:[{id,name,is_self,sort_no}]}` | owner / admin（seed 只读可 GET） |
| POST | `/api/routes/:id/travelers` | `{names:string[]}` | `{list:[...]}` | owner / admin |
| PATCH | `/api/routes/:id/travelers/:tid` | `{name?, sort_no?}` | `{traveler}` | owner / admin |
| DELETE | `/api/routes/:id/travelers/:tid` | `?force=1` | `{ok:true, affected:number}` | owner / admin |

- `POST` 支持批量（`names` 逐项 `trim`、去重、空串忽略），一次最多 50 个。
- `DELETE` 若该同行人已被流水引用（`payer_id` 或 `expense_parts`）：
  - 默认 `409 {code:'TRAVELER_IN_USE', affected:n}`，前端弹确认；
  - 带 `force=1` 时执行：`payer_id` 置 NULL、删除相关 `expense_parts` 行（该笔退化为「未指定分摊」并计入 `unassigned`）。

### 6.3 流水接口

| 方法 | 路径 | 入参 | 出参 `data` | 权限 |
|---|---|---|---|---|
| GET | `/api/routes/:id/expenses` | `?category=&from=&to=&payer=&page=&pageSize=` | `{list:[expense], total, page, pageSize, summary:{count,amount,byCategory}}` | owner / admin |
| POST | `/api/routes/:id/expenses` | `{spent_on,category,amount,title?,note?,payer_id,split_mode,parts:string[]}` | `expense` | owner / admin |
| PATCH | `/api/routes/:id/expenses/:eid` | 同上（局部） | `expense` | owner / admin |
| DELETE | `/api/routes/:id/expenses/:eid` | — | `true` | owner / admin |
| POST | `/api/routes/:id/expenses/bulk-delete` | `{ids:string[]}` | `{deleted:n}` | owner / admin |
| GET | `/api/routes/:id/settle` | — | `{rows, transfers, summary:{paid,owed,not_split,unassigned}}` | owner / admin |
| POST | `/api/routes/:id/ledger-mode` | `{mode:0\|1}` | `{ledger_mode, exp}` | owner / admin |

`expense` 序列化形态：

```json
{
  "id": "e_k9x2a1", "spent_on": "2026-07-12", "category": "门票", "amount": 640,
  "currency": "CNY", "title": "塔尔寺+青海湖", "note": "",
  "payer_id": "t1", "payer_name": "我（Kyson）",
  "split_mode": "equal", "parts": ["t1","t2","t3","t4"], "updated_at": 1789000000000
}
```

**写流水的事务边界**（关键）：

```
BEGIN IMMEDIATE
  INSERT/UPDATE/DELETE expenses (+ expense_parts 全量覆盖)
  UPDATE routes SET exp_<cat> = (SELECT SUM(amount) FROM expenses
                                 WHERE route_id=? AND category=?) , updated_at=?
COMMIT
```

### 6.4 既有接口的增量变更（向后兼容）

| 接口 | 变更 | 兼容性 |
|---|---|---|
| `GET /api/routes` | 列表项新增 `ledger_mode`、`expense_count` | 纯新增字段，旧前端忽略 |
| `GET /api/routes/:id` | 同上 | 同上 |
| `GET /api/routes/export?fmt=csv` | **不动**（仍导出 `exp_*` 聚合值） | 完全兼容 |
| `POST /api/routes/import` | 白名单 `ROUTE_FIELDS`（`routes_api.js:25`）**不含流水**；导入不产生流水 | 完全兼容 |
| `POST /api/routes` 新建 | 请求体可带 `ledger_mode`（默认 0） | 可选字段 |
| `GET /share/:token` | **一期不动**；二期可选追加「流水摘要 + 结算」只读区块 | 一期无影响 |

> **导入导出不含流水是刻意取舍**：JSON 备份要能完整还原则需扩展格式（`{routes, travelers, expenses}`）。本期为保证 `import` 的去重逻辑（名称+年份+目的地）与 CSV 契约不被破坏，**流水暂不参与备份**，在 PRD 与 UI 上明确标注「流水请在数据库备份中留存」。二期再扩展（附录 C-2）。

---

## 7. 交互设计

> **硬约束（用户要求）**：页面元素一律复用现有组件与颜色，不引入新视觉语言。原型已按此实现，见 7.3 映射表。

### 7.1 信息架构

```
工作台（现有）
└── 路线卡（现有 .card）
    ├── [新增] 徽标「流水 N 笔」          复用 .pill.pill-ok
    ├── [新增] 「我实付/应分担/收回」一行   复用 .tv-row（原型新增，仅 1 类）
    └── [新增] 卡片按钮「＋ 记一笔」        复用 .btn.btn-sm.btn-line
└── 路线详情弹层（现有 #detailMask）
    └── [新增] 三页签 概览 / 流水 / 结算    复用 .tabs/.tab/.tab.active（登录页同款）
        ├── 概览：现有 detail-row + 模式开关提示（复用 .banner）
        ├── 流水：筛选 chips（复用 .chip）+ 日期分组列表 + 汇总面板（复用 .panel/.kv）
        └── 结算：表格（复用 .table-wrap/.tbl）+ 转账卡（复用 .card 语言）
    └── [新增] 弹层「记一笔」（#expMask）     复用 .mask/.sheet/.field/.chip-row/.exp-grid
    └── [新增] 弹层「同行人」（#tvMask）      复用 .mask/.sheet/.kv/.chip-row/.code-row
```

### 7.2 导航与入口

| 入口 | 位置 | 显隐条件 |
|---|---|---|
| 三页签 | 路线详情弹层顶部 | `ledger_mode=1` 才显示「结算」页签 |
| ＋ 记一笔 | ① 卡片操作区 ② 详情底部操作区 | 仅 `ledger_mode=1` |
| 同行人 | 详情底部操作区（流水页签下） | 仅 `ledger_mode=1` |
| 开启逐笔记账 | 概览页 `.banner` 内 | 仅 `ledger_mode=0` |
| 退出流水模式 | 概览页 `.banner` 内 | 仅 `ledger_mode=1` |

### 7.3 组件复用映射表（新元素 → 现有组件/变量）

| 新 UI 元素 | 复用的现有类 | 定义位置 |
|---|---|---|
| 三页签切换 | `.tabs` / `.tab` / `.tab.active` | `styles.css:163-166`（登录/注册页同款） |
| 类目选择、付款人、分摊人、金额快捷 | `.chip-row` / `.chip` / `.chip.active` | `styles.css:104-107` |
| 弹层容器（记一笔 / 同行人） | `.mask` / `.sheet` / `.sheet h2` / `.close-x` / `.sheet-actions` | `styles.css:128-152` |
| 表单字段 | `.field` / `.field label` / `.field .hint` / `.exp-grid` | `styles.css:136-140` |
| 流水汇总块 / 结算块 | `.panel` / `.panel h3` / `.kv` | `styles.css:114-116, 216-219` |
| 结算明细表 | `.table-wrap` / `.tbl` | `styles.css:193-199` |
| 状态徽标（流水 N 笔） | `.pill` / `.pill-ok` | `styles.css:202-206` |
| 卡片上的分类彩色条 | `.minibar` + `COLORS[cat]` | `styles.css:92-93` / `charts.js:7-10` |
| 类目色块（列表左侧） | `COLORS[cat]` | `charts.js:7-10` |
| 预算进度条 | `.budget-bar`（**补齐缺失样式**，见附录 B） | `proto.css` |
| 金额输入（大号） | 新 `.amt-input`，内部复用 `input` 基础样式与 `:focus` 主色描边 | `styles.css:100-103` |
| 同行人头像 | **复用已定义未使用的 `--c0`…`--c8`** | `styles.css:7-8` |
| 主色 / 危险色 / 强调色 | `--primary` / `--primary-d` / `--primary-l` / `--danger` / `--accent` / `--line` / `--muted` | `styles.css:3-8` |
| 提示 / 告警条 | `.banner`（黄）/ `.split-hint`（绿）/ `.split-hint.warn`（红，复用 `--danger` 语义） | `styles.css:175-176` / `proto.css` |
| 轻提示 | `.toast` | `styles.css:227-230` |

**颜色语义约定（与项目既有语义一致，不引入新含义）**

| 语义 | 用色 | 与既有对齐 |
|---|---|---|
| 应收（别人欠我） | `--primary` 绿 | 同 `.stat .v` 正向数值 |
| 应付 / 超支 | `--danger` 红 | 同 `budgetBar()` 超支与 `.pill-ban` |
| 预算进度 | `--accent` 蓝（未超）/ `--danger` 红（超支） | 完全沿用 `app.js:233` |
| 分类 | `COLORS[cat]` 9 色 | 完全沿用环形图/迷你条 |
| 同行人 | `--c0`…`--c8` 循环 | 复用既有变量，避免新增色板 |

### 7.4 关键界面说明

| 界面 | 要点 |
|---|---|
| **路线卡** | 徽标「流水 N 笔」；新增一行「我实付 X · 应分担 Y（收回/需补 Z）」；「＋ 记一笔」直达记账（无需先进详情） |
| **概览** | 与现状 100% 一致；仅追加 `.banner` 说明「9 类金额由 N 笔流水自动汇总（只读）」+ 退出按钮。无流水时 banner 换成「开启逐笔记账」 |
| **流水** | 顶部 chips 筛选（仅列出实际用到的类目，减少噪音）；日期倒序分组，组头显示当日小计；每行：类目色块 + 事项 + 「类目 · 谁付 · 分摊口径」+ 金额；点击行直接进编辑 |
| **记一笔** | 金额大号输入 + 快捷金额（50/100/200/500/1000）；类目 chips（带色块）；日期（默认行程首日）；付款人单选 chips（带头像）；分摊人多选 chips + 全选/清空 + **实时人均提示条**；备注 |
| **结算** | 上：每人实付/应分担/差额表（差额绿涨红降）；下：「最少转账方案 共 N 笔」列表；底部口径脚注（含 `Σpaid ≠ Σowed` 时的差额解释） |
| **同行人** | 显示「同行人数（路线字段）vs 已登记名单」两行 + 不一致提示；输入框支持逗号/空格批量添加；名单 chips 带 × 移除（被引用时二次确认） |

### 7.5 状态与空态文案

| 场景 | 文案 |
|---|---|
| 无流水 | `还没有流水，记下第一笔吧 ✈` + 「＋ 记一笔」 |
| 未开启流水模式 | `该路线尚未开启逐笔记账。` + 「开启逐笔记账」 |
| 筛选无结果 | `该分类下暂无流水` |
| 无同行人 | `请先在「同行人」里登记名单，才能做 AA 结算` |
| 账已平 | `账已平，无需转账 🎉` |
| 0 位分摊人 | `⚠ 未选择分摊人：这笔将不计入任何人的应分担（仅记录实付）` |
| 实时人均 | `N 人平分，每人 ¥X · 由 {付款人} 垫付` |

### 7.6 移动端

- 详情弹层在 <560px 时为底部抽屉（`.mask` 既有行为），三页签横向等分自适应。
- 「记一笔」内容较长（约 1.5 屏），依赖 `.sheet` 既有 `overflow-y:auto`；**保存按钮随内容滚动**，一期不做吸底（保持与现有表单一致）。
- 快捷金额与类目 chips 均为 ≥40px 触控目标（沿用 `.chip` 的 `min-height:40px`）。

---

## 8. 权限矩阵

| 操作 | 本人路线 | 他人路线 | 示例路线（`is_seed=1`） | 管理员 |
|---|---|---|---|---|
| 查看流水 / 结算 | ✅ | ❌ 404 | ✅ 只读 | ✅ |
| 新增 / 编辑 / 删除流水 | ✅ | ❌ 404 | ❌ 403 | ✅ |
| 管理同行人 | ✅ | ❌ 404 | ❌ 403 | ✅ |
| 开 / 关流水模式 | ✅ | ❌ 404 | ❌ 403 | ✅ |
| 只读分享页看流水 | — | — | — | 二期（见 C-5） |

> 权限判定完全沿用既有 `findVisible(id, user.id)` + `is_seed` 检查，不新增权限概念。

---

## 9. 异常与边界场景

| # | 场景 | 期望行为 |
|---|---|---|
| E1 | 金额为 0 / 负数 / 非数字 | `400 INVALID_AMOUNT`，前端阻止提交 |
| E2 | 类目不在 9 类内 | `400 INVALID_CATEGORY` |
| E3 | 分摊人含非本路线同行人 | `400 INVALID_PARTICIPANT`，整笔拒绝 |
| E4 | 0 位分摊人（`split_mode='none'`） | 允许保存；结算时只计实付；口径脚注解释差额 |
| E5 | 消费日期在行程区间外 | 允许（提前购票场景），列表不特殊标记 |
| E6 | 删除被流水引用的同行人 | 默认 `409 TRAVELER_IN_USE` + 前端确认；`force=1` 后退化为「未指定分摊/付款人」 |
| E7 | 付款人为空（`payer_id=null`） | 落库允许；结算响应 `summary.unassigned>0` 时前端给出提示条 |
| E8 | 路线币种与流水 `currency` 不一致（历史快照） | 按流水快照币种展示，不做二次换算 |
| E9 | 开启流水模式时已有 9 列手动值 | 值保留；不自动生成「期初流水」（避免伪造明细），UI 说明「原为手动汇总的 ¥X 不含在流水内」 |
| E10 | 关闭流水模式 | 聚合值回写为手动值；流水保留；再次开启恢复 |
| E11 | 并发两笔同时写入 | `BEGIN IMMEDIATE` 串行化 + `busy_timeout=5000`（既有配置） |
| E12 | 同路线流水超过 500 笔 | 列表分页（`pageSize` 默认 50，与路线列表一致） |
| E13 | 极端舍入（3 人分 ¥100） | 每人 ¥33.33，余 ¥0.01 由贪心吸收，不产生孤儿转账；口径脚注标注「存在分位舍入」 |
| E14 | 路线被删除 | `ON DELETE CASCADE` 连带删除同行人与流水 |

---

## 10. 兼容与迁移

| 项 | 方案 |
|---|---|
| 老库升级 | 3 张新表 `CREATE TABLE IF NOT EXISTS` + `ledger_mode` 走既有 `addColumn` 幂等迁移（`db.js:118-126`），无需手工脚本 |
| 既有行为 | 所有路线默认 `ledger_mode=0` → 与现在完全一致；既有 7 个测试脚本应全绿 |
| 降级回滚 | 旧镜像只读写 `routes.exp_*`，忽略新表/新字段 → 可直接回滚，无数据损坏 |
| 导出导入 | CSV / JSON 契约不变；**流水不参与导入导出**（详见 6.4 说明），UI 需标注 |
| 统计口径 | 不变（仍读 `exp_*`），因为 D1 保证了聚合值始终等于明细之和 |
| `VERSION` | 发布时需同步 bump（既有约定，v1.1.0） |

---

## 11. 非功能需求

| 项 | 要求 |
|---|---|
| 依赖 | **零新增依赖**：SQLite 用既有 `better-sqlite3`，前端保持「无构建 + 手写 DOM」，不引入图表/UI 库 |
| 性能 | 单路线 500 笔内：列表响应 < 100ms；结算计算 O(n log n) 在前端 < 5ms（n≤50 人） |
| 安全 | 写操作同源校验；所有输出走 `esc()`（分享页与列表均需转义）；`title`/`note` 长度上限 500 字符；参数全部走 prepared statement |
| 可用性 | 记一笔主流程（金额→类目→保存）≤ 3 次点击；默认值覆盖 80% 场景（我付款 + 全员平分 + 行程首日） |
| 可测性 | 结算算法须为**纯函数**，可脱离 HTTP 单独断言（便于按 I1–I5 写用例） |
| 国际化 | 复用既有中文文案风格；不引入 i18n 框架 |

---

## 12. 验收用例

> 标注 ✅ 者为**原型阶段已用真机（Chromium + CDP）验证通过**的 41 条断言，实现阶段可直接平移为自动化用例。

| # | 用例 | 期望 | 原型验证 |
|---|---|---|---|
| T1 | 开启流水模式的路线，卡片显示「流水 N 笔」 | 徽标存在且 N 正确 | ✅ A2 |
| T2 | 流水汇总与卡片总额一致 | `Σ流水 == 卡片金额` | ✅ B4 / C5 |
| T3 | 按类目筛选 | 住宿筛选后仅剩 3 笔 | ✅ B5 |
| T4 | 结算不变量 I1 | `Σpaid == 总花费` | ✅ C5 |
| T5 | 结算不变量 I3 | `Σtransfers == 债权额` | ✅ C4 |
| T6 | 结算不变量 I4 | `transfers.length ≤ 人数−1`（本例 4 人 → 3 笔） | ✅ C3 |
| T7 | 实际差额计算正确 | 我 +¥4,027.50 | ✅ C2 |
| T8 | 记一笔默认值 | 付款人=我、全员平分、日期=行程首日 | ✅ D2/D3 |
| T9 | 实时人均（全员） | 400 / 4 人 → 每人 100 | ✅ D4 |
| T10 | 实时人均（部分人） | 400 / 2 人 → 每人 200 | ✅ D5 |
| T11 | 保存后即时生效 | 流水 13→14，卡片金额同步 | ✅ D6/D7/D8 |
| T12 | 部分人分摊影响结算 | 阿May 应分担 3,352.50 | ✅ D9 |
| T13 | `split_mode='none'` | 0 分摊人可行且给告警；只计实付 | ✅ D10–D13 |
| T14 | 不变量 I5 说明 | 口径脚注给出「未纳入分摊」差额 | ✅ D14 |
| T15 | 同行人批量添加 | 「测试A、测试B」→ +2 人 | ✅ E2 |
| T16 | 名单与人数不一致提示 | 显示「与人数不一致」 | ✅ E3 |
| T17 | 无流水路线不受影响 | 无徽标、金额取 9 列汇总、详情默认概览 | ✅ F1/F2/F3 |
| T18 | 切模式不丢数据 | 关流水后金额=聚合值 14,580 | ✅ F2 |
| T19 | 无未捕获 JS 错误 | `window.__errs` 为空 | ✅ G1 |
| T20 | 既有回归全绿 | `node tests/run-all.js` 7 脚本通过 | 待实现 |
| T21 | 越权访问 | 他人路线流水 → 404 | 待实现 |
| T22 | 示例路线只读 | 普通用户写流水 → 403 | 待实现 |
| T23 | 跨站写请求 | → 403 `BAD_ORIGIN` | 待实现 |
| T24 | 降级回滚 | 旧版本读写 `exp_*` 正常 | 待实现 |

---

## 13. 排期与风险

### 13.1 建议拆分（按依赖顺序，不commitment工期）

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| S1 | 数据层：3 表 DDL + `ledger_mode` 迁移 + 纯函数 `settle()` | 单测覆盖 I1–I5 |
| S2 | 后端接口：同行人 / 流水 CRUD + 事务回写聚合 + 模式开关 | 接口级断言 + 越权用例 |
| S3 | 前端：三页签 + 流水列表 + 记一笔 + 结算 + 同行人 | 平移原型 71 条断言 |
| S4 | 测试与收尾：补 `tests/smoke-ai.test.js`（AI 零覆盖缺口）、`tests/smoke-ledger.test.js`、README 章节、`VERSION`、镜像与 APK 发布 | 回归全绿 + 发布验证 |

### 13.2 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 事务回写聚合遗漏某条路径（如 `bulk-delete`） | 高 | 聚合回写收敛为**唯一函数** `recomputeRouteAgg(db, routeId)`，所有写路径末尾调用；用「流水汇总 == `exp_*`」做一致性断言 |
| 前端 `CATS` 与后端 `EXP_KEYS` 再度分叉 | 中 | 类目校验只用 `EXP_KEYS`；前端 `CATS` 由 `/api/public/site` 下发（沿用 `currency_symbols` 的既有下发模式） |
| 结算精度导致「账不平时多 1 分」 | 中 | 阈值 `0.005` + 余差吸收进最后一笔（5.4 已定规则） |
| 双端口径不一致（原型与实现） | 中 | 原型断言可直接平移；结算为纯函数、同源实现 |
| `deliverables/` 中混入原型导致仓库体积 | 低 | 原型仅 ~40KB，已归档在 `deliverables/`（该目录已在结构图中登记） |

---

## 14. 与既有功能的兼容性与冲突

> 本章回答「按本方案改完后，既有的**新增 / 编辑路线**与 **AI 规划 / AI 调整**还能不能用、会不会互相打断」。
> 全部结论均为**实测**（2026-09-18，独立 DATA_DIR 起真实服务 + 本地 OpenAI 兼容 mock 承接 AI 请求），非推断。

### 14.1 改动前基线：既有功能实测结果

| 功能 | 实测方式 | 结果 |
|---|---|---|
| 新增路线 | 真实 HTTP `POST /api/routes`（含 9 类金额）→ 回读校验 | ✅ 有效（201，9 类金额逐项一致） |
| 编辑路线 | `PUT /api/routes/:id` → 回读校验变更与保留字段 | ✅ 有效 |
| 删除路线 | `DELETE` → 再查返回 404 | ✅ 有效 |
| **AI 规划** | 门禁 → 配置 → 打本地 mock → 解析 → 审计，全链路 | ✅ 有效（含 3 种参数错误的 400 分支） |
| **AI 调整** | 同上，含多轮与 `history` 末尾 6 条截断 | ✅ 有效 |
| 既有回归套件 | `node tests/run-all.js` | ✅ 7/7 脚本通过 |
| ⚠️ 自动化守护缺口 | 全仓 grep | **既有 7 个测试脚本对 AI 零断言** —— AI 属「无回归守护」区，任何改动都需人工回归 |

端到端断言汇总：既有功能 **31 条**（本轮新增脚本）+ 原型 **71 条**，均 0 失败。

### 14.2 冲突 / 集成点清单（按风险排序，均已实测复现）

| # | 冲突点 | 实测证据 | 风险 | 处理方案 |
|---|---|---|---|---|
| **C1** | `routes` 表的写入走**固定白名单** `ROUTE_COLS` + `bind()`（`db.js:227-262`），未知字段被**静默丢弃** | POST 带 `ledger_mode:1` → 回读为 `undefined` | 高（静默失败，最难排查） | 必须把 `ledger_mode` 加入 `SCHEMA`/`addColumn`、`ROUTE_COLS`、`bind()`、`routeToJson()` 四处；并在测试中加「字段往返」断言 |
| **C2** | 9 类金额走**嵌套 `exp` 契约**（`db.js:220` `const e = data.exp || {}`），非平铺字段 | POST 带平铺 `机票:999` → 回读 `exp['机票']===0` | 中 | 流水聚合回写**必须保持 `exp` 嵌套形状**；不得为了流水新增平铺 `exp_*` 请求字段，否则前端 `r.exp[c]` 读不到 |
| **C3** | **PUT 不传 `exp` 会把 9 类金额全部清零** | `PUT {exp:{}}` → 9 类归零 | **高（数据丢失）** | 双保险：①前端在 `ledger_mode=1` 时**不提交** `exp`；②服务端在 `ledger_mode=1` 时**忽略 `body.exp`**，以流水聚合结果回写 |
| **C4** | `PUT` 是**整体覆盖**语义，未提交字段被重置为默认值 | `PUT` 只传 `name/year/dest` → `scenic` 变为 `""` | 中 | 既有前端本就整体提交（`saveForm` 构造完整 obj），新方案不得改成部分提交；新增 `.banner` 说明 |
| **C5** | AI 功能无自动化守护 | 见 14.1 | 中 | 本期补一组 AI 冒烟（门禁 + mock 打通），把 14.1 的 5 项固化为用例 |

### 14.3 明确不冲突的部分（可放心的边界）

| 面 | 原因 |
|---|---|
| **AI 规划 / AI 调整** | 二者只**读** `dest`/`start_date`/`end_date`/`days` 并**写** `scenic`，与 `travelers`/`expenses` 表**零交集**；AI 的产物经「编辑路线」保存，走的还是同一条 `PUT` 路径（已实测 H1 闭环） |
| 统计 / 趋势 / 年份 | 仍读 `routes.exp_*`；由 D1「物化聚合」保证其恒等于流水之和 |
| CSV / JSON 导出导入 | 契约不变；导入白名单不含流水，去重规则（名称+年份+目的地）不受影响 |
| 只读分享页 | 一期不动；服务端渲染与转义路径不新增输入面 |
| 预算条与人均 | 依赖 `exp_*` 与 `people`/同行人名单；`people` 语义不变（D4：只提示不自动改写） |
| 删除路线 | 既有 `ON DELETE CASCADE` 天然覆盖新增的 `travelers`/`expenses`/`expense_parts` |

### 14.4 对既有功能的**可见**改动（仅此一处）

| 位置 | 改动 | 依据 |
|---|---|---|
| 路线编辑表单 → 「9 类花费」区 | `ledger_mode=1` 时：输入框转**只读**（灰底），上方出现 `.banner`：「该路线已开启逐笔记账：9 类金额由 **N 笔流水**自动汇总，此处只读。保存路线时**不提交**这 9 个数值，由服务端以流水聚合结果为准。」+「去记流水」按钮 | 实测原型 M1–M3 |

其余全部交互（新增路线、编辑路线的其他字段、AI 规划、AI 调整、删除、导入导出、分享）**保持不变**；`ledger_mode=0` 的路线在表单上**与现在完全一致**（原型 M7 已验证）。

### 14.5 实现时必须保持的回归基线

| # | 必须保持的行为 | 原型已覆盖 | 实现阶段需补 |
|---|---|---|---|
| R1 | 新增路线 9 类金额正确落库（走 `exp` 嵌套） | ✅ K1–K7 | 接口级断言 |
| R2 | 编辑路线改名 / 改金额 / 改预算生效且未提交字段不丢 | ✅ K8–K10 | 同上 |
| R3 | 删除路线连带清理流水与同行人 | ✅ K11 | 同上 |
| R4 | AI 规划参数校验（缺日期 / 缺目的地 / 天数无效） | ✅ L3–L5 | 接口级 400 断言 |
| R5 | AI 规划生成后「调整」按钮自动出现 | ✅ L6 | 前端断言 |
| R6 | AI 调整多轮 + 应用回填 + `history` 截断 6 条 | ✅ L7–L12 | 接口级断言（mock） |
| R7 | AI 权限：未启用账号看不到 AI 入口 | ✅ L2 | 接口 403 断言 |
| R8 | **ledger 模式保存路线不清零 9 类金额** | ✅ M4 | 接口级断言（核心） |
| R9 | ledger 模式保存不破坏 `scenic`/`dest`/`days` | ✅ M5 | 同上 |
| R10 | 非 ledger 路线表单行为不变 | ✅ M7 | 同上 |

> **建议**：把上面 14.1 的既有功能验证脚本沉淀为 `tests/smoke-ai.test.js` 与 `tests/smoke-ledger.test.js`，补上当前最大的守护缺口（AI 零覆盖）。

---

## 附录 A · 原型与验证

**入口**：`deliverables/proto-ledger-aa/index.html`（直接双击即可，无需服务端与构建）

| 文件 | 说明 |
|---|---|
| `index.html` | 交互原型（纯前端，数据在内存，刷新重置）。**已包含既有功能**：新增/编辑路线表单、AI 规划、AI 调整对话面板 |
| `styles.css` | `public/styles.css` 的**逐字节副本**，保证视觉同源 |
| `proto.css` | 仅新增组件样式（已标注落地时应合并进 `public/styles.css`） |
| `verify-prototype.js` | 原型真机验证脚本（复用本机 Playwright Chromium + CDP，零依赖） |
| `verify-existing-features.js` | **既有功能**端到端验证脚本（起真实服务 + 本地 OpenAI 兼容 mock，验证新增/编辑/删除路线与 AI 规划/调整） |
| `shots/` | 11 张界面截图留档（`01-workbench` … `10-form-plain-editable`） |

**验证结论**：

| 层级 | 脚本 | 断言 | 结果 |
|---|---|---|---|
| 既有功能端到端 | `verify-existing-features.js` | 31 | **31 通过 / 0 失败** |
| 原型真机 | `verify-prototype.js` | 71 | **71 通过 / 0 失败**（含既有功能回放 K/L 与交叉验证 M） |

均为真实 Chromium（headless）+ CDP 驱动，无未捕获 JS 错误。

**验证过程中定位并修复的问题**：原型 3 个缺陷（分摊草稿被「全选/清空」重置、`split_mode` 未区分「纯记录」、无流水路线显示全 0 误导行）+ 1 个截图时机问题（`.sheet` 入场动画中途截屏得到半透明帧，已加 400ms 等待）；并实测出 14.2 的 5 个冲突点。

**可交互验证路径**：
1. 工作台 → 首张卡片「查看」→ 默认落在「流水」页签
2. 顶部 chips 筛选类目 → 点击任一行进入编辑
3. 切「结算」页签 → 核对每人差额与 3 笔转账方案
4. 底部「＋ 记一笔」→ 试改金额/类目/付款人/分摊人（观察实时人均）→ 保存后回看流水与结算变化
5. 顶部「同行人」→ 批量添加（逗号分隔）→ 观察「与人数不一致」提示
6. 原型条切到「无流水（纯汇总）」→ 确认与现状一致（无徽标、金额取 9 列、概览页给开启入口）
7. **既有功能回归**：工具条「＋ 新增路线」→ 填名称与起止日期（观察天数自动计算）→ 点「AI 规划」生成行程 → 点「调整」多轮对话 → 「应用此版本」回填 → 保存
8. **冲突可视化**：对「青海甘肃大环线」点「编辑」→ 观察 9 类花费转为只读 + 黄条提示（第 14.4 节的唯一可见改动）；对「京都赏枫」点「编辑」→ 9 类仍可手动填（行为不变）
9. 原型条「AI 权限：未启用」→ 观察编辑页的 AI 按钮全部消失（与真实权限规则一致）

---

## 附录 B · 顺带发现的问题（建议随本次一并修复）

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1 | **预算进度条样式缺失** | `app.js:227` 的 `budgetBar()` 输出 `.budget` / `.budget-bar` / `.budget-txt`，但 `public/styles.css` 全局无对应规则（已 grep 确认） | `span` 为行内元素且容器无高度 → **线上预算进度条实际不可见**，README「卡片显示进度条」描述与实现不符 | 将原型 `proto.css` 中补齐的 3 条规则合并进 `public/styles.css` |
| P2 | `--c0`…`--c8` 定义了但从未使用 | `styles.css:7-8` 定义，全仓库无引用 | 无功能影响 | 本次起用为同行人配色（避免新增色板） |
| P3 | README 结构图与真实文件曾不一致 | 已于 2026-09-17 修复（补 4 条 + `deliverables/`） | — | 本次新增 `server/ledger.js` 等文件时需**同步补结构图**（既有约定） |
| P4 | `.btn-primary` 是**为绿色 header 设计**的（`styles.css:63`：`background:#fff; color:var(--primary-d)`），但弹层（白底 `.sheet`）里的主按钮也用了它 → 白底白钮、仅靠文字色区分，主次层级弱 | `index.html` 的 `#formSave`「保存路线」、`#d_edit` 等均如此 | 视觉弱化，非功能缺陷 | 建议补一个填充态（如 `.btn-primary-fill{background:var(--primary);color:#fff}`）供白色弹层内使用；原型为呈现主次已在 `#formSave` 等处用行内样式临时替代 |

---

## 附录 C · 二期候选（本期不做，按优先级排列）

| # | 能力 | 价值 | 依赖 |
|---|---|---|---|
| C1 | 票据/发票图片上传与归档 | 报销场景闭环 | 文件存储 + 体积治理 |
| C2 | 逐笔多币种 + 历史汇率快照 | 出境多币种混记 | 汇率历史表 |
| C3 | 多用户协同编辑同一路线 | 家庭/团队共管 | 权限模型重构 |
| C4 | 「已结清」状态与结算凭证 | 避免重复催收 | 状态机 + 通知 |
| C5 | 分享页展示流水摘要 + 结算 | 无登录向同行人公示 | 分享页服务端渲染扩展 |
| C6 | JSON 备份含流水（`{routes,travelers,expenses}`） | 完整往返还原 | 导入格式版本化 |
| C7 | AI 记账（自然语言/小票照片 → 自动拆类目金额） | 大幅降低录入成本 | 复用 `ai_service.js` + 视觉模型字段 |
| C8 | 按份数/百分比差异化分摊 | 精细场景 | 已预留 `expense_parts.weight` |
| C9 | 预算按类目 + 「今天还能花多少」 | 预算管控升级 | 预算表扩展 |
