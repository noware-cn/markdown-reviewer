/* 提交浏览与合并接口回归：提交列表 / 单提交明细 / 提交内正文 / 合并条件 / 合并
 * 用 Node 原生 TS 支持直接运行 src/index.ts，GitHub API 换成内存 fixture。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREV = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE = 'cccccccccccccccccccccccccccccccccccccccc';

async function loadWorker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-worker-'));
  for (const name of fs.readdirSync(path.join(REPO, 'src'))) {
    const code = fs.readFileSync(path.join(REPO, 'src', name), 'utf8')
      .replace(/from "\.\/([A-Za-z0-9_-]+)"/g, 'from "./$1.ts"');
    fs.writeFileSync(path.join(dir, name), code);
  }
  const worker = (await import(path.join(dir, 'index.ts'))).default;
  const { createSession } = await import(path.join(dir, 'session.ts'));
  return { worker, createSession, dir };
}

function makeGitHub() {
  const state = {
    calls: [],
    merged: [],
    pr: {
      number: 1, title: '文档评审', state: 'open', merged_at: null, created_at: '2026-11-01T00:00:00Z',
      html_url: 'https://github.com/noware-cn/workspace/pull/1', user: { login: 'alice' },
      changed_files: 1, additions: 1, deletions: 1, commits: 2, draft: false,
      mergeable: true, mergeable_state: 'clean',
      base: { sha: BASE, ref: 'main' }, head: { sha: HEAD, ref: 'topic/x' },
    },
    repo: {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: false,
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    },
    commits: [
      { sha: PREV, html_url: `https://github.com/noware-cn/workspace/commit/${PREV}`, parents: [{ sha: BASE }],
        author: { login: 'alice' },
        commit: { message: 'docs: 先补一章背景\n\n补上背景说明。', author: { name: 'Alice', email: 'a@x', date: '2026-11-05T10:00:00Z' } } },
      { sha: HEAD, html_url: `https://github.com/noware-cn/workspace/commit/${HEAD}`, parents: [{ sha: PREV }],
        author: { login: 'bob' },
        commit: { message: 'docs: 补结论', author: { name: 'Bob', email: 'b@x', date: '2026-11-06T10:00:00Z' } } },
    ],
    detail: {
      sha: HEAD,
      html_url: `https://github.com/noware-cn/workspace/commit/${HEAD}`,
      parents: [{ sha: PREV }],
      author: { login: 'bob' },
      commit: { message: 'docs: 补结论', author: { name: 'Bob', email: 'b@x', date: '2026-11-06T10:00:00Z' } },
      stats: { additions: 1, deletions: 1, total: 2 },
      files: [{ filename: 'docs/a.md', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n # 标题\n-旧行\n+新行' }],
    },
    texts: { 'docs/a.md': '# 标题\n\n新行\n' },
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const p = u.pathname;
    state.calls.push(`${method} ${p}`);
    if (method === 'GET' && p === '/repos/noware-cn/workspace') return json(state.repo);
    if (method === 'GET' && p === '/repos/noware-cn/workspace/pulls/1') return json(state.pr);
    if (method === 'GET' && p === '/repos/noware-cn/workspace/pulls/1/commits') {
      const page = Number(u.searchParams.get('page') || '1');
      return json(page === 1 ? state.commits : []);
    }
    if (method === 'GET' && p === `/repos/noware-cn/workspace/commits/${HEAD}`) return json(state.detail);
    if (method === 'GET' && p.startsWith('/repos/noware-cn/workspace/contents/')) {
      const key = decodeURIComponent(p.slice('/repos/noware-cn/workspace/contents/'.length));
      return new Response(state.texts[key] ?? '');
    }
    if (method === 'PUT' && p === '/repos/noware-cn/workspace/pulls/1/merge') {
      const body = JSON.parse(init.body || '{}');
      state.merged.push(body);
      return json({ merged: true, sha: 'dddddddddddddddddddddddddddddddddddddddd', message: 'Pull Request successfully merged' });
    }
    return json({ message: `unmocked ${method} ${p}` }, 404);
  };
  return { state, fetchImpl };
}

async function mount() {
  const realFetch = globalThis.fetch;
  const { state, fetchImpl } = makeGitHub();
  globalThis.fetch = fetchImpl;
  const { worker, createSession, dir } = await loadWorker();
  const secret = 'test-secret-test-secret-test-secret';
  const session = await createSession({ login: 'alice', name: 'Alice', avatar: '', exp: Date.now() + 3600_000, token: 'user-token' }, secret);
  const env = {
    GITHUB_ORG: 'noware-cn', GITHUB_REPO: 'workspace', GITHUB_DATA_TOKEN: 'ro-token',
    SESSION_SECRET: secret, MOCK_MODE: '0', SERVICE_NAME: 'x', ENVIRONMENT: 'test',
  };
  const call = async (p, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('cookie', `sess=${session}`);
    if (init.body) headers.set('content-type', 'application/json');
    const res = await worker.fetch(new Request(`https://worker.test${p}`, { ...init, headers }), env, {});
    return { status: res.status, body: await res.json() };
  };
  const done = () => {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { state, call, done };
}

test('提交列表：短 sha、标题行、作者与父提交', async () => {
  const { call, done } = await mount();
  try {
    const res = await call('/api/approvals/1/commits');
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'github');
    assert.deepEqual(res.body.items.map((c) => c.shortSha), ['bbbbbbb', 'aaaaaaa']);
    assert.deepEqual(res.body.items.map((c) => c.headline), ['docs: 先补一章背景', 'docs: 补结论']);
    assert.equal(res.body.items[1].authorName, 'Bob');
    assert.deepEqual(res.body.items[1].parents, [PREV]);
    assert.equal(res.body.truncated, false);
  } finally { done(); }
});

test('单提交明细：sha 前缀命中，文件归一化并带 stats', async () => {
  const { call, done } = await mount();
  try {
    const res = await call('/api/approvals/1/commits/aaaaaaa');
    assert.equal(res.status, 200);
    assert.equal(res.body.sha, HEAD);
    assert.equal(res.body.files.length, 1);
    assert.equal(res.body.files[0].path, 'docs/a.md');
    assert.equal(res.body.files[0].additions, 1);
    assert.equal(res.body.stats.total, 2);
    assert.equal(res.body.truncated, false);
  } finally { done(); }
});

test('单提交明细：不属于本 PR 的提交返回 404', async () => {
  const { call, done } = await mount();
  try {
    const res = await call('/api/approvals/1/commits/ddddddd');
    assert.equal(res.status, 404);
    assert.match(res.body.message, /不属于此 PR/);
  } finally { done(); }
});

test('提交内正文：head 侧取该提交，base 侧取父提交', async () => {
  const { state, call, done } = await mount();
  try {
    const head = await call(`/api/approvals/1/commits/aaaaaaa/file?path=docs%2Fa.md&side=head`);
    assert.equal(head.status, 200);
    assert.equal(head.body.ref, HEAD);
    assert.equal(head.body.side, 'head');
    assert.ok(head.body.text.includes('新行'));

    const base = await call(`/api/approvals/1/commits/aaaaaaa/file?path=docs%2Fa.md&side=base`);
    assert.equal(base.status, 200);
    assert.equal(base.body.ref, PREV);
    assert.ok(state.calls.includes('GET /repos/noware-cn/workspace/contents/docs/a.md'));
  } finally { done(); }
});

test('合并条件：用登录者令牌判定写权限，只保留仓库允许的方式', async () => {
  const { state, call, done } = await mount();
  try {
    const res = await call('/api/approvals/1/merge-options');
    assert.equal(res.status, 200);
    assert.equal(res.body.canMerge, true);
    assert.equal(res.body.reason, null);
    assert.deepEqual(res.body.methods, ['merge', 'squash']);
    assert.equal(res.body.defaultMethod, 'merge');
    assert.equal(res.body.headSha, HEAD);
    assert.deepEqual(res.body.permissions, { push: true, maintain: false, admin: false });
    assert.ok(state.calls.includes('GET /repos/noware-cn/workspace'));
  } finally { done(); }
});

test('合并条件：无写权限时给出中文原因', async () => {
  const { state, call, done } = await mount();
  try {
    state.repo.permissions = { admin: false, maintain: false, push: false, triage: true, pull: true };
    const res = await call('/api/approvals/1/merge-options');
    assert.equal(res.body.canMerge, false);
    assert.equal(res.body.reason, '需要仓库写权限');

    const blocked = await call('/api/approvals/1/merge', {
      method: 'POST',
      body: JSON.stringify({ sha: HEAD, method: 'merge' }),
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /写权限/);
  } finally { done(); }
});

test('合并成功：按选择的 method 提交，并失效提交列表缓存', async () => {
  const { state, call, done } = await mount();
  try {
    await call('/api/approvals/1/commits');
    const listCalls = () => state.calls.filter((c) => c === 'GET /repos/noware-cn/workspace/pulls/1/commits').length;
    assert.equal(listCalls(), 1);

    const res = await call('/api/approvals/1/merge', {
      method: 'POST',
      body: JSON.stringify({ sha: HEAD, method: 'squash', commitTitle: '合并文档评审', commitMessage: '来自审批工作台' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.merged, true);
    assert.equal(res.body.queued, false);
    assert.deepEqual(state.merged, [{
      sha: HEAD, merge_method: 'squash', commit_title: '合并文档评审', commit_message: '来自审批工作台',
    }]);

    await call('/api/approvals/1/commits');
    assert.equal(listCalls(), 2, '合并后必须重新读取提交列表');
  } finally { done(); }
});

test('合并拒绝：head 已变化返回 409，且不会请求 GitHub 合并', async () => {
  const { state, call, done } = await mount();
  try {
    state.pr.head = { sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ref: 'topic/x' };
    const res = await call('/api/approvals/1/merge', {
      method: 'POST',
      body: JSON.stringify({ sha: HEAD, method: 'merge' }),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /新提交/);
    assert.deepEqual(state.merged, []);
  } finally { done(); }
});

test('合并拒绝：缺少有效 sha 与不支持的合并方式', async () => {
  const { state, call, done } = await mount();
  try {
    const bad = await call('/api/approvals/1/merge', { method: 'POST', body: JSON.stringify({ sha: 'abc' }) });
    assert.equal(bad.status, 400);

    const method = await call('/api/approvals/1/merge', {
      method: 'POST',
      body: JSON.stringify({ sha: HEAD, method: 'rebase' }),
    });
    assert.equal(method.status, 400);
    assert.match(method.body.message, /不支持的合并方式/);
    assert.deepEqual(state.merged, []);
  } finally { done(); }
});

test('合并条件：存在冲突时不可合并，POST 也不会打到 GitHub', async () => {
  const { state, call, done } = await mount();
  try {
    state.pr.mergeable = false;
    state.pr.mergeable_state = 'dirty';
    const options = await call('/api/approvals/1/merge-options');
    assert.equal(options.body.canMerge, false);
    assert.equal(options.body.reason, '存在合并冲突');
    assert.equal(options.body.mergeableState, 'dirty');

    const res = await call('/api/approvals/1/merge', {
      method: 'POST',
      body: JSON.stringify({ sha: HEAD, method: 'merge' }),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /冲突/);
    assert.deepEqual(state.merged, []);
  } finally { done(); }
});

test('合并拒绝：请求体不是 JSON 对象', async () => {
  const { state, call, done } = await mount();
  try {
    for (const raw of ['null', '[]', '"aaaaaaaa"', '123']) {
      const res = await call('/api/approvals/1/merge', { method: 'POST', body: raw });
      assert.equal(res.status, 400, `body=${raw}`);
      assert.match(res.body.message, /JSON/);
    }
    assert.deepEqual(state.merged, []);
  } finally { done(); }
});

test('已合并的 PR 不能再次合并', async () => {
  const { state, call, done } = await mount();
  try {
    state.pr.merged_at = '2026-11-07T00:00:00Z';
    const res = await call('/api/approvals/1/merge', {
      method: 'POST',
      body: JSON.stringify({ sha: HEAD, method: 'merge' }),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /已合并/);
  } finally { done(); }
});
