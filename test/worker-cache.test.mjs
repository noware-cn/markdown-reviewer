/* Worker 端回归：提交 Review 后 /diff 立即返回新评论（不再等 5 分钟缓存过期）
 * 通过 Node 原生 TS 支持直接运行 src/index.ts；GitHub API 用内存 fixture 替代。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

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
    comments: [],
    calls: [],
    pr: {
      number: 1, title: '文档评审', state: 'open', merged_at: null, created_at: '2026-11-01T00:00:00Z',
      html_url: 'https://github.com/noware-cn/workspace/pull/1', user: { login: 'alice' },
      changed_files: 1, additions: 1, deletions: 1, commits: 1,
      base: { sha: 'b1', ref: 'main' }, head: { sha: 'h1', ref: 'topic/x' },
    },
    files: [{ filename: 'docs/a.md', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,3 @@\n # 标题\n-旧行\n+新行' }],
    text: '# 标题\n\n新行\n',
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    state.calls.push(`${method} ${u.pathname}`);
    const p = u.pathname;
    if (method === 'GET' && p === '/repos/noware-cn/workspace/pulls/1') return json(state.pr);
    if (method === 'GET' && p === '/repos/noware-cn/workspace/pulls/1/files') return json(state.files);
    if (method === 'GET' && p === '/repos/noware-cn/workspace/pulls/1/comments') return json(state.comments);
    if (method === 'GET' && p === '/repos/noware-cn/workspace/pulls/1/reviews') return json([]);
    if (method === 'GET' && p.startsWith('/repos/noware-cn/workspace/contents/')) return new Response(state.text);
    if (method === 'POST' && p === '/repos/noware-cn/workspace/pulls/1/reviews') {
      const body = JSON.parse(init.body);
      for (const c of body.comments || []) {
        state.comments.push({
          id: 900 + state.comments.length, path: c.path, line: c.line, original_line: c.line,
          body: c.body, user: { login: 'alice' }, created_at: '2026-11-06T00:00:00Z',
          html_url: 'https://github.com/x/y/pull/1#discussion_r1', in_reply_to_id: null,
        });
      }
      return json({ id: 555, html_url: 'u' });
    }
    return json({ message: `unmocked ${method} ${p}` }, 404);
  };
  return { state, fetchImpl };
}

test('提交 Review 后 /diff 立即返回新评论', async () => {
  const realFetch = globalThis.fetch;
  const { state, fetchImpl } = makeGitHub();
  globalThis.fetch = fetchImpl;
  const { worker, createSession, dir } = await loadWorker();
  try {
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

    const first = await call('/api/approvals/1/diff');
    assert.equal(first.body.comments.length, 0);

    const post = await call('/api/approvals/1/comments', {
      method: 'POST',
      body: JSON.stringify({
        commit_id: 'h1', event: 'COMMENT',
        comments: [{ path: 'docs/a.md', body: '这行需要补充依据', line: 2, side: 'RIGHT' }],
      }),
    });
    assert.equal(post.status, 200);

    const second = await call('/api/approvals/1/diff');
    assert.equal(second.body.comments.length, 1, '提交后不带 refresh 也必须是新评论');

    // 正文接口同样应立即看到新评论关联数据（同一 /diff 缓存）
    const file = await call('/api/approvals/1/file?path=docs%2Fa.md&ref=h1');
    assert.equal(file.status, 200);
    assert.ok(file.body.text.startsWith('# 标题'));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件正文 refreshMeta 只刷新一次 PR 数据，refreshText 不刷新 PR 元数据', async () => {
  const realFetch = globalThis.fetch;
  const { state, fetchImpl } = makeGitHub();
  globalThis.fetch = fetchImpl;
  const { worker, createSession, dir } = await loadWorker();
  try {
    const secret = 'test-secret-test-secret-test-secret';
    const session = await createSession({ login: 'alice', name: 'Alice', avatar: '', exp: Date.now() + 3600_000, token: 'user-token' }, secret);
    const env = {
      GITHUB_ORG: 'noware-cn', GITHUB_REPO: 'workspace', GITHUB_DATA_TOKEN: 'ro-token',
      SESSION_SECRET: secret, MOCK_MODE: '0', SERVICE_NAME: 'x', ENVIRONMENT: 'test',
    };
    const call = async (p) => {
      const res = await worker.fetch(new Request(`https://worker.test${p}`, {
        headers: { cookie: `sess=${session}` },
      }), env, {});
      return { status: res.status, body: await res.json() };
    };
    await call('/api/approvals/1/diff');
    const before = state.calls.filter((x) => x === 'GET /repos/noware-cn/workspace/pulls/1').length;
    const refreshed = await call('/api/approvals/1/file?path=docs%2Fa.md&ref=h1&refreshMeta=1');
    assert.equal(refreshed.status, 200);
    const after = state.calls.filter((x) => x === 'GET /repos/noware-cn/workspace/pulls/1').length;
    assert.equal(after - before, 1);
    await call('/api/approvals/1/file?path=docs%2Fa.md&ref=h1&refreshText=1');
    const finalCount = state.calls.filter((x) => x === 'GET /repos/noware-cn/workspace/pulls/1').length;
    assert.equal(finalCount, after);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
