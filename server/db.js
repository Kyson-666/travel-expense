/* 数据层：better-sqlite3 连接 + 建表（幂等）+ 种子数据
 * 启动时 initDb()：表 + 种子管理员(admin/123456, 首登强制改密) + 首次导入 routes.json 为全员可见示例 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');
const PLACES_DATA = require('./places_data');

/* 9 类支出 */
const EXP_KEYS = ['交通', '机票', '高铁', '住宿', '餐饮', '门票', '团费', '购物', '其他'];
const EXP_COL = {
  '交通': 'exp_traffic', '机票': 'exp_flight', '高铁': 'exp_train',
  '住宿': 'exp_hotel', '餐饮': 'exp_meal', '门票': 'exp_ticket',
  '团费': 'exp_group', '购物': 'exp_shopping', '其他': 'exp_other'
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  email_verified INTEGER NOT NULL DEFAULT 0,
  force_reset INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER NOT NULL DEFAULT 1,
  smtp_user TEXT, smtp_pass TEXT, from_name TEXT, from_address TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, purpose TEXT NOT NULL, code TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vc_email ON verification_codes(email, purpose, consumed);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
  ip TEXT, ua TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, is_seed INTEGER NOT NULL DEFAULT 0,
  year TEXT, name TEXT, daterange TEXT, type TEXT, days INTEGER, people INTEGER,
  dest TEXT, scenic TEXT, hotel TEXT,
  start_date TEXT, end_date TEXT, currency TEXT DEFAULT 'CNY',
  budget_total REAL DEFAULT 0, budget_daily REAL DEFAULT 0,
  exp_traffic REAL DEFAULT 0, exp_flight REAL DEFAULT 0, exp_train REAL DEFAULT 0,
  exp_hotel REAL DEFAULT 0, exp_meal REAL DEFAULT 0, exp_ticket REAL DEFAULT 0,
  exp_group REAL DEFAULT 0, exp_shopping REAL DEFAULT 0, exp_other REAL DEFAULT 0,
  notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routes_owner ON routes(owner_id);
CREATE INDEX IF NOT EXISTS idx_routes_year ON routes(owner_id, year);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_name TEXT NOT NULL DEFAULT '旅行经费工作台',
  allow_register INTEGER NOT NULL DEFAULT 1,
  register_mode TEXT NOT NULL DEFAULT 'all',
  announce_text TEXT, home_currency TEXT NOT NULL DEFAULT 'CNY',
  updated_at INTEGER, updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_base_url TEXT, api_key TEXT, model_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  skip_ssl_verify INTEGER NOT NULL DEFAULT 0,
  plan_system_prompt TEXT,
  plan_user_prompt TEXT,
  chat_system_prompt TEXT,
  chat_user_prompt TEXT,
  updated_at INTEGER, updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS ai_enabled_users (
  user_id INTEGER PRIMARY KEY,
  enabled_at INTEGER NOT NULL,
  enabled_by INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* ---------- 逐笔消费流水 + AA 分账（v1.1.0） ----------
 * 设计要点：expenses 为明细真源；routes.exp_* 退化为**物化聚合**（由 recomputeRouteAgg 回写），
 * 因此统计 / 导出 / 分享 / 9 类明细等既有链路全部无需感知流水表。 */

/* 同行人（AA 结算主体） */
CREATE TABLE IF NOT EXISTS travelers (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  sort_no INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_travelers_route ON travelers(route_id);

/* 消费流水 */
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  spent_on TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'CNY',
  title TEXT,
  note TEXT,
  payer_id TEXT,
  split_mode TEXT NOT NULL DEFAULT 'equal',
  is_opening INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payer_id) REFERENCES travelers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_route_day ON expenses(route_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_expenses_route_cat ON expenses(route_id, category);

/* 分摊参与人（weight 为按份数分摊预留，当前恒为 1） */
CREATE TABLE IF NOT EXISTS expense_parts (
  expense_id TEXT NOT NULL,
  traveler_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (expense_id, traveler_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (traveler_id) REFERENCES travelers(id) ON DELETE CASCADE
);

/* 行程按天（景点路线 / 住宿）——一天一行。
 * route_days 为该结构的**真源**；routes.scenic / routes.hotel 退化为**物化镜像**，
 * 仅由 recomputeRouteDays() 回写，使分享页 / AI / 导出 / 搜索无需感知本表。
 * 历史数据（旧单框文本）由 migrateDaysFromScenic() 原样回填为一条 date='' 的「未分天」记录。 */
CREATE TABLE IF NOT EXISTS route_days (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  day_index INTEGER NOT NULL DEFAULT 0,
  date TEXT DEFAULT '',
  scenic TEXT DEFAULT '',
  hotel TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_days_uniq ON route_days(route_id, day_index);
CREATE INDEX IF NOT EXISTS idx_route_days_route ON route_days(route_id);

/* ---------- 足迹点亮：标准地名字典 + 路线目的地真源 + 点亮流水 ----------
 * places：随版本分发的字典（tools/build-places.py 离线生成，seedPlaces 幂等 upsert），
 *   用户不可创建 —— 「标准地名」的保证；
 * route_places：路线 × 地名（真源，有序多选，上限 20）；routes.dest 退化为物化镜像，
 *   由 recomputeDestMirror() 在同一事务内回写（与 route_days ↔ scenic/hotel 同构）；
 * footprint_lit：点亮流水（只增不删）—— 成就与地图的依据，删除路线不回退成就。 */
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adcode TEXT UNIQUE NOT NULL,
  country TEXT NOT NULL,
  province TEXT,
  city TEXT,
  name TEXT NOT NULL,
  pinyin TEXT,
  abbr TEXT,
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  level TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);

CREATE TABLE IF NOT EXISTS route_places (
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  place_id INTEGER NOT NULL,
  sort_no INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route_id, place_id),
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (place_id) REFERENCES places(id)
);
CREATE INDEX IF NOT EXISTS idx_route_places_owner ON route_places(owner_id);

CREATE TABLE IF NOT EXISTS footprint_lit (
  owner_id INTEGER NOT NULL,
  place_id INTEGER NOT NULL,
  first_lit_on TEXT,
  first_route_id TEXT,
  source TEXT NOT NULL DEFAULT 'route',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, place_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (place_id) REFERENCES places(id)
);
`;

let db = null;

function num(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
function scryptHash(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function uid(prefix) { return (prefix || 'r') + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function initDb() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const dbPath = path.join(config.DATA_DIR, config.DB_FILE);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  /* 幂等迁移：为已存在的库补加新列（CREATE TABLE IF NOT EXISTS 不会改旧表） */
  addColumn('routes', 'start_date', 'TEXT');
  addColumn('routes', 'end_date', 'TEXT');
  addColumn('routes', 'currency', "TEXT DEFAULT 'CNY'");
  addColumn('routes', 'budget_total', 'REAL DEFAULT 0');
  addColumn('routes', 'budget_daily', 'REAL DEFAULT 0');
  addColumn('routes', 'share_token', 'TEXT');
  addColumn('site_settings', 'home_currency', "TEXT NOT NULL DEFAULT 'CNY'");
  addColumn('ai_config', 'skip_ssl_verify', "INTEGER NOT NULL DEFAULT 0");
  addColumn('ai_config', 'plan_system_prompt', 'TEXT');
  addColumn('ai_config', 'plan_user_prompt', 'TEXT');
  addColumn('ai_config', 'chat_system_prompt', 'TEXT');
  addColumn('ai_config', 'chat_user_prompt', 'TEXT');
  addColumn('users', 'last_login', 'INTEGER');
  seedSingleton();
  seedAdmin();
  seedPlaces();
  migrateDestToStructured();
  seedRoutes();
  migrateAggregatesToOpening();
  migrateDaysFromScenic();
  enforceExpenseCurrencyInvariant();
  return db;
}

/* 仅当列不存在时添加（兼容老库升级） */
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
  }
}

function seedSingleton() {
  db.prepare('INSERT OR IGNORE INTO email_config (id) VALUES (1)').run();
  db.prepare('INSERT OR IGNORE INTO site_settings (id) VALUES (1)').run();
  db.prepare('INSERT OR IGNORE INTO ai_config (id) VALUES (1)').run();
}

function seedAdmin() {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(config.SEED_ADMIN.username);
  if (exists) return;
  const now = Date.now();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(config.SEED_ADMIN.password, salt);
  db.prepare(`INSERT INTO users (username, email, password_hash, password_salt, role, status, email_verified, force_reset, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'active', 0, 1, ?, ?)`)
    .run(config.SEED_ADMIN.username, null, hash, salt, config.SEED_ADMIN.role, now, now);
}

/* 首次运行（routes 表为空）时，把 data/routes.json 导入为全员可见示例（is_seed=1）
 * 复用 bind()（经 insertRoute）构造参数，避免与 routes_api 导入/更新各写一份字段映射 */
function seedRoutes() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM routes').get().c;
  if (n > 0) return;
  const file = path.join(config.DATA_DIR, 'routes.json');
  if (!fs.existsSync(file)) return;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(arr) || !arr.length) return;
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(config.SEED_ADMIN.username);
  if (!admin) return;
  const tx = db.transaction(() => {
    for (const r of arr) insertRoute(admin.id, r, true);
  });
  tx();
}

/* ============================================================================
   足迹点亮：地名字典 / 路线目的地真源 / 点亮流水
   ============================================================================ */

/* 字典幂等 upsert（随版本升级可扩充/修正条目；用户数据只引用 id，字典重建时按 adcode 对齐） */
function seedPlaces() {
  const stmt = db.prepare(`INSERT INTO places (adcode, country, province, city, name, pinyin, abbr, lng, lat, level)
    VALUES (@adcode, @country, @province, @city, @name, @pinyin, @abbr, @lng, @lat, @level)
    ON CONFLICT(adcode) DO UPDATE SET
      country=excluded.country, province=excluded.province, city=excluded.city, name=excluded.name,
      pinyin=excluded.pinyin, abbr=excluded.abbr, lng=excluded.lng, lat=excluded.lat, level=excluded.level`);
  const tx = db.transaction(() => {
    for (const p of PLACES_DATA) {
      stmt.run({ adcode: p.adcode, country: p.country, province: p.province || null, city: p.city || null,
        name: p.name, pinyin: p.pinyin || '', abbr: p.abbr || '', lng: p.lng, lat: p.lat, level: p.level });
    }
  });
  tx();
  const n = db.prepare('SELECT COUNT(*) AS c FROM places').get().c;
  if (n !== PLACES_DATA.length) console.log(`[db] 地名字典已更新：${n} 条`);
}

/* 存量 dest 一次性清空（已拍板 2026-10-20）：目的地升级为「标准地名多选」，
 * 旧自由文本不做规则匹配迁移、不保留字段。用 PRAGMA user_version 保证只执行一次；
 * 之后 dest 恒为 route_places 的物化镜像（recomputeDestMirror 回写）。 */
function migrateDestToStructured() {
  const uv = db.pragma('user_version', { simple: true });
  if (uv >= 1) return 0;
  const r = db.prepare(`UPDATE routes SET dest = '' WHERE COALESCE(dest, '') <> ''`).run();
  /* 已有 route_places 的路线（如重复执行/未来字典重建场景）：清空后按真源重算镜像，
   * 避免把「苏州 · 杭州」这类正常镜像误清为空 */
  const ids = db.prepare('SELECT DISTINCT route_id FROM route_places').all().map(x => x.route_id);
  for (const id of ids) recomputeDestMirror(id);
  db.pragma('user_version = 1');
  if (r.changes) console.log(`[db] 目的地升级为标准地名：已清空存量自由文本 ${r.changes} 条，请在路线表单重新选择`);
  return r.changes;
}

/* 地名解析：refs 元素可为 adcode（"320500"/"JP"）或简名（"苏州"）。
 * 名字精确匹配时市优先于省、再次国家（「吉林」命中吉林市而非吉林省的歧义以城市为先，
 * 表单 chip 会显示省份前缀供用户区分）。字典外的名字直接丢弃并记入 misses
 * （AI 提名 / 旧备份导入的幻觉地名在此被裁决）。 */
function resolvePlaceRefs(refs) {
  const out = [];
  const seen = new Set();
  const misses = [];
  const byAdcode = db.prepare('SELECT * FROM places WHERE adcode = ?');
  const byName = db.prepare(`SELECT * FROM places WHERE name = ?
    ORDER BY CASE level WHEN 'city' THEN 0 WHEN 'province' THEN 1 ELSE 2 END LIMIT 1`);
  for (const ref of (Array.isArray(refs) ? refs : []).slice(0, 50)) {
    const s = String(ref && typeof ref === 'object' ? (ref.adcode || ref.name || '') : (ref == null ? '' : ref)).trim();
    if (!s) continue;
    let row = null;
    if (/^\d{6}$/.test(s) || /^[A-Z]{2}$/.test(s)) row = byAdcode.get(s);
    if (!row) row = byName.get(s);
    if (!row) { misses.push(s); continue; }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= 20) break; /* 单路线目的地上限 20 */
  }
  return { places: out, misses };
}

function listRoutePlaces(routeId) {
  return db.prepare(`SELECT p.id, p.adcode, p.name, p.province, p.country, p.level, p.lng, p.lat, rp.sort_no
    FROM route_places rp JOIN places p ON p.id = rp.place_id
    WHERE rp.route_id = ? ORDER BY rp.sort_no ASC`).all(routeId);
}

/* 批量取多条路线的目的地（列表接口用，避免 N+1） */
function placesForRoutes(ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`SELECT rp.route_id, p.id, p.adcode, p.name, p.province, p.country, p.level, p.lng, p.lat, rp.sort_no
    FROM route_places rp JOIN places p ON p.id = rp.place_id
    WHERE rp.route_id IN (${ph}) ORDER BY rp.route_id, rp.sort_no ASC`).all(...ids)
    .forEach(r => { (out[r.route_id] || (out[r.route_id] = [])).push({
      id: r.id, adcode: r.adcode, name: r.name, province: r.province, country: r.country, level: r.level, sort_no: r.sort_no }); });
  return out;
}

/* 由 route_places 生成 routes.dest 物化镜像（「苏州 · 杭州 · 上海」）。
 * 与 recomputeRouteDays() 回写 scenic/hotel 完全同构：搜索 / CSV / 分享 / AI 全部零改动。 */
function recomputeDestMirror(routeId) {
  const dest = listRoutePlaces(routeId).map(p => p.name).join(' · ');
  db.prepare('UPDATE routes SET dest = ?, updated_at = ? WHERE id = ?').run(dest, Date.now(), routeId);
  return dest;
}

/* 覆盖式写入某路线的目的地（refs：adcode 或简名数组），同事务回写 dest 镜像 + 点亮流水。
 * footprint_lit 只增不删：路线删除后成就保留（已拍板「删除路线不熄灭地图」）。 */
function setRoutePlaces(routeId, ownerId, refs, opts = {}) {
  const { places } = resolvePlaceRefs(refs);
  const prev = listRoutePlaces(routeId).map(p => p.name);
  const now = Date.now();
  const startDate = String(opts.startDate || '').slice(0, 10);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM route_places WHERE route_id = ?').run(routeId);
    const ins = db.prepare('INSERT INTO route_places (route_id, owner_id, place_id, sort_no) VALUES (?,?,?,?)');
    places.forEach((pl, i) => ins.run(routeId, ownerId, pl.id, i));
    const lit = db.prepare(`INSERT OR IGNORE INTO footprint_lit
      (owner_id, place_id, first_lit_on, first_route_id, source, created_at) VALUES (?,?,?,?,?,?)`);
    for (const pl of places) lit.run(ownerId, pl.id, startDate, routeId, opts.source || 'route', now);
    recomputeDestMirror(routeId);
  });
  tx();
  if (!opts.silent) {
    const cur = places.map(p => p.name);
    const added = cur.filter(n => !prev.includes(n));
    const removed = prev.filter(n => !cur.includes(n));
    if (added.length || removed.length) {
      audit(ownerId, 'update_route_places', 'routes', routeId,
        ('更新目的地：' + (added.length ? '+' + added.join('、') : '') +
          (added.length && removed.length ? ' ' : '') + (removed.length ? '−' + removed.join('、') : '')).trim(),
        opts.ip || null);
    }
  }
  return listRoutePlaces(routeId);
}

/* 字典搜索：汉字模糊 + 拼音/首字母前缀；市优先、省级次之、国家最后 */
function searchPlaces(q, limit) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
  const like = '%' + kw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
  const rows = db.prepare(`SELECT * FROM places
    WHERE name LIKE ? ESCAPE '\\' OR pinyin LIKE ? ESCAPE '\\' OR abbr LIKE ? ESCAPE '\\' LIMIT 200`)
    .all(like, like, like);
  const lvlRank = { city: 0, province: 1, country: 2 };
  const score = (p) => {
    const name = p.name.toLowerCase();
    if (name === kw) return 0;
    if (p.abbr === kw || p.pinyin === kw) return 1;
    if (name.startsWith(kw)) return 2;
    if ((p.pinyin || '').startsWith(kw) || (p.abbr || '').startsWith(kw)) return 3;
    return 4;
  };
  return rows
    .sort((a, b) => (score(a) - score(b)) || ((lvlRank[a.level] || 9) - (lvlRank[b.level] || 9)) || a.name.localeCompare(b.name, 'zh'))
    .slice(0, lim)
    .map(p => ({ id: p.id, adcode: p.adcode, name: p.name, province: p.province, country: p.country,
      level: p.level, pinyin: p.pinyin, lng: p.lng, lat: p.lat }));
}

/* 直辖市与港澳：选中即省级点，但统计「城市数」时也计入一城 */
const MUNI_AS_CITY = new Set(['北京', '上海', '天津', '重庆', '香港', '澳门']);

function litRowsFor(ownerId) {
  return db.prepare(`SELECT f.place_id, f.first_lit_on, f.first_route_id, f.source, f.created_at,
      p.adcode, p.name, p.province, p.country, p.level, p.lng, p.lat
    FROM footprint_lit f JOIN places p ON p.id = f.place_id
    WHERE f.owner_id = ? ORDER BY f.first_lit_on ASC, f.created_at ASC`).all(ownerId);
}

/* 成就与汇总（纯计算，唯一口径来源，前端不二次推导） */
function footprintSummary(ownerId) {
  const rows = litRowsFor(ownerId);
  const china = rows.filter(r => r.country === '中国');
  const provinces = new Set();
  let cityCount = 0;
  const cityNames = new Set();
  for (const r of china) {
    if (r.level === 'province') { provinces.add(r.name); if (MUNI_AS_CITY.has(r.name)) { cityCount++; cityNames.add(r.name); } }
    else if (r.level === 'city') { provinces.add(r.province); cityCount++; cityNames.add(r.name); }
  }
  const countries = rows.filter(r => r.level === 'country').map(r => ({ name: r.name, first_lit_on: r.first_lit_on || '' }));

  /* 年度回顾：按首次点亮年份分组 */
  const byYear = {};
  for (const r of rows) {
    const y = String(r.first_lit_on || '').slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    if (!byYear[y]) byYear[y] = { year: y, cities: [], provinces: new Set(), countries: [] };
    if (r.level === 'city' || (r.level === 'province' && MUNI_AS_CITY.has(r.name))) byYear[y].cities.push(r.name);
    if (r.country === '中国') byYear[y].provinces.add(r.level === 'province' ? r.name : r.province);
    if (r.level === 'country') byYear[y].countries.push(r.name);
  }
  const yearly = Object.values(byYear).sort((a, b) => b.year.localeCompare(a.year))
    .map(y => ({ year: y.year, new_cities: y.cities, new_count: y.cities.length + y.countries.length,
      provinces: [...y.provinces].sort(), countries: y.countries }));
  const years = yearly.map(y => y.year);

  /* 首次点亮（有日期的取最早，否则取最早写入） */
  const dated = rows.filter(r => /^\d{4}/.test(r.first_lit_on || ''));
  const first = dated[0] || rows[0] || null;

  /* 单年最多 / 连续 N 年 */
  let maxYearCount = 0;
  for (const y of yearly) maxYearCount = Math.max(maxYearCount, y.new_count);
  const yearNums = years.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  let streak = 0, cur = 0, prevY = null;
  for (const y of yearNums) { cur = (prevY !== null && y === prevY + 1) ? cur + 1 : 1; streak = Math.max(streak, cur); prevY = y; }

  /* 同城二刷：同一城市出现在 ≥2 条现存路线 */
  const revisit = db.prepare(`SELECT COUNT(*) AS c FROM (
      SELECT place_id FROM route_places WHERE owner_id = ? GROUP BY place_id HAVING COUNT(DISTINCT route_id) >= 2)`)
    .get(ownerId).c;

  const pc = provinces.size;
  const ach = [
    { key: 'first', title: '迈出第一步', desc: first ? `首次点亮「${first.name}」${/^\d{4}/.test(first.first_lit_on || '') ? '（' + first.first_lit_on.slice(0, 4) + ' 年）' : ''}` : '选择路线的目的地即可点亮', done: rows.length > 0, progress: Math.min(rows.length, 1), target: 1 },
    { key: 'prov5', title: '小有版图', desc: '点亮 5 个省级行政区', done: pc >= 5, progress: Math.min(pc, 5), target: 5 },
    { key: 'prov10', title: '半壁江山', desc: '点亮 10 个省级行政区', done: pc >= 10, progress: Math.min(pc, 10), target: 10 },
    { key: 'prov20', title: '行者无疆', desc: '点亮 20 个省级行政区', done: pc >= 20, progress: Math.min(pc, 20), target: 20 },
    { key: 'prov34', title: '走遍中国', desc: '点亮全部 34 个省级行政区', done: pc >= 34, progress: Math.min(pc, 34), target: 34 },
    { key: 'city10', title: '十城记', desc: '点亮 10 座城市', done: cityCount >= 10, progress: Math.min(cityCount, 10), target: 10 },
    { key: 'city20', title: '二十城志', desc: '点亮 20 座城市', done: cityCount >= 20, progress: Math.min(cityCount, 20), target: 20 },
    { key: 'city50', title: '五十城传', desc: '点亮 50 座城市', done: cityCount >= 50, progress: Math.min(cityCount, 50), target: 50 },
    { key: 'year5', title: '丰收之年', desc: '单一年份新增点亮 5 处', done: maxYearCount >= 5, progress: Math.min(maxYearCount, 5), target: 5 },
    { key: 'streak3', title: '步履不停', desc: '连续 3 年都有新点亮', done: streak >= 3, progress: Math.min(streak, 3), target: 3 },
    { key: 'revisit', title: '故地重游', desc: '同一座城市出现在 2 条以上路线中', done: revisit > 0, progress: Math.min(revisit, 1), target: 1 },
    { key: 'abroad', title: '走向世界', desc: '点亮首个境外国家/地区', done: countries.length > 0, progress: Math.min(countries.length, 1), target: 1 }
  ];

  return {
    litCount: rows.length,
    cityCount,
    provinceCount: pc,
    countryCount: countries.length,
    countries,
    years,
    yearly,
    achievements: ach,
    firstLit: first ? { name: first.name, on: first.first_lit_on || '' } : null
  };
}

/* 地图数据：全国省/市中心点 + 点亮状态（点阵地图，不绘制边界线） */
function footprintMapData(ownerId) {
  const lit = new Map(litRowsFor(ownerId).map(r => [r.place_id, r]));
  const points = db.prepare(`SELECT id, adcode, name, province, level, lng, lat FROM places
    WHERE country = '中国' AND level IN ('province','city') ORDER BY level = 'city', id`).all()
    .map(p => {
      const l = lit.get(p.id);
      /* 省级点：本省任一城市点亮也视为点亮（省级模式口径） */
      let litByChild = false;
      if (!l && p.level === 'province') {
        litByChild = !!db.prepare(`SELECT 1 FROM footprint_lit f JOIN places cp ON cp.id = f.place_id
          WHERE f.owner_id = ? AND cp.country = '中国' AND cp.level = 'city' AND cp.province = ? LIMIT 1`).get(ownerId, p.name);
      }
      return { id: p.id, adcode: p.adcode, name: p.name, province: p.province, level: p.level,
        lng: p.lng, lat: p.lat, lit: !!l || litByChild, direct: !!l, on: l ? (l.first_lit_on || '') : '' };
    });
  const summary = footprintSummary(ownerId);
  return {
    points,
    countries_lit: summary.countries,
    stats: { cityCount: summary.cityCount, provinceCount: summary.provinceCount,
      countryCount: summary.countryCount, litCount: summary.litCount }
  };
}

/* 待标注路线：本人非示例路线中尚无目的地选择的（引导用户补选标准地名） */
function pendingRoutes(ownerId) {
  return db.prepare(`SELECT r.id, r.name, r.year, r.daterange FROM routes r
    WHERE r.owner_id = ? AND r.is_seed = 0
      AND NOT EXISTS (SELECT 1 FROM route_places rp WHERE rp.route_id = r.id)
    ORDER BY r.year DESC, r.created_at DESC LIMIT 100`).all(ownerId);
}

/* 路线外点亮（出差/路过/探亲）：只增不删，source='manual' */
function manualLit(ownerId, ref, date, ip) {
  const { places } = resolvePlaceRefs([ref]);
  if (!places.length) {
    const e = new Error('地名不在标准字典中，请从搜索结果中选择'); e.code = 'INVALID_PLACE'; throw e;
  }
  const pl = places[0];
  const on = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT OR IGNORE INTO footprint_lit
    (owner_id, place_id, first_lit_on, first_route_id, source, created_at) VALUES (?,?,?,NULL,'manual',?)`)
    .run(ownerId, pl.id, on, Date.now());
  const already = r.changes === 0;
  if (!already) audit(ownerId, 'footprint_manual_lit', 'places', pl.adcode, `手动点亮「${pl.name}」`, ip || null);
  return { place: { id: pl.id, adcode: pl.adcode, name: pl.name, province: pl.province, country: pl.country, level: pl.level },
    first_lit_on: on, already };
}


/* 解析日期区间文本 → ISO 起止（兼容 YYYY/M/D—YYYY/M/D、M/D—M/D、单日期） */
function isoDate(y, mo, d) { return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function parseDateRange(dr, year) {
  if (!dr) return { start: '', end: '' };
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { start: isoDate(m[1], m[2], m[3]), end: isoDate(m[4], m[5], m[6]) };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) {
    const sm = +m[1], em = +m[3];
    const ey = em < sm ? +year + 1 : +year;
    return { start: isoDate(year, m[1], m[2]), end: isoDate(ey, m[3], m[4]) };
  }
  m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { start: isoDate(m[1], m[2], m[3]), end: isoDate(m[1], m[2], m[3]) };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return { start: isoDate(year, m[1], m[2]), end: isoDate(year, m[1], m[2]) };
  return { start: '', end: '' };
}

/* 排序键：路线的「出发时间」毫秒值（优先结构化 start_date，回退 daterange 文本解析）。
 * 列表排序的**唯一权威**——前端不再二次排序，避免「页内按出发日排、页间按年+创建时间切」
 * 导致跨页顺序不自洽。无日期可解析返回 0（排到最后）。 */
function routeStartMs(row) {
  if (row && row.start_date) {
    const t = Date.parse(row.start_date + 'T00:00:00');
    if (!Number.isNaN(t)) return t;
  }
  const r = parseDateRange(row && row.daterange, row && row.year);
  if (r && r.start) {
    const t = Date.parse(r.start + 'T00:00:00');
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/* 由起止日期生成显示用 daterange 文本（如 2026/06/17 - 2026/06/24） */
function buildDateRangeText(start, end) {
  if (!start && !end) return '';
  const fmt = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return y && m && d ? `${y}/${m}/${d}` : s;
  };
  if (start && end && start !== end) return `${fmt(start)} - ${fmt(end)}`;
  return fmt(start || end);
}

/* 行 → JSON（重组 exp 对象，兼容原前端） */
function routeToJson(row) {
  const exp = {};
  for (const k of EXP_KEYS) exp[k] = num(row[EXP_COL[k]]);
  const out = { id: row.id, owner_id: row.owner_id, is_seed: !!row.is_seed, year: row.year, name: row.name,
    daterange: row.daterange, type: row.type, days: row.days, people: row.people, dest: row.dest,
    scenic: row.scenic, hotel: row.hotel, start_date: row.start_date || '', end_date: row.end_date || '',
    currency: row.currency || 'CNY', budget_total: num(row.budget_total), budget_daily: num(row.budget_daily),
    notes: row.notes, created_at: row.created_at, updated_at: row.updated_at, exp };
  return out;
}

function bind(data, userId, isSeed, now, id) {
  const e = data.exp || {};
  /* 起止日期优先取前端传入的 start_date/end_date，否则从 daterange 文本解析 */
  const startDate = (data.start_date || '').trim();
  const endDate = (data.end_date || '').trim();
  const dr = parseDateRange(data.daterange, data.year);
  const start = startDate || dr.start || '';
  const end = endDate || dr.end || '';
  /* daterange 显示文本：优先用前端传入的，否则由起止日期生成，保持兼容 */
  const daterange = (data.daterange && data.daterange.trim()) || buildDateRangeText(start, end);
  return {
    id: id || data.id || uid('r'), owner_id: userId, is_seed: isSeed ? 1 : 0,
    year: data.year || '', name: data.name || '', daterange, type: data.type || '自由行',
    days: parseInt(data.days) || 0, people: parseInt(data.people) || 0,
    dest: data.dest || '', scenic: data.scenic || '', hotel: data.hotel || '',
    start_date: start, end_date: end,
    currency: (data.currency && String(data.currency).trim()) || 'CNY',
    budget_total: num(data.budget_total), budget_daily: num(data.budget_daily),
    exp_traffic: num(e['交通']), exp_flight: num(e['机票']), exp_train: num(e['高铁']),
    exp_hotel: num(e['住宿']), exp_meal: num(e['餐饮']), exp_ticket: num(e['门票']),
    exp_group: num(e['团费']), exp_shopping: num(e['购物']), exp_other: num(e['其他']),
    notes: data.notes || '', created_at: now, updated_at: now
  };
}

const ROUTE_COLS = `id, owner_id, is_seed, year, name, daterange, type, days, people, dest, scenic, hotel, start_date, end_date, currency, budget_total, budget_daily,
  exp_traffic, exp_flight, exp_train, exp_hotel, exp_meal, exp_ticket, exp_group, exp_shopping, exp_other, notes, created_at, updated_at`;

function insertRoute(userId, data, isSeed) {
  const now = Date.now();
  const p = bind(data, userId, isSeed, now);
  db.prepare(`INSERT INTO routes (${ROUTE_COLS}) VALUES (@id,@owner_id,@is_seed,@year,@name,@daterange,@type,@days,@people,@dest,@scenic,@hotel,@start_date,@end_date,@currency,@budget_total,@budget_daily,
    @exp_traffic,@exp_flight,@exp_train,@exp_hotel,@exp_meal,@exp_ticket,@exp_group,@exp_shopping,@exp_other,@notes,@created_at,@updated_at)`).run(p);
  /* 9 类金额统一由流水派生：把传入的聚合值转成期初流水，再做一次聚合回写。
   * 这样「新建路线 / 导入」携带的 9 类金额不会丢，且后续增删流水能正确增量。 */
  if (createOpeningExpenses(getRouteRow(p.id))) recomputeRouteAgg(p.id);
  /* 按天行程：优先 day_plans 数组，否则把传入 scenic/hotel 视作「未分天」单条 */
  const dayPlans = daysFromInput(data);
  if (dayPlans.length) setRouteDays(p.id, userId, dayPlans);
  /* 目的地标准地名：places 数组（adcode 或简名）→ route_places 真源 + dest 镜像 + 点亮流水；
   * 未携带 places 时仍回写镜像（dest 恒由 route_places 派生，客户端传入的 dest 文本不落库） */
  if (Array.isArray(data.places)) setRoutePlaces(p.id, userId, data.places, { startDate: p.start_date, silent: !!isSeed });
  else recomputeDestMirror(p.id);
  return Object.assign(getRoute(p.id), { places: listRoutePlaces(p.id) });
}

/* 内部：取原始行（createOpeningExpenses 需要 exp_* 列） */
function getRouteRow(id) {
  return db.prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE id = ?`).get(id) || null;
}

/* 更新路线。
 * 注意：**不再写入 exp_\* 列** —— 9 类金额自 v1.1.0 起统一由流水派生（物化聚合），
 * 仅由 recomputeRouteAgg() 维护。否则「编辑路线」会凭空覆盖掉流水聚合值。
 *
 * 币种不变量：**同一路线的全部流水必须共享该路线的币种**。
 * recomputeRouteAgg() / settle() 只对 amount 求和、不带币种维度，一旦路线币种与流水
 * 快照币种分叉（改币种后不重算），两种币种的数字会被直接相加 → 金额静默错加。
 * 故此处改币种时，在同一事务内把该路线全部流水的 currency 一并改写（金额数字不变，
 * 仅重贴币种标签 —— 与用户此前在界面上看到的「按路线币种汇总」完全一致）。 */
function updateRoute(id, userId, data) {
  const now = Date.now();
  const p = bind(data, userId, false, now, id);
  const prev = db.prepare('SELECT currency FROM routes WHERE id = ?').get(id);
  const currencyChanged = prev && (prev.currency || 'CNY') !== (p.currency || 'CNY');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE routes SET year=@year, name=@name, daterange=@daterange, type=@type, days=@days, people=@people,
      dest=@dest, scenic=@scenic, hotel=@hotel, start_date=@start_date, end_date=@end_date, currency=@currency, budget_total=@budget_total, budget_daily=@budget_daily, notes=@notes, updated_at=@updated_at
      WHERE id=@id AND owner_id=@owner_id`).run(p);
    if (currencyChanged) {
      db.prepare('UPDATE expenses SET currency = ?, updated_at = ? WHERE route_id = ?')
        .run(p.currency, now, id);
    }
  });
  tx();
  /* 按天行程：day_plans 优先；否则 scenic/hotel 视作未分天单条；都没有则清空
   * （保持 PUT 整体覆盖语义；镜像 scenic/hotel 由 setRouteDays 统一回写） */
  const dayPlans = (Array.isArray(data.day_plans) || data.scenic !== undefined || data.hotel !== undefined)
    ? daysFromInput(data) : [];
  setRouteDays(id, userId, dayPlans);
  /* 目的地：携带 places 则整体覆盖（PUT 语义）；未携带仅回写镜像，保持 dest 恒为派生值 */
  if (Array.isArray(data.places)) setRoutePlaces(id, userId, data.places, { startDate: p.start_date });
  else recomputeDestMirror(id);
  return Object.assign(getRoute(id), { places: listRoutePlaces(id) });
}

