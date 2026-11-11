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
    mergeOptions: null,       // 覆盖 /merge-options 的个别字段
    commitTruncated: false,   // 提交明细的文件列表被截断
  };
  const meta = (n) => ({
    number: n, title: `PR ${n}`, state: world.prState || 'open', merged: Boolean(world.prMerged),
    baseSha: world.prs[n].baseSha, headSha: world.prs[n].headSha, baseRef: 'main', headRef: `f${n}`,
    commits: 1, changedFiles: world.prs[n].files.length, additions: 1, deletions: 1,
    author: 'u', createdAt: '', mergedAt: null, url: `https://github.com/x/y/pull/${n}`,
  });
  const respond = (call, body) => {
    if (body) return { status: body.status, ok: body.status >= 200 && body.status < 300, json: async () => body.data };
    const u = new URL(call.url, 'http://x');
    const reply = /^\/api\/approvals\/(\d+)\/comments\/(\d+)\/replies$/.exec(u.pathname);
    if (reply) {
      world.replies = world.replies || [];
      world.replies.push({ commentId: Number(reply[2]), body: (JSON.parse(call.body || '{}') || {}).body });
      return { status: 200, ok: true, json: async () => ({ ok: true, reply: { id: 990002, url: '#' } }) };
    }
    const sub = /^\/api\/approvals\/(\d+)\/commits\/([^/]+)(\/file)?$/.exec(u.pathname);
    if (sub) {
      const n = Number(sub[1]);
      const sha = decodeURIComponent(sub[2]);
      if (sub[3]) {
        const p = u.searchParams.get('path');
        return { status: 200, ok: true, json: async () => ({
          path: p, ref: sha, side: u.searchParams.get('side') || 'head',
          text: `# ${p} @ ${sha}\n\n- 项目\n`, truncated: false,
        }) };
      }
      return { status: 200, ok: true, json: async () => ({
        sha, shortSha: sha.slice(0, 7), headline: `提交 ${sha}`, message: `提交 ${sha}`,
        author: 'u', authorName: 'u', date: '', parents: [world.prs[n].baseSha], isMerge: false,
        url: `https://github.com/x/y/commit/${sha}`,
        stats: { additions: 1, deletions: 0, total: 1 },
        files: world.prs[n].files.slice(0, 1).map((f) => ({
          path: f.path, previousPath: null, status: f.status, additions: 1, deletions: 0,
          patch: '@@ -1,1 +1,1 @@\n-旧\n+新', isMarkdown: true,
        })),
        truncated: Boolean(world.commitTruncated),
      }) };
    }
    const m = /^\/api\/approvals\/(\d+)\/(diff|file|comments|commits|merge-options)$/.exec(u.pathname);
    if (!m) return { status: 404, ok: false, json: async () => ({ message: 'not found' }) };
    const n = Number(m[1]);
    if (m[2] === 'commits') {
      return { status: 200, ok: true, json: async () => ({
        items: [{
          sha: world.prs[n].headSha, shortSha: world.prs[n].headSha.slice(0, 7),
          headline: `提交 ${n}`, message: `提交 ${n}`, author: 'u', authorName: 'u',
          date: '', parents: [], isMerge: false, url: `https://github.com/x/y/commit/${world.prs[n].headSha}`,
        }],
        truncated: false,
      }) };
    }
    if (m[2] === 'merge-options') {
      return { status: 200, ok: true, json: async () => Object.assign({
        canMerge: true, reason: '', methods: ['merge', 'squash'], defaultMethod: 'merge',
        draft: false, mergeable: true, mergeableState: 'clean',
        headSha: world.prs[n].headSha, baseRef: 'main', headRef: `f${n}`, permissions: { push: true },
      }, world.mergeOptions || {}) };
    }
    if (m[2] === 'diff') {
      return { status: 200, ok: true, json: async () => ({
        meta: meta(n),
        files: world.prs[n].files.map((f) => ({
          path: f.path, previousPath: null, status: f.status, additions: 1, deletions: 0,
          patch: (world.patches && world.patches[f.path])
            || (f.status === 'added' ? null : '@@ -1,1 +1,1 @@\n-旧\n+新'),
          isMarkdown: true,
        })),
        comments: world.comments || [],
      }) };
    }
    if (m[2] === 'file') {
      const p = u.searchParams.get('path');
      const side = u.searchParams.get('side');
      const body = (side === 'base' && world.texts && world.texts[`${p}@base`])
        || (side !== 'base' && world.texts && world.texts[p])
        || (world.texts && world.texts[p])
        || `# ${p} @ ${u.searchParams.get('ref')}\n\n- 项目\n`;
      return { status: 200, ok: true, json: async () => ({ text: body, truncated: false }) };
    }
    return { status: world.post.status, ok: world.post.status === 200, json: async () => world.post.data };
  };
  world.fetch = (url, opts = {}) => {
    const call = { url, method: opts.method || "GET", body: opts.body };
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
    setAttribute() {}, getAttribute() { return 'true'; }, removeAttribute() {},
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
  const exposed = diffSrc.replace(ANCHOR, `  window.__D = D; window.__load = load; window.__selectFile = selectFile; window.__selectCommit = selectCommit; window.__commitAll = selectAll; window.__submit = submitDrafts; window.__locateFromSelection = locateFromSelection; window.__saveDrafts = saveDrafts; window.__listBlockWithInsertions = listBlockWithInsertions; window.__blockHtml = blockHtml; window.__wrapAdded = wrapAddedText; window.__docTarget = docLinkTarget; window.__docLink = handleDocLink; window.__resolve = resolveBlockUrls; window.__reply = sendReply; window.__railHTML = railHTML;\n${ANCHOR}`);
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
  assert.equal(app.ctx.window.__D.texts[app.ctx.window.__D.revKey]['a.md'].headSha, 'h1');
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

test('提交视图：只列该提交的文件，正文改用该提交的 ref，并标记只读', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const p = app.ctx.window.DiffView.mount(1, { commit: 'h1' });
  await tick();
  const d = world.gated().find((c) => c.url.includes('/1/diff'));
  if (d) d.release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await p;

  const D = app.ctx.window.__D;
  assert.equal(D.rev.kind, 'commit');
  assert.equal(D.rev.sha, 'h1');
  assert.deepEqual(D.files.map((f) => f.path), ['a.md'], '提交视图只列本次提交的文件');
  const texts = D.texts[D.revKey]['a.md'];
  assert.equal(texts.headSha, 'h1');
  assert.equal(texts.baseSha, 'b1', 'base 侧取父提交');
  assert.ok(world.calls.some((c) => c.url.includes('/api/approvals/1/commits/h1/file?')
    && c.url.includes('side=head')));

  const bar = app.els.get('wbCommitBar');
  assert.equal(bar.hidden, false);
  assert.ok(bar.innerHTML.includes('历史提交'));
  assert.ok(bar.innerHTML.includes('回到全部改动'));
  assert.equal(app.els.get('wbDoc').classList.contains('readonly'), true);
});

