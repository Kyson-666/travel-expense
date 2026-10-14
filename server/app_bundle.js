/* APP 热更新支持（web 层增量更新）
 *
 * 原理：安卓 Capacitor 壳启动时拉取本模块生成的 manifest（每个 web 文件的 sha256 指纹），
 * 与本地已下载版本对比，仅下载变化文件到应用私有目录，再通过 Bridge.setServerBasePath 切换。
 *
 * 两个公开接口（无需登录，APP 启动时尚无登录态）：
 *   GET /api/app/manifest        -> { version, generatedAt, files:[{path,sha256,size}] }
 *   GET /api/app/file?path=xxx   -> 单个 web 文件原始字节（严格限定在 public 目录内）
 *
 * 无任何新依赖：sha256 用内置 crypto，文件遍历用内置 fs。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
};

/* 递归列出目录下所有文件，返回相对路径（统一用 / 分隔，与 URL 一致） */
function walkDir(dir, base = '') {
  const result = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return result;
  }
  for (const e of entries) {
    const rel = base ? base + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      result.push(...walkDir(full, rel));
    } else if (e.isFile()) {
      result.push(rel);
    }
  }
  return result;
}

/* manifest 缓存：以 public 目录内最新 mtime 为失效依据，文件不变时不重复算 hash */
let cache = { latestMtime: -1, manifest: null };

/* 生成 web 资源清单：每个文件 sha256 + size，整体聚合 hash 作为 version 指纹 */
function getManifest() {
  const rels = walkDir(PUBLIC_DIR).sort();
  let latestMtime = 0;
  const files = [];
  for (const rel of rels) {
    const full = path.join(PUBLIC_DIR, rel.split('/').join(path.sep));
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
    const content = fs.readFileSync(full);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    files.push({ path: rel, sha256, size: stat.size });
  }
  if (cache.manifest && cache.latestMtime === latestMtime) return cache.manifest;

  const agg = crypto.createHash('sha256');
  for (const f of files) agg.update(f.path + ':' + f.sha256 + ':' + f.size + ';');
  const version = agg.digest('hex').slice(0, 12);

  const manifest = { version, generatedAt: Date.now(), files };
  cache = { latestMtime, manifest };
  return manifest;
}

/* 安全解析请求的相对路径，严格限定在 PUBLIC_DIR 内，防目录穿越 */
function resolveSafeFile(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  /* 统一为正斜杠，去掉开头的 / 和 query（parseUrl 已分离 query，这里双保险） */
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '').split('?')[0].split('#')[0];
  if (!cleaned || cleaned.includes('\0')) return null;
  const full = path.normalize(path.join(PUBLIC_DIR, cleaned.split('/').join(path.sep)));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  } catch (e) {
    return null;
  }
  return full;
}

module.exports = { getManifest, resolveSafeFile, PUBLIC_DIR, MIME };
