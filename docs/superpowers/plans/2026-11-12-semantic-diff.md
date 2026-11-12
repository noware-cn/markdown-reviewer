# Markdown 语义 diff（AST 单轨）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用块 AST 对齐 + 行内差异替换现有行 patch 拼装与独立坐标尺，把改动、评论、草稿、已阅收进单轨阅读视图。

**Architecture:** 纯函数引擎（`public/semdiff.js`，无 DOM、无网络）产出一份 `Decorated[]`；`public/diff.js` 只做渲染与交互。对齐用 patience 锚定 + 段内 LCS（CJK 2-gram Jaccard）；行内差异在 token 序列上用 vendor 的 `diff-match-patch`；粒度四档按改动密度分类。

**Tech Stack:** Cloudflare Worker（TS，仅服务端）+ vanilla JS（`public/*.js`，无构建）+ `marked v12.0.2`（已 vendored）+ `diff-match-patch 1.0.5`（新增 vendored）+ `node --test`。

**Spec:** `docs/superpowers/specs/2026-11-12-semantic-diff-design.md`

## Global Constraints

- 前端无构建：新代码是 `public/` 下的普通脚本，`window.SemDiff` 全局暴露；依赖必须 vendored 单文件并以 IIFE 包裹。
- `public/semdiff.js` 与 `public/diff-match-patch.min.js` 在 `public/index.html`、`public/doc.html` 中于 `diff.js` **之前**引入；如需登录后访问，同步加入 `wrangler.jsonc` 的 `run_worker_first`；四个 HTML 的资源版本号一并递增。
- 引擎不得触碰 `document`、`window.marked` 以外的宿主对象，不发起网络请求。
- 对齐阈值：同 kind 候选 `sim ≥ 0.45`；搬移 `sim ≥ 0.80`；粒度 `r ≤ 0.15` 词级、`≤ 0.60` 句级、否则段级；未配对为节点级。
- 上限：块数 2000、段内 LCS 长度 400、行内 token 5000，超限走降级。
- 行内类名沿用 `.md-ins`，新增 `.md-del`；块 DOM 属性 `class="md-block"`、`data-line`、`data-end-line`、`data-block`、`data-base-line`、`data-side="RIGHT"`、`.line-anchor`、`.has-comments` 不得改名，新增 `data-block-id`。
- 三态 URL 写 `?view=final|base|markup`，读入兼容存量 `?mode=` 并归一。
- 已阅键：`wb.reviewed.<owner/repo>.<n>.<sha>`。
- `public/highlight.min.js`（52 KB gzip）与 `public/mermaid.min.js`（766 KB gzip）是**静态资源**，不进 Worker 包；mermaid 必须在页面出现 `lang=mermaid` 的块时才注入，首屏不得请求。
- 代码块高亮只改渲染字符串，不得让 `SemDiff`/`Decorated` 依赖 hljs。
- 每处改动必须标注证据级别；测试只用 `node --test`，不引入 jsdom。

## Review Focus

1. **空/异常正文**（空文件、仅空白、仅 HTML 注释、`base` 与 `head` 完全相同）：期望"零改动、无标记、不报错"。→ Task 3、Task 6。
2. **同一块内重复词 + 数字单位**（`12.3%` → `18.6%`，且段内另有一处"样本"）：期望只标真正变化处，单位不被切碎。→ Task 5、Task 6。
3. **表格列增删与含 `|` 的单元格**：期望不串列、不把相邻列当同列改动。→ Task 8。
4. **400 KB 截断与引用文档（无 base 侧）**：期望尾部提示截断、引用视图零标记且不报错。→ Task 14。
5. **未知栅栏语言与超长代码块**（`objc` 之类 hljs 无内置语言、3000 行代码）：期望不着色也不猜语言、只高亮前 1000 行并提示。→ Task 21。
6. **mermaid 语法错误与脚本加载失败**（离线、被拦截）：期望显示错误摘要 + 源码，块仍可评论，绝不空白。→ Task 22。
7. **旧链接与旧快捷键**（`?mode=split`、按 `1/2/3/4`）：期望不白屏、不报错，归一或忽略。→ Task 12、Task 13。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `public/semdiff.js`（新增） | 纯函数引擎：`parseBlocks`、`alignBlocks`、`diffBlock`、`classify`、`diffDocument` |
| `public/diff-match-patch.min.js`（新增） | vendored `diff-match-patch 1.0.5`，IIFE，暴露 `window.diff_match_patch` |
| `public/diff.js`（修改） | 渲染与交互：`readingHTML` 消费 `Decorated[]`，右栏、三态、键盘 |
| `public/styles.css`（修改） | 块级标记、行内 `ins/del`、右栏、审阅窗格；删除 `.drail*` |
| `public/index.html`、`public/doc.html`（修改） | 引入新脚本、三态控件、右栏骨架 |
| `public/route.js`（修改） | `mode` → `view` 归一，删除三视图参数 |
| `scripts/make-worksheet.mjs`（新增） | 生成人工标注工作表 |
| `test/semdiff.test.mjs`（新增） | 引擎单测与属性测试 |
| `test/semdiff-golden.test.mjs`（新增） | 黄金语料回归 |
| `test/fixtures/golden/*.json`（新增） | 语料：`{name, base, head, expect}` |
| `test/generation.test.mjs`、`test/screen.test.mjs`…（修改） | 渲染层断言随结构调整 |

---

## Task 1: 语料骨架与标注工作表

**Files:**
- Create: `test/fixtures/golden/README.md`、`test/fixtures/golden/sample.json`、`scripts/make-worksheet.mjs`、`test/worksheet.test.mjs`
- Modify: `package.json`（新增 `npm run worksheet`）