test('提交视图：切回全部改动会恢复 PR 的文件列表', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const p = app.ctx.window.DiffView.mount(1, { commit: 'h1' });
  await tick();
  const d = world.gated().find((c) => c.url.includes('/1/diff'));
  if (d) d.release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await p;

  const D = app.ctx.window.__D;
  assert.deepEqual(D.files.map((f) => f.path), ['a.md']);
  app.ctx.window.__commitAll();
  assert.equal(D.rev.kind, 'all');
  assert.deepEqual(D.files.map((f) => f.path), ['a.md', 'b.md']);
  assert.equal(app.els.get('wbCommitBar').hidden, true);
  assert.equal(app.els.get('wbDoc').classList.contains('readonly'), false);
});

test('提交视图：慢的提交明细返回后不覆盖后来的「全部改动」', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const D = app.ctx.window.__D;

  world.gate = (c) => c.url.includes('/commits/h1');
  const slow = app.ctx.window.__selectCommit('h1');
  await tick();
  assert.equal(world.gated().length, 1, '明细请求应仍在飞行中');

  app.ctx.window.__commitAll();
  world.gated().forEach((c) => c.release());
  await slow;

  assert.equal(D.rev.kind, 'all', '过期响应不能把视图切回提交');
  assert.deepEqual(D.files.map((f) => f.path), ['a.md', 'b.md']);
});

test('正文加载：过期视图的响应不写进当前视图的缓存', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const D = app.ctx.window.__D;

  delete D.texts[D.revKey]['b.md'];
  world.gate = (c) => c.url.includes('/file?path=b.md');
  const slow = app.ctx.window.__selectFile('b.md');
  await tick();
  assert.equal(world.gated().length, 1);

  const commit = app.ctx.window.__selectCommit('h1');
  await tick();
  await releaseGated(world, (c) => c.url.includes('/commits/h1/file?'));
  await commit;
  assert.equal(D.rev.kind, 'commit');

  await releaseGated(world, (c) => c.url.includes('/file?path=b.md'));
  await slow;
  assert.equal(D.texts[D.revKey]['b.md'], undefined, '旧视图的正文不能落到新视图的缓存里');
});

