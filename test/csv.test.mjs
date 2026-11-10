/* CSV 解析 / 行级差异 / 数据表渲染回归测试（node --test，无需依赖） */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = new URL('..', import.meta.url).pathname;
const modelSrc = fs.readFileSync(`${REPO}public/diff-model.js`, 'utf8');
const diffSrc = fs.readFileSync(`${REPO}public/diff.js`, 'utf8');

function loadModel() {
  // 在主 realm 里执行，避免跨 context 的数组原型导致 deepStrictEqual 失败
  const prev = globalThis.window;
  globalThis.window = {};
  try {
    vm.runInThisContext(modelSrc);
    return globalThis.window.DiffModel;
  } finally {
    globalThis.window = prev;
  }
}

const model = loadModel();

/* diff-model 里的 window.marked 是运行时全局：这些用例临时挂上真实 marked。 */
const markedSrc = fs.readFileSync(`${REPO}public/marked.min.js`, 'utf8');
const marked = (() => {
  const c = { module: { exports: {} }, exports: {}, window: {}, self: {} };
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(markedSrc, c);
  return c.exports.marked;
})();
const withMarked = (fn) => {
  const prev = globalThis.window;
  globalThis.window = { marked };
  try { return fn(); } finally { globalThis.window = prev; }
};

function mountView() {
  const els = new Map();
  const classList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
      toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
    };
  };
  const el = (id) => ({
    id, hidden: true, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    scrollTop: 0, dataset: {}, style: {}, classList: classList(),
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0 }; }, setSelectionRange() {}, focus() {}, closest() { return null; },
    setAttribute() {}, getAttribute() { return 'true'; }, removeAttribute() {},
  });
  const store = {};
  const ctx = {
    window: { DiffModel: model, innerWidth: 1200, getSelection: () => null },
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
      querySelectorAll() { return []; },
      addEventListener() {},
      activeElement: null,
      body: { classList: classList() },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    crypto: { randomUUID: () => 'id' },
    setTimeout, clearTimeout, URL, console,
    requestAnimationFrame: (fn) => fn(),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const ANCHOR = '  let bound = false;';
  const exposed = diffSrc.replace(ANCHOR,
    `  window.__D = D; window.__reading = csvReadingHTML; window.__sb = csvSideBySideHTML; window.__locate = locateFromSelection; window.__commentBody = commentBody; window.__tools = csvToolsHTML;\n${ANCHOR}`);
  vm.runInContext(exposed, ctx);
  return ctx.window;
}

const win = mountView();
const fileOf = (extra) => ({
  path: 'data/账目.csv', previousPath: null, status: 'modified', additions: 2, deletions: 2,
  patch: null, isMarkdown: false, ...extra,
});
const mountFile = (file, base, head) => {
  win.__D.meta = { number: 1, headSha: 'h1', baseSha: 'b1', url: 'https://github.com/x/y/pull/1' };
  /* 正文缓存按视图分区（revKey）：测试里直接用当前分区的储位 */
  win.__D.texts[win.__D.revKey] ||= {};
  win.__D.texts[win.__D.revKey][file.path] = {
    base, head, headLoaded: true, baseLoaded: true, headTruncated: false, baseTruncated: false,
  };
  return file;
};

/* ---------- 解析 ---------- */

test('csvParse：基础字段、行号与列数', () => {
  const parsed = model.csvParse('id,name\n1,张三\n2,李四\n');
  assert.equal(parsed.columns, 2);
  assert.deepEqual(parsed.rows.map((r) => [r.startLine, r.endLine, r.cells]),
    [[1, 1, ['id', 'name']], [2, 2, ['1', '张三']], [3, 3, ['2', '李四']]]);
});

test('csvParse：引号内逗号、转义引号与换行', () => {
  const parsed = model.csvParse('a,"b,1","say ""hi"""\n1,"x\ny",2');
  assert.deepEqual(parsed.rows[0].cells, ['a', 'b,1', 'say "hi"']);
  assert.deepEqual(parsed.rows[1].cells, ['1', 'x\ny', '2']);
  assert.deepEqual([parsed.rows[1].startLine, parsed.rows[1].endLine], [2, 3]);
  assert.equal(parsed.columns, 3);
});

