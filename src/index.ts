import type { Env } from "./github";
import { getApproval, listApprovals } from "./github";
import {
  createIssueComment,
  createReviewCommentReply,
  createReview,
  getCommitDetail,
  getFileText,
  getMergeOptions,
  getPrCommits,
  getPrFiles,
  getPrMeta,
  getReviewComments,
  mergePull,
  GitHubError,
  type CommitDetail,
  type CommitSummary,
  type DiffFile,
  type MergeMethod,
  type MergeOptions,
  type PrMeta,
  type ReviewComment,
  type ReviewDraft,
} from "./diff";
import { MOCK_APPROVALS, MOCK_DETAIL } from "./mock";
import { MOCK_DIFF, type MockDiffPayload } from "./mock-diff";
import { MOCK_DIFF_16 } from "./mock-diff-16";
import { defaultBranch, DOC_PATH, normalizeDocPath, resolveDocPath } from "./doc";
import { createSession, readCookie, readSession, type SessionPayload } from "./session";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0" };

const json = (data: unknown, status = 200, extra: HeadersInit = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** 解析 patch，返回 head 侧可评论行号 → hunk 索引的映射（add + ctx op 的 new 行号） */
function commentableHeadLines(patch: string | null): Map<number, number> | null {
  if (!patch) return null;
  const lines = patch.split("\n");
  const result = new Map<number, number>();
  let newNo = 0;
  let hunkIdx = -1;
  for (const line of lines) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { newNo = Number(h[1]); hunkIdx += 1; continue; }
    if (line.startsWith("+")) { result.set(newNo, hunkIdx); newNo += 1; }
    else if (line.startsWith("-")) { /* del, skip */ }
    else if (line.startsWith(" ") || line === "") { result.set(newNo, hunkIdx); newNo += 1; }
  }
  return result;
}

const cookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** 取数令牌：优先服务端只读令牌，其次登录者自己的令牌。 */
const dataToken = (env: Env, session: SessionPayload | null): string | null =>
  env.GITHUB_DATA_TOKEN || session?.token || null;

/** GitHub 取数结果内存缓存：5 分钟 TTL；key 按「组织/仓库 + 路径」，同一仓库所有协作者可见数据一致，跨用户共享。 */
const apiCache = new Map<string, { at: number; body: unknown }>();
const apiCacheTTL = 300_000;
/** 简单容量上限：提交/合并接口会引入更多 key，避免 Worker 内存无界增长。 */
const API_CACHE_MAX = 300;

const repoKey = (env: Env): string => `${env.GITHUB_ORG}/${env.GITHUB_REPO}`;

/** 失效代号：失效时 +1，飞在路上的请求回来后若代号已变就不回写，避免旧数据复活。 */
const apiGen = new Map<string, number>();
const apiInvalidate = (...keys: string[]) => {
  for (const key of keys) {
    apiCache.delete(key);
    apiGen.set(key, (apiGen.get(key) ?? 0) + 1);
  }
};

/** 取数并回写缓存。GitHub 失败且存在旧缓存时返回旧数据（stale=true），避免把用户晾在加载态。 */
const apiCached = async <T>(
  env: Env,
  key: string,
  refresh: boolean,
  produce: () => Promise<T>,
): Promise<{ value: T; stale: boolean }> => {
  const mapKey = `${repoKey(env)}|${key}`;
  const hit = apiCache.get(mapKey);
  if (hit && !refresh && Date.now() - hit.at < apiCacheTTL) return { value: hit.body as T, stale: false };
  const gen = apiGen.get(mapKey) ?? 0;
  try {
    const body = await produce();
    /** 期间被失效过：这次结果可能已旧，丢弃不写。 */
    if ((apiGen.get(mapKey) ?? 0) !== gen) return { value: body, stale: false };
    /** 重新写入时移到队尾，淘汰时优先丢最久未更新的 key。 */
    apiCache.delete(mapKey);
    apiCache.set(mapKey, { at: Date.now(), body });
    if (apiCache.size > API_CACHE_MAX) {
      const oldest = apiCache.keys().next().value;
      if (oldest) apiCache.delete(oldest);
    }
    return { value: body, stale: false };
  } catch (error) {
    if (hit) return { value: hit.body as T, stale: true };
    throw error;
  }
};

/** 深链回跳只接受站内绝对路径：拒绝 //host、/\host 与协议串，避免开放重定向。 */
const safeNext = (raw: string | null): string | null => {
  if (!raw || raw.length > 300) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.includes("://") || /[\r\n]/.test(raw)) return null;
  return raw;
};