function getRoute(id) {
  const row = db.prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE id = ?`).get(id);
  return row ? routeToJson(row) : null;
}

/* ---------- 只读分享 ---------- */
function getShareToken(id) {
  const r = db.prepare('SELECT share_token FROM routes WHERE id = ?').get(id);
  return (r && r.share_token) || null;
}
function setShareToken(id, token) {
  db.prepare('UPDATE routes SET share_token = ? WHERE id = ?').run(token, id);
}
function clearShareToken(id) {
  db.prepare('UPDATE routes SET share_token = NULL WHERE id = ?').run(id);
}
function findRouteByShareToken(token) {
  const row = db.prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE share_token = ?`).get(token);
  return row ? routeToJson(row) : null;
}

/* ---------- AI 配置 ---------- */
function getAiConfig() {
  const c = db.prepare('SELECT * FROM ai_config WHERE id = 1').get() || {};
  return {
    api_base_url: c.api_base_url || '',
    api_key: c.api_key || '',
    model_id: c.model_id || '',
    enabled: !!c.enabled,
    skip_ssl_verify: !!c.skip_ssl_verify,
    plan_system_prompt: c.plan_system_prompt || '',
    plan_user_prompt: c.plan_user_prompt || '',
    chat_system_prompt: c.chat_system_prompt || '',
    chat_user_prompt: c.chat_user_prompt || '',
    updated_at: c.updated_at || null,
    updated_by: c.updated_by || null
  };
}
function saveAiConfig(data, adminId) {
  const cur = getAiConfig();
  const apiKey = data.api_key && data.api_key !== '******' ? String(data.api_key) : (cur.api_key || '');
  db.prepare(`UPDATE ai_config SET api_base_url=?, api_key=?, model_id=?, enabled=?, skip_ssl_verify=?,
    plan_system_prompt=?, plan_user_prompt=?, chat_system_prompt=?, chat_user_prompt=?,
    updated_at=?, updated_by=? WHERE id=1`)
    .run(
      String(data.api_base_url || '').trim(),
      apiKey,
      String(data.model_id || '').trim(),
      data.enabled ? 1 : 0,
      data.skip_ssl_verify ? 1 : 0,
      data.plan_system_prompt === undefined ? cur.plan_system_prompt : String(data.plan_system_prompt),
      data.plan_user_prompt === undefined ? cur.plan_user_prompt : String(data.plan_user_prompt),
      data.chat_system_prompt === undefined ? cur.chat_system_prompt : String(data.chat_system_prompt),
      data.chat_user_prompt === undefined ? cur.chat_user_prompt : String(data.chat_user_prompt),
      Date.now(),
      adminId
    );
  return getAiConfig();
}