test('前进/后退到提交地址：恢复路由里的阅读方式并保留锚点', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const D = app.ctx.window.__D;
  D.mode = 'reading';

  const routed = app.ctx.window.DiffView.applyRoute({
    kind: 'pr', n: 1, commit: 'h1', mode: 'split', line: 12, endLine: null,
  });
  await tick();
  await releaseGated(world, (c) => c.url.includes('/commits/h1/file?'));
  await routed;

  assert.equal(D.rev.kind, 'commit');
  assert.equal(D.mode, 'split', '换视图时要落回路由里的阅读方式');
  assert.deepEqual({ ...D.pendingAnchor }, { line: 12, endLine: null }, '换视图不能丢掉路由里的锚点');
});

test('合并区：存在冲突时按钮禁用并说明原因', async () => {
  const world = makeWorld();
  world.mergeOptions = { canMerge: true, reason: '', mergeable: false, mergeableState: 'dirty', methods: [] };
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const drawer = app.els.get('wbDrawerBody').innerHTML;
  assert.ok(drawer.includes('存在合并冲突'), '禁用合并按钮必须说明原因');
  assert.ok(/id="wbMerge"[^>]*disabled/.test(drawer), '有冲突时不给合并按钮');
});

test('默认阅读视图不等提交列表：正文与列表并行加载', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const isList = (c) => /^\/api\/approvals\/1\/commits$/.test(c.url);
  world.gate = (c) => c.url.includes('/diff') || isList(c);

  const mounted = app.ctx.window.DiffView.mount(1);
  await tick();
  world.gated().find((c) => c.url.includes('/1/diff')).release();
  await tick();

  assert.ok(world.gated().some(isList), '提交列表仍未返回');
  assert.ok(world.calls.some((c) => c.url.includes('/file?')), '正文请求不该等提交列表');
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await tick();
  await tick();
  assert.equal(app.ctx.window.__D.prefetchDone, 2);

  await releaseGated(world, isList);
  await mounted;
});

test('提交条：文件列表被截断时标注数量并指向 GitHub', async () => {
  const world = makeWorld();
  world.commitTruncated = true;
  const app = mountApp(world);
  const p = app.ctx.window.DiffView.mount(1, { commit: 'h1' });
  await tick();
  world.gated().find((c) => c.url.includes('/1/diff')).release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/commits/h1/file?'));
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await p;

  const bar = app.els.get('wbCommitBar').innerHTML;
  assert.ok(bar.includes('1+ 个文件'), '截断时数量要带 +');
  assert.ok(bar.includes('只列出前 1 个文件'), '截断时要说清只列了部分');
  assert.ok(bar.includes('在 GitHub 查看'));
  assert.ok(app.els.get('wbStats').textContent.includes('1+ 个文件'));
});

test('选提交失败不会把正在加载的正文丢掉', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const D = app.ctx.window.__D;

  delete D.texts[D.revKey]['b.md'];
  world.gate = (c) => c.url.includes('/file?path=b.md');
  const slow = app.ctx.window.__selectFile('b.md');
  await tick();
  assert.equal(world.gated().length, 1);

  /* 选一个不在列表里的提交：只弹提示，视图仍是「全部改动」 */
  const picked = await app.ctx.window.__selectCommit('ffffffff');
  assert.equal(picked, false);
  assert.equal(D.rev.kind, 'all');

  await releaseGated(world, (c) => c.url.includes('/file?path=b.md'));
  await slow;
  const texts = D.texts[D.revKey]['b.md'];
  assert.ok(texts && texts.headLoaded, '正文仍要落到当前视图，不能卡在「正在加载正文…」');
});

test('提交列表晚到只刷新下拉，不重建抽屉', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const isList = (c) => /^\/api\/approvals\/1\/commits$/.test(c.url);
  world.gate = (c) => c.url.includes('/diff') || isList(c)
    || c.url.includes('/merge-options') || c.url.includes('/file?');

  const mounted = app.ctx.window.DiffView.mount(1);
  await tick();
  world.gated().find((c) => c.url.includes('/1/diff')).release();
  await tick();
  await releaseGated(world, (c) => c.url.includes('/file?'));
  await releaseGated(world, (c) => c.url.includes('/merge-options'));
  await tick();
  await tick();
  assert.ok(world.gated().some(isList), '此时只剩提交列表未返回');

  /* 模拟审核人正在抽屉里写评论：后台请求完成后不该重建抽屉 */
  app.els.get('wbDrawerBody').innerHTML = 'COMPOSER-SENTINEL';
  await releaseGated(world, isList);
  await mounted;

  assert.equal(app.els.get('wbDrawerBody').innerHTML, 'COMPOSER-SENTINEL', '列表到达不应重建抽屉');
  assert.ok(app.els.get('wbCommitSelect').innerHTML.includes('提交 1'), '下拉框要更新');
});