**Interfaces:**
- Produces: 语料 JSON 结构 `{ name: string, base: string, head: string, expect: { states: Array<{ kind: string, state: string, tier: string, ins?: string[], del?: string[] }> } }`；`makeWorksheet(pairs: Array<{name, base, head, candidates}>) => string`（Markdown 表格文本）。

- [ ] **Step 1: 写失败测试**

```js
// test/worksheet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorksheet } from '../scripts/make-worksheet.mjs';

test('工作表每条改动一行，含判定列', () => {
  const md = makeWorksheet([{ name: 'a.md', base: '旧句。', head: '新句。', candidates: [{ line: 3, state: 'modified' }] }]);
  assert.match(md, /\| a\.md \| 3 \| modified \|/);
  assert.match(md, /\| 判定（对\/错） \|/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/worksheet.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/make-worksheet.mjs'`

- [ ] **Step 3: 实现 `makeWorksheet`**（`scripts/make-worksheet.mjs`，ESM，导出 `makeWorksheet`；表头固定为 `文件 | 行 | 期望状态 | 期望粒度 | 行内插入 | 行内删除 | 判定（对/错） | 备注`）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/worksheet.test.mjs`
Expected: PASS

- [ ] **Step 5: 落一份样例语料**（`test/fixtures/golden/sample.json`，用 PR 16 里的 `README.md` 一段真实改动），在 `README.md` 里写清 JSON 字段含义

- [ ] **Step 6: 提交**

```bash
git add scripts/make-worksheet.mjs test/worksheet.test.mjs test/fixtures/golden package.json
git commit -m "test: 语义 diff 语料骨架与标注工作表生成器"
```

> **前置依赖（阻塞本任务收尾）**：另需 3 份真实文档路径，由项目负责人提供；工作表生成后由负责人填写"判定"列。语料未签收前，Task 9 的黄金断言只跑 `sample.json`。

## Task 2: 现状基线测量

**Files:**
- Create: `scripts/measure-baseline.mjs`、`docs/superpowers/specs/2026-11-12-baseline.md`

**Interfaces:**
- Consumes: 语料 JSON（Task 1）。
- Produces: 一份"当前实现 vs 期望"的错标/漏标计数，写进 `2026-11-12-baseline.md`（供 P2 验收对比）。

- [ ] **Step 1: 写测量脚本**（`node scripts/measure-baseline.mjs test/fixtures/golden/*.json`：用现有 `diff-model.js` 的 `mdBlocks` 产出块状态，与 `expect.states` 比对，输出 `{总处, 错标, 漏标}`）
- [ ] **Step 2: 跑一次并记录结果**

Run: `node scripts/measure-baseline.mjs test/fixtures/golden/sample.json`
Expected: 打印 `{总处: n, 错标: x, 漏标: y}`，把结果抄进 `2026-11-12-baseline.md`

- [ ] **Step 3: 提交**

```bash
git add scripts/measure-baseline.mjs docs/superpowers/specs/2026-11-12-baseline.md
git commit -m "chore: 记录语义 diff 的现状基线"
```

## Task 3: `parseBlocks`

**Files:**
- Create: `public/semdiff.js`、`test/semdiff.test.mjs`

**Interfaces:**
- Produces: `window.SemDiff.parseBlocks(source: string, side: "base" | "head") => Block[]`；`Block = { id, side, kind, level?, parentId?, children?, cells?, startLine, endLine, raw, text, sig? }`；`id = \`${side}:${kind}:${startLine}\``；`kind ∈ heading|paragraph|quote|list|listItem|table|tableRow|code|html|image|hr`（`list`/`table` 为容器，同时产出子块）。

- [ ] **Step 1: 写失败测试**

```js
test('parseBlocks：行号、容器与子块、文本投影', () => {
  const src = '# 标题\n\n- 甲\n- 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const bs = SemDiff.parseBlocks(src, 'head');
  const h = bs.find((b) => b.kind === 'heading');
  assert.equal(h.startLine, 1); assert.equal(h.text, '标题');
  const items = bs.filter((b) => b.kind === 'listItem');
  assert.deepEqual(items.map((b) => b.text), ['甲', '乙']);
  assert.ok(items.every((b) => b.parentId && b.parentId.startsWith('head:list:')));
  const rows = bs.filter((b) => b.kind === 'tableRow');
  assert.equal(rows[1].cells.length, 2); assert.equal(rows[1].cells[1].text, '2');
  assert.equal(new Set(bs.map((b) => b.id)).size, bs.length);
});

test('parseBlocks：空与仅空白的正文不抛错', () => {
  assert.deepEqual(SemDiff.parseBlocks('', 'head'), []);
  assert.equal(SemDiff.parseBlocks('\n\n \n', 'head').filter((b) => b.kind !== 'hr').length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/semdiff.test.mjs`
Expected: FAIL — `SemDiff is not defined`

- [ ] **Step 3: 实现**（`public/semdiff.js`：IIFE，`window.SemDiff = {...}`；用 `window.marked.lexer` 走 token 树，按 `token.raw` 换行数累计行号；`list`/`table` 展开为子块并保留容器；`text` 递归取 `text`/`alt` 字段；测试用 `vm` 注入 `window.marked`，写法照 `test/diff-model.test.mjs:11-25`）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/semdiff.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 5: 提交**

```bash
git add public/semdiff.js test/semdiff.test.mjs
git commit -m "feat(semdiff): 块 AST 解析，含容器子块与表格单元格"
```

## Task 4: `Sig` 与 `alignBlocks`

**Files:**
- Modify: `public/semdiff.js`、`test/semdiff.test.mjs`

**Interfaces:**
- Produces: `SemDiff.alignBlocks(base: Block[], head: Block[]) => { pairs: Array<[string, string]>, state: Record<string, "normal"|"added"|"removed"|"modified">, baseLineOf: Record<string, number> }`（键为 `block.id`）；`SemDiff.similarity(a: Block, b: Block) => number`。
- 规则：仅同 `kind` 配对（标题另需 `level` 相同）；`sim ≥ 0.45` 候选；段内 LCS 保序；`keys` 唯一且两侧唯一者先行锚定。

- [ ] **Step 1: 写失败测试**

```js
test('alignBlocks：段落微改配成 modified，跨段插入为 added', () => {
  const base = SemDiff.parseBlocks('段落一。\n\n段落二讲费用口径。\n\n段落三。', 'base');
  const head = SemDiff.parseBlocks('段落一。\n\n新增一段。\n\n段落二讲费用口径与披露。\n\n段落三。', 'head');
  const r = SemDiff.alignBlocks(base, head);
  const st = Object.values(r.state);
  assert.equal(st.filter((s) => s === 'added').length, 1);
  assert.equal(st.filter((s) => s === 'modified').length, 1);
  assert.equal(st.filter((s) => s === 'normal').length, 2);
});

test('alignBlocks：对齐保序', () => {
  const base = SemDiff.parseBlocks('A\n\nB\n\nC', 'base');
  const head = SemDiff.parseBlocks('C\n\nA\n\nB', 'head');
  const r = SemDiff.alignBlocks(base, head);
  const pairs = r.pairs.map(([b, h]) => [Number(b.split(':').pop()), Number(h.split(':').pop())]);
  for (let i = 1; i < pairs.length; i += 1) {
    assert.ok(pairs[i][0] > pairs[i - 1][0] && pairs[i][1] > pairs[i - 1][1], '配对必须双向递增');
  }
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff.test.mjs`；Expected: FAIL — `alignBlocks is not a function`
- [ ] **Step 3: 实现 `similarity`（2-gram Jaccard，CJK 按字切、拉丁按词切、去标点与空白）与 `alignBlocks`（锚定 → 段内 LCS DP，段长上限 400）**
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/semdiff.test.mjs`；Expected: PASS（4 项）
- [ ] **Step 5: 提交**

```bash
git add public/semdiff.js test/semdiff.test.mjs
git commit -m "feat(semdiff): 块对齐（patience 锚定 + 段内 LCS）"
```

## Task 5: token 化

**Files:**
- Modify: `public/semdiff.js`；Create: `public/diff-match-patch.min.js`

**Interfaces:**
- Produces: `SemDiff.tokenize(text: string) => string[]`；数字与其后紧邻单位（`%`、万/亿/元/家/个/人/次/天/年/月）与前置 `¥`/`$` 合成一个 token。

- [ ] **Step 1: 写失败测试**

```js
test('tokenize：中文按字、数字带单位、英文按词', () => {
  assert.deepEqual(SemDiff.tokenize('增长12.3%'), ['增', '长', '12.3%']);
  assert.deepEqual(SemDiff.tokenize('400KB 与 2 家'), ['400KB', ' ', '与', ' ', '2', ' ', '家']);
  assert.deepEqual(SemDiff.tokenize('¥1,000'), ['¥1,000']);
});

test('tokenize：拼接后逐字节还原原文', () => {
  const s = '区域银行 12.3%（含 ¥1,000）——见 PR#16。';
  assert.equal(SemDiff.tokenize(s).join(''), s);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff.test.mjs`；Expected: FAIL — `tokenize is not a function`
- [ ] **Step 3: vendor `diff-match-patch 1.0.5`**（`npm pack diff-match-patch@1.0.5`，取 `diff_match_patch_uncompressed.js` 包成 IIFE 写入 `public/diff-match-patch.min.js`，暴露 `window.diff_match_patch`；在 `public/index.html`、`public/doc.html` 中于 `semdiff.js` 之前引入，版本号递增）
- [ ] **Step 4: 实现 `tokenize`**（按 Spec §7.4 的六类规则；实现后跑第 1 步两个用例）
- [ ] **Step 5: 跑测试确认通过** — Run: `node --test test/semdiff.test.mjs`；Expected: PASS（6 项）
- [ ] **Step 6: 提交**

```bash
git add public/diff-match-patch.min.js public/semdiff.js public/index.html public/doc.html test/semdiff.test.mjs
git commit -m "feat(semdiff): CJK token 化并 vendor diff-match-patch"
```

## Task 6: `diffBlock`

**Files:**
- Modify: `public/semdiff.js`、`test/semdiff.test.mjs`

**Interfaces:**
- Produces: `InlineRange = { op: "ins"|"del", start: number, end: number, delText?: string }`；`SemDiff.diffBlock(baseText: string, headText: string) => InlineRange[]`；区间坐标是 **headText** 字符偏移；`del` 区间的 `start === end`（零宽锚点）。
- 不变量：施加区间后逐字节还原 `headText`；`delText` 在 `baseText` 该块起点之后可寻。

- [ ] **Step 1: 写失败测试**

```js
test('diffBlock：重复词只标真正变化处', () => {
  const r = SemDiff.diffBlock('样本覆盖 84 家机构，口径与去年一致。', '样本覆盖 84 家机构，口径与去年一致，样本需补充来源。');
  const ins = r.filter((x) => x.op === 'ins').map((x) => x.end - x.start);
  assert.deepEqual(ins, ['，样本需补充来源'.length]); // 唯一一段插入
});

test('diffBlock：数字与单位不被切碎', () => {
  const r = SemDiff.diffBlock('同比增长 12.3%。', '同比增长 18.6%。');
  const del = r.find((x) => x.op === 'del'); const ins = r.find((x) => x.op === 'ins');
  assert.equal(del.delText, '12.3%'); assert.equal(ins.end - ins.start, '18.6%'.length);
});

test('diffBlock：相同文本返回空', () => {
  assert.deepEqual(SemDiff.diffBlock('同一句。', '同一句。'), []);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff.test.mjs`；Expected: FAIL — `diffBlock is not a function`
- [ ] **Step 3: 实现**：token 序列以 `\u0001` 连接 → `diff_main` + `diff_cleanupSemanticLossless` → 按 token 边界还原为区间 → 三条后处理（同类合并间隔 ≤ 2 token；`del` 两侧标点各扩 1 token；端点吸附词边界）→ 若还原失败则该块返回 `[]`（调用方降级块级）
- [ ] **Step 4: 加属性测试**（随机插入/删除/替换：断言施加区间后等于 `headText`；`delText` 可寻）
- [ ] **Step 5: 跑测试确认通过** — Run: `node --test test/semdiff.test.mjs`；Expected: PASS
- [ ] **Step 6: 提交**

```bash
git add public/semdiff.js test/semdiff.test.mjs
git commit -m "feat(semdiff): 行内差异与三条后处理"
```

## Task 7: `classify` 与 `diffDocument`

**Files:**
- Modify: `public/semdiff.js`、`test/semdiff.test.mjs`

**Interfaces:**
- Produces: `SemDiff.classify(baseBlock, headBlock, ranges) => { tier: "inline"|"sentence"|"block"|"node", r: number }`；`SemDiff.diffDocument(baseText, headText) => Decorated[]`，`Decorated = { block, state, inline?: InlineChange[], baseText?, pair?, children? }`，其中 `InlineChange = InlineRange & { unit: string }`（`unit` 为改动单元标识，段落为 `block.id`，表格单元格为 `rowId#c<col>`）；按 head 顺序输出，`removed` 块插在其配对位置。形状与设计文档 §7.5 完全一致：**扁平条目，每条自带 `unit`、`op`、`start`、`end`**。

- [ ] **Step 1: 写失败测试**

```js
test('classify：三档阈值', () => {
  const b = { kind: 'paragraph', text: '甲'.repeat(100) };
  const mk = (n) => [{ op: 'ins', start: 0, end: n }];
  assert.equal(SemDiff.classify(b, b, mk(10)).tier, 'inline');
  assert.equal(SemDiff.classify(b, b, mk(40)).tier, 'sentence');
  assert.equal(SemDiff.classify(b, b, mk(80)).tier, 'block');
});

test('diffDocument：新增段落与删除段落都出现，顺序为旧上新高', () => {
  const out = SemDiff.diffDocument('甲。\n\n乙。', '甲。\n\n丙。');
  assert.deepEqual(out.map((d) => d.state), ['normal', 'removed', 'added']);
  assert.equal(out[1].block.text, '乙。'); assert.equal(out[2].block.text, '丙。');
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff.test.mjs`；Expected: FAIL — `classify is not a function`
- [ ] **Step 3: 实现 `classify`（r = 变更 token 数 / head token 数）与 `diffDocument`（parse → align → 逐对 diff+classify；未配对块 `tier: "node"`；容器按子块展开）**
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/semdiff.test.mjs`；Expected: PASS
- [ ] **Step 5: 提交**

```bash
git add public/semdiff.js test/semdiff.test.mjs
git commit -m "feat(semdiff): 四档粒度与文档级装配"
```

## Task 8: 表格列对齐

**Files:**
- Modify: `public/semdiff.js`、`test/semdiff.test.mjs`

**Interfaces:**
- Produces: `SemDiff.alignColumns(baseRow: Block, headRow: Block) => Array<[number, number]>`（`[baseCol, headCol]`，按表头文本对齐，退化按列序）；`diffDocument` 产出的表格行 `inline` 条目 `unit = \`${rowId}#c${col}\``。

- [ ] **Step 1: 写失败测试**

```js
test('表格：加一列不染红整表，仅标新增列', () => {
  const base = '| 名称 | 金额 |\n| --- | --- |\n| 甲 | 10 |\n';
  const head = '| 名称 | 金额 | 说明 |\n| --- | --- | --- |\n| 甲 | 10 | 新增 |\n';
  const out = SemDiff.diffDocument(base, head);
  const cells = out.flatMap((d) => d.inline || []).filter((x) => x.unit.includes('#c'));
  assert.ok(cells.every((x) => x.unit.endsWith('#c2')), '只应标第三列');
});

test('表格：单元格含 | 与行内代码时不串列', () => {
  const base = '| a | b |\n| --- | --- |\n| `x|y` | 2 |\n';
  const head = '| a | b |\n| --- | --- |\n| `x|z` | 2 |\n';
  const out = SemDiff.diffDocument(base, head);
  const r = out.flatMap((d) => d.inline || []);
  assert.equal(r.length, 2); assert.ok(r.every((x) => x.unit.endsWith('#c0')));
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff.test.mjs`；Expected: FAIL（当前实现整行 diff，`unit` 不带列号）
- [ ] **Step 3: 实现 `alignColumns` 并在 `diffDocument` 中对 `tableRow` 按列跑 `diffBlock`**
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/semdiff.test.mjs`；Expected: PASS
- [ ] **Step 5: 提交**

```bash
git add public/semdiff.js test/semdiff.test.mjs
git commit -m "feat(semdiff): 表格列对齐与单元格级差异"
```

## Task 9: 黄金语料回归

**Files:**
- Create: `test/semdiff-golden.test.mjs`
- Modify: `test/fixtures/golden/*.json`（按负责人签收的工作表补齐）

**Interfaces:**
- Consumes: `SemDiff.diffDocument`（Task 7）、语料 JSON（Task 1）。

- [ ] **Step 1: 写测试**（遍历 `test/fixtures/golden/*.json`：断言 `states` 的 kind/state/tier 序列一致；`ins`/`del` 文本集合一致；失败时打印 `name` 与差异位置）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff-golden.test.mjs`；Expected: FAIL（样例语料尚有未实现的结构）
- [ ] **Step 3: 修引擎直到通过**（只允许改引擎，不允许放宽断言；确因语料标错则记录到工作表备注，交由负责人复核）
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test --test-reporter=spec test/semdiff-golden.test.mjs`；Expected: PASS，全部语料；错标 0
- [ ] **Step 5: 提交**

```bash
git add test/semdiff-golden.test.mjs test/fixtures/golden
git commit -m "test(semdiff): 黄金语料回归"
```

## Task 10: 行内投影与 DOM 契约

**Files:**
- Modify: `public/diff.js`、`public/styles.css`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `projectInline(html: string, changes: InlineChange[], textMaps: Record<string, Array<{ textStart: number, textEnd: number, htmlStart: number, htmlEnd: number }>>) => string`（`changes` 直接来自 `Decorated.inline`，按 `unit` 分组查 `textMaps`；`textMap` 由渲染器在生成该块 HTML 时同步记录）；`blockHtml` 额外输出 `data-block-id`。

- [ ] **Step 1: 写失败测试**（断言：`<ins class="md-ins">`、`<del class="md-del">` 落在正确文本位置；`data-block-id` 存在；`data-line`/`data-end-line`/`data-block` 仍在）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL — 无 `md-del`、无 `data-block-id`
- [ ] **Step 3: 实现**：块 HTML 生成时同步产出 `textMap`（每段文本在 HTML 字符串中的起止），按 `changes` 的 `unit` + `start/end` 换算为 HTML 偏移后插入标签；跨标签时按该 unit 的 textMap 分段插入
- [ ] **Step 4: 加 CSS**（`.md-ins` 沿用、`.md-del` 删除线、块级 `border-left` 三色 + `::before` 符号 `+ ~ − ↔`）
- [ ] **Step 5: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 6: 提交**

```bash
git add public/diff.js public/styles.css test/generation.test.mjs
git commit -m "feat: 行内影射与块级标记样式"
```

## Task 11: `readingHTML` 切换到引擎

**Files:**
- Modify: `public/diff.js`（`readingHTML`、`blockHtml`）、`test/generation.test.mjs`
- Delete: `changeRail`、`syncRail`、`railHTML` 及其调用与样式

**Interfaces:**
- Consumes: `SemDiff.diffDocument`（Task 7）、`projectInline`（Task 10）。
- Produces: `readingHTML(file) => string`，输入不变、输出为 `Decorated[]` 渲染结果。

- [ ] **Step 1: 写失败测试**（断言：页面无 `.drail`；新增块含 `.is-added`；同一段既有插入又有删除时同时出现 `.md-ins` 与 `.md-del`）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**：取 base/head 全文（沿用现有 `side=base` 的 file 请求）→ `SemDiff.diffDocument` → 渲染；删掉 `.drail` 相关代码与样式；保留 `has-comments`/草稿虚线/章节 `.cbar`
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿（含既有评论、草稿、深链用例）
- [ ] **Step 5: 提交**

```bash
git add public/diff.js public/styles.css test/generation.test.mjs
git commit -m "feat: 阅读视图改用 AST 引擎，删除坐标尺"
```

## Task 12: 三态显示与 `?view=`

**Files:**
- Modify: `public/diff.js`、`public/index.html`、`public/route.js`、`public/styles.css`、`public/doc.html`、`test/route.test.mjs`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `parseView(search: string) => "final"|"base"|"markup"`（兼容 `?mode=`）；`setView(v)`；三态只切 class 与 `hidden`，不重建 DOM。

- [ ] **Step 1: 写失败测试**（`?view=base` → 渲染 base 文本且禁用评论按钮；`?mode=split` → 归一到 `markup` 且不抛错；切换三次不触发正文重取）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/route.test.mjs test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（`#wbMarks` 改为三态分段控件；原始态用 `baseText` 渲染块，评论按 base↔head 行映射挂载，映射不到只进右栏）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/diff.js public/index.html public/route.js public/styles.css public/doc.html test/route.test.mjs test/generation.test.mjs
git commit -m "feat: 最终/原始/标记三态显示"
```

## Task 13: 删除三种非阅读视图

**Files:**
- Modify: `public/diff.js`、`public/route.js`、`public/index.html`、`public/styles.css`
- Delete: `sideBySideHTML`、`unifiedHTML`、`splitHTML`、`csvSideBySideHTML` 并排分支
- Modify tests: `test/generation.test.mjs`、`test/csv.test.mjs`、`test/route.test.mjs`

- [ ] **Step 1: 写失败测试**（断言：`window.__render` 暴露的视图枚举只剩 `reading`；按 `2`/`3`/`4` 不抛错且视图不变）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs test/csv.test.mjs test/route.test.mjs`；Expected: FAIL
- [ ] **Step 3: 删除并改分派**（顶栏去掉三个按钮；`1/2/3/4` 快捷键折叠为仅 `1`；`mode` 参数只保留兼容读取）
- [ ] **Step 4: 全仓复查遗留**

Run: `grep -rn "sideBySide\|unified\|splitHTML\|drail\|changeRail\|syncRail\|railHTML" public/ test/`
Expected: 无输出（`split` 作为 `String.split` 的白名单命中需人工确认）

- [ ] **Step 5: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 6: 提交**

```bash
git add -u && git commit -m "refactor: 删除并排/统一/分栏视图"
```

## Task 14: 兜底渲染与截断

**Files:**
- Modify: `public/diff.js`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `renderPlain(file) => string`（`inline: []`，块状态由行 patch 推导，顶部提示条）；`truncated` 时尾部提示"内容被截断"。

- [ ] **Step 1: 写失败测试**（① `marked.lexer` 抛错时页面含提示且块仍渲染；② `truncated: true` 时含"内容被截断"；③ 引用文档 `ref` 模式零标记且不抛错）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（`try/catch` 包 `parseBlocks`，失败走 `renderPlain`；`ref` 模式直接 `render`）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/diff.js test/generation.test.mjs
git commit -m "feat: 解析失败与截断的兜底渲染"
```

## Task 15: CSV 适配 `Decorated`

**Files:**
- Modify: `public/diff.js`、`test/csv.test.mjs`

**Interfaces:**
- Consumes: `csvModel`（既有）。
- Produces: `csvDecorated(file) => Decorated[]`（`unit = \`${rowId}#c${i}\``），交给同一渲染器。

- [ ] **Step 1: 写失败测试**（断言：CSV 渲染出单元格级 `md-ins`；无并排视图残留）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/csv.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现适配器**（不移植 `csvParse`，只把行状态与变更列映射到 `Decorated`）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿（26 项 CSV 用例不退化）
- [ ] **Step 5: 提交**

```bash
git add public/diff.js test/csv.test.mjs
git commit -m "refactor: CSV 台账接入统一渲染"
```

## Task 16: 右栏骨架

**Files:**
- Modify: `public/index.html`、`public/styles.css`、`public/diff.js`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `renderRail(items: Decorated[]) => string`；`syncRailLayout()`（`≥1440px` 常驻 240px，否则收起为右缘把手，复用 `wbDrawerBtn`）。

- [ ] **Step 1: 写失败测试**（断言：`innerWidth = 1600` 时常驻、`= 1200` 时收起且存在把手；条目顺序与 `Decorated[]` 一致）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（把现有抽屉改为右栏容器；`resize` 只切 class，不重建内容）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/index.html public/styles.css public/diff.js test/generation.test.mjs
git commit -m "feat: 右栏骨架与窄屏把手"
```

## Task 17: 改动卡片与已阅

**Files:**
- Modify: `public/diff.js`、`public/styles.css`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `cardHTML(d: Decorated) => string`（类型 + 首句 + `+n −m` + 已阅按钮）；`toggleReviewed(blockId)`；`reviewKey()` → `wb.reviewed.<owner/repo>.<n>.<sha>`；顶栏计数 `未阅 x / 共 y`。

- [ ] **Step 1: 写失败测试**（断言：卡片文案含 `+n −m`；点击后 `localStorage` 写入该键且计数变化；`sha` 变化后计数归零）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（块左符号位与卡片共用同一状态源；点击卡片滚动并短暂高亮）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/diff.js public/styles.css test/generation.test.mjs
git commit -m "feat: 改动卡片与已阅计数"
```

## Task 18: 评论与草稿并入右栏

**Files:**
- Modify: `public/diff.js`、`public/styles.css`、`test/generation.test.mjs`

**Interfaces:**
- Consumes: `commentThreads`、`treeItemHTML`、`threadReplyHTML`（既有）。
- Produces: 右栏条目类型 `{ kind: "change"|"thread"|"draft", blockId, ... }`，按块序合并；双向 brushing 保留。

- [ ] **Step 1: 写失败测试**（断言：同一段既有改动卡片又有评论线程时，卡片在前；草稿条目带 `未发送`；悬停正文块时右栏对应条目加 `is-active`）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（合并排序；保留 `data-jump-to`、回复框草稿键 `位置:线程`）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/diff.js public/styles.css test/generation.test.mjs
git commit -m "feat: 改动/评论/草稿同栏"
```

## Task 19: 搬移检测

**Files:**
- Modify: `public/semdiff.js`、`public/diff.js`、`public/styles.css`、`test/semdiff.test.mjs`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `state: "moved"`、`Decorated.pair = { blockId, line }`；卡片文案"移自 L12"；不参与 `+n −m`。

- [ ] **Step 1: 写失败测试**（列表换序：两块都标 `moved` 且 `pair` 互指；计数只加 1）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/semdiff.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（未配对 removed/added 且 `sim ≥ 0.80` 且保序 → `moved`）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/semdiff.js public/diff.js public/styles.css test/semdiff.test.mjs test/generation.test.mjs
git commit -m "feat: 段落搬移检测"
```

## Task 20: 审阅窗格与键盘

**Files:**
- Modify: `public/index.html`、`public/diff.js`、`public/styles.css`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `togglePane()`；`j/k` 块间移动、`p/n` 改动间移动、`r` 回复、`e` 已阅、`Enter` 展开；底部 120px 折叠面板。

- [ ] **Step 1: 写失败测试**（断言：`p` 跳下一条改动并高亮；`e` 切换已阅；`j/k` 在焦点于输入框时不拦截）
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/generation.test.mjs`；Expected: FAIL
- [ ] **Step 3: 实现**（统一快捷键表；输入框内 `return`；`aria-live` 报告当前位置）
- [ ] **Step 4: 跑测试确认通过** — Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**

```bash
git add public/index.html public/diff.js public/styles.css test/generation.test.mjs
git commit -m "feat: 审阅窗格与键盘导航"
```

## Task 21: 语法高亮与代码行级比较

**Files:**
- Create: `public/highlight.min.js`、`scripts/vendor-highlight.mjs`、`test/highlight.test.mjs`
- Modify: `public/diff.js`（代码块渲染）、`public/styles.css`、`public/index.html`、`public/doc.html`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `langOf(info: string) => string | null`（别名归一：`js→javascript`、`ts→typescript`、`sh→bash`、`yml→yaml`、`md→markdown`；`hljs.getLanguage(name)` 为 false 时返回 `null`）；`splitHighlightedLines(html: string) => string[]`（在行边界补闭合/重开标签，返回的每段标签自平衡）；`diffCodeLines(baseText: string, headText: string) => Array<{ op: "add" | "del", line: number }>`（`line` 为**该侧** 1-based 行号，`add` 落在 head、`del` 落在 base；`ctx` 行不输出）。
- 代码块输出：`<pre><code class="hljs lang-<x>"><span class="code-line" data-line="N">…</span>…</code></pre>`；被标记的行同时带 `is-add` / `is-del` 与 `data-gutter="+"|"−"`。

- [ ] **Step 1: 写失败测试**

```js
// test/highlight.test.mjs
test('splitHighlightedLines：多行注释跨行仍保持着色且逐行自平衡', () => {
  const html = '<span class="hljs-comment">/* 第一行\n第二行 */</span>const a = 1;';
  const lines = splitHighlightedLines(html);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('<span class="hljs-comment">'), '首行重开');
  assert.ok(lines[0].endsWith('</span>'), '首行闭合');
  assert.ok(lines[1].startsWith('<span class="hljs-comment">'), '次行重开');
});

