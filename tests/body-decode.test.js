/* 单测：readBody 请求体解码（无服务端，直接构造 req 流）
 * 运行：node tests/body-decode.test.js
 * 覆盖：
 *   1) 多字节字符被切在任意分片边界时不损坏（P1-1 回归：逐片 toString 会解成 U+FFFD）
 *   2) 单字节分片（最坏分片）同样正确
 *   3) 空请求体 → {}
 *   4) 非法 JSON → 报错
 *   5) 超限（>6MB 字节）→ 拒绝且销毁连接
 *   6) 解码后超 200 万字符 → 拒绝（业务上限）
 */
'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { readBody } = require(path.join(__dirname, '..', 'server', 'http.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

/* 构造一个只实现 readBody 所需接口的假 req：按给定分片依次 data → end */
function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  process.nextTick(() => {
    for (const c of chunks) { if (req.destroyed) return; req.emit('data', c); }
    if (!req.destroyed) req.emit('end');
  });
  return req;
}

async function parseWithChunks(chunks) {
  return readBody(fakeReq(chunks));
}

async function main() {
  section('1. 多字节字符切在任意分片边界');
  const payload = { note: '中文备注·日本語·한국어·emoji😀', title: '东京 2026 赏樱', amount: 123.45 };
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  let badAt = [];
  for (let i = 1; i < buf.length; i++) {
    const got = await parseWithChunks([buf.subarray(0, i), buf.subarray(i)]);
    if (JSON.stringify(got) !== JSON.stringify(payload)) badAt.push(i);
  }
  check('在全部 ' + (buf.length - 1) + ' 个字节边界切分均能正确还原', badAt.length === 0,
    badAt.length ? badAt.slice(0, 10) : undefined);

  section('2. 单字节分片（最坏分片）');
  const oneByte = Array.from(buf, b => Buffer.from([b]));
  const got2 = await parseWithChunks(oneByte);
  check('逐字节投递仍正确还原（含 emoji 四字节序列）', JSON.stringify(got2) === JSON.stringify(payload));

  section('3. 空请求体');
  check('空 body → {}', JSON.stringify(await parseWithChunks([])) === '{}');
  check('仅空白 body → {}', JSON.stringify(await parseWithChunks([Buffer.from('  \n ') ])) === '{}');

  section('4. 非法 JSON');
  let invalid = null;
  try { await readBody(fakeReq([Buffer.from('{"a":')])); } catch (e) { invalid = e; }
  check('非法 JSON → invalid json', !!invalid && /invalid json/.test(invalid.message), invalid && invalid.message);

  section('5. 字节超限');
  const big = Buffer.alloc(6e6 + 1, 0x7b);   // 6MB+1 的 '{'
  const req5 = fakeReq([big]);
  let tooBig = null;
  try { await readBody(req5); } catch (e) { tooBig = e; }
  check('>6MB 字节 → body too large', !!tooBig && /body too large/.test(tooBig.message), tooBig && tooBig.message);
  check('超限后销毁连接（停止继续读取）', req5.destroyed === true);

  section('6. 字符数超限（业务上限 200 万字符）');
  /* 合法 JSON 字符串：2,000,001 个 ASCII 字符（字节数 2,000,003 < 6MB，先过字节闸门） */
  const huge = Buffer.from('"' + 'a'.repeat(2000001) + '"');
  let tooLong = null;
  try { await readBody(fakeReq([huge])); } catch (e) { tooLong = e; }
  check('解码后 >200 万字符 → body too large', !!tooLong && /body too large/.test(tooLong.message), tooLong && tooLong.message);

  console.log('\n===== readBody 单测：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
}

main().catch(e => { console.error('单测异常：', e); process.exit(2); });
