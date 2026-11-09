/** 仓库内任意文档的定位：把文档里的链接（含历史裸路径）解析成真实仓库路径。 */
import type { Env } from "./github";
import { repoPath } from "./github";
import { GitHubError } from "./diff";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_TREE_FILES = 5000;

/** 只有这些后缀才当成"文档链接"，其余路径仍走静态资源。 */
export const DOC_PATH = /\.(md|markdown|mdx|csv)$/i;

interface TreeEntry { path: string; type: string }
interface Cached<T> { at: number; value: T }

const treeCache = new Map<string, Cached<string[]>>();
const branchCache = new Map<string, Cached<string>>();

const headers = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "approval-visualization-worker",
});

/** 归一化成仓库内相对路径；带 `..` 或空路径一律拒绝。 */
export const normalizeDocPath = (input: string): string | null => {
  let decoded = String(input ?? "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* 非法转义保持原样，交给后续匹配 */
  }
  const parts = decoded.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return null;
  return parts.join("/");
};

export const defaultBranch = async (env: Env, token: string): Promise<string> => {
  const key = `${env.GITHUB_ORG ?? "noware-cn"}/${env.GITHUB_REPO ?? "workspace"}`;
  const hit = branchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const response = await fetch(`https://api.github.com${repoPath(env)}`, { headers: headers(token) });
  if (!response.ok) throw new GitHubError(response.status, "读取仓库信息失败");
  const body = (await response.json()) as { default_branch?: string };
  const value = body.default_branch || "main";
  branchCache.set(key, { at: Date.now(), value });
  return value;
};

export const listRepoFiles = async (env: Env, token: string, ref: string): Promise<string[]> => {
  const key = `${env.GITHUB_ORG ?? "noware-cn"}/${env.GITHUB_REPO ?? "workspace"}@${ref}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const response = await fetch(
    `https://api.github.com${repoPath(env)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: headers(token) },
  );
  if (!response.ok) throw new GitHubError(response.status, `读取仓库文件树失败：${ref.slice(0, 7)}`);
  const body = (await response.json()) as { tree?: TreeEntry[] };
  const files = (body.tree ?? [])
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .slice(0, MAX_TREE_FILES);
  treeCache.set(key, { at: Date.now(), value: files });
  return files;
};

export interface DocResolution {
  path: string | null;
  candidates: string[];
}

const shortest = (list: string[]): string[] =>
  [...list].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 5);

/**
 * 先精确匹配，再按"路径后缀唯一命中"纠正：
 * 历史链接常写成 `客户需求记录/x.md`，丢掉前面的目录层级，这里补回真实路径。
 */
export const resolveDocPath = async (
  env: Env,
  token: string,
  ref: string,
  requested: string,
): Promise<DocResolution> => {
  const normalized = normalizeDocPath(requested);
  if (!normalized) return { path: null, candidates: [] };
  const files = await listRepoFiles(env, token, ref);
  if (files.includes(normalized)) return { path: normalized, candidates: [] };

  const suffix = files.filter((file) => file.endsWith(`/${normalized}`));
  if (suffix.length === 1) return { path: suffix[0], candidates: [] };
  if (suffix.length > 1) return { path: null, candidates: shortest(suffix) };

  const base = normalized.split("/").pop() ?? normalized;
  const sameName = files.filter((file) => file.split("/").pop() === base);
  return { path: null, candidates: shortest(sameName) };
};
