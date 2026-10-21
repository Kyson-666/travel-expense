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

/* 返回 { ok, message }：ok=true 表示 Key 可用于足迹页底图；false 时 message 给出可读原因。
 * 高德说明：JS API Key 与 Web 服务 Key 互不通用 —— 管理后台引导申请的是「Web端(JS API)」Key
 * （足迹地图渲染用），而 REST 校验走的是 Web 服务通道。因此：
 *   · USERKEY_PLAT_NOMATCH = 高德已识别该 Key 且它是 JS API 类型 → **正是我们想要的**，视为通过；
 *   · INVALID_USER_KEY     = Key 本身错误 → 失败。 */
async function testMapKey(cfg) {
  const provider = cfg && cfg.provider;
  const key = String((cfg && cfg.key) || '').trim();
  if (!key) return { ok: false, message: '请先填写地图 Key' };
  try {
    if (provider === 'amap') {
      const j = await fetchJson('https://restapi.amap.com/v3/ip?key=' + encodeURIComponent(key));
      if (j && String(j.status) === '1') return { ok: true, message: '高德 Web 服务 Key 有效（省份：' + (j.province || '未知') + '）' };
      const info = (j && (j.info || j.infocode)) || '校验未通过';
      if (/USERKEY_PLAT_NOMATCH/i.test(info)) {
        return { ok: true, message: '✓ 高德已识别该 Key，类型为「Web端(JS API)」（足迹地图所需类型）——连通性测试走的 Web 服务通道对 JS Key 不适用，属预期现象。请打开足迹页展开地图实际验证底图加载。' };
      }
      if (/INVALID_USER_KEY/i.test(info)) {
        return { ok: false, message: '高德返回 INVALID_USER_KEY：Key 不存在或已删除，请核对后重新填写。' };
      }
      if (/USER_DAILY_QUERY_OVERLIMIT/i.test(info)) {
        return { ok: false, message: '高德返回：今日该 Key 的配额已用尽（不影响足迹底图展示，仅影响 REST 校验），请明日再测或忽略。' };
      }
      return { ok: false, message: '高德返回：' + info + '（若为类型问题请确认 Key 为「Web端(JS API)」）' };
    }
    if (provider === 'tencent') {
      const j = await fetchJson('https://apis.map.qq.com/ws/location/v1/ip?key=' + encodeURIComponent(key));
      if (j && j.status === 0) {
        return { ok: true, message: '腾讯位置服务 Key 有效（IP 归属：' +
          ((j.result && j.result.ad_info && (j.result.ad_info.province + ' ' + j.result.ad_info.city)) || '未知') + '）' };
      }
      const st = j && j.status;
      if (st === 111) {
        return { ok: true, message: '✓ 腾讯已识别该 Key，但启用了域名/IP 白名单导致服务端校验请求被拒 —— 请以足迹页实际加载为准（把你的站点域名加入该 Key 的域名白名单即可）。' };
      }
      if (st === 112) {
        return { ok: false, message: '该 Key 未开通 WebServiceAPI：请在腾讯位置服务控制台 → 应用管理 → 编辑该 Key → 勾选「WebServiceAPI」后重新测试。' };
      }
      return { ok: false, message: '腾讯返回：' + ((j && j.message) || '校验未通过') + '（status=' + (st || '?') + '，常见：Key 格式错误 / 未启用 WebServiceAPI / 配额限制）' };
    }
    return { ok: false, message: '未知的图商类型' };
  } catch (e) {
    return { ok: false, message: netErrorHint(e) };
  }
}

module.exports = { testMapKey };