test('严格选区定位：多行块取整块范围，单行/代码行仍精确', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const node = (selector, dataset) => ({ nodeType: 1, dataset, closest(q) { return q === selector ? this : null; } });
  const multi = node('.md-block[data-line][data-end-line]', { line: '4', endLine: '8' });
  assert.deepEqual({ ...app.ctx.window.__locateFromSelection({ anchorNode: multi, focusNode: multi }) }, { start: 4, end: 8 });
  const single = node('.md-block[data-line][data-end-line]', { line: '4', endLine: '4' });
  assert.deepEqual({ ...app.ctx.window.__locateFromSelection({ anchorNode: single, focusNode: single }) }, { start: 4, end: 4 });
  const codeA = node('.code-line[data-line]', { line: '10' });
  const codeB = node('.code-line[data-line]', { line: '12' });
  assert.deepEqual({ ...app.ctx.window.__locateFromSelection({ anchorNode: codeA, focusNode: codeB }) }, { start: 10, end: 12 });
  const unknown = { nodeType: 1, dataset: { line: '3' }, closest() { return null; } };
  assert.equal(app.ctx.window.__locateFromSelection({ anchorNode: unknown, focusNode: unknown }), null);
});

test('代码块逐行映射从围栏下一行开始', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const block = app.ctx.window.DiffModel.mdBlocks('```js\nconst x = 1;\n```')[0];
  const html = app.ctx.window.__blockHtml(block, {});
  assert.ok(html.includes('class="code-line" data-line="2"'));
});

test('列表删除项在原列表项位置插入', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const block = app.ctx.window.DiffModel.mdBlocks('- 第一项\n- 第三项').find((b) => b.type === 'ul');
  const result = app.ctx.window.__listBlockWithInsertions(block, [{
    afterNewLine: 1,
    change: { id: 'del-2', oldStart: 2, oldEnd: 2, oldText: '- 第二项' },
  }], { path: 'a.md' });
  const first = result.html.indexOf('<li data-line="1">');
  const deleted = result.html.indexOf('删除（Base L2）');
  const firstClose = result.html.indexOf('</li>', first);
  const second = result.html.indexOf('<li data-line="2">');
  assert.ok(first >= 0 && firstClose < deleted && deleted < second);
  assert.deepEqual(Array.from(result.unplaced), []);
});

test('列表行号映射被放弃时，删除内容回退到 unplaced 而不丢失', () => {
  const world = makeWorld();
  const app = mountApp(world);
  // marked 去掉嵌套缩进后 item.raw 在原文匹配不上，行号映射整体放弃。
  const block = app.ctx.window.DiffModel.mdBlocks('- a\n  - b\n    c\n  - d\n- e').find((b) => b.type === 'ul');
  const result = app.ctx.window.__listBlockWithInsertions(block, [{
    afterNewLine: 2,
    change: { id: 'del-b', oldStart: 2, oldEnd: 2, oldText: '- b' },
  }], { path: 'a.md' });
  assert.ok(!/<li[^>]*\bdata-line=/.test(result.html), '行号映射应被整体放弃');
  assert.ok(!result.html.includes('删除（Base L2）'), '不应把删除内容错配到其他列表项');
  assert.deepEqual(Array.from(result.unplaced, (item) => item.change.id), ['del-b']);
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
  world.gate = () => false; // 本用例只关心请求参数，不拦截网络
  await app.ctx.window.__load(1, true, true);
  assert.ok(world.calls.some((c) => c.url.includes('/1/diff') && c.url.includes('refreshMeta=1')));
  assert.equal(world.calls.filter((c) => c.url.includes('/file?')).length, beforeFiles);
  /* 正文缓存不动；提交列表随强制刷新重取一次（?refresh=1 只出现在 commits 上） */
  assert.ok(world.calls.every((c) => !c.url.includes('refreshText=1')));
  const forced = world.calls.filter((c) => c.url.includes('refresh=1') && !c.url.includes('/commits'));
  assert.deepEqual(forced, []);
});

test('切换并重新打开原 PR 后，旧提交只清除旧快照草稿', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  app.ctx.window.__D.drafts = [{ id: 'submitted-before-switch', path: 'a.md', body: '旧意见', start: 1, end: 1, headSha: 'h1' }];
  app.ctx.window.__saveDrafts();
  world.gate = (call) => call.method === 'POST';
  const submit = app.ctx.window.__submit();
  await tick();
  await mountComplete(world, app, 2);
  await mountComplete(world, app, 1);
  app.ctx.window.__D.drafts = [{ id: 'new-after-reopen', path: 'a.md', body: '新意见', start: 1, end: 1, headSha: 'h1' }];
  app.ctx.window.__saveDrafts();
  const post = world.gated().find((call) => call.method === 'POST');
  assert.ok(post);
  post.release();
  await submit;
  assert.deepEqual(app.ctx.window.__D.drafts.map((draft) => draft.id), ['new-after-reopen']);
  const saved = JSON.parse(app.store['wb.drafts.1']);
  assert.deepEqual(saved.map((draft) => draft.id), ['new-after-reopen']);
  // 抽屉必须同步重画，否则旧草稿仍按旧索引可被删除，误删新草稿。
  const drawer = app.els.get('wbDrawerBody').innerHTML;
  assert.ok(drawer.includes('新意见'));
  assert.ok(!drawer.includes('旧意见'));
});

