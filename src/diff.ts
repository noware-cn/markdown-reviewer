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
  commitId: string | null;
  originalCommitId: string | null;
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

/** 提交列表项：GitHub pulls/{n}/commits 不返回文件与 stats。 */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  headline: string;
  message: string;
  author: string;
  authorName: string;
  date: string;
  parents: string[];
  isMerge: boolean;
  url: string;
}

export interface CommitDetail extends CommitSummary {
  stats: { additions: number; deletions: number; total: number };
  files: DiffFile[];
  truncated: boolean;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeOptions {
  canMerge: boolean;
  reason: string | null;
  methods: MergeMethod[];
  defaultMethod: MergeMethod | null;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  headSha: string;
  baseRef: string;
  headRef: string;
  permissions: { push: boolean; maintain: boolean; admin: boolean } | null;
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
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
  commit_id?: string | null;
  original_commit_id?: string | null;
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
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}

interface RawRepo {
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

interface RawCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
  author: { login: string } | null;
  parents: Array<{ sha: string }>;
}

interface RawCommitDetail extends RawCommit {
  stats?: { additions: number; deletions: number; total: number };
  files?: RawFile[];
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

/** pulls/{n}/files 与 commits/{sha} 的 files 结构一致，统一走同一套归一化。 */
const toDiffFile = (file: RawFile): DiffFile => ({
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

export const getPrFiles = async (env: Env, token: string, number: number): Promise<DiffFile[]> => {
  const out: DiffFile[] = [];
  /** 翻页拉全，确保大 PR 数据完整；上限 30 页（3000 个文件）仅为防失控死循环。 */
  for (let page = 1; page <= 30; page += 1) {
    const batch = await call<RawFile[]>(
      env,
      token,
      `${repoPath(env)}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    out.push(...batch.map(toDiffFile));
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
        commitId: comment.commit_id ?? null,
        originalCommitId: comment.original_commit_id ?? null,
      });
    }
    if (batch.length < 100) break;
    if (page === 20) throw new GitHubError(502, "行级评论超过 2000 条，未能完整读取。");
  }
  return out;
};

const toCommitSummary = (raw: RawCommit): CommitSummary => {
  const message = raw.commit.message ?? "";
  const headline = message.split("\n")[0]?.trim() || "(无提交说明)";
  return {
    sha: raw.sha,
    shortSha: raw.sha.slice(0, 7),
    headline,
    message,
    author: raw.author?.login ?? raw.commit.author?.name ?? "未知",
    authorName: raw.commit.author?.name ?? raw.author?.login ?? "未知",
    date: raw.commit.author?.date ?? "",
    parents: (raw.parents ?? []).map((parent) => parent.sha),
    isMerge: (raw.parents ?? []).length > 1,
    url: raw.html_url,
  };
};

/** PR 的提交列表；最多 1000 条，足够覆盖文档类 PR，超出时标 truncated。 */
export const getPrCommits = async (
  env: Env,
  token: string,
  number: number,
): Promise<{ items: CommitSummary[]; truncated: boolean }> => {
  const out: CommitSummary[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await call<RawCommit[]>(
      env,
      token,
      `${repoPath(env)}/pulls/${number}/commits?per_page=100&page=${page}`,
    );
    out.push(...batch.map(toCommitSummary));
    if (batch.length < 100) return { items: out, truncated: false };
  }
  return { items: out, truncated: true };
};

/** 单次提交的完整改动；GitHub 对大提交的 files 会分页，最多 3000 个文件。 */
export const getCommitDetail = async (
  env: Env,
  token: string,
  sha: string,
): Promise<CommitDetail> => {
  const files: DiffFile[] = [];
  let first: RawCommitDetail | null = null;
  let truncated = false;
  for (let page = 1; page <= 30; page += 1) {
    const batch = await call<RawCommitDetail>(
      env,
      token,
      `${repoPath(env)}/commits/${sha}?per_page=100&page=${page}`,
    );
    if (!first) first = batch;
    if (Array.isArray(batch.files)) files.push(...batch.files.map(toDiffFile));
    if (!Array.isArray(batch.files) || batch.files.length < 100) break;
    if (page === 30) truncated = true;
  }
  if (!first) throw new GitHubError(502, `读取提交 ${sha.slice(0, 7)} 失败。`);
  return {
    ...toCommitSummary(first),
    stats: first.stats ?? { additions: 0, deletions: 0, total: 0 },
    files,
    truncated,
  };
};

const MERGE_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

/** 合并前置条件：权限、草稿、冲突、分支保护状态与仓库允许的合并方式。 */
export const getMergeOptions = async (
  env: Env,
  token: string,
  number: number,
): Promise<MergeOptions> => {
  const [pull, repo] = await Promise.all([
    call<RawPull>(env, token, `${repoPath(env)}/pulls/${number}`),
    call<RawRepo>(env, token, repoPath(env)),
  ]);
  const permissions = repo.permissions
    ? {
      push: Boolean(repo.permissions.push),
      maintain: Boolean(repo.permissions.maintain),
      admin: Boolean(repo.permissions.admin),
    }
    : null;
  const allowed = {
    merge: repo.allow_merge_commit !== false,
    squash: repo.allow_squash_merge !== false,
    rebase: repo.allow_rebase_merge !== false,
  };
  const methods = MERGE_METHODS.filter((method) => allowed[method]);
  const draft = Boolean(pull.draft);
  const canMerge = pull.state === "open"
    && !pull.merged_at
    && !draft
    && Boolean(permissions && (permissions.push || permissions.maintain || permissions.admin));

  let reason: string | null = null;
  if (pull.merged_at) reason = "PR 已合并";
  else if (pull.state !== "open") reason = "PR 已关闭";
  else if (draft) reason = "草稿 PR 不能合并";
  else if (!permissions || !(permissions.push || permissions.maintain || permissions.admin)) {
    reason = "需要仓库写权限";
  } else if (pull.mergeable === false || pull.mergeable_state === "dirty") {
    reason = "存在合并冲突";
  } else if (pull.mergeable_state === "blocked") {
    reason = "缺少必需审批或状态检查";
  } else if (pull.mergeable_state === "behind") {
    reason = "分支落后于 base，需要先更新分支";
  } else if (pull.mergeable_state === "unstable") {
    reason = "必需状态检查未通过";
  }

  return {
    canMerge,
    reason,
    methods,
    defaultMethod: methods[0] ?? null,
    draft,
    mergeable: pull.mergeable ?? null,
    mergeableState: pull.mergeable_state ?? null,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    permissions,
  };
};

/** 真正执行合并；sha 由调用方锁定，head 变化时 GitHub 会拒绝。 */
export const mergePull = async (
  env: Env,
  token: string,
  number: number,
  input: { sha: string; method: MergeMethod; commitTitle?: string; commitMessage?: string },
): Promise<MergeResult> => {
  const payload: Record<string, string> = {
    sha: input.sha,
    merge_method: input.method,
  };
  if (input.commitTitle) payload.commit_title = input.commitTitle;
  if (input.commitMessage) payload.commit_message = input.commitMessage;
  const result = await call<{ merged: boolean; sha: string | null; message: string }>(
    env,
    token,
    `${repoPath(env)}/pulls/${number}/merge`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return { merged: Boolean(result.merged), sha: result.sha ?? null, message: result.message ?? "" };
};

export interface ReviewDraft {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  /** true = 该范围不在 diff 内：不作为行级评论，改发 PR 整体评论（正文自带路径与行号） */
  plain?: boolean;
}

export interface ReviewResult {
  id: number;
  url: string;
  comments: number;
}

export interface IssueCommentResult {
  id: number;
  url: string;
}

/** PR 整体评论（不挂行）：用于 diff 之外的行，正文由客户端拼好路径与行号范围。 */
export const createIssueComment = async (
  env: Env,
  token: string,
  number: number,
  body: string,
): Promise<IssueCommentResult> => {
  const comment = await call<{ id: number; html_url: string }>(
    env,
    token,
    `${repoPath(env)}/issues/${number}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  return { id: comment.id, url: comment.html_url };
};

/** 一次提交把草稿合并成一条 review；event 默认 COMMENT，可指定 REQUEST_CHANGES 或 APPROVE。 */
export const createReview = async (
  env: Env,
  token: string,
  number: number,
  commitId: string,
  drafts: ReviewDraft[],
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" = "COMMENT",
): Promise<ReviewResult> => {
  const eventBody =
    event === "REQUEST_CHANGES"
      ? `变更查看器提交的行级审阅意见（共 ${drafts.length} 条），结论：请求修改后再审。`
      : event === "APPROVE"
        ? `变更查看器提交的审阅结论：批准合并。${drafts.length ? `附 ${drafts.length} 条行级意见。` : ""}`
        : `变更查看器提交的行级审阅意见（共 ${drafts.length} 条）`;
  const payload = {
    commit_id: commitId,
    event,
    body: eventBody,
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