/** HTML：允许边缘缓存 60 秒（部署后最长 60 秒旧），浏览器每次重新验证，兼顾速度与新版本可见性。 */
const serveAsset = async (env: Env, request: Request, path: string): Promise<Response> => {
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url).toString(), { method: "GET" }));
  if (response.headers.get("content-type")?.includes("text/html")) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "public, s-maxage=60, max-age=0");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
};

const health = (env: Env): Response =>
  json({
    status: "ok",
    service: env.SERVICE_NAME,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    commit: env.DEPLOY_COMMIT ?? "unknown",
    endpoints: ["/api/health", "/api/approvals", "/api/me"],
  });

const denyPage = (message: string, status = 403): Response =>
  html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>访问被拒绝</title>
     <body style="font-family:微软雅黑,sans-serif;padding:64px;color:#1F2329">
     <h1 style="color:#C7000B;font-size:22px">访问被拒绝</h1><p>${message}</p>
     <p><a href="/auth/logout" style="color:#C7000B">退出登录</a></p></body></html>`,
    status,
  );

const signedSession = async (
  env: Env,
  user: { login: string; name: string | null; avatar_url: string },
  token: string,
): Promise<string> => {
  const secret = env.SESSION_SECRET ?? "";
  const payload: SessionPayload = {
    login: user.login,
    name: user.name ?? user.login,
    avatar: user.avatar_url,
    exp: Date.now() + 8 * 3_600_000,
    token,
  };
  return createSession(payload, secret);
};

const handleCallback = async (env: Env, request: Request, url: URL): Promise<Response> => {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(request.headers.get("Cookie"), "oauth_state");

  if (!code || !state || !expected || state !== expected) {
    return denyPage("登录校验失败，请重新登录。", 400);
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) {
    return denyPage("OAuth 未配置完成：缺少 CLIENT_ID、CLIENT_SECRET 或 SESSION_SECRET。", 500);
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  if (!tokenResponse.ok) return denyPage("换取访问令牌失败。", 502);

  const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) return denyPage(`GitHub 未返回令牌：${tokenBody.error ?? "未知原因"}`, 401);

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "approval-visualization-worker",
    },
  });
  if (!userResponse.ok) return denyPage("读取 GitHub 用户信息失败。", 502);
  const user = (await userResponse.json()) as { login: string; name: string | null; avatar_url: string };

  if (env.GITHUB_ORG) {
    const orgResponse = await fetch(
      `https://api.github.com/user/memberships/orgs/${env.GITHUB_ORG}`,
      {
        headers: {
          Authorization: `Bearer ${tokenBody.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "approval-visualization-worker",
        },
      },
    );
    if (!orgResponse.ok) {
      return denyPage(`账号 ${user.login} 不是 ${env.GITHUB_ORG} 组织成员，无权访问。`, 403);
    }
    const orgMembership = (await orgResponse.json()) as { state: string };
    if (orgMembership.state !== "active") {
      return denyPage(`账号 ${user.login} 的 ${env.GITHUB_ORG} 组织成员状态为 ${orgMembership.state}，请先接受组织邀请。`, 403);
    }
  }

  const session = await signedSession(env, user, tokenBody.access_token);
  const next = safeNext(readCookie(request.headers.get("Cookie"), "oauth_next"));
  const headers = new Headers({ Location: next ?? "/" });
  headers.append("Set-Cookie", cookie("sess", session, 28_800));
  headers.append("Set-Cookie", cookie("oauth_next", "", 0));
  return new Response(null, { status: 302, headers });
};

/** mock 里按 PR 号取快照；未收录的号沿用 #11 的样例。 */
const mockDiffOf = (number: number): MockDiffPayload => (number === 16 ? MOCK_DIFF_16() : MOCK_DIFF());

/** 演示模式只有一个合成提交：把 PR 的全部改动视为一次提交。 */
const mockCommitOf = (number: number): CommitDetail => {
  const payload = mockDiffOf(number);
  const meta = payload.meta;
  return {
    sha: meta.headSha,
    shortSha: meta.headSha.slice(0, 7),
    headline: "演示提交：PR 全部改动",
    message: "演示提交：PR 全部改动\n\n演示模式把 PR 的全部改动合并成一个提交。",
    author: meta.author,
    authorName: meta.author,
    date: meta.createdAt,
    parents: [meta.baseSha],
    isMerge: false,
    url: `${meta.url}/commits/${meta.headSha}`,
    stats: {
      additions: meta.additions,
      deletions: meta.deletions,
      total: meta.additions + meta.deletions,
    },
    files: payload.files,
    truncated: false,
  };
};

const mockCommitsOf = (number: number): { items: CommitSummary[]; truncated: boolean } => {
  const detail = mockCommitOf(number);
  return {
    items: [{
      sha: detail.sha,
      shortSha: detail.shortSha,
      headline: detail.headline,
      message: detail.message,
      author: detail.author,
      authorName: detail.authorName,
      date: detail.date,
      parents: detail.parents,
      isMerge: detail.isMerge,
      url: detail.url,
    }],
    truncated: false,
  };
};

const mockMergeOptionsOf = (number: number): MergeOptions => {
  const meta = mockDiffOf(number).meta;
  const canMerge = meta.state === "open" && !meta.merged;
  return {
    canMerge,
    reason: canMerge ? null : meta.merged ? "PR 已合并" : "PR 已关闭",
    methods: ["merge", "squash"],
    defaultMethod: "merge",
    draft: false,
    mergeable: true,
    mergeableState: "clean",
    headSha: meta.headSha,
    baseRef: meta.baseRef,
    headRef: meta.headRef,
    permissions: { push: true, maintain: false, admin: false },
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const isMock = env.MOCK_MODE === "1";
    const secret = env.SESSION_SECRET ?? (isMock ? "local-dev-secret" : "");
    const session = secret
      ? await readSession(request.headers.get("Cookie"), secret)
      : null;

    if (path === "/api/health") return health(env);

    if (path === "/auth/login") {
      /** 深链回跳：只接受站内绝对路径，防止开放重定向 */
      const next = safeNext(url.searchParams.get("next"));
      if (isMock) {
        const login = env.DEV_FAKE_USER ?? "demo-reviewer";
        const mockSession = await createSession(
          { login, name: login, avatar: "", exp: Date.now() + 8 * 3_600_000 },
          secret,
        );
        const headers = new Headers({ Location: next ?? "/" });
        headers.append("Set-Cookie", cookie("sess", mockSession, 28_800));
        if (next) headers.append("Set-Cookie", cookie("oauth_next", next, 600));
        return new Response(null, { status: 302, headers });
      }
      if (!env.GITHUB_CLIENT_ID) return denyPage("未配置 GITHUB_CLIENT_ID，无法发起登录。", 500);

      const state = crypto.randomUUID();
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
      authorize.searchParams.set("scope", "repo read:org");
      authorize.searchParams.set("state", state);
      const headers = new Headers({ Location: authorize.toString() });
      headers.append("Set-Cookie", cookie("oauth_state", state, 600));
      if (next) headers.append("Set-Cookie", cookie("oauth_next", next, 600));
      return new Response(null, { status: 302, headers });
    }

    if (path === "/auth/callback") return handleCallback(env, request, url);

    if (path === "/auth/logout") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": cookie("sess", "", 0) },
      });
    }

    if (path === "/api/me") {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      return json({ login: session.login, name: session.name, avatar: session.avatar, mock: isMock });
    }

    if (path === "/api/approvals") {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      if (isMock) return json({ items: MOCK_APPROVALS(), source: "mock" });
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const refresh = url.searchParams.has("refresh");
        const { value, stale } = await apiCached(env, "/api/approvals", refresh, () => listApprovals(env, token));
        return json({ items: value, source: "github", ...(stale ? { stale: true } : {}) });
      } catch (error) {
        return json({ status: "error", message: `读取 GitHub 失败：${String(error)}` }, 502);
      }
    }

    const detail = path.match(/^\/api\/approvals\/(\d+)$/);
    if (detail) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(detail[1]);
      if (isMock) {
        const item = MOCK_DETAIL(number);
        return item ? json({ item, source: "mock" }) : json({ status: "error", message: "not_found" }, 404);
      }
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const refresh = url.searchParams.has("refresh");
        const { value: item, stale } = await apiCached(env, `/api/approvals/${number}`, refresh, () => getApproval(env, token, number));
        return json({ item, source: "github", ...(stale ? { stale: true } : {}) });
      } catch (error) {
        return json({ status: "error", message: `读取 GitHub 失败：${String(error)}` }, 502);
      }
    }

    const diffRoute = path.match(/^\/api\/approvals\/(\d+)\/diff$/);
    if (diffRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(diffRoute[1]);
      if (isMock) {
        return json({ ...mockDiffOf(number), source: "mock" });
      }
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const refreshMeta = url.searchParams.has("refreshMeta") || url.searchParams.has("refresh");
        const { value, stale } = await apiCached(env, `/diff/${number}`, refreshMeta, async () => {
          const [m, f, c] = await Promise.all([
            getPrMeta(env, token, number),
            getPrFiles(env, token, number),
            getReviewComments(env, token, number),
          ]);
          return [m, f, c] as [PrMeta, DiffFile[], ReviewComment[]];
        });
        const [meta, files, comments] = value;
        return json({ meta, files, comments, source: "github", ...(stale ? { stale: true } : {}) });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: `读取 GitHub 失败：${String(error)}` }, status >= 500 ? 502 : status);
      }
    }

    /** PR 的提交列表：只读浏览用；合并后仍可读取。 */
    const commitsRoute = path.match(/^\/api\/approvals\/(\d+)\/commits$/);
    if (commitsRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(commitsRoute[1]);
      if (isMock) return json({ ...mockCommitsOf(number), source: "mock" });
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const refresh = url.searchParams.has("refresh") || url.searchParams.has("refreshMeta");
        const { value, stale } = await apiCached(env, `/commits/${number}`, refresh, () => getPrCommits(env, token, number));
        return json({ ...value, source: "github", ...(stale ? { stale: true } : {}) });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: `读取提交列表失败：${String(error)}` }, status >= 500 ? 502 : status);
      }
    }

    /** 单次提交的完整改动；sha 必须在当前 PR 的提交列表内。 */
    const commitDetailRoute = path.match(/^\/api\/approvals\/(\d+)\/commits\/([0-9a-fA-F]{7,40})$/);
    if (commitDetailRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(commitDetailRoute[1]);
      const wanted = commitDetailRoute[2].toLowerCase();
      if (isMock) {
        const detail = mockCommitOf(number);
        if (!detail.sha.toLowerCase().startsWith(wanted)) {
          return json({ status: "error", message: "该提交不属于此 PR" }, 404);
        }
        return json({ ...detail, source: "mock" });
      }
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const commits = await apiCached(env, `/commits/${number}`, false, () => getPrCommits(env, token, number));
        const hit = commits.value.items.find((item) => item.sha.toLowerCase().startsWith(wanted));
        if (!hit) return json({ status: "error", message: "该提交不属于此 PR" }, 404);
        const { value, stale } = await apiCached(
          env,
          `/commit/${number}/${hit.sha}`,
          false,
          () => getCommitDetail(env, token, hit.sha),
        );
        return json({ ...value, source: "github", ...(stale ? { stale: true } : {}) });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: `读取提交失败：${String(error)}` }, status >= 500 ? 502 : status);
      }
    }

    /** 提交视图的正文：head 侧是该提交，base 侧是它的第一个父提交。 */
    const commitFileRoute = path.match(/^\/api\/approvals\/(\d+)\/commits\/([0-9a-fA-F]{7,40})\/file$/);
    if (commitFileRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(commitFileRoute[1]);
      const wanted = commitFileRoute[2].toLowerCase();
      const filePath = url.searchParams.get("path");
      const side = url.searchParams.get("side") === "base" ? "base" : "head";
      if (!filePath) return json({ status: "error", message: "缺少 path 参数" }, 400);
      if (isMock) {
        const detail = mockCommitOf(number);
        if (!detail.sha.toLowerCase().startsWith(wanted)) {
          return json({ status: "error", message: "该提交不属于此 PR" }, 404);
        }
        const mock = mockDiffOf(number);
        const cached = mock.texts[filePath];
        if (!cached) return json({ status: "error", message: "mock 中没有该文件正文" }, 404);
        return json({
          path: filePath,
          ref: side === "base" ? detail.parents[0] : detail.sha,
          side,
          text: side === "base" ? cached.base : cached.head,
          truncated: false,
          source: "mock",
        });
      }
      const token = dataToken(env, session);
      if (!token) return json({ status: "error", message: "缺少取数令牌。" }, 503);
      try {
        const commits = await apiCached(env, `/commits/${number}`, false, () => getPrCommits(env, token, number));
        const hit = commits.value.items.find((item) => item.sha.toLowerCase().startsWith(wanted));
        if (!hit) return json({ status: "error", message: "该提交不属于此 PR" }, 404);
        const { value: detail } = await apiCached(
          env,
          `/commit/${number}/${hit.sha}`,
          false,
          () => getCommitDetail(env, token, hit.sha),
        );
        const file = detail.files.find((item) => item.path === filePath);
        if (!file) return json({ status: "error", message: "该文件不在这次提交的改动中。" }, 404);
        const emptySide = (side === "head" && file.status === "removed")
          || (side === "base" && file.status === "added");
        if (emptySide) {
          return json({
            path: filePath,
            ref: side === "base" ? (detail.parents[0] ?? "") : detail.sha,
            side,
            text: "",
            truncated: false,
            source: "github",
          });
        }
        if (side === "base" && !detail.parents[0]) {
          return json({ status: "error", message: "该提交没有父提交，无法读取改前正文。" }, 400);
        }
        const sourcePath = side === "base" && file.status === "renamed" && file.previousPath
          ? file.previousPath
          : file.path;
        const ref = side === "base" ? detail.parents[0] : detail.sha;
        const refreshText = url.searchParams.has("refreshText") || url.searchParams.has("refresh");
        const payload = await getFileText(env, token, sourcePath, ref, refreshText);
        return json({ ...payload, path: filePath, ref, side, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: String(error) }, status >= 500 ? 502 : status);
      }
    }

    /** 合并前置条件：由登录者令牌判断写权限，避免把只读令牌当成可合并。 */
    const mergeOptionsRoute = path.match(/^\/api\/approvals\/(\d+)\/merge-options$/);
    if (mergeOptionsRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(mergeOptionsRoute[1]);
      if (isMock) return json({ ...mockMergeOptionsOf(number), source: "mock" });
      const token = session.token;
      if (!token) return json({ status: "error", message: "当前登录会话没有 GitHub 写入令牌，请重新登录。" }, 503);
      try {
        const options = await getMergeOptions(env, token, number);
        return json({ ...options, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: `读取合并条件失败：${String(error)}` }, status >= 500 ? 502 : status);
      }
    }

    /** 合并 PR：sha 锁定 head，服务端重新校验权限与状态，成功后失效列表/详情/提交缓存。 */
    const mergeRoute = path.match(/^\/api\/approvals\/(\d+)\/merge$/);
    if (mergeRoute && request.method === "POST") {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(mergeRoute[1]);
      let body: { sha?: string; method?: string; commitTitle?: string; commitMessage?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ status: "error", message: "请求体不是合法 JSON" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ status: "error", message: "请求体必须是 JSON 对象" }, 400);
      }
      const sha = String(body.sha ?? "").trim();
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        return json({ status: "error", message: "缺少有效的 head SHA。" }, 400);
      }
      const commitTitle = typeof body.commitTitle === "string" ? body.commitTitle.trim().slice(0, 200) : "";
      const commitMessage = typeof body.commitMessage === "string" ? body.commitMessage.trim().slice(0, 10_000) : "";

      if (isMock) {
        const meta = mockDiffOf(number).meta;
        if (meta.merged || meta.state !== "open") {
          return json({ status: "error", message: `PR #${number} 已${meta.merged ? "合并" : "关闭"}，不能再次合并。` }, 409);
        }
        return json({
          ok: true,
          merged: true,
          queued: false,
          sha: `mock-merge-${number}`,
          message: "演示模式：已模拟合并。",
          source: "mock",
        });
      }

      const token = session.token;
      if (!token) return json({ status: "error", message: "当前登录会话没有 GitHub 写入令牌，请重新登录。" }, 503);
      const readToken = dataToken(env, session) || token;
      try {
        const meta = await getPrMeta(env, readToken, number);
        if (meta.merged || meta.state !== "open") {
          return json({ status: "error", message: `PR #${number} 已${meta.merged ? "合并" : "关闭"}，不能再次合并。` }, 409);
        }
        if (meta.headSha.toLowerCase() !== sha.toLowerCase()) {
          return json({ status: "error", message: "PR 已产生新提交，当前页面不是最新版本。请刷新后重试。" }, 409);
        }
        const options = await getMergeOptions(env, token, number);
        if (!options.canMerge) {
          return json({ status: "error", message: options.reason || "当前不满足合并条件。" }, 409);
        }
        if (!options.methods.length) {
          return json({ status: "error", message: "仓库没有启用任何合并方式。" }, 409);
        }
        const requested = typeof body.method === "string" ? body.method : "";
        const method = (requested || options.defaultMethod) as MergeMethod | null;
        if (!method || !options.methods.includes(method)) {
          return json({ status: "error", message: `不支持的合并方式：${requested || "(空)"}` }, 400);
        }
        const result = await mergePull(env, token, number, {
          sha,
          method,
          ...(commitTitle ? { commitTitle } : {}),
          ...(commitMessage ? { commitMessage } : {}),
        });
        for (const key of [
          "/api/approvals",
          `/api/approvals/${number}`,
          `/diff/${number}`,
          `/commits/${number}`,
        ]) {
          apiInvalidate(`${repoKey(env)}|${key}`);
        }
        return json({
          ok: true,
          merged: result.merged,
          queued: !result.merged,
          sha: result.sha,
          message: result.message || (result.merged ? "已合并。" : "合并请求已受理。"),
          source: "github",
        });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        const clientStatus = status === 405 ? 409 : status === 422 ? 400 : status >= 500 ? 502 : status;
        const hint = status === 403
          ? "当前登录者没有合并权限，或分支保护拒绝了这次合并。"
          : status === 405
            ? "GitHub 拒绝合并（常见原因：存在冲突、缺少必需审批或状态检查）。"
            : status === 409
              ? "PR 状态已变化，请刷新后重试。"
              : status === 422
                ? "合并参数无效。"
                : "GitHub 暂时不可用，请稍后重试。";
        return json(
          { status: "error", message: `${hint}（${String(error)}）`, retryable: status >= 500 },
          clientStatus,
        );
      }
    }

    /** 渲染视图要看到"改前 / 改后"正文，这里按 ref 取整份文件原文。 */
    const fileRoute = path.match(/^\/api\/approvals\/(\d+)\/file$/);
    if (fileRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(fileRoute[1]);
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ status: "error", message: "缺少 path 参数" }, 400);
      if (isMock) {
        const mock = mockDiffOf(number);
        const cached = mock.texts[filePath];
        if (!cached) return json({ status: "error", message: "mock 中没有该文件正文" }, 404);
        const ref = url.searchParams.get("ref") || mock.meta.headSha;
        return json({
          path: filePath,
          ref,
          side: ref === mock.meta.baseSha ? "base" : "head",
          text: ref === mock.meta.baseSha ? cached.base : cached.head,
          truncated: false,
          source: "mock",
        });
      }
      const token = dataToken(env, session);
      if (!token) return json({ status: "error", message: "缺少取数令牌。" }, 503);
      try {
        const refreshMeta = url.searchParams.has("refreshMeta") || url.searchParams.has("refresh");
        const refreshText = url.searchParams.has("refreshText") || url.searchParams.has("refresh");
        const { value } = await apiCached(env, `/diff/${number}`, refreshMeta, async () => {
          const [meta, files, comments] = await Promise.all([
            getPrMeta(env, token, number),
            getPrFiles(env, token, number),
            getReviewComments(env, token, number),
          ]);
          return [meta, files, comments] as [PrMeta, DiffFile[], ReviewComment[]];
        });
        const [meta, files] = value;
        const file = files.find((item) => item.path === filePath);
        if (!file) return json({ status: "error", message: "该文件不属于此 PR 的变更文件。" }, 404);
        const requestedRef = url.searchParams.get("ref") || meta.headSha;
        if (requestedRef !== meta.headSha && requestedRef !== meta.baseSha) {
          return json({ status: "error", message: "ref 必须是此 PR 的 base 或 head commit SHA。" }, 400);
        }
        const side = requestedRef === meta.baseSha ? "base" : "head";
        const emptySide = (side === "head" && file.status === "removed")
          || (side === "base" && file.status === "added");
        if (emptySide) {
          return json({ path: filePath, ref: requestedRef, side, text: "", truncated: false, source: "github" });
        }
        const sourcePath = side === "base" && file.status === "renamed" && file.previousPath
          ? file.previousPath
          : file.path;
        const payload = await getFileText(env, token, sourcePath, requestedRef, refreshText);
        return json({ ...payload, path: filePath, ref: requestedRef, side, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: String(error) }, status >= 500 ? 502 : status);
      }
    }

    /** 文档正文：PR 里的文件与"文档里引用的其他文件"共用；只有 PR 文件能写行评论。 */
    if (path === "/api/doc") {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const normalized = normalizeDocPath(url.searchParams.get("path") || "");
      if (!normalized) return json({ status: "error", message: "path 不合法" }, 400);
      if (isMock) {
        const mock = mockDiffOf(Number(url.searchParams.get("pr") || 16));
        const hit = mock.texts[normalized];
        if (!hit) {
          return json(
            { status: "error", message: "演示模式只收录了该 PR 内改动的文件", path: normalized, candidates: [] },
            404,
          );
        }
        return json({ path: normalized, ref: mock.meta.headSha, text: hit.head, truncated: false, source: "mock" });
      }
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const ref = url.searchParams.get("ref") || (await defaultBranch(env, token));
        const { path: resolved, candidates } = await resolveDocPath(env, token, ref, normalized);
        if (!resolved) {
          return json(
            { status: "error", message: "该文档不在当前提交中", path: normalized, ref, candidates },
            404,
          );
        }
        const payload = await getFileText(env, token, resolved, ref);
        return json({ ...payload, path: resolved, requested: normalized, ref, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: String(error), path: normalized }, status >= 500 ? 502 : status);
      }
    }

    /** 草稿整体提交成一条 review；event 默认 COMMENT，可选 REQUEST_CHANGES。行号取 head 侧真实行。 */
    const commentRoute = path.match(/^\/api\/approvals\/(\d+)\/comments$/);
    if (commentRoute && request.method === "POST") {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(commentRoute[1]);
      let body: { commit_id?: string; event?: string; comments?: ReviewDraft[] };
      try {
        body = (await request.json()) as { commit_id?: string; event?: string; comments?: ReviewDraft[] };
      } catch {
        return json({ status: "error", message: "请求体不是合法 JSON" }, 400);
      }
      const event = body.event === "REQUEST_CHANGES" || body.event === "APPROVE"
        ? body.event
        : "COMMENT";
      const drafts = Array.isArray(body.comments) ? body.comments : [];
      if (!drafts.length && event !== "APPROVE") return json({ status: "error", message: "没有可提交的意见" }, 400);
      const invalid = drafts.find((d) => !d || typeof d.path !== "string" || typeof d.body !== "string"
        || (!d.plain && !Number.isFinite(d.line)));
      if (invalid) return json({ status: "error", message: "意见缺少 path / line / body" }, 400);
      const anchored = drafts.filter((d) => !d.plain);
      const plains = drafts.filter((d) => d.plain);

      if (isMock) {
        return json({
          ok: true,
          event,
          review: anchored.length || event !== "COMMENT"
            ? { id: 990001, url: "https://github.com/noware-cn/markdown-reviewer/pull/11#pullrequestreview-990001", comments: anchored.length }
            : null,
          plainCount: plains.length,
          source: "mock",
        });
      }

      const token = session.token;
      if (!token) return json({ status: "error", message: "当前登录会话没有 GitHub 写入令牌，请重新登录。" }, 503);
      try {
        const readToken = dataToken(env, session) || token;
        const [meta, files] = await Promise.all([
          getPrMeta(env, readToken, number),
          getPrFiles(env, readToken, number),
        ]);
        if (meta.merged || meta.state !== "open") {
          return json(
            { status: "error", message: `PR #${number} 已${meta.merged ? "合并" : "关闭"}，GitHub 不允许再新增行级评论。` },
            409,
          );
        }
        if (!body.commit_id || body.commit_id !== meta.headSha) {
          return json({ status: "error", message: "PR 已产生新提交，草稿对应的代码版本已过期。请刷新并重新定位意见。" }, 409);
        }
        const changedPaths = new Set(files.map((file) => file.path));
        const invalidDraft = drafts.find((draft) =>
          !changedPaths.has(draft.path)
          || !draft.body.trim()
          || (!draft.plain && (!Number.isInteger(Number(draft.line)) || Number(draft.line) < 1))
          || (!draft.plain && draft.start_line !== undefined && (!Number.isInteger(Number(draft.start_line)) || Number(draft.start_line) < 1 || Number(draft.start_line) > Number(draft.line)))
        );
        if (invalidDraft) return json({ status: "error", message: "草稿包含无效文件路径、行号或空评论，请重新定位。" }, 400);
        // 校验草稿行号在 patch hunk 范围内（GitHub 只允许评论 diff hunk 内的行）
        if (anchored.length) {
          const patchByPath = new Map(files.map((f) => [f.path, f.patch]));
          const outOfHunk = anchored.find((draft) => {
            const cl = commentableHeadLines(patchByPath.get(draft.path) ?? null);
            if (cl === null) return false; // 无 patch（新增文件）→ 所有行可评论
            const lineHunk = cl.get(Number(draft.line));
            if (lineHunk === undefined) return true;
            if (draft.start_line !== undefined) {
              const startHunk = cl.get(Number(draft.start_line));
              if (startHunk === undefined || startHunk !== lineHunk) return true;
            }
            return false;
          });
          if (outOfHunk) return json({ status: "error", message: `草稿定位在 diff 之外（${outOfHunk.path.split("/").pop()} L${outOfHunk.line}），请只在变更行或相邻上下文行评论。` }, 400);
        }
        /* 行级意见进 review；diff 之外的行发 PR 整体评论（正文自带路径与行号范围） */
        const review = anchored.length || event !== "COMMENT"
          ? await createReview(
            env,
            token,
            number,
            meta.headSha,
            anchored.map((d) => ({
              path: d.path,
              body: d.body,
              line: Number(d.line),
              side: "RIGHT" as const,
              start_line: d.start_line && Number(d.start_line) < Number(d.line) ? Number(d.start_line) : undefined,
            })),
            event,
          )
          : null;
        const plainComments = await Promise.all(plains.map((d) => createIssueComment(env, token, number, d.body)));
        // 新评论/新 Review 已写入：立刻失效该 PR 的 diff 缓存（meta+files+comments），
        // 否则客户端提交后的 /diff 会继续返回最长 5 分钟的旧评论。
        apiInvalidate(`${repoKey(env)}|/diff/${number}`);
        return json({ ok: true, review, plainCount: plainComments.length, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        const hint =
          status === 422
            ? "行号已失效：PR 有新提交，请刷新后重新定位。"
            : status === 403
              ? "当前登录令牌没有提交 Review 所需的仓库写权限，请重新授权 repo 权限。"
              : status === 404
                ? "PR 或文件不存在。"
                : "GitHub 暂时不可用，请稍后重试。";
        return json(
          { status: "error", message: `${hint}（${String(error)}）`, retryable: status >= 500 },
          status >= 500 ? 502 : status,
        );
      }
    }

    /** 回复一条已有的行级评论，挂进同一线程。 */
    const replyRoute = path.match(/^\/api\/approvals\/(\d+)\/comments\/(\d+)\/replies$/);
    if (replyRoute && request.method === "POST") {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(replyRoute[1]);
      const commentId = Number(replyRoute[2]);
      let body: { body?: string };
      try {
        body = (await request.json()) as { body?: string };
      } catch {
        return json({ status: "error", message: "请求体不是合法 JSON" }, 400);
      }
      const text = String(body.body ?? "").trim();
      if (!text) return json({ status: "error", message: "回复内容不能为空" }, 400);
      if (isMock) return json({ ok: true, reply: { id: 990002, url: "#" }, source: "mock" });
      const token = session.token;
      if (!token) return json({ status: "error", message: "当前登录会话没有 GitHub 写入令牌，请重新登录。" }, 503);
      try {
        /* 与评论、Review 一致：已关闭或已合并的 PR 不再接受回复 */
        const meta = await getPrMeta(env, token, number);
        if (meta.merged || meta.state !== "open") {
          return json({
            status: "error",
            message: `PR #${number} 已${meta.merged ? "合并" : "关闭"}，不能再回复评论。`,
          }, 409);
        }
        const reply = await createReviewCommentReply(env, token, number, commentId, text);
        apiInvalidate(`${repoKey(env)}|/diff/${number}`);
        return json({ ok: true, reply, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        const hint = status === 404
          ? "该评论或 PR 不存在。"
          : status === 403
            ? "当前登录令牌没有回复评论所需的仓库写权限。"
            : status === 422
              ? "GitHub 拒绝了该回复（目标可能不是根评论，或内容不合法）。"
              : "GitHub 暂时不可用，请稍后重试。";
        return json(
          { status: "error", message: `${hint}（${String(error)}）`, retryable: status >= 500 },
          status >= 500 ? 502 : status,
        );
      }
    }

    if (path === "/" || path === "/index.html" || /^\/pr\/\d+(\/|$)/.test(path)) {
      return session ? serveAsset(env, request, "/index.html") : serveAsset(env, request, "/login.html");
    }

    /** 只读文档页：/doc/<路径> 与历史裸路径（….md / …csv）都交给同一个页面渲染，不再回 JSON。 */
    if (request.method === "GET" && (path.startsWith("/doc/") || DOC_PATH.test(path))) {
      return session ? serveAsset(env, request, "/doc.html") : serveAsset(env, request, "/login.html");
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      if (path.startsWith("/api/")) return json({ status: "error", message: "not_found", path }, 404);
      return serveAsset(env, request, "/not-found.html");
    }
    /** 非 HTML 静态资源：带版本号 ?v= 的按不可变长缓存（URL 变化即新版本），未带版本号只缓存 1 小时，避免部署后拿旧资源。 */
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", url.searchParams.has("v")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