/* ---------- AI 启用用户 ---------- */
function getAiEnabledUserIds() {
  return db.prepare('SELECT user_id FROM ai_enabled_users').all().map(r => r.user_id);
}
function isAiEnabledUser(userId) {
  return !!db.prepare('SELECT 1 FROM ai_enabled_users WHERE user_id = ?').get(userId);
}
function setAiEnabledUsers(userIds, adminId) {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM ai_enabled_users').run();
    const stmt = db.prepare('INSERT OR IGNORE INTO ai_enabled_users (user_id, enabled_at, enabled_by) VALUES (?, ?, ?)');
    for (const uid of userIds) {
      const id = parseInt(uid, 10);
      if (id > 0) stmt.run(id, now, adminId);
    }
  });
  tx();
  return getAiEnabledUserIds();
}

/* 审计日志：auth 与 admin 共用的唯一实现（写入失败不阻塞主流程） */
function audit(actorId, action, targetType, targetId, detail, ip) {
  try {
    db.prepare('INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(actorId, action, targetType || null, targetId || null, detail || null, ip || null, Date.now());
  } catch (e) { /* 审计写入失败不阻塞主流程 */ }
}

/* ============================================================================
   逐笔消费流水 + AA 分账
   ============================================================================ */
const round2 = (v) => Math.round((num(v)) * 100) / 100;

/* ---------- 物化聚合：expenses 明细 → routes.exp_* ----------
 * 所有流水的增删改都必须在同一事务内调用本函数，保证 9 类聚合值与明细恒等；
 * 既有统计 / 导出 / 分享链路读的都是 exp_*，因此无需改动。 */
function recomputeRouteAgg(routeId) {
  const sums = {};
  EXP_KEYS.forEach(k => { sums[k] = 0; });
  const rows = db.prepare('SELECT category, SUM(amount) AS s FROM expenses WHERE route_id = ? GROUP BY category').all(routeId);
  for (const r of rows) if (EXP_KEYS.includes(r.category)) sums[r.category] = round2(r.s);

  const setCols = EXP_KEYS.map(k => `${EXP_COL[k]} = @${EXP_COL[k]}`).join(', ');
  const p = { id: routeId, updated_at: Date.now() };
  EXP_KEYS.forEach(k => { p[EXP_COL[k]] = sums[k]; });
  db.prepare(`UPDATE routes SET ${setCols}, updated_at = @updated_at WHERE id = @id`).run(p);
  return sums;
}

/* 把某条路线的 9 类聚合金额转为「期初」流水（仅当该路线尚无任何流水）。
 * 期初流水 payer_id 为空、split_mode='none' → 只记金额、不参与 AA 结算
 * （历史数据无从得知付款人与分摊人，不应伪造）。 */
function createOpeningExpenses(row) {
  if (!row) return 0;
  if (db.prepare('SELECT 1 FROM expenses WHERE route_id = ? LIMIT 1').get(row.id)) return 0;
  const ins = db.prepare(`INSERT INTO expenses
      (id, route_id, owner_id, spent_on, category, amount, currency, title, note, payer_id, split_mode, is_opening, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,'none',1,?,?)`);
  const now = Date.now();
  let created = 0;
  for (const k of EXP_KEYS) {
    const v = round2(row[EXP_COL[k]]);
    if (v <= 0) continue;
    ins.run(uid('e'), row.id, row.owner_id, row.start_date || '', k, v, row.currency || 'CNY', '期初（历史数据）', '', now, now);
    created++;
  }
  return created;
}

/* 历史数据迁移（幂等）：把已有路线的 9 类聚合金额一次性转成期初流水。
 * 统一为流水口径后，9 类金额恒由流水派生，老数据不迁移就会显示为 0。
 * 重复启动不会重复插入（createOpeningExpenses 内部会检查是否已有流水）。 */
function migrateAggregatesToOpening() {
  const cols = EXP_KEYS.map(k => EXP_COL[k]).join(', ');
  const routes = db.prepare(`SELECT id, owner_id, currency, start_date, ${cols} FROM routes`).all();
  const tx = db.transaction(() => {
    let created = 0;
    for (const r of routes) {
      created += createOpeningExpenses(r);
      recomputeRouteAgg(r.id);
    }
    if (created) console.log(`[db] 已把历史 9 类金额转为期初流水 ${created} 笔（统一为流水口径）`);
  });
  tx();
}

/* 批量取分摊人（避免 N+1 查询） */
function partsFor(expenseIds) {
  const out = {};
  if (!expenseIds.length) return out;
  const ph = expenseIds.map(() => '?').join(',');
  db.prepare(`SELECT expense_id, traveler_id FROM expense_parts WHERE expense_id IN (${ph})`).all(...expenseIds)
    .forEach(r => { (out[r.expense_id] || (out[r.expense_id] = [])).push(r.traveler_id); });
  return out;
}

function expenseToJson(row, partsMap) {
  return {
    id: row.id, route_id: row.route_id,
    spent_on: row.spent_on || '',
    category: row.category,
    amount: round2(row.amount),
    currency: row.currency || 'CNY',
    title: row.title || '',
    note: row.note || '',
    payer_id: row.payer_id || null,
    split_mode: row.split_mode || 'equal',
    is_opening: !!row.is_opening,
    parts: (partsMap && partsMap[row.id]) || [],
    created_at: row.created_at, updated_at: row.updated_at
  };
}

/* ---------- 同行人 ---------- */
function listTravelers(routeId) {
  return db.prepare('SELECT id, route_id, name, is_self, sort_no, created_at FROM travelers WHERE route_id = ? ORDER BY sort_no ASC, created_at ASC')
    .all(routeId)
    .map(t => ({ id: t.id, route_id: t.route_id, name: t.name, is_self: !!t.is_self, sort_no: t.sort_no }));
}
function findTraveler(id, routeId) {
  return db.prepare('SELECT * FROM travelers WHERE id = ? AND route_id = ?').get(id, routeId) || null;
}
/* 批量新增（按名称去重，同一路线内不允许重名）
 * 若名单中尚无「本人」标记，把第一位新成员标记为 is_self —— 结算与卡片需要「我」这个主体，
 * 可由前端「设为我」改到其他人身上（同一路线内至多一人）。 */
function addTravelers(routeId, ownerId, names) {
  const cur = listTravelers(routeId);
  const exist = new Set(cur.map(t => t.name));
  let hasSelf = cur.some(t => t.is_self);
  let sortNo = cur.length;
  const now = Date.now();
  const created = [];
  const tx = db.transaction(() => {
    for (const raw of names) {
      const name = String(raw || '').trim();
      if (!name || exist.has(name)) continue;
      exist.add(name);
      const id = uid('t');
      const selfFlag = hasSelf ? 0 : 1;
      hasSelf = true;
      db.prepare('INSERT INTO travelers (id, route_id, owner_id, name, is_self, sort_no, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, routeId, ownerId, name, selfFlag, sortNo++, now);
      created.push(id);
    }
  });
  tx();
  return { created: created.length, list: listTravelers(routeId) };
}
function updateTraveler(id, routeId, data) {
  const cur = findTraveler(id, routeId);
  if (!cur) return null;
  const name = data.name === undefined ? cur.name : String(data.name || '').trim();
  if (!name) { const e = new Error('姓名不能为空'); e.code = 'INVALID_NAME'; throw e; }
  const dup = db.prepare('SELECT id FROM travelers WHERE route_id = ? AND name = ? AND id <> ?').get(routeId, name, id);
  if (dup) { const e = new Error('同名同行人已存在'); e.code = 'DUPLICATE_NAME'; throw e; }
  const sortNo = data.sort_no === undefined ? cur.sort_no : (parseInt(data.sort_no, 10) || 0);
  const selfFlag = data.is_self === undefined ? cur.is_self : (data.is_self ? 1 : 0);
  const tx = db.transaction(() => {
    db.prepare('UPDATE travelers SET name = ?, sort_no = ?, is_self = ? WHERE id = ? AND route_id = ?')
      .run(name, sortNo, selfFlag, id, routeId);
    /* 「本人」在一条路线内唯一：标记新的即清掉其余 */
    if (selfFlag) db.prepare('UPDATE travelers SET is_self = 0 WHERE route_id = ? AND id <> ?').run(routeId, id);
  });
  tx();
  return listTravelers(routeId).find(t => t.id === id);
}
/* 统计某同行人被流水引用的次数（作为付款人或分摊人） */
function travelerUsage(id) {
  const asPayer = db.prepare('SELECT COUNT(*) AS c FROM expenses WHERE payer_id = ?').get(id).c;
  const asPart = db.prepare('SELECT COUNT(*) AS c FROM expense_parts WHERE traveler_id = ?').get(id).c;
  return asPayer + asPart;
}
/* 删除同行人：默认拒绝（前端二次确认后带 force=1 重试）
 * force 时：其作为付款人的流水改为「未指定付款人」；其分摊关系移除（该笔退化为按剩余分摊人均分） */
function deleteTraveler(id, routeId, force) {
  const cur = findTraveler(id, routeId);
  if (!cur) return { ok: false, code: 'NOT_FOUND' };
  const affected = travelerUsage(id);
  if (affected > 0 && !force) return { ok: false, code: 'IN_USE', affected };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_parts WHERE traveler_id = ?').run(id);
    db.prepare('UPDATE expenses SET payer_id = NULL, updated_at = ? WHERE payer_id = ?').run(Date.now(), id);
    db.prepare('DELETE FROM travelers WHERE id = ? AND route_id = ?').run(id, routeId);
  });
  tx();
  return { ok: true, affected };
}

