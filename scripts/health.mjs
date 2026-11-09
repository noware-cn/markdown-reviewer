/**
 * 健康检查逻辑：/api/health 的断言集合。
 * 被 scripts/smoke.mjs（本地 CLI）和 test/production.test.mjs（CI 用例）共用。
 *
 * 返回 { target, status, body, failures }，failures 为空即通过。
 */
export async function checkHealth(baseUrl, expectedCommit = "") {
  const target = `${String(baseUrl).replace(/\/+$/, "")}/api/health`;
  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };

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

  return { target, status, body, failures };
}
