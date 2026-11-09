/* 左侧树状视图的数据结构回归：单链合并、排序、汇总、根级文件。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = new URL('..', import.meta.url).pathname;
const modelSrc = fs.readFileSync(`${REPO}public/diff-model.js`, 'utf8');

const ctx = { window: {}, console };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext(modelSrc, ctx);
const { buildFileTree } = ctx.window.DiffModel;

const file = (path, extra) => ({ path, status: 'modified', additions: 2, deletions: 1, ...extra });

/* VM 里建出来的数组原型不同，统一用 Array.from 转成当前 realm 的数组再比 */
const names = (nodes) => Array.from(nodes, (n) => `${n.type === 'dir' ? 'd' : 'f'}:${n.name}`);

test('buildFileTree：单链目录合并成一行，文件按名称排序', () => {
  const tree = buildFileTree([
    file('docs/a/b/x.md'),
    file('docs/a/b/y.md'),
  ]);
  assert.deepEqual(names(tree), ['d:docs/a/b']);
  assert.deepEqual(names(tree[0].children), ['f:x.md', 'f:y.md']);
  assert.equal(tree[0].path, 'docs/a/b');
});

test('buildFileTree：目录里既有文件又有子目录时不再合并，目录排在文件前', () => {
  const tree = buildFileTree([
    file('docs/readme.md'),
    file('docs/sub/a.md'),
  ]);
  assert.deepEqual(names(tree), ['d:docs']);
  assert.deepEqual(names(tree[0].children), ['d:sub', 'f:readme.md']);
});

test('buildFileTree：根级文件单独成项，与目录按类型排序', () => {
  const tree = buildFileTree([file('zeta.md'), file('alpha.md'), file('docs/x.md')]);
  assert.deepEqual(names(tree), ['d:docs', 'f:alpha.md', 'f:zeta.md']);
});

test('buildFileTree：目录汇总行数与文件数', () => {
  const tree = buildFileTree([
    file('a/b/c/one.md', { additions: 3, deletions: 1 }),
    file('a/b/c/two.md', { additions: 4, deletions: 2 }),
    file('a/b/d/three.md', { additions: 5, deletions: 5 }),
  ]);
  const a = tree[0];
  assert.equal(a.name, 'a/b');
  assert.equal(a.count, 3);
  assert.equal(a.additions, 12);
  assert.equal(a.deletions, 8);
  assert.deepEqual(names(a.children), ['d:c', 'd:d']);
  assert.equal(a.children[0].count, 2);
});

test('buildFileTree：深层合并只在单链上发生', () => {
  const tree = buildFileTree([
    file('docs/区域银行智能研发解决方案/00-项目治理/a.md'),
    file('docs/区域银行智能研发解决方案/08-客户需求与市场洞察/b.md'),
  ]);
  assert.deepEqual(names(tree), ['d:docs/区域银行智能研发解决方案']);
  assert.deepEqual(names(tree[0].children), ['d:00-项目治理', 'd:08-客户需求与市场洞察']);
});

test('buildFileTree：空列表与异常路径不炸', () => {
  assert.deepEqual(Array.from(buildFileTree([])), []);
  assert.deepEqual(Array.from(buildFileTree(null)), []);
  assert.deepEqual(names(buildFileTree([file('')])), []);
  assert.deepEqual(names(buildFileTree([file('//x//y.md')])), ['d:x']);
});