/* ---------- 流水 ---------- */
/* 校验：类目必须在 9 类内；付款人 / 分摊人必须属于本路线 */
function validateExpenseInput(routeId, data) {
  const category = String(data.category || '').trim();
  if (!EXP_KEYS.includes(category)) { const e = new Error('消费类目不正确'); e.code = 'INVALID_CATEGORY'; throw e; }
  const amount = num(data.amount);
  if (!(amount > 0)) { const e = new Error('金额必须大于 0'); e.code = 'INVALID_AMOUNT'; throw e; }
  const ids = new Set(listTravelers(routeId).map(t => t.id));
  const payerId = data.payer_id ? String(data.payer_id) : null;
  if (payerId && !ids.has(payerId)) { const e = new Error('付款人不在本路线的同行人名单中'); e.code = 'INVALID_PAYER'; throw e; }
  const rawParts = Array.isArray(data.parts) ? data.parts.map(String) : [];
  const parts = [...new Set(rawParts)];
  const bad = parts.find(p => !ids.has(p));
  if (bad) { const e = new Error('分摊人不在本路线的同行人名单中'); e.code = 'INVALID_PARTICIPANT'; throw e; }
  /* split_mode：由「是否有分摊人」推导，不接受前端任意指定 */
  const splitMode = parts.length ? 'equal' : 'none';
  const spentOn = String(data.spent_on || '').trim();
  if (spentOn && !/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) { const e = new Error('消费日期格式应为 YYYY-MM-DD'); e.code = 'INVALID_DATE'; throw e; }
  return {
    category, amount: round2(amount),
    spent_on: spentOn,
    title: String(data.title || '').trim().slice(0, 200),
    note: String(data.note || '').trim().slice(0, 500),
    payer_id: payerId, split_mode: splitMode, parts
  };
}

