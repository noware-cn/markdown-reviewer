/* 文档链接解析回归：客户端（文档里的一条链接落到哪）+ 服务端（仓库里的真实路径）。
 * 用户报告的原始问题是「点链接返回 JSON」，根因是相对链接被解析到站点根，落到静态资源 404。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const REPO = new URL('..', import.meta.url).pathname;
const markedSrc = fs.readFileSync(`${REPO}public/marked.min.js`, 'utf8');
const modelSrc = fs.readFileSync(`${REPO}public/diff-model.js`, 'utf8');

function loadModel() {
  const ctx = { window: {}, console, URL };
  const markedCtx = { module: { exports: {} }, exports: {}, window: {}, self: {} };
  markedCtx.globalThis = markedCtx;
  vm.createContext(markedCtx);
  vm.runInContext(markedSrc, markedCtx);
  ctx.window.marked = markedCtx.exports.marked;
  ctx.window.DOMPurify = { sanitize: (s) => s };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(modelSrc, ctx);
  return ctx.window.DiffModel;
}

const model = loadModel();
const CTX = { host: "workspace.noware.cn", org: "noware-cn", repo: "workspace" };

/* ---------- 客户端：文档里的链接 ---------- */

test('resolveDocLink：相对路径按当前文档所在目录展开', () => {
  const hit = model.resolveDocLink("./客户需求记录模板.md", "docs/08-客户需求/README.md", CTX);
  assert.equal(hit.kind, "repo");
  assert.equal(hit.path, "docs/08-客户需求/客户需求记录模板.md");
  assert.equal(hit.isDoc, true);
});

test('resolveDocLink：../ 逐级回到上级目录', () => {
  const hit = model.resolveDocLink("../../09-方案/x.md", "docs/08-客户需求/记录/a.md", CTX);
  assert.equal(hit.kind, "repo");
  assert.equal(hit.path, "docs/09-方案/x.md");
});

test('resolveDocLink：越过仓库根的 .. 不当成仓库链接', () => {
  assert.equal(model.resolveDocLink("../../../x.md", "a/b.md", CTX).kind, "other");
});

test('resolveDocLink：站内绝对路径与同域绝对 URL 都归到仓库路径', () => {
  assert.equal(model.resolveDocLink("/docs/x.md", "a/b.md", CTX).path, "docs/x.md");
  assert.equal(
    model.resolveDocLink("https://workspace.noware.cn/docs/x.md", "a/b.md", CTX).path,
    "docs/x.md",
  );
});

test('resolveDocLink：GitHub blob 链接取出 ref 之后的仓库路径', () => {
  const hit = model.resolveDocLink(
    "https://github.com/noware-cn/workspace/blob/272905c/docs/a/x.md?plain=1#L3",
    "a/b.md",
    CTX,
  );
  assert.equal(hit.kind, "repo");
  assert.equal(hit.path, "docs/a/x.md");
  assert.equal(hit.anchor, "L3");
});

test('resolveDocLink：外链、锚点、协议链接各归各类', () => {
  assert.equal(model.resolveDocLink("https://example.com/a.md", "a/b.md", CTX).kind, "external");
  assert.equal(model.resolveDocLink("https://github.com/other/repo/blob/main/a.md", "a/b.md", CTX).kind, "external");
  const anchor = model.resolveDocLink("#客户需求", "a/b.md", CTX);
  assert.equal(anchor.kind, "anchor");
  assert.equal(anchor.anchor, "客户需求");
  assert.equal(model.resolveDocLink("mailto:a@b.com", "a/b.md", CTX).kind, "other");
  assert.equal(model.resolveDocLink("javascript:alert(1)", "a/b.md", CTX).kind, "other");
  assert.equal(model.resolveDocLink("", "a/b.md", CTX).kind, "other");
});

test('resolveDocLink：URL 编码的路径会被解码，非文档后缀不算文档', () => {
  const encoded = model.resolveDocLink("%E5%AE%A2%E6%88%B7/%E9%9C%80%E6%B1%82.md", "a/b.md", CTX);
  assert.equal(encoded.path, "a/客户/需求.md");
  assert.equal(encoded.isDoc, true);
  const img = model.resolveDocLink("img/a.png", "docs/b.md", CTX);
  assert.equal(img.path, "docs/img/a.png");
  assert.equal(img.isDoc, false);
  assert.equal(model.resolveDocLink("a.csv", "docs/b.md", CTX).isDoc, true);
});

test('slugify：保留中文与数字，去标点，空白转连字符', () => {
  assert.equal(model.slugify("客户需求记录 V0.1"), "客户需求记录-v01");
  assert.equal(model.slugify("  3. 数据 (LAN) 流入  "), "3-数据-lan-流入");
  assert.equal(model.slugify(""), "");
});

