import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = () => {
  globalThis.window = globalThis;
  vm.runInThisContext(readFileSync(new URL('../public/marked.min.js', import.meta.url), 'utf8'));
  vm.runInThisContext(readFileSync(new URL('../public/semdiff.js', import.meta.url), 'utf8'));
  return globalThis.SemDiff;
};

const SemDiff = load();

test('parseBlocks：行号、容器与子块、表格单元格', () => {
  const src = '# 标题\n\n- 甲\n- 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const bs = SemDiff.parseBlocks(src, 'head');
  const h = bs.find((b) => b.kind === 'heading');
  assert.equal(h.startLine, 1);
  assert.equal(h.text, '标题');
  const items = bs.filter((b) => b.kind === 'listItem');
  assert.deepEqual(items.map((b) => b.text), ['甲', '乙']);
  assert.ok(items.every((b) => b.parentId && b.parentId.startsWith('head:list:')));
  const rows = bs.filter((b) => b.kind === 'tableRow');
  assert.equal(rows[1].cells.length, 2);
  assert.equal(rows[1].cells[1].text, '2');
  assert.equal(new Set(bs.map((b) => b.id)).size, bs.length);
});

test('parseBlocks：空正文不抛错', () => {
  assert.deepEqual(SemDiff.parseBlocks('', 'head'), []);
  assert.equal(SemDiff.parseBlocks('\n\n \n', 'head').length, 0);
});

test('alignBlocks：微改配成 modified，插入为 added，对齐保序', () => {
  const base = SemDiff.parseBlocks('段落一。\n\n段落二讲费用口径。\n\n段落三。', 'base');
  const head = SemDiff.parseBlocks('段落一。\n\n新增一段。\n\n段落二讲费用口径与披露。\n\n段落三。', 'head');
  const r = SemDiff.alignBlocks(base, head);
  const st = Object.values(r.state);
  assert.equal(st.filter((s) => s === 'added').length, 1);
  assert.equal(st.filter((s) => s === 'modified').length, 1);
  const pairs = r.pairs.map(([b, h]) => [Number(b.split(':').pop()), Number(h.split(':').pop())]);
  for (let i = 1; i < pairs.length; i += 1) {
    assert.ok(pairs[i][0] > pairs[i - 1][0] && pairs[i][1] > pairs[i - 1][1]);
  }
});

test('tokenize：中文按字、数字带单位、拼接还原原文', () => {
  assert.deepEqual(SemDiff.tokenize('增长12.3%'), ['增', '长', '12.3%']);
  const s = '区域银行 12.3%（含 ¥1,000）——见 PR#16。';
  assert.equal(SemDiff.tokenize(s).join(''), s);
});

test('diffBlock：重复词只标真正变化处，数字与单位不被切碎', () => {
  const r = SemDiff.diffBlock('样本覆盖 84 家机构，口径与去年一致。', '样本覆盖 84 家机构，口径与去年一致，样本需补充来源。');
  const ins = r.filter((x) => x.op === 'ins');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].text, '，样本需补充来源。');
  assert.deepEqual(SemDiff.diffBlock('同一句。', '同一句。'), []);
});

test('classify：三档阈值', () => {
  const b = { kind: 'paragraph', text: '甲'.repeat(100) };
  const mk = (n) => [{ op: 'ins', start: 0, end: n }];
  assert.equal(SemDiff.classify(b, b, mk(10)).tier, 'inline');
  assert.equal(SemDiff.classify(b, b, mk(40)).tier, 'sentence');
  assert.equal(SemDiff.classify(b, b, mk(80)).tier, 'block');
});

test('diffDocument：新增与删除都出现，顺序为旧上新高', () => {
  const out = SemDiff.diffDocument('甲。\n\n乙。', '甲。\n\n丙。');
  assert.deepEqual(out.map((d) => d.state), ['normal', 'removed', 'added']);
  assert.equal(out[1].block.text, '乙。');
  assert.equal(out[2].block.text, '丙。');
});

test('diffCodeLines：新增标 add、删除标 del、未变行不输出', () => {
  const r = SemDiff.diffCodeLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(r.filter((x) => x.op === 'del'), [{ op: 'del', line: 2 }]);
  assert.deepEqual(r.filter((x) => x.op === 'add'), [{ op: 'add', line: 2 }, { op: 'add', line: 4 }]);
  assert.deepEqual(SemDiff.diffCodeLines('', 'x\ny'), [{ op: 'add', line: 1 }, { op: 'add', line: 2 }]);
});

test('splitHighlightedLines：多行注释跨行仍保持着色且逐行自平衡', () => {
  const html = '<span class="hljs-comment">/* 第一行\n第二行 */</span>const a = 1;';
  const lines = SemDiff.splitHighlightedLines(html);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('<span class="hljs-comment">'));
  assert.ok(lines[0].endsWith('</span>'));
  assert.ok(lines[1].startsWith('<span class="hljs-comment">'));
});

test('projectInline：把插入文本包进 .md-ins，标签内不插入', () => {
  const html = '<p>样本覆盖 84 家机构，口径与去年一致，样本需补充来源。</p>';
  const ranges = [{ op: 'ins', start: 0, end: 0, text: '，样本需补充来源' }];
  const out = SemDiff.projectInline(html, ranges);
  assert.ok(out.includes('<ins class="md-ins">，样本需补充来源</ins>'));
  assert.ok(out.includes('</p>'));
});