function insertExpense(routeId, ownerId, data) {
  const v = validateExpenseInput(routeId, data);
  const route = db.prepare('SELECT currency FROM routes WHERE id = ?').get(routeId);
  /* 客户端可选提供幂等 id（离线同步）；旧客户端不传或传入非法值时仍由服务端生成。 */
  const requestedId = typeof data.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(data.id) ? data.id : '';
  const id = requestedId || uid('e');
  const existing = db.prepare('SELECT id, route_id, owner_id FROM expenses WHERE id = ?').get(id);
  if (existing) {
    if (existing.route_id === routeId && existing.owner_id === ownerId) {
      const old = getExpense(id, routeId);
      const sameParts = JSON.stringify((old.parts || []).slice().sort()) === JSON.stringify(v.parts.slice().sort());
      const same = old.category === v.category && old.amount === v.amount && old.spent_on === v.spent_on &&
        old.title === v.title && old.note === v.note && old.payer_id === v.payer_id && sameParts;
      if (same) return old; /* POST 重放：幂等成功 */
    }
    const e = new Error('该流水已存在且内容不一致'); e.code = 'ID_CONFLICT'; throw e;
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO expenses (id, route_id, owner_id, spent_on, category, amount, currency, title, note, payer_id, split_mode, is_opening, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`)
      .run(id, routeId, ownerId, v.spent_on, v.category, v.amount, (route && route.currency) || 'CNY', v.title, v.note, v.payer_id, v.split_mode, now, now);
    const insPart = db.prepare('INSERT INTO expense_parts (expense_id, traveler_id, weight) VALUES (?,?,1)');
    v.parts.forEach(p => insPart.run(id, p));
    recomputeRouteAgg(routeId);
  });
  tx();
  return getExpense(id, routeId);
}

/* 离线批量同步。外层单事务保证一组操作原子提交；逐笔校验错误转成结果，
 * 只有数据库级意外错误才中止并回滚整组。聚合在事务末尾最多重算一次。 */
function syncExpenseOps(routeId, ownerId, ops) {
  const list = Array.isArray(ops) ? ops : [];
  if (list.length > 200) { const e = new Error('单次最多同步 200 笔'); e.code = 'OPS_TOO_MANY'; throw e; }
  const now = Date.now();
  const results = [];
  let changed = false;

  const tx = db.transaction(() => {
    const route = db.prepare('SELECT id, owner_id, currency FROM routes WHERE id = ?').get(routeId);
    if (!route || route.owner_id !== ownerId) {
      for (const op of list) results.push({ op_id: String((op && op.op_id) || ''), status: 'rejected', code: 'ROUTE_NOT_FOUND', message: '路线不存在或无权访问' });
      return;
    }

    const travelerIds = new Set(listTravelers(routeId).map(t => t.id));
    const insExpense = db.prepare(`INSERT INTO expenses
      (id, route_id, owner_id, spent_on, category, amount, currency, title, note, payer_id, split_mode, is_opening, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`);
    const insPart = db.prepare('INSERT INTO expense_parts (expense_id, traveler_id, weight) VALUES (?,?,1)');

    for (const raw of list) {
      const op = raw && typeof raw === 'object' ? raw : {};
      const opId = typeof op.op_id === 'string' ? op.op_id.slice(0, 80) : '';
      const type = op.type;
      const clientId = typeof op.client_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(op.client_id) ? op.client_id : '';
      if (!opId || !clientId || (type !== 'expense.create' && type !== 'expense.delete' && type !== 'expense.update')) {
        results.push({ op_id: opId, status: 'rejected', code: 'INVALID_OP', message: '操作格式不正确' });
        continue;
      }

      if (type === 'expense.delete') {
        const existing = db.prepare('SELECT id FROM expenses WHERE id = ? AND route_id = ? AND owner_id = ?')
          .get(clientId, routeId, ownerId);
        if (existing) {
          db.prepare('DELETE FROM expenses WHERE id = ? AND route_id = ? AND owner_id = ?')
            .run(clientId, routeId, ownerId);
          changed = true;
        }
        results.push({ op_id: opId, status: 'accepted', id: clientId });
        continue;
      }

      /* expense.update（阶段 2 离线编辑）：乐观锁 + 幂等重放。
       * · 流水不存在（可能已在其他端删除）→ rejected，保留队列交用户处置；
       * · 服务端当前内容已等于目标内容 → duplicate（重放时 base 必然过期，不能误判冲突）；
       * · base_updated_at 与服务端 updated_at 不一致 → conflict，附服务端记录供二选一；
       * · 同行人失效 → 与新增同口径降级（金额保留、payer 置空、parts 清空）。 */
      if (type === 'expense.update') {
        const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(clientId);
        if (!row || row.route_id !== routeId || row.owner_id !== ownerId) {
          results.push({ op_id: opId, status: 'rejected', code: 'EXPENSE_NOT_FOUND', message: '该流水已不存在（可能已在其他设备删除）' });
          continue;
        }
        const upd = op.data && typeof op.data === 'object' ? op.data : {};
        const old = expenseToJson(row, partsFor([clientId]));
        const updPayer = upd.payer_id ? String(upd.payer_id) : null;
        const updParts = Array.isArray(upd.parts) ? [...new Set(upd.parts.map(String))] : [];
        const updMissing = (updPayer && !travelerIds.has(updPayer)) || updParts.some(t => !travelerIds.has(t));
        let uv;
        try {
          uv = validateExpenseInput(routeId, {
            category: upd.category, amount: upd.amount, spent_on: upd.spent_on,
            title: upd.title, note: upd.note,
            payer_id: updMissing ? null : updPayer,
            parts: updMissing ? [] : updParts
          });
        } catch (e) {
          results.push({ op_id: opId, status: 'rejected', code: e.code || 'INVALID_EXPENSE', message: e.message || '流水内容不正确' });
          continue;
        }
        const sameParts = JSON.stringify((old.parts || []).slice().sort()) === JSON.stringify(uv.parts.slice().sort());
        const contentSame = old.category === uv.category && old.amount === uv.amount && old.spent_on === uv.spent_on &&
          old.title === uv.title && old.note === uv.note && old.payer_id === uv.payer_id && sameParts;
        if (contentSame) {
          results.push({ op_id: opId, status: 'duplicate', id: clientId, server_record: old });
          continue;
        }
        const base = upd.base_updated_at;
        if (base !== undefined && base !== null && String(base) !== '' && Number(base) !== Number(row.updated_at)) {
          results.push({ op_id: opId, status: 'conflict', code: 'EDIT_CONFLICT', message: '该流水已在其他端被修改，请选择保留哪一侧', server: old });
          continue;
        }
        db.prepare(`UPDATE expenses SET spent_on=?, category=?, amount=?, title=?, note=?, payer_id=?, split_mode=?, updated_at=? WHERE id=? AND route_id=?`)
          .run(uv.spent_on, uv.category, uv.amount, uv.title, uv.note, uv.payer_id, uv.split_mode, now, clientId, routeId);
        db.prepare('DELETE FROM expense_parts WHERE expense_id = ?').run(clientId);
        uv.parts.forEach(t => insPart.run(clientId, t));
        changed = true;
        results.push(updMissing
          ? { op_id: opId, status: 'degraded', id: clientId, code: 'TRAVELER_MISSING', message: '同行人已不存在，已记为未指定付款人', server_record: getExpense(clientId, routeId) }
          : { op_id: opId, status: 'accepted', id: clientId, server_record: getExpense(clientId, routeId) });
        continue;
      }

      const data = op.data && typeof op.data === 'object' ? op.data : {};
      const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(clientId);
      if (existing) {
        /* 不泄露其他路线流水内容：跨路线/owner 的相同 id 仅返回 conflict。 */
        if (existing.route_id !== routeId || existing.owner_id !== ownerId) {
          results.push({ op_id: opId, status: 'conflict', code: 'ID_CONFLICT', message: '客户端 id 已被占用' });
          continue;
        }
        const old = expenseToJson(existing, partsFor([clientId]));
        let normalized;
        try {
          const clean = {
            category: data.category, amount: data.amount, spent_on: data.spent_on,
            title: data.title, note: data.note, payer_id: data.payer_id,
            parts: Array.isArray(data.parts) ? data.parts.filter(x => travelerIds.has(String(x))) : []
          };
          /* 对比已存在项时，引用已删除的同行人视为内容不一致；不把旧项降级后误判 duplicate。 */
          const hasMissing = (data.payer_id && !travelerIds.has(String(data.payer_id))) ||
            (Array.isArray(data.parts) && data.parts.some(x => !travelerIds.has(String(x))));
          if (hasMissing) {
            const sameBase = old.category === String(data.category || '').trim() && round2(num(old.amount)) === round2(num(data.amount)) &&
              old.spent_on === String(data.spent_on || '').trim() && old.title === String(data.title || '').trim().slice(0, 200) &&
              old.note === String(data.note || '').trim().slice(0, 500) && old.payer_id == null &&
              old.split_mode === 'none' && (old.parts || []).length === 0;
            if (sameBase) {
              results.push({ op_id: opId, status: 'duplicate', id: clientId, server_record: old });
              continue;
            }
            throw Object.assign(new Error('同行人已不存在'), { code: 'TRAVELER_MISSING' });
          }
          normalized = validateExpenseInput(routeId, clean);
        } catch (e) {
          results.push({ op_id: opId, status: 'conflict', code: 'ID_CONFLICT', message: '客户端 id 已存在且内容不一致' });
          continue;
        }
        const oldParts = (old.parts || []).slice().sort();
        const newParts = normalized.parts.slice().sort();
        const same = old.category === normalized.category && old.amount === normalized.amount &&
          old.spent_on === normalized.spent_on && old.title === normalized.title && old.note === normalized.note &&
          old.payer_id === normalized.payer_id && JSON.stringify(oldParts) === JSON.stringify(newParts);
        results.push(same
          ? { op_id: opId, status: 'duplicate', id: clientId, server_record: old }
          : { op_id: opId, status: 'conflict', code: 'ID_CONFLICT', message: '客户端 id 已存在且内容不一致' });
        continue;
      }

      /* 先做白名单浅清理，验证函数负责金额/类目/日期/长度约束。 */
      const payerRaw = data.payer_id ? String(data.payer_id) : null;
      const partsRaw = Array.isArray(data.parts) ? [...new Set(data.parts.map(String))] : [];
      const travelerMissing = (payerRaw && !travelerIds.has(payerRaw)) || partsRaw.some(id => !travelerIds.has(id));
      const payload = {
        category: data.category,
        amount: data.amount,
        spent_on: data.spent_on,
        title: data.title,
        note: data.note,
        payer_id: travelerMissing ? null : payerRaw,
        parts: travelerMissing ? [] : partsRaw
      };
      let v;
      try {
        v = validateExpenseInput(routeId, payload);
      } catch (e) {
        results.push({ op_id: opId, status: 'rejected', code: e.code || 'INVALID_EXPENSE', message: e.message || '流水内容不正确' });
        continue;
      }

      insExpense.run(clientId, routeId, ownerId, v.spent_on, v.category, v.amount, route.currency || 'CNY',
        v.title, v.note, v.payer_id, v.split_mode, now, now);
      v.parts.forEach(id => insPart.run(clientId, id));
      changed = true;
      results.push(travelerMissing
        ? { op_id: opId, status: 'degraded', id: clientId, code: 'TRAVELER_MISSING', message: '同行人已不存在，已记为未指定付款人', server_record: getExpense(clientId, routeId) }
        : { op_id: opId, status: 'accepted', id: clientId, server_record: getExpense(clientId, routeId) });
    }

    if (changed) recomputeRouteAgg(routeId);
  });

  tx();
  return { server_time: Date.now(), results };
}

function getExpense(id, routeId) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ? AND route_id = ?').get(id, routeId);
  if (!row) return null;
  return expenseToJson(row, partsFor([id]));
}

function updateExpense(id, routeId, data) {
  const cur = db.prepare('SELECT * FROM expenses WHERE id = ? AND route_id = ?').get(id, routeId);
  if (!cur) return null;
  /* 离线编辑乐观锁（设计 §11 阶段 2）：客户端可携带 base_updated_at（离线编辑时看到的
   * 服务端版本戳）。与服务端当前 updated_at 不一致 → 抛 EDIT_CONFLICT 并附服务端记录，
   * 交由冲突处置面板决定「保留本地 / 采用服务端」。缺省时保持原有无条件更新（在线编辑）。 */
  const base = data.base_updated_at;
  if (base !== undefined && base !== null && String(base) !== '' && Number(base) !== Number(cur.updated_at)) {
    const e = new Error('该流水已在其他端被修改');
    e.code = 'EDIT_CONFLICT';
    e.server = getExpense(id, routeId);
    throw e;
  }
  /* 局部更新：未提交字段沿用现值，避免「不传即清空」 */
  const merged = {
    category: data.category === undefined ? cur.category : data.category,
    amount: data.amount === undefined ? cur.amount : data.amount,
    spent_on: data.spent_on === undefined ? (cur.spent_on || '') : data.spent_on,
    title: data.title === undefined ? cur.title : data.title,
    note: data.note === undefined ? cur.note : data.note,
    payer_id: data.payer_id === undefined ? cur.payer_id : data.payer_id,
    parts: data.parts === undefined ? (partsFor([id])[id] || []) : data.parts
  };
  const v = validateExpenseInput(routeId, merged);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE expenses SET spent_on=?, category=?, amount=?, title=?, note=?, payer_id=?, split_mode=?, updated_at=? WHERE id=? AND route_id=?`)
      .run(v.spent_on, v.category, v.amount, v.title, v.note, v.payer_id, v.split_mode, now, id, routeId);
    db.prepare('DELETE FROM expense_parts WHERE expense_id = ?').run(id);
    const insPart = db.prepare('INSERT INTO expense_parts (expense_id, traveler_id, weight) VALUES (?,?,1)');
    v.parts.forEach(p => insPart.run(id, p));
    recomputeRouteAgg(routeId);
  });
  tx();
  return getExpense(id, routeId);
}

