/* generation 隔离 / spinner 生命周期 / 提交失败提示 回归测试（node --test，无需依赖）
 * 用受控 fetch + 最小 DOM 桩驱动真实的 public/diff.js。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = new URL('..', import.meta.url).pathname;
const markedSrc = fs.readFileSync(`${REPO}public/marked.min.js`, 'utf8');
const modelSrc = fs.readFileSync(`${REPO}public/diff-model.js`, 'utf8');
const diffSrc = fs.readFileSync(`${REPO}public/diff.js`, 'utf8');

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeWorld() {
  const world = {
    calls: [],
    gate: (c) => c.url.includes('/diff'),
    prs: {
      1: { headSha: 'h1', baseSha: 'b1', files: [{ path: 'a.md', status: 'modified' }, { path: 'b.md', status: 'modified' }] },
      2: { headSha: 'h2', baseSha: 'b2', files: [{ path: 'c.md', status: 'added' }] },
      3: { headSha: 'h3', baseSha: 'b3', files: [{ path: 'd.md', status: 'added' }] },
    },
    post: { status: 200, data: { ok: true, review: { id: 77, comments: 0 } } },
  };
  const meta = (n) => ({
    number: n, title: `PR ${n}`, state: 'open', merged: false,
    baseSha: world.prs[n].baseSha, headSha: world.prs[n].headSha, baseRef: 'main', headRef: `f${n}`,
    commits: 1, changedFiles: world.prs[n].files.length, additions: 1, deletions: 1,
    author: 'u', createdAt: '', mergedAt: null, url: `https://github.com/x/y/pull/${n}`,
  });
  const respond = (call, body) => {
    if (body) return { status: body.status, ok: body.status >= 200 && body.status < 300, json: async () => body.data };
    const u = new URL(call.url, 'http://x');
    const m = /^\/api\/approvals\/(\d+)\/(diff|file|comments)$/.exec(u.pathname);
    if (!m) return { status: 404, ok: false, json: async () => ({ message: 'not found' }) };
    const n = Number(m[1]);
    if (m[2] === 'diff') {
      return { status: 200, ok: true, json: async () => ({
        meta: meta(n),
        files: world.prs[n].files.map((f) => ({
          path: f.path, previousPath: null, status: f.status, additions: 1, deletions: 0,
          patch: f.status === 'added' ? null : '@@ -1,1 +1,1 @@\n-旧\n+新', isMarkdown: true,
        })),
        comments: [],
      }) };
    }
    if (m[2] === 'file') {
      const p = u.searchParams.get('path');
      return { status: 200, ok: true, json: async () => ({ text: `# ${p} @ ${u.searchParams.get('ref')}\n\n- 项目\n`, truncated: false }) };
    }
    return { status: world.post.status, ok: world.post.status === 200, json: async () => world.post.data };
  };
  world.fetch = (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET' };
    world.calls.push(call);
    if (world.gate(call)) {
      return new Promise((resolve) => { call.release = (body) => { call.released = true; resolve(respond(call, body)); }; });
    }
    return Promise.resolve(respond(call));
  };
  world.gated = () => world.calls.filter((c) => c.release && !c.released);
  return world;
}

function makeDocument() {
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
  });
  return {
    els,
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
      querySelectorAll() { return []; },
      addEventListener() {},
      activeElement: null,
      body: { classList: classList() },
    },
  };
}

function mountApp(world) {
  const { document, els } = makeDocument();
  const store = {};
  const ctx = {
    window: { getSelection: () => null, innerWidth: 1200 },
    document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: world.fetch,
    location: { href: '' },
    confirm: () => true,
    setTimeout, clearTimeout, AbortController, URL, console,
    requestAnimationFrame: (fn) => fn(),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const modelCtx = { window: { marked: null, DOMPurify: { sanitize: (s) => s } } };
  modelCtx.window.window = modelCtx.window;
  const markedCtx = { module: { exports: {} }, exports: {}, window: {}, self: {} };
  markedCtx.globalThis = markedCtx;
  vm.createContext(markedCtx);
  vm.runInContext(markedSrc, markedCtx);
  modelCtx.window.marked = markedCtx.exports.marked;
  vm.createContext(modelCtx);
  vm.runInContext(modelSrc, modelCtx);
  ctx.window.DiffModel = modelCtx.window.DiffModel;

  const ANCHOR = '  let bound = false;';
  const exposed = diffSrc.replace(ANCHOR, `  window.__D = D; window.__load = load; window.__selectFile = selectFile; window.__submit = submitDrafts; window.__locateFromSelection = locateFromSelection; window.__saveDrafts = saveDrafts; window.__listBlockWithInsertions = listBlockWithInsertions; window.__blockHtml = blockHtml;\n${ANCHOR}`);
  vm.runInContext(exposed, ctx);
  return { ctx, els, store };
}

async function releaseGated(world, pred) {
  for (let i = 0; i < 20; i += 1) {
    const open = world.gated().filter(pred);
    if (!open.length) return;
    open.forEach((c) => c.release());
    await tick();
  }
  throw new Error(`未释放完：${world.gated().map((c) => c.url).join(', ')}`);
}

async function mountComplete(world, app, n) {
  const p = app.ctx.window.DiffView.mount(n);
  await tick();
  const d = world.gated().find((c) => c.url.includes(`/${n}/diff`));
  if (d) d.release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await p;
}

const loadingState = (app) => ({ loading: app.ctx.window.__D.loading, hidden: app.els.get('wbLoading').hidden });

test('切换 PR：旧请求返回后 spinner 不残留', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const p1 = app.ctx.window.DiffView.mount(1);
  await tick();
  const p2 = app.ctx.window.DiffView.mount(2);
  await tick();
  const d1 = world.gated().find((c) => c.url.includes('/1/diff'));
  const d2 = world.gated().find((c) => c.url.includes('/2/diff'));
  d1.release();
  await tick();
  d2.release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await Promise.all([p1, p2]);
  assert.deepEqual(loadingState(app), { loading: 0, hidden: true });
});

test('selectFile 被新一代取代后 spinner 不残留', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  world.gate = (c) => c.url.includes('/diff') || c.url.includes('/file?');
  const sf = app.ctx.window.__selectFile('a.md', true);
  await tick();
  const p2 = app.ctx.window.DiffView.mount(2);
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?') && c.url.includes('path=a.md'));
  const d2 = world.gated().find((c) => c.url.includes('/2/diff'));
  if (d2) d2.release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await Promise.all([sf, p2]);
  assert.deepEqual(loadingState(app), { loading: 0, hidden: true });
});

test('同代次并发加载多个文件不会误减计数', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  world.gate = (c) => c.url.includes('/diff') || c.url.includes('/file?');
  const a = app.ctx.window.__selectFile('a.md', true);
  const b = app.ctx.window.__selectFile('b.md', true);
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await Promise.all([a, b]);
  assert.deepEqual(loadingState(app), { loading: 0, hidden: true });
});

test('连续 mount 多次不累积 loading', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const ps = [1, 2, 3].map((n) => app.ctx.window.DiffView.mount(n));
  await tick();
  for (const d of world.gated().filter((c) => c.url.includes('/diff'))) {
    d.release();
    await tick();
  }
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await Promise.all(ps);
  assert.deepEqual(loadingState(app), { loading: 0, hidden: true });
});

test('预加载只使用本代次快照，不请求新 PR 的正文', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  world.gate = (c) => c.url.includes('/diff') || (c.url.includes('/file?') && c.url.includes('ref=h1'));
  const p1 = app.ctx.window.DiffView.mount(1);
  await tick();
  world.gated().find((c) => c.url.includes('/1/diff')).release();
  await tick();
  const p2 = app.ctx.window.DiffView.mount(2);
  await tick();
  const d2 = world.gated().find((c) => c.url.includes('/2/diff'));
  d2.release();
  await tick();
  // 释放 gen1 仍在飞的请求，让它继续发下一跳
  await releaseGated(world, (c) => c.url.includes('ref=h1'));
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await Promise.all([p1, p2]);
  // gen2 自己请求 c.md 是正常的；gen1 遗留的 a.md/b.md 请求落到 /2/ 才是泄漏
  const leaked = world.calls.filter((c) => c.url.includes('/api/approvals/2/file?')
    && /path=(a|b)\.md/.test(c.url));
  assert.deepEqual(leaked, []);
  assert.deepEqual(loadingState(app), { loading: 0, hidden: true });
});

test('评论刷新复用已加载正文（0 次正文请求）', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const before = world.calls.filter((c) => c.url.includes('/file?')).length;
  const p = app.ctx.window.__load(1, true, false);
  await tick();
  world.gated().find((c) => c.url.includes('/1/diff')).release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await p;
  assert.equal(world.calls.filter((c) => c.url.includes('/file?')).length - before, 0);
  assert.equal(app.ctx.window.__D.texts['a.md'].headSha, 'h1');
});

test('提交失败不再把旧 PR 的错误弹到新 PR', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  app.ctx.window.__D.drafts = [{ path: 'a.md', body: '意见', start: 1, end: 1, headSha: 'h1' }];
  world.gate = (c) => c.method === 'POST' || c.url.includes('/diff');
  const sub = app.ctx.window.__submit();
  await tick();
  const p2 = app.ctx.window.DiffView.mount(2);
  await tick();
  const d2 = world.gated().find((c) => c.url.includes('/2/diff'));
  d2.release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await p2;
  const post = world.gated().find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/approvals/1/comments', '提交目标必须是快照里的 PR');
  post.release({ status: 409, data: { status: 'error', message: 'PR 已产生新提交' } });
  await sub;
  assert.equal(app.els.get('dtoast')?.textContent || '', '', '旧 PR 的失败提示不应显示在新 PR 上');
  assert.equal(app.ctx.window.__D.n, 2);
});

test('严格选区定位：多行块不回退到块首', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const node = (selector, dataset) => ({ nodeType: 1, dataset, closest(q) { return q === selector ? this : null; } });
  const multi = node('.md-block[data-line][data-end-line]', { line: '4', endLine: '8' });
  assert.equal(app.ctx.window.__locateFromSelection({ anchorNode: multi, focusNode: multi }), null);
  const single = node('.md-block[data-line][data-end-line]', { line: '4', endLine: '4' });
  assert.deepEqual(app.ctx.window.__locateFromSelection({ anchorNode: single, focusNode: single }), { start: 4, end: 4 });
  const codeA = node('.code-line[data-line]', { line: '10' });
  const codeB = node('.code-line[data-line]', { line: '12' });
  assert.deepEqual(app.ctx.window.__locateFromSelection({ anchorNode: codeA, focusNode: codeB }), { start: 10, end: 12 });
  const unknown = { nodeType: 1, dataset: { line: '3' }, closest() { return null; } };
  assert.equal(app.ctx.window.__locateFromSelection({ anchorNode: unknown, focusNode: unknown }), null);
});

test('代码块逐行映射从围栏下一行开始', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const block = app.ctx.window.DiffModel.mdBlocks('```js\\nconst x = 1;\\n```')[0];
  const html = app.ctx.window.__blockHtml(block, {});
  assert.ok(html.includes('class="code-line" data-line="2"'));
});

test('列表删除项在原列表项位置插入', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const block = app.ctx.window.DiffModel.mdBlocks('- 第一项\\n- 第三项').find((b) => b.type === 'ul');
  const result = app.ctx.window.__listBlockWithInsertions(block, [{
    afterNewLine: 1,
    change: { id: 'del-2', oldStart: 2, oldEnd: 2, oldText: '- 第二项' },
  }], { path: 'a.md' });
  const first = result.html.indexOf('<li data-line="1">');
  const deleted = result.html.indexOf('删除（Base L2）');
  const firstClose = result.html.indexOf('</li>', first);
  const second = result.html.indexOf('<li data-line="2">');
  assert.ok(first >= 0 && firstClose < deleted && deleted < second);
  assert.deepEqual(result.unplaced, []);
});

test('提交成功只删除快照草稿，保留请求期间新增的草稿', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  app.ctx.window.__D.drafts = [{ id: 'submitted-1', path: 'a.md', body: '旧意见', start: 1, end: 1, headSha: 'h1' }];
  app.ctx.window.__saveDrafts();
  world.gate = (c) => c.method === 'POST';
  const submit = app.ctx.window.__submit();
  await tick();
  app.ctx.window.__D.drafts.push({ id: 'new-during-submit', path: 'a.md', body: '新意见', start: 1, end: 1, headSha: 'h1' });
  app.ctx.window.__saveDrafts();
  const post = world.gated().find((c) => c.method === 'POST');
  assert.ok(post);
  post.release();
  await submit;
  assert.deepEqual(app.ctx.window.__D.drafts.map((d) => d.id), ['new-during-submit']);
  const saved = JSON.parse(app.store['wb.drafts.1']);
  assert.deepEqual(saved.map((d) => d.id), ['new-during-submit']);
});

test('手动强制刷新只刷新 PR 元数据，不强制刷新正文', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const beforeFiles = world.calls.filter((c) => c.url.includes('/file?')).length;
  await app.ctx.window.__load(1, true, true);
  assert.ok(world.calls.some((c) => c.url.includes('/1/diff') && c.url.includes('refreshMeta=1')));
  assert.equal(world.calls.filter((c) => c.url.includes('/file?')).length, beforeFiles);
  assert.ok(world.calls.every((c) => !c.url.includes('refreshText=1') && !c.url.includes('refresh=1')));
});