test('renderMarkdown：标题带锚点 id，重复标题加序号，表格套滚动外壳', () => {
  const html = model.renderMarkdown("# 客户需求\n\n## 记录\n\n## 记录\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  assert.ok(html.includes('<h1 id="客户需求">'));
  assert.ok(html.includes('<h2 id="记录">'));
  assert.ok(html.includes('<h2 id="记录-1">'), "重复标题追加序号");
  assert.ok(html.includes('<div class="table-shell"><div class="tscroll"><table>'));
});

/* ---------- 服务端：仓库内路径 ---------- */

async function loadDoc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-doc-"));
  for (const name of fs.readdirSync(path.join(REPO, "src"))) {
    const code = fs.readFileSync(path.join(REPO, "src", name), "utf8")
      .replace(/from "\.\/([A-Za-z0-9_-]+)"/g, 'from "./$1.ts"');
    fs.writeFileSync(path.join(dir, name), code);
  }
  return import(path.join(dir, "doc.ts"));
}

const doc = await loadDoc();
const ENV = { GITHUB_ORG: "noware-cn", GITHUB_REPO: "workspace" };

const withTree = async (files, fn) => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ tree: files.map((p) => ({ path: p, type: "blob" })) }) };
  };
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = previous;
  }
};

test('normalizeDocPath：去空段与 .、拒绝 .. 与空路径', () => {
  assert.equal(doc.normalizeDocPath("docs/a.md"), "docs/a.md");
  assert.equal(doc.normalizeDocPath("/docs//a.md"), "docs/a.md");
  assert.equal(doc.normalizeDocPath("docs\\a.md"), "docs/a.md");
  assert.equal(doc.normalizeDocPath("%E5%AE%A2%E6%88%B7/a.md"), "客户/a.md");
  assert.equal(doc.normalizeDocPath("../etc/passwd"), null);
  assert.equal(doc.normalizeDocPath("docs/../a.md"), null);
  assert.equal(doc.normalizeDocPath(""), null);
  assert.equal(doc.normalizeDocPath("/"), null);
});

test('resolveDocPath：精确命中直接用仓库路径', async () => {
  await withTree(["docs/08-客户需求/README.md"], async () => {
    const hit = await doc.resolveDocPath(ENV, "t", "r1", "docs/08-客户需求/README.md");
    assert.equal(hit.path, "docs/08-客户需求/README.md");
    assert.equal(hit.candidates.length, 0);
  });
});

test('resolveDocPath：丢了目录层级的链接按后缀唯一命中补回', async () => {
  await withTree([
    "docs/08-客户需求与市场洞察/客户需求记录/客户需求记录模板.md",
    "docs/09-技术方案/README.md",
  ], async () => {
    const hit = await doc.resolveDocPath(ENV, "t", "r2", "客户需求记录/客户需求记录模板.md");
    assert.equal(hit.path, "docs/08-客户需求与市场洞察/客户需求记录/客户需求记录模板.md");
    assert.equal(hit.candidates.length, 0);
  });
});

test('resolveDocPath：后缀多处命中时给候选、不给错文件', async () => {
  await withTree([
    "docs/a/记录.md",
    "docs/b/c/记录.md",
    "docs/d/e/f/记录.md",
  ], async () => {
    const hit = await doc.resolveDocPath(ENV, "t", "r3", "x/记录.md");
    assert.equal(hit.path, null);
    assert.deepEqual(hit.candidates, ["docs/a/记录.md", "docs/b/c/记录.md", "docs/d/e/f/记录.md"]);
  });
});

test('resolveDocPath：找不到时退回同名文件当候选', async () => {
  await withTree(["docs/a/客户需求-001_脱敏分析记录_V0.1.md"], async () => {
    const hit = await doc.resolveDocPath(ENV, "t", "r4", "客户需求记录/客户需求-001_脱敏分析记录_V0.1.md");
    assert.equal(hit.path, null);
    assert.deepEqual(hit.candidates, ["docs/a/客户需求-001_脱敏分析记录_V0.1.md"]);
  });
});

test('resolveDocPath：非法路径在读取文件树之前就拒绝', async () => {
  let calls = 0;
  const hit = await withTree([], async (getCalls) => {
    const result = await doc.resolveDocPath(ENV, "t", "r5", "../secret.md");
    calls = getCalls();
    return result;
  });
  assert.equal(hit.path, null);
  assert.equal(hit.candidates.length, 0);
  assert.equal(calls, 0);
});