test('langOf：别名归一，未知语言返回 null 不猜', () => {
  assert.equal(langOf('ts'), 'typescript');
  assert.equal(langOf('objc-not-real'), null);
  assert.equal(langOf(''), null);
});

test('diffCodeLines：新增标 add、删除标 del、未变行不输出', () => {
  const r = diffCodeLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(r.filter((x) => x.op === 'del'), [{ op: 'del', line: 2 }]);
  assert.deepEqual(r.filter((x) => x.op === 'add'), [{ op: 'add', line: 2 }, { op: 'add', line: 4 }]);
});

test('diffCodeLines：整块新增与整块删除', () => {
  assert.deepEqual(diffCodeLines('', 'x\ny'), [{ op: 'add', line: 1 }, { op: 'add', line: 2 }]);
  assert.deepEqual(diffCodeLines('x\ny', ''), [{ op: 'del', line: 1 }, { op: 'del', line: 2 }]);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/highlight.test.mjs`；Expected: FAIL — 模块不存在

- [ ] **Step 3: vendor 高亮库**（`scripts/vendor-highlight.mjs`：`npm i -D highlight.js@11.11.1` → `esbuild entry --bundle --minify --format=iife`，entry 内容 `import hljs from 'highlight.js/lib/common'; window.hljs = hljs;`，产物写入 `public/highlight.min.js`（实测 158 KB min / 52 KB gzip）。脚本可重跑，产物提交入库；`package.json` 增加 `npm run vendor:hljs`）

- [ ] **Step 4: 实现 `langOf` 与 `splitHighlightedLines`**（用 `<span ...>` 栈：遇开标签入栈，行边界先按栈逆序补 `</span>`，下一行按栈顺序重开；`code-line` 包裹在外层，不参与栈）

- [ ] **Step 5: 实现 `diffCodeLines`**（按 `\n` 切行 → 行级 LCS（沿用引擎的 DP，上限 5000 行）→ 未配对行分别产出 `del`（base 行号）与 `add`（head 行号）；行尾空白与 `\r` 先归一，避免误判）

- [ ] **Step 6: 跑测试确认通过（纯函数部分）** — Run: `node --test test/highlight.test.mjs`；Expected: PASS（4 项）

- [ ] **Step 7: 接入渲染**（`public/diff.js` 的代码块分支：先 `hljs.highlight(code, { language, ignoreIllegals: true })`，再 `splitHighlightedLines`，逐行包 `code-line` 并保留 `data-line`；`langOf` 返回 `null` 时只 `esc`；超过 1000 行只高亮前 1000 行并加 `data-hljs-truncated`；对 `state !== 'normal'` 的代码块用 `diffCodeLines(baseText, text)` 给 head 行加 `is-add` + `data-gutter="+"`，把 `del` 行渲染进"原文（已替换）"面板并加 `is-del` + `data-gutter="−"`；`index.html`/`doc.html` 在 `diff.js` 之前引入 `highlight.min.js`，版本号递增）

- [ ] **Step 8: 加渲染断言与样式**（`test/generation.test.mjs`：① 代码块 `data-line` 与评论落点不变；② 未知语言无 `class="hljs"`；③ 新增一行代码后 `is-add` 只在那一行、被删行出现在原文面板且带 `is-del`；④ 未改动的代码块无 `is-add`/`is-del`。`styles.css` 加深/浅两套 `.hljs-*` 变量与 `.code-line.is-add/.is-del`、`[data-gutter]::before` 的 `+`/`−`）

- [ ] **Step 9: 跑测试确认通过** — Run: `npm test`；Expected: 全绿

- [ ] **Step 10: 提交**

```bash
git add scripts/vendor-highlight.mjs public/highlight.min.js public/diff.js public/styles.css public/index.html public/doc.html test/highlight.test.mjs test/generation.test.mjs package.json
git commit -m "feat: 代码块语法高亮与行级比较"
```

## Task 22: mermaid 渲染

**Files:**
- Create: `public/mermaid.min.js`、`scripts/vendor-mermaid.mjs`、`test/mermaid.test.mjs`
- Modify: `public/diff.js`、`public/styles.css`、`public/index.html`、`public/doc.html`、`test/generation.test.mjs`

**Interfaces:**
- Produces: `loadMermaidModule(doc: { createElement, appendChild }) => { ensureMermaidFor(items) => Promise<void> }`（把脚本注入所需的宿主操作显式传入，单测用假 doc，生产传 `document`）；`hasMermaid(items: Decorated[]) => boolean`；`mermaidPlaceholderHTML(d: Decorated, i: number) => string`（含 `data-mermaid="i"`、`<pre class="mm-src">源码</pre>`、`<div class="mm-host">渲染中…</div>`）；`ensureMermaidFor(items) => Promise<void>`（无 mermaid 块时立即 resolve 且不注入；有则注入 `<script src="/mermaid.min.js?v=…" defer>`，**并发去重**，失败 reject）；`mermaidFailHTML(err: Error, source: string) => string`；`mountMermaid(root: Element)`（对每个 `[data-mermaid]` 调 `window.mermaid.render`，成功替换 `mm-host`，失败换成 `mermaidFailHTML` + 保留源码）。

- [ ] **Step 1: 写失败测试**

```js
// test/mermaid.test.mjs
test('无 mermaid 块时不注入脚本', async () => {
  const injected = [];
  const { ensureMermaidFor } = loadMermaidModule({ createElement: () => ({ setAttribute() {}, addEventListener() {} }), appendChild: (n) => injected.push(n) });
  await ensureMermaidFor([]);
  assert.equal(injected.length, 0);
});

test('有 mermaid 块时注入一次，并发调用不重复', async () => {
  const injected = [];
  const mod = loadMermaidModule({ createElement: () => ({ src: '', setAttribute() {}, addEventListener() {} }), appendChild: (n) => injected.push(n) });
  const [a, b] = await Promise.allSettled([mod.ensureMermaidFor([{ block: { kind: 'code', lang: 'mermaid' } }]), mod.ensureMermaidFor([{ block: { kind: 'code', lang: 'mermaid' } }])]);
  assert.equal(injected.length, 1);
});

test('失败降级含错误摘要与源码，不空白', () => {
  const html = mermaidFailHTML(new Error('Parse error'), 'graph TD; A-->');
  assert.match(html, /图表渲染失败/);
  assert.match(html, /Parse error/);
  assert.match(html, /graph TD/);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/mermaid.test.mjs`；Expected: FAIL — 模块不存在

- [ ] **Step 3: vendor mermaid**（`scripts/vendor-mermaid.mjs`：`npm i -D mermaid@11.4.1` → esbuild 打包默认导出为 IIFE `window.mermaid`，产物 `public/mermaid.min.js`，实测 2.6 MB min / 766 KB gzip；`package.json` 增加 `npm run vendor:mermaid`）

- [ ] **Step 4: 实现占位与懒加载**（渲染时 mermaid 块输出占位；`readingHTML` 之后调用 `ensureMermaidFor(items)`；`window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: prefersDark ? 'dark' : 'default' })`；每个图 `render(<uniqueId>, code)` 后写入 `mm-host`）

- [ ] **Step 5: 实现改动对比**（`state !== 'normal'` 的 mermaid 块：默认显示改后渲染 + 角标"图表已变更"，`<details>` 内放改前渲染（`baseText`）；两侧源码都用 Task 21 的 `diffCodeLines` + `is-add`/`is-del` 标记，改前侧只显示被删行与上下文、改后侧只显示新增行与上下文）

- [ ] **Step 6: 加断言与样式**（`test/generation.test.mjs`：mermaid 块输出占位且**不包含** `window.mermaid` 调用；改块带"图表已变更"；`styles.css` 加 `.mm-host`、`.mm-src`、`.mm-badge` 与窄屏上下堆叠）

- [ ] **Step 7: 跑测试确认通过** — Run: `npm test`；Expected: 全绿（mermaid 真实渲染不进单测）

- [ ] **Step 8: 浏览器冒烟**（`npx wrangler dev --local --port 8790 --var MOCK_MODE:1`；打开含 mermaid 的文档：确认首屏 Network 无 `mermaid.min.js`，滚动到图表后请求一次、渲染成功；再用错误语法验证降级文案）

- [ ] **Step 9: 提交**

```bash
git add scripts/vendor-mermaid.mjs public/mermaid.min.js public/diff.js public/styles.css public/index.html public/doc.html test/mermaid.test.mjs test/generation.test.mjs package.json
git commit -m "feat: mermaid 懒加载渲染、改动对比与失败降级"
```

---

## 验收（P4 结束时）

1. 顶栏无 diff 模式按钮；`grep` 无 `drail|changeRail|syncRail|railHTML|sideBySideHTML|unifiedHTML|splitHTML`。
2. 黄金语料：错标 0、漏标 ≤ 2、粒度不符 ≤ 2（以负责人签收的工作表为准）。
3. 三态切换不重建 DOM、不重取正文（请求计数断言）。
4. 既有 169 项测试全绿；新增引擎与语料用例全绿。
5. 右栏在 1440/1200 两种宽度下行为正确；键盘可达。
6. 代码块：`data-line` 与评论落点不变；未知语言不着色；> 1000 行只高亮前 1000 行并提示；**改动的代码块里新增行带 `+`、删除行带 `−`（在原文面板）**，未改动行不带标记。
7. mermaid：无图表页面首屏无 `mermaid.min.js` 请求；有图表页面渲染一次且缓存；三种失败路径都有文案与源码。
