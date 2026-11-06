/* 线上环境验证（依赖境外站点：*.workers.dev 与 api.cloudflare.com）。
 *
 * 本地默认跳过，CI 里由工作流注入环境变量后执行：
 *   PROD_BASE_URL      部署地址（仓库变量，部署工作流也会自动带上）
 *   EXPECT_COMMIT      期望的部署提交；设置后 /api/health 与 DEPLOY_COMMIT 都必须一致
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  读取线上 Worker 绑定
 *   WORKER_NAME        可选，默认 approval-visualization-worker
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth } from '../scripts/health.mjs';

const baseUrl = process.env.PROD_BASE_URL || '';
const expectedCommit = process.env.EXPECT_COMMIT || '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
const workerName = process.env.WORKER_NAME || 'approval-visualization-worker';

test('/api/health 可达且返回部署提交', { skip: !baseUrl && '未设置 PROD_BASE_URL（CI 中由工作流注入）' }, async () => {
  const { target, status, body, failures } = await checkHealth(baseUrl, expectedCommit);
  assert.deepEqual(failures, [], `${target}（HTTP ${status}）\n${JSON.stringify(body)}`);
});

test('线上 Worker 绑定正确：DEPLOY_COMMIT 匹配、运行时 Secret 齐全', {
  skip: (!accountId || !apiToken) && '未设置 Cloudflare 凭据（CI 中由 Secret 注入）',
}, async () => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/settings`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  const data = await res.json();
  assert.equal(data.success, true, `读取绑定失败：HTTP ${res.status} ${JSON.stringify(data.errors)}`);

  const bindings = data.result?.bindings || [];
  const binding = (name) => bindings.find((b) => b.name === name);
  const commit = binding('DEPLOY_COMMIT')?.text || '';
  assert.match(commit, /^[0-9a-f]{7,40}$/, `DEPLOY_COMMIT 未写入或格式异常：${JSON.stringify(commit)}`);
  if (expectedCommit) assert.equal(commit, expectedCommit, '线上版本不是本次提交');

  for (const name of ['SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_DATA_TOKEN']) {
    assert.equal(binding(name)?.type, 'secret_text', `${name} 未配置为 Secret`);
  }
});