function deleteExpense(id, routeId) {
  const cur = db.prepare('SELECT id FROM expenses WHERE id = ? AND route_id = ?').get(id, routeId);
  if (!cur) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expenses WHERE id = ? AND route_id = ?').run(id, routeId);
    recomputeRouteAgg(routeId);
  });
  tx();
  return true;
}

function bulkDeleteExpenses(routeId, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  const tx = db.transaction(() => {
    const r = db.prepare(`DELETE FROM expenses WHERE route_id = ? AND id IN (${ph})`).run(routeId, ...list);
    recomputeRouteAgg(routeId);
    return r.changes;
  });
  return tx();
}

function listExpenses(routeId, opts = {}) {
  const where = ['route_id = ?'];
  const args = [routeId];
  if (opts.category) { where.push('category = ?'); args.push(String(opts.category)); }
  if (opts.payer) { where.push('payer_id = ?'); args.push(String(opts.payer)); }
  if (opts.from) { where.push('spent_on >= ?'); args.push(String(opts.from)); }
  if (opts.to) { where.push('spent_on <= ?'); args.push(String(opts.to)); }
  /* 增量拉取（离线客户端）：只返回 updated_at 晚于游标的行。不返回删除墓碑 ——
   * 客户端以「打开台账时全量刷新」兜底对账删除；增量仅用于在线期间的低成本补拉。 */
  const since = Number(opts.updatedSince) > 0 ? Number(opts.updatedSince) : 0;
  if (since) { where.push('updated_at > ?'); args.push(since); }
  const w = where.join(' AND ');

  if (since) {
    const rows = db.prepare(`SELECT * FROM expenses WHERE ${w} ORDER BY updated_at ASC LIMIT 1000`).all(...args);
    const partsMap = partsFor(rows.map(r => r.id));
    /* 游标 = 本次返回行的最大 updated_at（空集则原地不动），保证「查询后、响应前」的写入
     * 下次仍会被拉取到，不会因时钟推进而漏行。 */
    const watermark = rows.length ? (Number(rows[rows.length - 1].updated_at) || since) : since;
    return { list: rows.map(r => expenseToJson(r, partsMap)), total: rows.length, incremental: true, watermark, server_time: Date.now() };
  }

  const agg = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM expenses WHERE ${w}`).get(...args);
  const byCategory = {};
  EXP_KEYS.forEach(k => { byCategory[k] = 0; });
  db.prepare(`SELECT category, COALESCE(SUM(amount),0) AS s FROM expenses WHERE ${w} GROUP BY category`).all(...args)
    .forEach(r => { byCategory[r.category] = round2(r.s); });

  const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 200, 1), 500);
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  const rows = db.prepare(`SELECT * FROM expenses WHERE ${w} ORDER BY spent_on DESC, created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  const partsMap = partsFor(rows.map(r => r.id));
  return {
    list: rows.map(r => expenseToJson(r, partsMap)),
    total: agg.c, amount: round2(agg.s), byCategory, page, pageSize,
    /* 全量口径同样返回服务端时间：作为客户端增量拉取游标（watermark）的起点。 */
    server_time: Date.now()
  };
}