test('csvParse：BOM / CRLF / 空行 / 末尾换行', () => {
  const parsed = model.csvParse('\uFEFFa,b\r\n\r\n1,2\r\n');
  assert.deepEqual(parsed.rows.map((r) => r.cells), [['a', 'b'], [''], ['1', '2']]);
  assert.deepEqual(parsed.rows.map((r) => r.startLine), [1, 2, 3]);
  assert.equal(model.csvParse('').rows.length, 0);
  assert.equal(model.csvParse('\n').rows.length, 1);
});

/* ---------- 行级差异 ---------- */

const BASE = 'id,name,amount\n1,张三,100\n2,李四,200\n3,王五,300';
const HEAD = 'id,name,amount\n1,张三,120\n2,李四,200\n4,赵六,400';
const PATCH_MOD = [
  '@@ -1,4 +1,4 @@',
  ' id,name,amount',
  '-1,张三,100',
  '+1,张三,120',
  ' 2,李四,200',
  '-3,王五,300',
  '+4,赵六,400',
].join('\n');

test('csvModel：成对增删记作"修改行"，并标出变化的列', () => {
  const csv = model.csvModel(HEAD, BASE, PATCH_MOD);
  const rows = csv.head.rows;
  assert.deepEqual(rows.map((r) => r.state), ['normal', 'modified', 'normal', 'modified']);
  assert.deepEqual(Array.from(rows[1].changedCells), [2]);
  assert.deepEqual(rows[1].before.cells, ['1', '张三', '100']);
  assert.deepEqual(Array.from(rows[3].changedCells), [0, 1, 2]);
  assert.deepEqual(csv.stats, { added: 0, modified: 2, removed: 0 });
  assert.deepEqual(rows.map((r) => r.commentLine), [1, 2, 3, 4]);
});

test('csvModel：纯删除行记录落点，纯新增行标为新增', () => {
  const del = model.csvModel('id,name\n1,a\n3,c', 'id,name\n1,a\n2,b\n3,c', [
    '@@ -1,4 +1,3 @@',
    ' id,name',
    ' 1,a',
    '-2,b',
    ' 3,c',
  ].join('\n'));
  assert.deepEqual(del.removed.map((item) => [item.row.startLine, item.afterLine]), [[3, 2]]);
  assert.deepEqual(del.stats, { added: 0, modified: 0, removed: 1 });

  const add = model.csvModel('id,name\n1,a\n2,b\n3,c', 'id,name\n1,a\n3,c', [
    '@@ -1,3 +1,4 @@',
    ' id,name',
    ' 1,a',
    '+2,b',
    ' 3,c',
  ].join('\n'));
  assert.deepEqual(add.head.rows.map((r) => r.state), ['normal', 'normal', 'added', 'normal']);
  assert.deepEqual(add.head.rows[2].changedCells, null);
  assert.deepEqual(add.stats, { added: 1, modified: 0, removed: 0 });
});

test('csvModel：整份新增文件的所有行都是新增行', () => {
  const csv = model.csvModel('a,b\n1,2\n3,4', '', [
    '@@ -0,0 +1,3 @@',
    '+a,b',
    '+1,2',
    '+3,4',
  ].join('\n'));
  assert.deepEqual(csv.head.rows.map((r) => r.state), ['added', 'added', 'added']);
  assert.deepEqual(csv.head.rows.map((r) => r.commentLine), [1, 2, 3]);
});

test('csvModel：跨行记录只按一行改动也标记整行为修改', () => {
  const base = 'id,note\n1,"a\nb"\n2,c';
  const head = 'id,note\n1,"a\nB"\n2,c';
  const patch = [
    '@@ -1,4 +1,4 @@',
    ' id,note',
    ' 1,"a',
    '-b"',
    '+B"',
    ' 2,c',
  ].join('\n');
  const csv = model.csvModel(head, base, patch);
  const row = csv.head.rows[1];
  assert.deepEqual([row.startLine, row.endLine], [2, 3]);
  assert.equal(row.state, 'modified');
  assert.deepEqual(Array.from(row.changedCells), [1]);
  assert.equal(row.before.cells[1], 'a\nb');
  assert.deepEqual(csv.head.rows[2].state, 'normal');
});