test('文档内相对资源：图片与文档链接按当前提交解析', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n看图：![图示](img/a.png) 与 [细则](./b.md#L20)\n' };
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const html = app.els.get('wbContent').innerHTML;
  assert.ok(
    html.includes('https://raw.githubusercontent.com/x/y/h1/img/a.png'),
    '图片要按 head 提交解析，不能留相对路径',
  );
  assert.ok(html.includes('/doc/b.md?ref=h1#L20'), '文档链接落到工作台文档页并保留行锚点');
});

test('语义 diff：块内只给新增片段加下划线，不再出现整块徽章', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n第一段保持不动，\n这里新增了一句话。\n' };
  world.patches = { 'a.md': '@@ -1,3 +1,3 @@\n # 标题\n \n 第一段保持不动，\n-旧的一句。\n+这里新增了一句话。\n' };
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const html = app.els.get('wbContent').innerHTML;
  assert.ok(!html.includes('class="diff-tag'), '正文里不再出现「新增/修改」徽章');
  assert.ok(html.includes('<ins class="md-ins">这里新增了一句话。</ins>'), '只标记新增的片段');
  assert.ok(!html.includes('<ins class="md-ins">第一段保持不动'), '未改动的文本不能被一起标上');
});

test('章节列表：右侧微条按改动数填充', async () => {
  const world = makeWorld();
  world.texts = {
    'a.md': '# 标题\n\n第一节正文。\n\n## 二节\n\n第二节正文。\n',
  };
  world.patches = { 'a.md': '@@ -1,6 +1,6 @@\n # 标题\n \n-第一节正文。\n+第一节正文改了。\n \n ## 二节\n \n 第二节正文。\n' };
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const chapters = app.els.get('wbChapters').innerHTML;
  assert.ok(chapters.includes('class="cbar'), '每个章节条目带改动密度微条');
  assert.ok(chapters.includes('<i class="on"></i>'), '有改动的节至少填一格');
});

test('评论记号：有评论的段落带浅底与页边窄条，正文不写数字', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n第一段内容。\n\n第二段内容。\n' };
  world.patches = { 'a.md': '@@ -1,3 +1,5 @@\n # 标题\n \n+第一段内容。\n+\n+第二段内容。\n' };
  world.comments = [
    { id: 11, path: 'a.md', line: 3, originalLine: 3, side: 'RIGHT', body: '这段要补依据', author: 'reviewer', url: 'https://github.com/x/y/pull/1#c11', inReplyTo: null },
    { id: 12, path: 'a.md', line: 3, originalLine: 3, side: 'RIGHT', body: '同意，补一下测算', author: 'other', url: null, inReplyTo: 11 },
  ];
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const html = app.els.get('wbContent').innerHTML;
  assert.ok(/class="md-block[^"]*has-comments"/.test(html), '有评论的块要带 has-comments');
  assert.ok(html.includes('class="cstripe"'), '页边要有一条窄条标位置');
  assert.ok(html.includes('此段 1 个评论线程'), '气泡说明线程数，而不是在正文里写数字');
  assert.ok(!/<sup/.test(html), '正文不出现上标数字');
  assert.ok(/class="md-block(?! has-comments)[^"]*"(?![^>]*has-comments)/.test(html), '没有评论的块保持原样');
});

test('评论树：按行排序、回复缩进，悬停与正文用同一个行锚点', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n第一段内容。\n\n第二段内容。\n' };
  world.patches = { 'a.md': '@@ -1,3 +1,5 @@\n # 标题\n \n+第一段内容。\n+\n+第二段内容。\n' };
  world.comments = [
    { id: 21, path: 'a.md', line: 5, originalLine: 5, side: 'RIGHT', body: '第二段的问题', author: 'b', url: null, inReplyTo: null },
    { id: 20, path: 'a.md', line: 3, originalLine: 3, side: 'RIGHT', body: '第一段的问题', author: 'a', url: 'https://github.com/x/y/pull/1#c20', inReplyTo: null },
    { id: 22, path: 'a.md', line: 3, originalLine: 3, side: 'RIGHT', body: '第一段的回复', author: 'c', url: null, inReplyTo: 20 },
  ];
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const drawer = app.els.get('wbDrawerBody').innerHTML;
  assert.ok(drawer.includes('评论树 · 2 线程 / 1 回复'), '标题按线程统计');
  assert.ok(drawer.indexOf('第一段的问题') < drawer.indexOf('第二段的问题'), '按行号升序，不按返回顺序');
  assert.ok(drawer.includes('titem reply'), '回复缩进成子项');
  assert.ok(drawer.includes('data-jump-to="3"'), '每条都带正文行锚点，供悬停联动与跳转');
});

