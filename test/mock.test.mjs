/* 演示数据回归：MOCK_MODE 下按 PR 号返回对应快照，未收录的号回落到 #11。
 * #16 是 noware-cn/workspace 真实 PR 的抓取快照，含两份 CSV 台账。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const SECRET = 'test-secret-test-secret-test-secret';

async function loadWorker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mock-'));
  for (const name of fs.readdirSync(path.join(REPO, 'src'))) {
    const code = fs.readFileSync(path.join(REPO, 'src', name), 'utf8')
      .replace(/from "\.\/([A-Za-z0-9_-]+)"/g, 'from "./$1.ts"');
    fs.writeFileSync(path.join(dir, name), code);
  }
  const worker = (await import(path.join(dir, 'index.ts'))).default;
  const { createSession } = await import(path.join(dir, 'session.ts'));
  return { worker, createSession };
}

async function boot() {
  const { worker, createSession } = await loadWorker();
  const session = await createSession(
    { login: 'alice', name: 'Alice', avatar: '', exp: Date.now() + 3600_000, token: '' },
    SECRET,
  );
  const env = { MOCK_MODE: '1', SESSION_SECRET: SECRET, SERVICE_NAME: 'x', ENVIRONMENT: 'test' };
  const call = async (p) => {
    const res = await worker.fetch(
      new Request(`https://worker.test${p}`, { headers: { cookie: `sess=${session}` } }),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };
  return { call };
}

const CSV_LEDGER = 'docs/市场调查/区域银行智能研发/中标台账.csv';
const CSV_SOURCES = 'docs/市场调查/区域银行智能研发/来源清单.csv';

test('#16 快照带两份 CSV 台账，行数与真实 PR 的 104 / 66 行一致', async () => {
  const { call } = await boot();
  const { status, body } = await call('/api/approvals/16/diff');
  assert.equal(status, 200);
  assert.equal(body.meta.number, 16);
  assert.equal(body.files.length, 10);

  const csv = body.files.filter((f) => f.path.endsWith('.csv'));
  assert.deepEqual(csv.map((f) => f.path).sort(), [CSV_LEDGER, CSV_SOURCES].sort());
  for (const file of csv) {
    assert.equal(file.isMarkdown, false);
    assert.ok(file.patch && file.patch.startsWith('@@'), `${file.path} 应带 patch`);
  }

  const ledger = body.texts[CSV_LEDGER];
  assert.equal(ledger.base, '');
  assert.ok(ledger.head.replace(/^\ufeff/, '').startsWith('id,class,buyer,buyer_type,province,'));
  assert.equal(ledger.head.trimEnd().split('\n').length, 104);
  assert.equal(body.texts[CSV_SOURCES].head.trimEnd().split('\n').length, 66);
});

test('#16 的 CSV 正文按 ref 区分 base 与 head', async () => {
  const { call } = await boot();
  const diff = (await call('/api/approvals/16/diff')).body;
  const query = `?path=${encodeURIComponent(CSV_LEDGER)}`;

  const head = (await call(`/api/approvals/16/file${query}&ref=${diff.meta.headSha}`)).body;
  assert.equal(head.side, 'head');
  assert.match(head.text, /RB-0001/);

  const base = (await call(`/api/approvals/16/file${query}&ref=${diff.meta.baseSha}`)).body;
  assert.equal(base.side, 'base');
  assert.equal(base.text, '');
});

test('未收录的 PR 号仍回落到 #11 快照，列表里能点到 #16', async () => {
  const { call } = await boot();
  const fallback = await call('/api/approvals/11/diff');
  assert.equal(fallback.body.meta.number, 11);

  const list = await call('/api/approvals');
  const item = list.body.items.find((x) => x.number === 16);
  assert.ok(item, '列表应包含 #16');
  assert.equal(item.state, 'open');
  assert.match(item.title, /中标台账/);
});
