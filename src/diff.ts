import type { Env } from "./github";

/** 单个改动文件的归一化结构，字段与 GitHub pulls/{n}/files 对齐。 */
export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string | null;
  isMarkdown: boolean;
}

export interface ReviewComment {
  id: number;
  path: string;
  line: number | null;
  originalLine: number | null;
  body: string;
  author: string;
  createdAt: string;
  url: string;
  inReplyTo: number | null;
}

export interface PrMeta {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  author: string;
  createdAt: string;
  mergedAt: string | null;
  url: string;
}

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface RawComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
  in_reply_to_id?: number | null;
}

interface RawPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
  changed_files: number;
  additions: number;
  deletions: number;
  commits: number;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}

const repoPath = (env: Env): string =>
  `/repos/${env.GITHUB_ORG ?? "noware-cn"}/${env.GITHUB_REPO ?? "workspace"}`;

/** 统一出口：把 GitHub 的错误状态码翻译成页面能直接显示的话。 */
export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const call = async <T>(
  _env: Env,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "approval-visualization-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? "";
    } catch {
      detail = "";
    }
    throw new GitHubError(response.status, detail || `GitHub ${response.status} ${path}`);
  }
  return (await response.json()) as T;
};

export const getPrMeta = async (env: Env, token: string, number: number): Promise<PrMeta> => {
  const pull = await call<RawPull>(env, token, `${repoPath(env)}/pulls/${number}`);
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: Boolean(pull.merged_at),
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    commits: pull.commits,
    changedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
    author: pull.user?.login ?? "未知",
    createdAt: pull.created_at,
    mergedAt: pull.merged_at,
    url: pull.html_url,
  };
};

const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);

export const getPrFiles = async (env: Env, token: string, number: number): Promise<DiffFile[]> => {
  const out: DiffFile[] = [];
  /** 翻页拉全，确保大 PR 数据完整；上限 30 页（3000 个文件）仅为防失控死循环。 */
  for (let page = 1; page <= 30; page += 1) {
    const batch = await call<RawFile[]>(
      env,
      token,
      `${repoPath(env)}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    for (const file of batch) {
      out.push({
        path: file.filename,
        previousPath: file.previous_filename ?? null,
        status: (["added", "modified", "removed", "renamed"].includes(file.status)
          ? file.status
          : "modified") as DiffFile["status"],
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
        isMarkdown: isMarkdown(file.filename),
      });
    }
    if (batch.length < 100) break;
    if (page === 30) throw new GitHubError(502, "PR 文件超过 3000 个，未能完整读取。");
  }
  return out;
};

/** 取某个版本的文件原文，用于渲染视图做"改前 / 改后"正文对照。 */
interface FileTextPayload {
  path: string;
  ref: string;
  text: string;
  truncated: boolean;
}

/** 同一会话内短缓存，避免反复点同一文件时重复请求 GitHub。文件内容在 PR 生命周期内几乎不变，放宽到 30 分钟；?refresh=1 可绕过。 */
const fileTextCache = new Map<string, { at: number; value: FileTextPayload }>();
const FILE_TEXT_TTL_MS = 30 * 60 * 1000;

export const getFileText = async (
  env: Env,
  token: string,
  path: string,
  ref: string,
  refresh = false,
): Promise<FileTextPayload> => {
  const key = `${path}@${ref}`;
  const hit = fileTextCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < FILE_TEXT_TTL_MS) return hit.value;
  const response = await fetch(
    `https://api.github.com${repoPath(env)}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "approval-visualization-worker",
      },
    },
  );
  if (!response.ok) {
    throw new GitHubError(response.status, `读取文件失败：${path} @ ${ref.slice(0, 7)}`);
  }
  const raw = await response.text();
  const limit = 400 * 1024;
  const value: FileTextPayload = {
    path,
    ref,
    text: raw.length > limit ? raw.slice(0, limit) : raw,
    truncated: raw.length > limit,
  };
  fileTextCache.set(key, { at: Date.now(), value });
  return value;
};

export const getReviewComments = async (
  env: Env,
  token: string,
  number: number,
): Promise<ReviewComment[]> => {
  const out: ReviewComment[] = [];
  /** 翻页拉全，确保评论不截断；上限 20 页（2000 条）仅为防失控死循环。 */
  for (let page = 1; page <= 20; page += 1) {
    const batch = await call<RawComment[]>(
      env,
      token,
      `${repoPath(env)}/pulls/${number}/comments?per_page=100&page=${page}`,
    );
    for (const comment of batch) {
      out.push({
        id: comment.id,
        path: comment.path,
        line: comment.line,
        originalLine: comment.original_line,
        body: comment.body,
        author: comment.user?.login ?? "未知",
        createdAt: comment.created_at,
        url: comment.html_url,
        inReplyTo: comment.in_reply_to_id ?? null,
      });
    }
    if (batch.length < 100) break;
    if (page === 20) throw new GitHubError(502, "行级评论超过 2000 条，未能完整读取。");
  }
  return out;
};

export interface ReviewDraft {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
}

export interface ReviewResult {
  id: number;
  url: string;
  comments: number;
}

/** 一次提交把草稿合并成一条 review；event 默认 COMMENT，可指定 REQUEST_CHANGES。 */
export const createReview = async (
  env: Env,
  token: string,
  number: number,
  commitId: string,
  drafts: ReviewDraft[],
  event: "COMMENT" | "REQUEST_CHANGES" = "COMMENT",
): Promise<ReviewResult> => {
  const payload = {
    commit_id: commitId,
    event,
    body:
      event === "REQUEST_CHANGES"
        ? `变更查看器提交的行级审阅意见（共 ${drafts.length} 条），结论：请求修改后再审。`
        : `变更查看器提交的行级审阅意见（共 ${drafts.length} 条）`,
    comments: drafts.map((draft) => ({
      path: draft.path,
      body: draft.body,
      line: draft.line,
      side: "RIGHT",
      ...(draft.start_line && draft.start_line < draft.line
        ? { start_line: draft.start_line, start_side: "RIGHT" }
        : {}),
    })),
  };
  const review = await call<{ id: number; html_url: string }>(
    env,
    token,
    `${repoPath(env)}/pulls/${number}/reviews`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return { id: review.id, url: review.html_url, comments: drafts.length };
};