test('气泡回复：就地 POST 到 replies，成功后本地补进评论树', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n第一段内容。\n' };
  world.patches = { 'a.md': '@@ -1,3 +1,3 @@\n # 标题\n \n+第一段内容。\n' };
  world.comments = [
    { id: 31, path: 'a.md', line: 3, originalLine: 3, side: 'RIGHT', body: '这段要补依据', author: 'reviewer', url: null, inReplyTo: null },
  ];
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const html = app.els.get('wbContent').innerHTML;
  assert.ok(html.includes('class="trta"'), '气泡里要有回复框');
  assert.ok(html.includes('data-act="reply"'));

  await app.ctx.window.__reply(31, '已补在第 4 节', null);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(world.replies?.length, 1, '要走 replies 接口');
  assert.equal(world.replies[0].commentId, 31);
  assert.equal(world.replies[0].body, '已补在第 4 节');
  assert.ok(app.els.get('wbDrawerBody').innerHTML.includes('已补在第 4 节'), '回复立刻出现在评论树里');
});


test('只读视图：已关闭 / 已合并的 PR 不出现回复框', async () => {
  for (const flag of [{ prState: 'closed' }, { prMerged: true }]) {
    const world = makeWorld();
    Object.assign(world, flag);
    world.texts = { 'a.md': '# 标题\n\n第一段内容。\n' };
    world.patches = { 'a.md': '@@ -1,3 +1,3 @@\n # 标题\n \n+第一段内容。\n' };
    world.comments = [
      { id: 41, path: 'a.md', line: 3, originalLine: 3, body: '看一下这段', author: 'reviewer', url: null, inReplyTo: null },
    ];
    const app = mountApp(world);
    await mountComplete(world, app, 1);
    const html = app.els.get('wbContent').innerHTML;
    assert.ok(html.includes('has-comments'), '评论记号还在');
    assert.equal(html.includes('class="trta"'), false, '只读视图不出回复框');
    assert.equal(app.els.get('wbDrawerBody').innerHTML.includes('data-act="reply-tree"'), false);
  }
});

test('评论树不截断长评论；过期评论标注位置已变', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n第一段内容。\n' };
  world.patches = { 'a.md': '@@ -1,3 +1,3 @@\n # 标题\n \n+第一段内容。\n' };
  const longBody = '这里的结论需要补充三条依据：' + '甲'.repeat(200);
  world.comments = [
    { id: 51, path: 'a.md', line: 3, originalLine: 3, body: longBody, author: 'reviewer', url: null, inReplyTo: null },
    { id: 52, path: 'a.md', line: null, originalLine: 2, body: '旧位置的评论', author: 'reviewer', url: null, inReplyTo: null },
  ];
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const tree = app.els.get('wbDrawerBody').innerHTML;
  assert.ok(tree.includes(longBody), '长评论完整显示');
  assert.ok(tree.includes('位置已变'), '过期评论有标注');
  const html = app.els.get('wbContent').innerHTML;
  assert.equal((html.match(/has-comments/g) || []).length, 1, '只有当前行号的评论标在正文上');
});

test('原文块按 base 提交解析图片，不用 head', async () => {
  const world = makeWorld();
  world.texts = {
    'a.md': '# 标题\n\n![图](images/a%23b.png) 新说明\n',
    'a.md@base': '# 标题\n\n![图](images/a%23b.png) 旧说明\n',
  };
  world.prs[1].baseSha = 'base123456';
  world.prs[1].headSha = 'head123456';
  world.patches = { 'a.md': '@@ -1,3 +1,3 @@\n # 标题\n \n-![图](images/a%23b.png) 旧说明\n+![图](images/a%23b.png) 新说明\n' };
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const html = app.els.get('wbContent').innerHTML;
  assert.ok(html.includes('/base123456/'), '原文用 base 提交');
  assert.ok(html.includes('/head123456/'), '新文用 head 提交');
  assert.ok(html.includes('images/a%23b.png'), '路径段编码，%23 不被当成片段');
});


