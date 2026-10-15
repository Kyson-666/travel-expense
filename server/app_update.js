/* APP 包（APK）自更新：元数据 + 公开流式下载 + 管理端流式上传
 *
 * 存放位置：$DATA_DIR/apk/app-release.apk（随数据卷一起备份）+ apk/meta.json（版本/哈希/说明）
 * 读取时以文件实际大小为准，sha256 由上传时计算并写入元数据，客户端下载后逐字节校验。
 * 只有 meta.json 与 APK 同时存在才对外提供；否则 manifest 里 apk 为 null，APP 端完全静默。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const APK_DIR = path.join(config.DATA_DIR, 'apk');
const APK_FILE = path.join(APK_DIR, 'app-release.apk');
const META_FILE = path.join(APK_DIR, 'meta.json');
const MAX_APK = 80 * 1024 * 1024;   /* 80MB 上限：防止误传大文件占满数据卷 */

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (e) { return null; }
}

/* 当前可分发的 APK 信息；文件或元数据缺失 → null（客户端据此判定「无原生包更新」） */
function apkInfo() {
  const meta = readMeta();
  if (!meta) return null;
  let st;
  try { st = fs.statSync(APK_FILE); } catch (e) { return null; }
  const versionCode = Number(meta.versionCode) || 0;
  if (!(versionCode > 0)) return null;
  return {
    versionCode,
    versionName: String(meta.versionName || ''),
    sha256: String(meta.sha256 || ''),
    size: st.size,
    notes: String(meta.notes || '').slice(0, 1000),
    publishedAt: Number(meta.publishedAt) || 0,
    url: '/api/app/apk'
  };
}

/* 流式下载，支持 Range（断点续传）；无 APK 时返回 false 交由调用方回 404 */
function streamApk(req, res) {
  const info = apkInfo();
  if (!info) return false;
  const size = info.size;
  const headers = {
    'Content-Type': 'application/vnd.android.package-archive',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Disposition': 'attachment; filename="app-release.apk"'
  };
  let start = 0;
  let end = size - 1;
  let code = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      if (m[1] === '' && m[2] !== '') start = Math.max(0, size - parseInt(m[2], 10));
      else {
        start = parseInt(m[1], 10) || 0;
        if (m[2] !== '') end = Math.min(size - 1, parseInt(m[2], 10));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        res.end();
        return true;
      }
      code = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    }
  }
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(code, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(APK_FILE, { start, end }).pipe(res);
  return true;
}

/* 流式接收上传（application/octet-stream 原始字节），边收边算 sha256，成功后原子替换。
 * 任一步失败都不影响线上已有的 APK（写 tmp → 校验 → rename）。 */
function saveApkFrom(req, meta) {
  return new Promise((resolve, reject) => {
    const versionCode = Number(meta.versionCode) || 0;
    if (!(versionCode > 0)) return reject(new Error('versionCode 必须为正整数'));
    fs.mkdirSync(APK_DIR, { recursive: true });
    const tmp = APK_FILE + '.tmp';
    const hash = crypto.createHash('sha256');
    let size = 0;
    let done = false;
    const ws = fs.createWriteStream(tmp);
    const abort = (msg) => {
      if (done) return;
      done = true;
      try { ws.destroy(); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      reject(new Error(msg));
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_APK) { req.destroy(); abort('APK 超过 80MB 上限'); return; }
      hash.update(chunk);
    });
    req.on('error', () => abort('上传中断'));
    req.on('aborted', () => abort('上传中断'));
    ws.on('error', () => abort('写入失败'));
    ws.on('finish', () => {
      if (done) return;
      done = true;
      try {
        fs.renameSync(tmp, APK_FILE);
        const out = {
          versionCode,
          versionName: String(meta.versionName || '').trim().slice(0, 40),
          sha256: hash.digest('hex'),
          size,
          notes: String(meta.notes || '').trim().slice(0, 1000),
          publishedAt: Date.now()
        };
        fs.writeFileSync(META_FILE, JSON.stringify(out, null, 2));
        resolve(out);
      } catch (e) { reject(e); }
    });
    req.pipe(ws);
  });
}

function deleteApk() {
  let deleted = false;
  [APK_FILE, META_FILE].forEach((f) => { try { fs.unlinkSync(f); deleted = true; } catch (e) { /* ignore */ } });
  return { deleted };
}

module.exports = { apkInfo, streamApk, saveApkFrom, deleteApk, APK_DIR, APK_FILE, MAX_APK };
