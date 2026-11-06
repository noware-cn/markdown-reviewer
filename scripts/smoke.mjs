/**
 * 健康检查冒烟脚本（本地/手动用）。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:8787 npm run smoke      # 本地 wrangler dev
 *   BASE_URL=https://<生产地址> EXPECT_COMMIT=<sha> npm run smoke
 *
 * CI 里的同类验证见 test/production.test.mjs（`npm run test:prod`）。
 */

import { checkHealth } from "./health.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8787";
const expectedCommit = process.env.EXPECT_COMMIT || "";

const { target, status, body, failures } = await checkHealth(baseUrl, expectedCommit);

console.log(`target: ${target}`);
console.log(`http:   ${status ?? "-"}`);
console.log(`body:   ${body ? JSON.stringify(body) : "-"}`);

if (failures.length > 0) {
  console.error("\nFAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\nPASS");