test('行内新增标记：位置有序；同一段里同一句出现多次时不猜，只留页边记号', () => {
  const app = mountApp(makeWorld());
  const wrap = app.ctx.window.__wrapAdded;

  const twice = '<p>目标压到 15 秒，再说一遍目标压到 15 秒。</p>';
  assert.equal(wrap(twice, ['目标压到 15 秒']), twice, '有歧义时整句都不标');

  const once = wrap('<p>其余不变，目标压到 15 秒。</p>', ['目标压到 15 秒']);
  assert.ok(once.includes('<ins class="md-ins">目标压到 15 秒</ins>'), '唯一匹配才标');

  const two = wrap('<p>甲段。</p><p>乙段新句。</p>', ['甲段。', '乙段新句。']);
  assert.equal((two.match(/<ins class="md-ins">/g) || []).length, 2, '多个新增片段各标一次');

  const acrossTags = wrap('<p>前 <b>后</b>。</p>', ['前 后。']);
  assert.equal(acrossTags.includes('<ins'), false, '跨标签的新增文本不拆标签，只留页边记号');
});


test('内链还原：/doc/ 路径与锚点解码回仓库路径，其他链接不受影响', () => {
  const app = mountApp(makeWorld());
  const target = app.ctx.window.__docTarget;
  const j = (v) => JSON.stringify(v);
  assert.equal(j(target('/doc/a%20b/c%23d.md?ref=abc#L20')), j({ path: 'a b/c#d.md', anchor: 'L20', ref: 'abc' }));
  assert.equal(j(target('/doc/x.md')), j({ path: 'x.md', anchor: '', ref: '' }));
  assert.equal(j(target('/doc/x.md?ref=h1')), j({ path: 'x.md', anchor: '', ref: 'h1' }));
  assert.equal(target('/pr/1'), null);
  assert.equal(target('https://github.com/a/b'), null);
});


test('新增行按源码顺序匹配：短句在前、长句在后，两处都要标出来', async () => {
  const world = makeWorld();
  world.texts = {
    'a.md': '# 标题\n\n第一段不变。\n\n短句新增。\n原始说明文字，目标是与上一版保持一致，另外补充更长的说明。\n',
    'a.md@base': '# 标题\n\n第一段不变。\n\n原始说明文字，目标是与上一版保持一致。\n',
  };
  world.patches = { 'a.md': '@@ -1,5 +1,6 @@\n # 标题\n \n 第一段不变。\n \n-原始说明文字，目标是与上一版保持一致。\n+短句新增。\n+原始说明文字，目标是与上一版保持一致，另外补充更长的说明。\n' };
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const html = app.els.get('wbContent').innerHTML;
  assert.equal((html.match(/<ins class="md-ins">/g) || []).length, 2, '两处新增都标出来');
});

test('带修饰键的内链点击交给浏览器：不拦截、不阻止默认行为', () => {
  const app = mountApp(makeWorld());
  const handler = app.ctx.window.__docLink;
  const link = { getAttribute: (k) => (k === 'href' ? '/doc/a.md' : null) };
  for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    let prevented = false;
    const event = { [key]: true, preventDefault: () => { prevented = true; } };
    assert.equal(handler(event, link), false, `${key} 时交给浏览器`);
    assert.equal(prevented, false, `${key} 时不阻止默认行为`);
  }
  let prevented = false;
  const plain = handler({ preventDefault: () => { prevented = true; } }, link);
  assert.equal(prevented, true, '普通点击仍就地处理');
  assert.equal(plain, true);
});


test('相对资源改写保留片段：PDF 页码、图片锚点都不丢', () => {
  const world = makeWorld();
  const app = mountApp(world);
  const resolve = app.ctx.window.__resolve;
  const D = app.ctx.window.__D;
  D.meta = { url: 'https://github.com/x/y/pull/1', headSha: 'head1', baseSha: 'base1', state: 'open' };
  const file = { path: 'docs/a.md', status: 'modified' };
  const html = '<a href="spec.pdf#page=3">规格</a><a href="other.md#L20">链接</a><img src="p.png">';
  const out = resolve(html, file, 'head1');
  assert.ok(out.includes('raw.githubusercontent.com/x/y/head1/docs/spec.pdf#page=3'), 'PDF 片段保留');
  assert.ok(out.includes('href="/doc/docs/other.md?ref=head1#L20"'), '文档链接带锚点');
  assert.ok(out.includes('head1/docs/p.png'), '图片走 raw');
});