/* ---------- AA 结算 ----------
 * 口径（保证 Σnet = 0，即「账恒平」）：
 *   · 无付款人的流水（期初历史数据 / 未指定付款人）→ 计入 unassigned，**整体不参与结算**
 *     （既不计实付、也不产生应分担），否则会出现负无穷的账目缺口
 *   · split_mode='none'（未选分摊人）→ 该笔由**付款人自己承担**（计入 self_borne），不产生债务
 *   · 其余按分摊人均分 → owed
 *   net = paid − (owed + self_borne)；>0 为应收（他人欠我），<0 为应付
 * 转账方案：按差额贪心配对，笔数 ≤ 人数 − 1
 * 精度：0.005 为冲抵阈值（半分），金额统一四舍五入到分 */
function settle(routeId) {
  const ts = listTravelers(routeId);
  const paid = {}, owed = {}, selfBorne = {};
  ts.forEach(t => { paid[t.id] = 0; owed[t.id] = 0; selfBorne[t.id] = 0; });

  const all = db.prepare('SELECT * FROM expenses WHERE route_id = ?').all(routeId);
  const partsMap = partsFor(all.map(e => e.id));
  let notSplit = 0, unassigned = 0;

  for (const e of all) {
    const a = num(e.amount);
    const byId = e.payer_id && paid[e.payer_id] !== undefined ? e.payer_id : null;
    /* 无付款人 → 无法归属，整体排除在结算之外 */
    if (!byId) { unassigned += a; continue; }
    paid[byId] += a;

    if (e.split_mode === 'none') { notSplit += a; selfBorne[byId] += a; continue; }
    const parts = (partsMap[e.id] || []).filter(id => owed[id] !== undefined);
    /* 分摊人为空（异常兜底）→ 视同自付，避免账目缺口 */
    const list = parts.length ? parts : null;
    if (!list) { notSplit += a; selfBorne[byId] += a; continue; }
    const per = a / list.length;
    list.forEach(id => { owed[id] += per; });
  }

  const rows = ts.map(t => {
    const burden = round2(owed[t.id] + selfBorne[t.id]);
    return {
      id: t.id, name: t.name, is_self: !!t.is_self,
      paid: round2(paid[t.id]),
      owed: burden,                    /* 该人实际负担（分摊份额 + 自付） */
      share: round2(owed[t.id]),       /* 其中：分摊份额 */
      self_borne: round2(selfBorne[t.id]),
      net: round2(paid[t.id] - burden)
    };
  });

  const creditors = rows.filter(r => r.net > 0.005).map(r => ({ id: r.id, name: r.name, v: r.net })).sort((a, b) => b.v - a.v);
  const debtors = rows.filter(r => r.net < -0.005).map(r => ({ id: r.id, name: r.name, v: -r.net })).sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const m = Math.min(creditors[i].v, debtors[j].v);
    if (m > 0.005) {
      transfers.push({
        from: debtors[j].id, from_name: debtors[j].name,
        to: creditors[i].id, to_name: creditors[i].name,
        amount: round2(m)
      });
    }
    creditors[i].v -= m; debtors[j].v -= m;
    if (creditors[i].v < 0.005) i++;
    if (debtors[j].v < 0.005) j++;
  }

  return {
    rows, transfers,
    summary: {
      paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
      owed: round2(rows.reduce((s, r) => s + r.owed, 0)),
      not_split: round2(notSplit),
      unassigned: round2(unassigned),
      expense_count: all.length,
      traveler_count: ts.length
    }
  };
}

/* 某路线的流水笔数与结算概览（列表页卡片用，避免逐条查询） */

/* ---------- 币种不变量维护 ----------
 * 不变量：expenses.currency 必须恒等于其所属 routes.currency。
 * 写入侧已保证（insertExpense 取路线币种；updateRoute 改币种时同步改写），
 * 本函数为**幂等修复**：校正历史库中因「改币种未重算」而残留的分叉数据。
 * 校正不改变任何金额数字，也不改变界面显示（界面一直按路线币种汇总），仅重贴标签。 */
function enforceExpenseCurrencyInvariant() {
  const r = db.prepare(`UPDATE expenses
      SET currency = (SELECT r.currency FROM routes r WHERE r.id = expenses.route_id)
      WHERE COALESCE(currency, '') <> COALESCE((SELECT r.currency FROM routes r WHERE r.id = expenses.route_id), '')`).run();
  if (r.changes) console.log(`[db] 已校正 ${r.changes} 笔流水的币种以匹配所属路线（币种不变量）`);
  return r.changes;
}

/* ---------- 备份还原：同行人 + 逐笔流水 ----------
 * 导出结构（可往返）：travelers 携带原 id 以便流水引用；expenses 的 payer_id / parts
 * 指向 travelers[].id。导入时按 id 映射重写，避免跨路线 id 冲突。 */
