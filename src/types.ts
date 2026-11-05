/** 审批单据的公共类型定义。 */

export type StageStatus = "done" | "current" | "pending" | "rejected" | "commented" | "dismissed";

export interface ApprovalStage {
  /** 节点名称，例如「提交」「张三 审批」「合并」 */
  name: string;
  /** 处理人 */
  actor: string;
  status: StageStatus;
  /** ISO 时间，未发生为 null */
  at: string | null;
  /** 处理意见摘要 */
  comment: string | null;
}

export type ApprovalState = "open" | "merged" | "closed";

export interface Approval {
  id: string;
  number: number;
  title: string;
  requester: string;
  department: string;
  amount: number | null;
  state: ApprovalState;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  stages: ApprovalStage[];
  url: string;
}