test('内链按 ref 分流：当前视图提交就地切换，其他提交单开引用视图', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  const w = app.ctx.window;
  const D = w.__D;
  D.meta = { url: 'https://github.com/x/y/pull/1', headSha: 'head1', baseSha: 'base1', state: 'open' };
  D.n = 1;
  D.files = [{ path: 'a.md', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-旧\n+新' }];
  D.rev = { kind: 'all' };
  const link = (href) => ({ getAttribute: (k) => (k === 'href' ? href : null) });
  const ev = { preventDefault() {} };

  world.calls.length = 0;
  assert.equal(w.__docLink(ev, link('/doc/a.md?ref=head1')), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(world.calls.some((c) => c.url.includes('/approvals/1/file')), 'head 版本仍是 PR 内文件，就地切换');
  assert.equal(world.calls.some((c) => c.url.includes('/api/doc')), false, '不额外开引用视图');

  world.calls.length = 0;
  assert.equal(w.__docLink(ev, link('/doc/a.md?ref=base1')), true);
  await new Promise((r) => setTimeout(r, 30));
  const docCall = world.calls.find((c) => c.url.includes('/api/doc'));
  assert.ok(docCall && /ref=base1/.test(docCall.url), 'base 版本按该提交开引用视图');

  /* 提交视图：commit 与 head 都算「同一次审阅」，指向本 PR 文件的链接仍就地切换 */
  D.rev = { kind: 'commit', sha: 'c1', parentSha: 'p1' };
  world.calls.length = 0;
  w.__docLink(ev, link('/doc/a.md?ref=head1'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(world.calls.some((c) => c.url.includes('/commits/c1/file')), '提交视图下 head 链接切文件');
  assert.equal(world.calls.some((c) => c.url.includes('/api/doc')), false, '不再单开引用视图');

  /* 提交视图：指向不在本次改动里的文件，按链接的提交打开，不退回 head */
  world.calls.length = 0;
  w.__docLink(ev, link('/doc/notes.md?ref=c1'));
  await new Promise((r) => setTimeout(r, 30));
  const docCall2 = world.calls.find((c) => c.url.includes('/api/doc'));
  assert.ok(docCall2 && /ref=c1/.test(docCall2.url), '引用视图按链接的提交取数');
});


test('回复面板默认收起：正文气泡与评论树都先给「回复」按钮，点开才有输入框', async () => {
  const world = makeWorld();
  world.texts = {
    'a.md': '# 标题\n\n这一段有评论。\n',
  };
  world.comments = [
    { id: 71, path: 'a.md', line: 3, side: 'RIGHT', author: 'lijing', body: '这里需要补数据来源', url: null, inReplyTo: null, commitId: 'b1', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  for (const [where, html] of [
    ['正文气泡', app.els.get('wbContent').innerHTML],
    ['评论树', app.els.get('wbDrawerBody').innerHTML],
  ]) {
    assert.ok(html.includes('data-act="reply-toggle"'), `${where} 要有「回复」按钮`);
    assert.ok(/data-composer="(doc|tree):71" hidden/.test(html), `${where} 的输入框默认隐藏`);
    assert.ok(html.includes('class="trta"'), `${where} 输入框仍在（展开时复用）`);
  }
});


test('未发送的草稿也在正文里标出来：页边虚线 + 气泡条目', async () => {
  const world = makeWorld();
  world.texts = { 'a.md': '# 标题\n\n这一段有评论。\n' };
  world.comments = [
    { id: 81, path: 'a.md', line: 3, side: 'RIGHT', author: 'lijing', body: '补数据来源', url: null, inReplyTo: null, commitId: 'b1', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const app = mountApp(world);
  await mountComplete(world, app, 1);

  const D = app.ctx.window.__D;
  D.drafts = [{ id: 'd1', path: 'a.md', start: 3, end: 3, body: '这里的口径要说明', headSha: D.meta.headSha }];
  await app.ctx.window.__selectFile('a.md', true);

  const html = app.els.get('wbContent').innerHTML;
  assert.ok(html.includes('has-drafts'), '块上要带 has-drafts');
  assert.ok(html.includes('class="dstripe"'), '页边要有草稿虚线');
  assert.ok(html.includes('1 条草稿未发送'), '气泡头部要写草稿数');
  assert.ok(html.includes('这里的口径要说明'), '气泡里要能读到草稿内容');
  assert.ok(html.includes('has-comments'), '已发出的评论标记不受影响');
});


test('刻度按真实像素定位：相邻同类合并，颜色只区分新增/修改/删除', async () => {
  const world = makeWorld();
  const app = mountApp(world);
  await mountComplete(world, app, 1);
  const railHTML = app.ctx.window.__railHTML;

  const html = railHTML([
    { kind: 'mod', line: 3, top: 120, height: 40 },
    { kind: 'mod', line: 6, top: 164, height: 20 },   // 与上一块间距 4px，合并
    { kind: 'add', line: 9, top: 300, height: 30 },
    { kind: 'del', line: 12, top: 360, height: 10 },
  ]);
  assert.equal((html.match(/class="drail-t/g) || []).length, 3, '相邻同类合并成一条');
  assert.ok(html.includes('style="top:120.0px;height:64.0px"'), '合并后覆盖两块的完整高度');
  assert.ok(html.includes('style="top:300.0px;height:30.0px"'), '未合并的块保持自己的位置');
  assert.ok(html.includes('data-drail="9"'), '保留跳转行号');
  assert.ok(html.includes('· 新增') && html.includes('· 删除') && html.includes('· 修改'), '三种状态都有文案');
});