function exportLedger(routeId) {
  const travelers = listTravelers(routeId).map(t => ({
    id: t.id, name: t.name, is_self: !!t.is_self, sort_no: t.sort_no
  }));
  const rows = db.prepare('SELECT * FROM expenses WHERE route_id = ? ORDER BY spent_on ASC, created_at ASC').all(routeId);
  const partsMap = partsFor(rows.map(r => r.id));
  const expenses = rows.map(r => ({
    spent_on: r.spent_on || '',
    category: r.category,
    amount: num(r.amount),
    title: r.title || '',
    note: r.note || '',
    payer_id: r.payer_id || null,
    is_opening: !!r.is_opening,
    parts: (partsMap[r.id] || []).slice()
  }));
  return { travelers, expenses };
}

/* 把导出的同行人 / 流水还原到目标路线。
 * · 同行人按名称去重（同路线内不允许重名），并维护「本人」唯一性；
 * · 流水 payer_id / parts 按旧→新 id 映射改写，映射不到的（同行人缺失）退化为未指定；
 * · 流水币种统一取路线币种，维持币种不变量；
 * · 类目非法 / 金额非正的条目跳过，不阻断整体导入。 */
function importLedger(routeId, ownerId, travelers, expenses) {
  const tList = Array.isArray(travelers) ? travelers : [];
  const eList = Array.isArray(expenses) ? expenses : [];
  if (!tList.length && !eList.length) return { travelers: 0, expenses: 0 };

  const route = db.prepare('SELECT currency FROM routes WHERE id = ?').get(routeId);
  const cur = (route && route.currency) || 'CNY';
  const now = Date.now();
  const idMap = new Map();
  let tCreated = 0, eCreated = 0;

  const tx = db.transaction(() => {
    const cur0 = listTravelers(routeId);
    const exist = new Set(cur0.map(t => t.name));
    let hasSelf = cur0.some(t => t.is_self);
    let sortNo = cur0.length;
    const insT = db.prepare('INSERT INTO travelers (id, route_id, owner_id, name, is_self, sort_no, created_at) VALUES (?,?,?,?,?,?,?)');
    for (const t of tList) {
      const name = String((t && t.name) || '').trim();
      if (!name || exist.has(name)) continue;
      exist.add(name);
      const nid = uid('t');
      const selfFlag = (t.is_self && !hasSelf) ? 1 : 0;
      if (selfFlag) hasSelf = true;
      insT.run(nid, routeId, ownerId, name, selfFlag, sortNo++, now);
      if (t.id) idMap.set(String(t.id), nid);
      tCreated++;
    }

    const insE = db.prepare(`INSERT INTO expenses
        (id, route_id, owner_id, spent_on, category, amount, currency, title, note, payer_id, split_mode, is_opening, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insP = db.prepare('INSERT OR IGNORE INTO expense_parts (expense_id, traveler_id, weight) VALUES (?,?,1)');
    for (const e of eList) {
      if (!e || typeof e !== 'object') continue;
      const category = String(e.category || '').trim();
      if (!EXP_KEYS.includes(category)) continue;
      const amount = round2(num(e.amount));
      if (!(amount > 0)) continue;
      const eid = uid('e');
      const payer = e.payer_id && idMap.has(String(e.payer_id)) ? idMap.get(String(e.payer_id)) : null;
      const parts = (Array.isArray(e.parts) ? e.parts : [])
        .map(p => idMap.get(String(p))).filter(Boolean);
      const splitMode = parts.length ? 'equal' : 'none';
      insE.run(eid, routeId, ownerId, String(e.spent_on || '').slice(0, 10), category, amount, cur,
        String(e.title || '').slice(0, 200), String(e.note || '').slice(0, 500),
        payer, splitMode, e.is_opening ? 1 : 0, now, now);
      parts.forEach(p => insP.run(eid, p));
      eCreated++;
    }
    recomputeRouteAgg(routeId);
  });
  tx();
  return { travelers: tCreated, expenses: eCreated };
}

/* ============================================================================
   行程按天（景点路线 / 住宿）
   route_days 为真源；routes.scenic / routes.hotel 为由其派生的物化镜像。
   ============================================================================ */

/* 由 ISO 日期生成可读标签（如 2026-09-21 → 9月21日）；非法/空返回 '' */
function dayDateLabel(date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

function listRouteDays(routeId) {
  return db.prepare('SELECT day_index, date, scenic, hotel FROM route_days WHERE route_id = ? ORDER BY day_index ASC')
    .all(routeId)
    .map(r => ({ date: r.date || '', scenic: r.scenic || '', hotel: r.hotel || '' }));
}

/* 批量取多条路线的按天数据（列表接口用，避免 N+1） */
function daysForRoutes(ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`SELECT route_id, date, scenic, hotel FROM route_days WHERE route_id IN (${ph}) ORDER BY route_id, day_index ASC`)
    .all(...ids)
    .forEach(r => { (out[r.route_id] || (out[r.route_id] = [])).push({ date: r.date || '', scenic: r.scenic || '', hotel: r.hotel || '' }); });
  return out;
}

/* 由 route_days 生成 scenic / hotel 的物化镜像文本。
 * 有日期则加「【M月D日】」前缀（便于分享页 / 导出可读）；未分天（date=''）则原样输出，
 * 因此「历史数据未编辑」时镜像与原文逐字一致。 */
function recomputeRouteDays(routeId) {
  const rows = listRouteDays(routeId);
  const label = (d) => { const l = dayDateLabel(d); return l ? '【' + l + '】' : ''; };
  const scenic = rows.filter(r => r.scenic.trim()).map(r => label(r.date) + r.scenic).join('\n');
  const hotel = rows.filter(r => r.hotel.trim()).map(r => label(r.date) + r.hotel).join('\n');
  db.prepare('UPDATE routes SET scenic = ?, hotel = ?, updated_at = ? WHERE id = ?')
    .run(scenic, hotel, Date.now(), routeId);
  return { scenic, hotel };
}

/* 覆盖式写入某路线的按天数据（days: [{date, scenic, hotel}]），并回写镜像 */
function setRouteDays(routeId, ownerId, days) {
  const list = (Array.isArray(days) ? days : []).map((d, i) => ({
    day_index: i,
    date: String((d && d.date) || '').trim(),
    scenic: String((d && d.scenic) || ''),
    hotel: String((d && d.hotel) || '')
  }));
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM route_days WHERE route_id = ?').run(routeId);
    const ins = db.prepare(`INSERT INTO route_days
        (id, route_id, owner_id, day_index, date, scenic, hotel, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const d of list) ins.run(uid('d'), routeId, ownerId, d.day_index, d.date, d.scenic, d.hotel, now, now);
    recomputeRouteDays(routeId);
  });
  tx();
  return listRouteDays(routeId);
}

/* 由入参解析按天数据：优先 day_plans 数组；否则把 scenic / hotel 文本视作「未分天」单条。
 * 注意：字段名用 day_plans 而非 days —— routes.days 既是表字段也是前端「天数」，
 * 复用会互相覆盖（曾导致天数被按天数组覆盖的 bug）。 */
function daysFromInput(data) {
  if (Array.isArray(data.day_plans)) return data.day_plans;
  const scenic = String(data.scenic || '');
  const hotel = String(data.hotel || '');
  if (scenic || hotel) return [{ date: '', scenic, hotel }];
  return [];
}

/* 首次启动回填（幂等）：把已有 scenic / hotel（且尚无按天记录）的路线，
 * 原样迁移为一条 date='' 的「未分天」记录——不改一个字符，可回滚。
 * 不在此处解析拆分：历史文本的按天拆分交由前端打开编辑时「尽力预填」，
 * 保存后才真正结构化（避免自动改写历史内容）。 */
function migrateDaysFromScenic() {
  const routes = db.prepare(`SELECT id, owner_id, scenic, hotel FROM routes
    WHERE (scenic IS NOT NULL AND scenic != '') OR (hotel IS NOT NULL AND hotel != '')`).all();
  if (!routes.length) return 0;
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO route_days
      (id, route_id, owner_id, day_index, date, scenic, hotel, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
  const check = db.prepare('SELECT 1 FROM route_days WHERE route_id = ? LIMIT 1');
  const tx = db.transaction(() => {
    let n = 0;
    for (const r of routes) {
      if (check.get(r.id)) continue;
      ins.run(uid('d'), r.id, r.owner_id, 0, '', r.scenic || '', r.hotel || '', now, now);
      n++;
    }
    if (n) console.log(`[db] 已把历史行程迁移为「未分天」记录 ${n} 条（原样保留，编辑时可按天拆分）`);
    return n;
  });
  return tx();
}

module.exports = {
  initDb, get db() { return db; },
  EXP_KEYS, EXP_COL, num, scryptHash, uid,
  ROUTE_COLS,
  parseDateRange, routeStartMs,
  routeToJson, insertRoute, updateRoute, getRoute,
  getShareToken, setShareToken, clearShareToken, findRouteByShareToken,
  getAiConfig, saveAiConfig, getAiEnabledUserIds, isAiEnabledUser, setAiEnabledUsers,
  audit,
  /* 逐笔流水 + AA 分账 */
  recomputeRouteAgg, migrateAggregatesToOpening, enforceExpenseCurrencyInvariant,
  listTravelers, findTraveler, addTravelers, updateTraveler, deleteTraveler, travelerUsage,
  insertExpense, syncExpenseOps, updateExpense, deleteExpense, bulkDeleteExpenses, listExpenses, getExpense,
  exportLedger, importLedger,
  settle,
  /* 行程按天（景点路线 / 住宿） */
  dayDateLabel, listRouteDays, daysForRoutes, setRouteDays, recomputeRouteDays, migrateDaysFromScenic,
  /* 足迹点亮：字典 / 目的地真源 / 点亮流水 */
  seedPlaces, migrateDestToStructured, resolvePlaceRefs, listRoutePlaces, placesForRoutes,
  recomputeDestMirror, setRoutePlaces, searchPlaces,
  footprintSummary, footprintMapData, pendingRoutes, manualLit,
  round2
};
