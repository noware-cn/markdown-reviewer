/**
 * 健康检查冒烟脚本。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:8787 npm run smoke      # 本地 wrangler dev
 *   BASE_URL=https://<生产地址> npm run smoke          # 生产验证
 *
 * 断言：HTTP 200、status=ok、service/environment/commit 非空、timestamp 可解析。
 * 设置 EXPECT_COMMIT 时，额外断言 commit 与期望值一致，用于核对生产部署提交。
 */

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8787";
const expectedCommit = process.env.EXPECT_COMMIT || "";
const target = `${baseUrl.replace(/\/+$/, "")}/api/health`;

const failures = [];

const check = (condition, message) => {
  if (!condition) failures.push(message);
};

let status;
let body;
try {
  const response = await fetch(target, { redirect: "follow" });
  status = response.status;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    failures.push(`响应不是合法 JSON：${text.slice(0, 120)}`);
  }
  check(status === 200, `HTTP 状态应为 200，实际 ${status}`);
  check(response.headers.get("content-type")?.includes("application/json"), "content-type 应为 application/json");
} catch (error) {
  failures.push(`请求失败：${error.message}`);
}

if (body) {
  check(body.status === "ok", `status 应为 ok，实际 ${body.status}`);
  check(typeof body.service === "string" && body.service.length > 0, "service 缺失");
  check(typeof body.environment === "string" && body.environment.length > 0, "environment 缺失");
  check(typeof body.commit === "string" && body.commit.length > 0, "commit 缺失");
  check(Number.isFinite(Date.parse(body.timestamp)), "timestamp 不是可解析的时间");
  if (expectedCommit) {
    check(body.commit === expectedCommit, `commit 应为 ${expectedCommit}，实际 ${body.commit}`);
  }
}

console.log(`target: ${target}`);
console.log(`http:   ${status ?? "-"}`);
console.log(`body:   ${body ? JSON.stringify(body) : "-"}`);

if (failures.length > 0) {
  console.error("\nFAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\nPASS");
