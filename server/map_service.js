/* 地图服务：图商 key 连通性测试（服务端出网）
 * - amap：restapi.amap.com/v3/ip（Web 服务 API，status=1 即有效）
 * - tencent：apis.map.qq.com/ws/location/v1/ip（status=0 即有效）
 * 使用 Node 18+ 内置全局 fetch，5 秒超时；测试本身不消耗展示类配额
 * （仅一次 REST 校验，且仅在管理员点击「测试连通性」时发生）。 */
'use strict';

const TIMEOUT_MS = 5000;

function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'travel-expense-map-test' } })
    .then(r => r.json())
    .finally(() => clearTimeout(timer));
}

/* 提取网络层失败原因（DNS / 超时 / 证书），给管理员可操作提示 */
function netErrorHint(e) {
  const code = (e && e.cause && e.cause.code) || (e && e.name) || '';
  if (code === 'AbortError' || /timeout/i.test(String(e && e.message))) return '请求超时（5 秒），请检查服务器能否访问图商接口。';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS 解析失败，请检查服务器网络。';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return '网络连接失败，请检查防火墙/出网规则。';
  if (/cert/i.test(code)) return 'SSL 证书验证失败（' + code + '）。';
  return '网络请求失败：' + ((e && e.message) || code || '未知错误');
}

/* 返回 { ok, message }：ok=true 表示 key 有效；false 时 message 给出可读原因 */
async function testMapKey(cfg) {
  const provider = cfg && cfg.provider;
  const key = String((cfg && cfg.key) || '').trim();
  if (!key) return { ok: false, message: '请先填写地图 Key' };
  try {
    if (provider === 'amap') {
      const j = await fetchJson('https://restapi.amap.com/v3/ip?key=' + encodeURIComponent(key));
      if (j && String(j.status) === '1') return { ok: true, message: '高德 Key 有效（省份：' + (j.province || '未知') + '）' };
      return { ok: false, message: '高德返回：' + ((j && (j.info || j.infocode)) || '校验未通过') +
        '（若为 INVALID_USER_KEY 请核对 Key；若为 USER_DAILY_QUERY_OVERLIMIT 表示今日配额已用尽）' };
    }
    if (provider === 'tencent') {
      const j = await fetchJson('https://apis.map.qq.com/ws/location/v1/ip?key=' + encodeURIComponent(key));
      if (j && j.status === 0) return { ok: true, message: '腾讯位置服务 Key 有效（IP 归属：' +
        ((j.result && j.result.ad_info && (j.result.ad_info.province + ' ' + j.result.ad_info.city)) || '未知') + '）' };
      return { ok: false, message: '腾讯返回：' + ((j && j.message) || '校验未通过') + '（status=' + ((j && j.status) || '?') + '，常见：key 格式错误 / 域名或配额限制）' };
    }
    return { ok: false, message: '未知的图商类型' };
  } catch (e) {
    return { ok: false, message: netErrorHint(e) };
  }
}

module.exports = { testMapKey };
