import type { Env } from "./github";
import { getApproval, listApprovals } from "./github";
import {
  createReview,
  getFileText,
  getPrFiles,
  getPrMeta,
  getReviewComments,
  GitHubError,
  type DiffFile,
  type PrMeta,
  type ReviewComment,
  type ReviewDraft,
} from "./diff";
import { MOCK_APPROVALS, MOCK_DETAIL } from "./mock";
import { MOCK_DIFF } from "./mock-diff";
import { createSession, readCookie, readSession, type SessionPayload } from "./session";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0" };

const json = (data: unknown, status = 200, extra: HeadersInit = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const cookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** 取数令牌：优先服务端只读令牌，其次登录者自己的令牌。 */
const dataToken = (env: Env, session: SessionPayload | null): string | null =>
  env.GITHUB_DATA_TOKEN || session?.token || null;

/** GitHub 取数结果内存缓存：5 分钟 TTL；key 按「组织/仓库 + 路径」，同一仓库所有协作者可见数据一致，跨用户共享。 */
const apiCache = new Map<string, { at: number; body: unknown }>();
const apiCacheTTL = 300_000;

const repoKey = (env: Env): string => `${env.GITHUB_ORG}/${env.GITHUB_REPO}`;

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
  try {
    const body = await produce();
    apiCache.set(mapKey, { at: Date.now(), body });
    return { value: body, stale: false };
  } catch (error) {
    if (hit) return { value: hit.body as T, stale: true };
    throw error;
  }
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
  }

  const session = await signedSession(env, user, tokenBody.access_token);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": cookie("sess", session, 28_800),
    },
  });
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
      if (isMock) {
        const login = env.DEV_FAKE_USER ?? "demo-reviewer";
        const mockSession = await createSession(
          { login, name: login, avatar: "", exp: Date.now() + 8 * 3_600_000 },
          secret,
        );
        return new Response(null, {
          status: 302,
          headers: { Location: "/", "Set-Cookie": cookie("sess", mockSession, 28_800) },
        });
      }
      if (!env.GITHUB_CLIENT_ID) return denyPage("未配置 GITHUB_CLIENT_ID，无法发起登录。", 500);

      const state = crypto.randomUUID();
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
      authorize.searchParams.set("scope", "repo read:org");
      authorize.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorize.toString(),
          "Set-Cookie": cookie("oauth_state", state, 600),
        },
      });
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
        return json({ ...MOCK_DIFF(), source: "mock" });
      }
      const token = dataToken(env, session);
      if (!token) {
        return json({ status: "error", message: "缺少取数令牌：未配置 GITHUB_DATA_TOKEN，且会话中没有登录者令牌。" }, 503);
      }
      try {
        const refresh = url.searchParams.has("refresh");
        const { value, stale } = await apiCached(env, `/diff/${number}`, refresh, async () => {
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

    /** 渲染视图要看到"改前 / 改后"正文，这里按 ref 取整份文件原文。 */
    const fileRoute = path.match(/^\/api\/approvals\/(\d+)\/file$/);
    if (fileRoute) {
      if (!session) return json({ status: "error", message: "unauthenticated" }, 401);
      const number = Number(fileRoute[1]);
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ status: "error", message: "缺少 path 参数" }, 400);
      if (isMock) {
        const mock = MOCK_DIFF();
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
        const refresh = url.searchParams.has("refresh");
        const { value } = await apiCached(env, `/diff/${number}`, refresh, async () => {
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
        const payload = await getFileText(env, token, sourcePath, requestedRef, refresh);
        return json({ ...payload, path: filePath, ref: requestedRef, side, source: "github" });
      } catch (error) {
        const status = error instanceof GitHubError ? error.status : 502;
        return json({ status: "error", message: String(error) }, status >= 500 ? 502 : status);
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
      const invalid = drafts.find(
        (d) => !d || typeof d.path !== "string" || typeof d.body !== "string" || !Number.isFinite(d.line),
      );
      if (invalid) return json({ status: "error", message: "意见缺少 path / line / body" }, 400);

      if (isMock) {
        return json({
          ok: true,
          event,
          review: { id: 990001, url: "https://github.com/noware-cn/markdown-reviewer/pull/11#pullrequestreview-990001", comments: drafts.length },
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
          || !Number.isInteger(Number(draft.line))
          || Number(draft.line) < 1
          || !draft.body.trim()
          || (draft.start_line !== undefined && (!Number.isInteger(Number(draft.start_line)) || Number(draft.start_line) < 1 || Number(draft.start_line) > Number(draft.line)))
        );
        if (invalidDraft) return json({ status: "error", message: "草稿包含无效文件路径、行号或空评论，请重新定位。" }, 400);
        const review = await createReview(
          env,
          token,
          number,
          meta.headSha,
          drafts.map((d) => ({
            path: d.path,
            body: d.body,
            line: Number(d.line),
            side: "RIGHT" as const,
            start_line: d.start_line && Number(d.start_line) < Number(d.line) ? Number(d.start_line) : undefined,
          })),
          event,
        );
        return json({ ok: true, review, source: "github" });
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

    if (path === "/" || path === "/index.html") {
      return session ? serveAsset(env, request, "/index.html") : serveAsset(env, request, "/login.html");
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      return json({ status: "error", message: "not_found", path }, 404);
    }
    /** 非 HTML 静态资源：带版本号 ?v= 的按不可变长缓存（URL 变化即新版本），未带版本号只缓存 1 小时，避免部署后拿旧资源。 */
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", url.searchParams.has("v")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