test('csvModel：表头变化保留旧表头与变化列', () => {
  const csv = model.csvModel('id,金额\n1,2', 'id,amount\n1,2', [
    '@@ -1,2 +1,2 @@',
    '-id,amount',
    '+id,金额',
    ' 1,2',
  ].join('\n'));
  const header = csv.head.rows[0];
  assert.equal(header.state, 'modified');
  assert.deepEqual(header.before.cells, ['id', 'amount']);
  assert.deepEqual(Array.from(header.changedCells), [1]);
});

/* ---------- 渲染 ---------- */

test('阅读视图：表头、修改行、旧行与列高亮', () => {
  const file = mountFile(fileOf({ patch: PATCH_MOD }), BASE, HEAD);
  const html = win.__reading(file);
  assert.ok(html.includes('<div class="table-shell is-csv"'));
  assert.ok(html.includes('<span class="tstat">4 行 · 3 列 · 首行为表头'));
  assert.ok(html.includes('<span class="csv-delta">~2</span>'));
  assert.ok(html.includes('data-tbl="only"'), '宽表工具条：仅看变化行');
  assert.ok(html.includes('data-tbl="cols"'), '宽表工具条：列设置');
  assert.ok(html.includes('data-tbl="full"'), '宽表工具条：全屏');
  assert.ok(html.includes('<div class="tscroll"'), '横向滚动容器');
  assert.ok(html.includes('<thead><tr class="csv-row is-header"'));
  assert.equal((html.match(/<tr class="csv-row is-modified"/g) || []).length, 2);
  assert.equal((html.match(/<tr class="csv-row is-removed"/g) || []).length, 2);
  assert.ok(html.includes('<td data-col="2" data-label="amount" class="is-changed">120</td>'));
  assert.ok(html.includes('data-comment-line="2"'));
  assert.ok(html.includes('<span class="line-anchor" data-line="2"'), '改动行可直接评论');
  assert.equal((html.match(/class="line-anchor"/g) || []).length, 4, 'hunk 内的行都有行号锚点');
});

test('阅读视图：未改动区域的行没有评论锚点', () => {
  // 第 3 行在 hunk 外时不能评论（GitHub 只接受 diff 行）
  const base = 'id,name\n1,a\n2,b\n3,c';
  const head = 'id,name\n1,a\n2,b\n3,C';
  const patch = ['@@ -4,1 +4,1 @@', '-3,c', '+3,C'].join('\n');
  const file = mountFile(fileOf({ path: 'data/x.csv', patch }), base, head);
  const html = win.__reading(file);
  assert.equal((html.match(/class="line-anchor"/g) || []).length, 1);
  assert.ok(html.includes('data-comment-line="4"'));
  assert.ok(!html.includes('data-comment-line="3"'));
});

test('阅读视图：纯删除行插回原位，插在删除点后的记录之前', () => {
  const base = 'id,name\n1,a\n2,b\n3,c';
  const head = 'id,name\n1,a\n3,c';
  const patch = ['@@ -1,4 +1,3 @@', ' id,name', ' 1,a', '-2,b', ' 3,c'].join('\n');
  const file = mountFile(fileOf({ patch }), base, head);
  const html = win.__reading(file);
  const removedAt = html.indexOf('<td data-col="0" data-label="id">2</td>');
  const nextRow = html.indexOf('data-line="3"');
  assert.ok(removedAt > 0 && removedAt < nextRow, '删除行应出现在 L3 之前');
  assert.ok(html.includes('<span class="csv-num">−3</span>'), '删除行显示原 Base 行号');
});

test('阅读视图：单元格内容按文本转义', () => {
  const base = 'a,b\n1,2';
  const head = 'a,b\n<img src=x onerror=alert(1)>,2';
  const patch = ['@@ -2,1 +2,1 @@', '-1,2', '+<img src=x onerror=alert(1)>,2'].join('\n');
  const file = mountFile(fileOf({ path: 'data/escape.csv', patch }), base, head);
  const html = win.__reading(file);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'));
});

