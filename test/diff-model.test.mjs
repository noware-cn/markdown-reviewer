/* mdBlocks 列表边界 + <li> 行号映射回归测试（node --test，无需依赖） */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = new URL('..', import.meta.url).pathname;
const markedSrc = fs.readFileSync(`${REPO}public/marked.min.js`, 'utf8');
const modelSrc = fs.readFileSync(`${REPO}public/diff-model.js`, 'utf8');

function loadModel({ withMarked = true } = {}) {
  const ctx = { window: {}, console };
  if (withMarked) {
    const markedCtx = { module: { exports: {} }, exports: {}, window: {}, self: {} };
    markedCtx.globalThis = markedCtx;
    vm.createContext(markedCtx);
    vm.runInContext(markedSrc, markedCtx);
    ctx.window.marked = markedCtx.exports.marked;
    ctx.window.DOMPurify = { sanitize: (s) => s };
  }
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(modelSrc, ctx);
  return ctx.window.DiffModel;
}

const model = loadModel();
const noMarked = loadModel({ withMarked: false });

/* 期望值手工给出（基准：CommonMark / marked 实际渲染），不复用被测实现。 */
const CASES = [
  { name: '嵌套 + 续行', doc: '- 父项\n  父项的补充段落\n  - 子项\n- 第二项', ranges: [[1, 4]], li: [1, 3, 4] },
  { name: '空行分隔（loose）', doc: '- a\n\n- b', ranges: [[1, 3]], li: [1, 3] },
  { name: '有序列表 + 空行', doc: '1. a\n\n2. b', ranges: [[1, 3]], li: [1, 3] },
  { name: '有序列表 1) 形式', doc: '1) a\n2) b', ranges: [[1, 2]], li: [1, 2] },
  { name: '懒续行', doc: '- a\nb\n- c', ranges: [[1, 3]], li: [1, 3] },
  { name: '表格嵌在项内', doc: '- a\n| x | y |\n| - | - |', ranges: [[1, 3]], li: [1] },
  { name: '围栏代码块内不是列表项', doc: '- 项目一\n  ```\n  - 假标记\n  ```\n- 项目二', ranges: [[1, 5]], li: [1, 5] },
  { name: '缩进代码块不是列表', doc: '段落\n\n    - 这是代码', ranges: [], li: [] },
  { name: '列表后接段落', doc: '- a\n\n普通段落', ranges: [[1, 1]], li: [1] },
  { name: '列表后接标题', doc: '- a\n# 标题', ranges: [[1, 1]], li: [1] },
  { name: '空行嵌套', doc: '- a\n\n  - b\n- c', ranges: [[1, 4]], li: [1, 3, 4] },
  { name: '引用行属于列表项', doc: '- a\n> q', ranges: [[1, 2]], li: [1] },
  { name: '任务列表', doc: '- [ ] a\n- [x] b', ranges: [[1, 2]], li: [1, 2] },
  { name: '两个列表被标题隔开', doc: '- a\n\n# h\n\n- b', ranges: [[1, 1], [5, 5]], li: [1, 5] },
  { name: '项内缩进代码', doc: '- a\n\n      code\n\n- b', ranges: [[1, 5]], li: [1, 5] },
  { name: '缩进代码中的假列表标记', doc: '- 父项\n\n      - 这只是代码，不是列表项\n\n- 第二项', ranges: [[1, 6]], li: [1, 6] },
];

const listBlocks = (m, doc) => Array.from(m.mdBlocks(doc)).filter((b) => b.type === 'ul' || b.type === 'ol');

for (const c of CASES) {
  test(`列表边界：${c.name}`, () => {
    const blocks = listBlocks(model, c.doc);
    assert.deepEqual(blocks.map((b) => [b.startLine, b.endLine]), c.ranges);
    const lines = c.doc.split('\n');
    for (const b of blocks) {
      assert.equal(b.raw, lines.slice(b.startLine - 1, b.endLine).join('\n'), 'raw 必须是源码切片');
      assert.equal((b.html.match(/<li>/g) || []).length, Array.from(model.listItemLines(b.raw, b.startLine)).length, '<li> 与行号数量一致');
    }
  });

  test(`<li> 行号映射：${c.name}`, () => {
    const blocks = listBlocks(model, c.doc);
    const mapped = blocks.flatMap((b) => Array.from(model.listItemLines(b.raw, b.startLine)));
    assert.deepEqual(mapped, c.li);
  });

  test(`无 marked 降级仍是列表：${c.name}`, () => {
    // 降级模式按「连续标记行」分组，行为与旧实现一致（不含续行/围栏识别）
    const marker = /^\s*([-*+]|\d+[.)])\s+/;
    const runs = [];
    c.doc.split('\n').forEach((ln, idx) => {
      if (!marker.test(ln)) return;
      const last = runs[runs.length - 1];
      if (last && last[1] === idx) last[1] = idx + 1;
      else runs.push([idx + 1, idx + 1]);
    });
    const fallback = listBlocks(noMarked, c.doc).map((b) => [b.startLine, b.endLine]);
    assert.deepEqual(fallback, runs);
  });
}

test('缩进代码行不会让 mdBlocks 死循环', () => {
  const doc = '段落\n\n    - 这是代码\n\n结尾';
  const blocks = Array.from(model.mdBlocks(doc));
  assert.deepEqual(blocks.map((b) => [b.type, b.startLine]), [['para', 1], ['para', 3], ['para', 5]]);
});
