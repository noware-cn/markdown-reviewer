import type { Approval, ApprovalStage, ApprovalState, StageStatus } from "./types";

export interface Env {
  ASSETS: Fetcher;
  SERVICE_NAME: string;
  ENVIRONMENT: string;
  GITHUB_ORG?: string;
  GITHUB_REPO?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_DATA_TOKEN?: string;
  SESSION_SECRET?: string;
  MOCK_MODE?: string;
  DEV_FAKE_USER?: string;
  DEPLOY_COMMIT?: string;
}

interface GitHubPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  requested_reviewers: Array<{ login: string }>;
  head?: { ref: string };
  merged_by?: { login: string } | null;
  closed_by?: { login: string } | null;
}

interface GitHubReview {
  id: number;
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
  body: string | null;
}

const DEPARTMENTS = ["科技", "财务", "风控", "运营", "合规"];

const pickDepartment = (labels: Array<{ name: string }>): string => {
  const hit = labels.find((label) => DEPARTMENTS.some((d) => label.name.includes(d)));
  return hit ? hit.name : "未分类";
};

const reviewStatus = (state: string): StageStatus => {
  if (state === "APPROVED") return "done";
  if (state === "CHANGES_REQUESTED") return "rejected";
  if (state === "COMMENTED") return "commented";
  if (state === "DISMISSED") return "dismissed";
  return "pending";
};

const buildStages = (pull: GitHubPull, reviews: GitHubReview[]): ApprovalStage[] => {
  const stages: ApprovalStage[] = [
    {
      name: "提交",
      actor: pull.user?.login ?? "未知",
      status: "done",
      at: pull.created_at,
      comment: pull.head?.ref ? `来源分支 ${pull.head.ref}` : null,
    },
  ];

  const latestDecisionByUser = new Map<string, GitHubReview>();
  const latestCommentByUser = new Map<string, GitHubReview>();
  for (const review of reviews) {
    if (review.state === "PENDING") continue;
    const login = review.user?.login ?? "未知";
    const target = review.state === "COMMENTED" ? latestCommentByUser : latestDecisionByUser;
    const existing = target.get(login);
    if (!existing || (review.submitted_at ?? "") > (existing.submitted_at ?? "")) {
      target.set(login, review);
    }
  }

  const reviewStages = [
    ...[...latestDecisionByUser.entries()].map(([login, review]) => ({
      name: login + " 审批",
      actor: login,
      status: reviewStatus(review.state),
      at: review.submitted_at,
      comment: (review.body || "").trim().slice(0, 120) || null,
    })),
    ...[...latestCommentByUser.entries()].map(([login, review]) => ({
      name: login + " 评论",
      actor: login,
      status: "commented" as const,
      at: review.submitted_at,
      comment: (review.body || "").trim().slice(0, 120) || null,
    })),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  stages.push(...reviewStages);

  for (const reviewer of pull.requested_reviewers) {
    if (latestDecisionByUser.has(reviewer.login)) continue;
    stages.push({
      name: `${reviewer.login} 审批`,
      actor: reviewer.login,
      status: "current",
      at: null,
      comment: "等待审批",
    });
  }

  if (pull.merged_at) {
    stages.push({ name: "合并", actor: pull.merged_by?.login ?? "未知", status: "done", at: pull.merged_at, comment: null });
  } else if (pull.state === "closed") {
    stages.push({ name: "关闭", actor: pull.closed_by?.login ?? "未知", status: "rejected", at: pull.updated_at, comment: "已关闭未合并" });
  }

  return stages;
};

const currentStage = (pull: GitHubPull, stages: ApprovalStage[]): string => {
  if (pull.merged_at) return "已合并";
  if (pull.state === "closed") return "已关闭";
  const rejected = stages.find((stage) => stage.status === "rejected");
  if (rejected) return "需修改";
  const waiting = stages.find((stage) => stage.status === "current");
  if (waiting) return waiting.name.replace(" 审批", "");
  const hasApproval = stages.some((stage) => stage.status === "done" && stage.name.endsWith("审批"));
  if (!hasApproval && stages.some((stage) => stage.status === "dismissed")) return "审批已撤销";
  if (!hasApproval && stages.some((stage) => stage.status === "commented")) return "待审批";
  return "待合并";
};

const approvalState = (pull: GitHubPull): ApprovalState => {
  if (pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return "open";
};

const toApproval = (pull: GitHubPull, reviews: GitHubReview[]): Approval => {
  const stages = buildStages(pull, reviews);
  return {
    id: String(pull.number),
    number: pull.number,
    title: pull.title,
    requester: pull.user?.login ?? "未知",
    department: pickDepartment(pull.labels ?? []),
    amount: null,
    state: approvalState(pull),
    currentStage: currentStage(pull, stages),
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    stages,
    url: pull.html_url,
  };
};

const githubFetch = async <T>(path: string, token: string): Promise<T> => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "approval-visualization-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} ${path}`);
  }
  return (await response.json()) as T;
};

const githubFetchAll = async <T>(path: string, token: string, maxPages = 30): Promise<T[]> => {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubFetch<T[]>(path + separator + "per_page=100&page=" + page, token);
    out.push(...batch);
    if (batch.length < 100) break;
    if (page === maxPages) throw new Error(`GitHub 分页超过安全上限（${maxPages * 100} 条），拒绝返回不完整列表。`);
  }
  return out;
};

const mapWithConcurrency = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
};

const repoPath = (env: Env): string =>
  `/repos/${env.GITHUB_ORG ?? "noware-cn"}/${env.GITHUB_REPO ?? "workspace"}`;

export const listApprovals = async (env: Env, token: string): Promise<Approval[]> => {
  const pulls = await githubFetchAll<GitHubPull>(repoPath(env) + "/pulls?state=all&sort=updated&direction=desc", token);
  const reviews = await mapWithConcurrency(pulls, 5, (pull) =>
    githubFetchAll<GitHubReview>(repoPath(env) + "/pulls/" + pull.number + "/reviews", token),
  );
  return pulls.map((pull, index) => toApproval(pull, reviews[index]));
};

export const getApproval = async (
  env: Env,
  token: string,
  number: number,
): Promise<Approval> => {
  const [pull, reviews] = await Promise.all([
    githubFetch<GitHubPull>(`${repoPath(env)}/pulls/${number}`, token),
    githubFetchAll<GitHubReview>(repoPath(env) + "/pulls/" + number + "/reviews", token),
  ]);
  return toApproval(pull, reviews);
};