test('阅读视图：缺 patch 的修改文件给出 GitHub 跳转提示', () => {
  const file = mountFile(fileOf({ patch: null }), BASE, HEAD);
  const html = win.__reading(file);
  assert.ok(html.includes('GitHub 未返回该文件的差异'));
});

test('阅读视图：新增文件不逐行标注，但显式说明是新增文件', () => {
  const file = mountFile(fileOf({ path: 'data/new.csv', status: 'added', patch: null }), '', 'a,b\n1,2');
  const html = win.__reading(file);
  assert.ok(html.includes('class="added-note"'), '顶部有新增文件说明');
  assert.ok(html.includes('<span class="diff-tag add">新增</span>'), '工具条仍标出新增');
  assert.ok(html.includes('全部行均为新增'));
  assert.ok(!html.includes('is-added'), '整表新增时不再逐行涂色');
});

test('前后对照：Base 侧标出被替换行，Head 侧标出修改行', () => {
  const file = mountFile(fileOf({ patch: PATCH_MOD }), BASE, HEAD);
  const html = win.__sb(file);
  assert.equal((html.match(/class="csv-table"/g) || []).length, 2);
  assert.equal((html.match(/<tr class="csv-row is-partial"/g) || []).length, 2);
  assert.equal((html.match(/<tr class="csv-row is-modified"/g) || []).length, 2);
  assert.ok(html.includes('data-old-line="2"'), 'Base 行用旧行号定位');
});

/* ---------- 选区定位 ---------- */

test('选区定位：多行列表块里按 <li data-line> 落到具体列表项（含跨行项）', () => {
  /* 第 3 行起是有序列表；第一项折行到第 4 行，第二项在第 5 行 */
  const HEAD = '前文\n\n1. 第一条\n   折行内容\n2. 第二条\n';
  const file = fileOf({ path: 'docs/list.md', isMarkdown: true, additions: 5, deletions: 0 });
  mountFile(file, '', HEAD);
  win.__D.files = [file];
  win.__D.file = file.path;
  const makeNode = (line) => ({
    nodeType: 1,
    dataset: { line: String(line) },
    closest(sel) {
      if (sel === '.md-block[data-line][data-end-line]') return { dataset: { line: '3', endLine: '5' } };
      if (sel === 'li[data-line]') return this;
      return null;
    },
  });
  assert.deepEqual({ ...withMarked(() => win.__locate({ anchorNode: makeNode(3), focusNode: makeNode(3) })) },
    { start: 3, end: 4 });
  assert.deepEqual({ ...withMarked(() => win.__locate({ anchorNode: makeNode(5), focusNode: makeNode(5) })) },
    { start: 5, end: 5 });
});

test('选区定位：跨多个列表项取首尾范围', () => {
  const file = fileOf({ path: 'docs/list2.md', isMarkdown: true, additions: 3, deletions: 0 });
  mountFile(file, '', '1. 甲\n2. 乙\n3. 丙\n');
  win.__D.files = [file];
  win.__D.file = file.path;
  const makeNode = (line) => ({
    nodeType: 1,
    dataset: { line: String(line) },
    closest(sel) {
      if (sel === '.md-block[data-line][data-end-line]') return { dataset: { line: '1', endLine: '3' } };
      if (sel === 'li[data-line]') return this;
      return null;
    },
  });
  const r = withMarked(() => win.__locate({ anchorNode: makeNode(1), focusNode: makeNode(3) }));
  assert.deepEqual({ ...r }, { start: 1, end: 3 });
});

test('选区定位：表格行按 <tr data-line> 落到该行', () => {
  const cell = {
    nodeType: 1,
    closest(sel) {
      if (sel === 'tr[data-line]') return { dataset: { line: '12' } };
      if (sel === '.md-block[data-line][data-end-line]') return { dataset: { line: '9', endLine: '14' } };
      return null;
    },
  };
  assert.deepEqual({ ...win.__locate({ anchorNode: cell, focusNode: cell }) }, { start: 12, end: 12 });
});

