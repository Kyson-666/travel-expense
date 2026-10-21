/* 通用 HTTP 工具：JSON 响应 / 请求体解析 / Cookie / URL 解析 */
'use strict';

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function ok(res, data) { send(res, 200, { ok: true, data }); }
function created(res, data) { send(res, 201, { ok: true, data }); }
function fail(res, code, msg, extra) {
  const body = { ok: false, msg };
  if (extra) Object.assign(body, extra);
  send(res, code, body);
}
/* 请求体上限：
 *   MAX_BODY_CHARS 为业务上限（沿用既有 200 万字符口径，按 UTF-16 字符单元计），
 *   MAX_BODY_BYTES 为内存护栏 = 字符上限 × 3。
 *   依据：UTF-16 每个字符单元在 UTF-8 中最多占 3 字节（BMP 汉字即 3 字节；辅助平面
 *   字符如 emoji 占 2 个单元 / 4 字节，折合 2 字节每单元）。因此「≤200 万单元」的请求
 *   其字节数必然 ≤ 6MB，先按 6MB 字节截断不会误杀任何原本合法的请求。 */
const MAX_BODY_CHARS = 2e6;
const MAX_BODY_BYTES = MAX_BODY_CHARS * 3;

/* 解析 JSON 请求体。
 * **必须收集 Buffer 后一次性解码**：Node 的 data 事件按 TCP 分段投递，逐片 toString()
 * 会把落在分片边界上的多字节字符解成 U+FFFD（中文备份导入、长备注等大请求会静默损坏）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const abort = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
      req.destroy();
    };
    req.on('data', (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length;
      if (bytes > MAX_BODY_BYTES) return abort(new Error('body too large'));
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      if (text.length > MAX_BODY_CHARS) return reject(new Error('body too large'));
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) {
      const key = p.slice(0, i).trim();
      const rawVal = p.slice(i + 1).trim();
      try { out[key] = decodeURIComponent(rawVal); } catch (e) { out[key] = rawVal; }
    }
  });
  return out;
}
function parseUrl(raw) {
  const u = new URL(raw || '/', 'http://localhost');
  const query = {};
  u.searchParams.forEach((v, k) => { query[k] = v; });
  return { pathname: u.pathname, query };
}

/* 转义 LIKE 通配符 % 和 _（防止用户输入被当作通配符），用户/路线搜索共用单一实现 */
function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

module.exports = { send, ok, created, fail, readBody, parseCookies, parseUrl, escapeLike };