/* 前端路由解析/构建回归测试（node --test，无需依赖） */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = new URL('..', import.meta.url).pathname;
const src = fs.readFileSync(`${REPO}public/route.js`, 'utf8');

const load = () => {
  const ctx = {
    window: {},
    location: { href: 'https://x.test/', origin: 'https://x.test' },
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, console,
  };
  ctx.window.addEventListener = () => {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.AppRoute;
};
const R = load();

test('列表：无参数与筛选参数', () => {
  assert.deepEqual({ ...R.parse('https://x.test/') }, { kind: 'list', state: null, q: null });
  assert.deepEqual({ ...R.parse('https://x.test/?state=open&q=csv') }, { kind: 'list', state: 'open', q: 'csv' });
  /* 非法 state 忽略 */
  assert.deepEqual({ ...R.parse('https://x.test/?state=bogus') }, { kind: 'list', state: null, q: null });
});

test('列表 URL 构建', () => {
  assert.equal(R.build({ kind: 'list' }), '/');
  assert.equal(R.build({ kind: 'list', state: 'merged' }), '/?state=merged');
  assert.equal(R.build({ kind: 'list', q: '中文 关键字' }), '/?q=%E4%B8%AD%E6%96%87+%E5%85%B3%E9%94%AE%E5%AD%97');
});

test('PR：默认文件与无锚点', () => {
  assert.deepEqual({ ...R.parse('https://x.test/pr/16') },
    { kind: 'pr', n: 16, file: null, mode: null, commit: null, line: null, endLine: null, heading: null });
  assert.equal(R.build({ kind: 'pr', n: 16 }), '/pr/16');
});

test('PR：提交视图参数往返与非法 sha 忽略', () => {
  const sha = '72a8b8132f0dcf12f22f684d8a69af800041f49a';
  const url = R.build({ kind: 'pr', n: 16, file: 'a/b.md', commit: sha, mode: 'split' });
  assert.equal(url, `/pr/16/blob/a/b.md?mode=split&commit=${sha}`);
  const parsed = R.parse(`https://x.test${url}`);
  assert.equal(parsed.commit, sha);
  assert.equal(parsed.file, 'a/b.md');

  /* 大写归一为小写；非十六进制或过短的值丢弃 */
  assert.equal(R.parse(`https://x.test/pr/16?commit=${sha.toUpperCase()}`).commit, sha);
  assert.equal(R.parse('https://x.test/pr/16?commit=zzzz').commit, null);
  assert.equal(R.parse('https://x.test/pr/16?commit=abc').commit, null);
  assert.equal(R.build({ kind: 'pr', n: 16, commit: null }), '/pr/16');
});

test('PR：中文路径按段编码，往返一致', () => {
  const path = 'docs/区域银行智能研发解决方案/README.md';
  const url = R.build({ kind: 'pr', n: 16, file: path, mode: 'reading' });
  assert.ok(url.startsWith('/pr/16/blob/docs/%E5%8C%BA%E5%9F%9F'), url);
  assert.ok(url.includes('/README.md'));
  assert.ok(!url.includes('?mode='), '默认视图不写进 URL');
  assert.equal(R.parse(`https://x.test${url}`).file, path);
});

test('PR：模式与行范围', () => {
  const url = R.build({ kind: 'pr', n: 16, file: 'a/b.md', mode: 'split', line: 120, endLine: 140 });
  assert.equal(url, '/pr/16/blob/a/b.md?mode=split#L120-L140');
  const parsed = R.parse(`https://x.test${url}`);
  assert.equal(parsed.mode, 'split');
  assert.equal(parsed.line, 120);
  assert.equal(parsed.endLine, 140);
});

test('PR：单行锚点与标题锚点', () => {
  assert.equal(R.build({ kind: 'pr', n: 16, file: 'a.md', line: 7 }), '/pr/16/blob/a.md#L7');
  const single = R.parse('https://x.test/pr/16/blob/a.md#L7');
  assert.deepEqual({ line: single.line, endLine: single.endLine, heading: single.heading },
    { line: 7, endLine: null, heading: null });

  const head = R.build({ kind: 'pr', n: 16, file: 'a.md', heading: '总体方案与双路线' });
  assert.ok(head.includes('#%E6%80%BB%E4%BD%93'), head);
  assert.equal(R.parse(`https://x.test${head}`).heading, '总体方案与双路线');
});

test('锚点解析：大小写、倒序范围、非法值', () => {
  assert.deepEqual({ ...R.parseAnchor('#l120') }, { line: 120, endLine: null, heading: null });
  assert.deepEqual({ ...R.parseAnchor('#L140-L120') }, { line: 140, endLine: null, heading: null });
  assert.deepEqual({ ...R.parseAnchor('#L0') }, { line: null, endLine: null, heading: null });
  assert.deepEqual({ ...R.parseAnchor('') }, { line: null, endLine: null, heading: null });
});

test('特殊字符路径：井号、问号、百分号、空格', () => {
  const path = 'docs/带#井号 和?问号/100%.md';
  const url = R.build({ kind: 'pr', n: 3, file: path });
  assert.ok(!url.includes('#井'), '路径里的 # 必须被编码');
  assert.equal(R.parse(`https://x.test${url}`).file, path);
});

test('未知路径回列表，PR 号补零可解析', () => {
  assert.equal(R.parse('https://x.test/nope').kind, 'list');
  const zero = R.parse('https://x.test/pr/016');
  assert.equal(zero.n, 16);
});

test('doc 页保持原语义', () => {
  const doc = R.parse('https://x.test/doc/docs/%E4%B8%AD%E6%96%87.md?ref=abc#%E6%A0%87%E9%A2%98');
  assert.equal(doc.kind, 'doc');
  assert.equal(doc.path, 'docs/中文.md');
  assert.equal(doc.search, '?ref=abc');
  assert.equal(R.build(doc), '/doc/docs/%E4%B8%AD%E6%96%87.md?ref=abc#%E6%A0%87%E9%A2%98');
});