test('选区定位：多行段落按选中文字收窄到具体行', () => {
  const HEAD = '标题\n\n第一行内容\n第二行内容\n第三行内容\n';
  const file = fileOf({ path: 'docs/para.md', isMarkdown: true, additions: 5, deletions: 0 });
  mountFile(file, '', HEAD);
  win.__D.files = [file];
  win.__D.file = file.path;
  const block = { nodeType: 1, dataset: { line: '3', endLine: '5' },
    closest(sel) { return sel === '.md-block[data-line][data-end-line]' ? this : null; } };
  const sel = { anchorNode: block, focusNode: block, toString: () => '第二行内容' };
  assert.deepEqual({ ...withMarked(() => win.__locate(sel)) }, { start: 4, end: 4 });
});

test('选区定位：文字匹配不到时回退整块范围，不拒绝', () => {
  const file = fileOf({ path: 'docs/para2.md', isMarkdown: true, additions: 5, deletions: 0 });
  mountFile(file, '', '标题\n\n甲\n乙\n丙\n');
  win.__D.files = [file];
  win.__D.file = file.path;
  const block = { nodeType: 1, dataset: { line: '3', endLine: '5' },
    closest(sel) { return sel === '.md-block[data-line][data-end-line]' ? this : null; } };
  const sel = { anchorNode: block, focusNode: block, toString: () => '完全对不上的文字' };
  assert.deepEqual({ ...withMarked(() => win.__locate(sel)) }, { start: 3, end: 5 });
});

test('选区定位：多行段落退到整块范围（有文字可反查时再收窄）', () => {
  const node = {
    nodeType: 1,
    closest(sel) {
      if (sel === '.md-block[data-line][data-end-line]') return { dataset: { line: '10', endLine: '14' } };
      return null;
    },
  };
  assert.deepEqual({ ...win.__locate({ anchorNode: node, focusNode: node }) }, { start: 10, end: 14 });
  /* 块外（不属于任何块）仍然拒绝 */
  const outside = { nodeType: 1, closest() { return null; } };
  assert.equal(win.__locate({ anchorNode: outside, focusNode: outside }), null);
});

test('工具条：新增文件不给“仅看变化行”', () => {
  assert.ok(win.__tools().includes('仅看变化行'));
  assert.ok(!win.__tools({ noRows: true }).includes('仅看变化行'));
  assert.ok(win.__tools({ noRows: true }).includes('全屏'));
});

test('评论正文：文字评论附路径与行号范围', () => {
  const body = win.__commentBody({
    path: 'docs/区域银行智能研发解决方案/README.md', start: 3, end: 7,
    quote: '填写原则', body: '这一节需要补链接。', unanchored: true,
  });
  assert.ok(body.startsWith('> 填写原则'));
  assert.ok(body.includes('这一节需要补链接。'));
  assert.ok(body.includes('`docs/区域银行智能研发解决方案/README.md` L3–L7'));
  assert.ok(body.includes('按文字评论提交'));
  /* 单行时只写 L7 */
  const single = win.__commentBody({ path: 'a.md', start: 7, end: 7, body: 'x', unanchored: true });
  assert.ok(single.includes('`a.md` L7'));
  assert.ok(!single.includes('L7–7'));
});

test('评论正文：行级评论不加位置行（GitHub 自带行号）', () => {
  const body = win.__commentBody({ path: 'a.md', start: 3, end: 5, quote: '', body: 'x' });
  assert.equal(body, 'x');
});

test('评论正文：有引用时拼成 blockquote', () => {
  assert.equal(win.__commentBody({ quote: '', body: '正文' }), '正文');
  assert.equal(win.__commentBody({ quote: '第一行\n第二行', body: '补充说明' }), '> 第一行\n> 第二行\n\n补充说明');
});

test('选区定位：CSV 行按 data-comment-line 取评论行', () => {
  const row = (dataset) => ({ nodeType: 1, dataset, closest(q) { return q === '.csv-row[data-line]' ? this : null; } });
  assert.deepEqual({ ...win.__locate({ anchorNode: row({ line: '2', commentLine: '3' }), focusNode: row({ line: '2', commentLine: '3' }) }) },
    { start: 3, end: 3 });
  assert.deepEqual({ ...win.__locate({ anchorNode: row({ line: '5' }), focusNode: row({ line: '5' }) }) }, { start: 5, end: 5 });
});
