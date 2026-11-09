import type { Approval, ApprovalStage, ApprovalState } from "./types";

/**
 * 演示数据：仅在 MOCK_MODE=1 时使用。
 * 这些单据是虚构的，不对应任何真实业务或仓库记录。
 */

const ago = (days: number): string => {
  const base = Date.now() - days * 86_400_000;
  return new Date(base).toISOString();
};

const stagesOf = (
  requester: string,
  approvers: Array<{ name: string; status: ApprovalStage["status"]; day: number; comment: string | null }>,
  createdAt: string,
): ApprovalStage[] => [
  { name: "提交", actor: requester, status: "done", at: createdAt, comment: "发起申请" },
  ...approvers.map((approver) => ({
    name: `${approver.name} 审批`,
    actor: approver.name,
    status: approver.status,
    at: approver.status === "current" || approver.status === "pending" ? null : ago(approver.day),
    comment: approver.comment,
  })),
];

const build = (
  number: number,
  title: string,
  requester: string,
  department: string,
  amount: number,
  state: ApprovalState,
  currentStage: string,
  createdAt: string,
  updatedAt: string,
  stages: ApprovalStage[],
): Approval => ({
  id: String(number),
  number,
  title,
  requester,
  department,
  amount,
  state,
  currentStage,
  createdAt,
  updatedAt,
  stages,
  url: "#",
});

const NAMES = ["张伟", "李静", "王磊", "陈曦", "刘洋", "赵敏", "孙睿", "周萍"];

const SPECS: Array<{ title: string; department: string; amount: number }> = [
  { title: "核心系统批量作业窗口调整申请", department: "科技", amount: 0 },
  { title: "第三批信创服务器采购立项", department: "科技", amount: 4_860_000 },
  { title: "互联网渠道营销活动费率优惠", department: "运营", amount: 320_000 },
  { title: "对公账户开户流程线上化改造", department: "运营", amount: 0 },
  { title: "反欺诈规则库新增 12 条策略", department: "风控", amount: 0 },
  { title: "票据贴现业务授信额度上调", department: "风控", amount: 12_000_000 },
  { title: "年度审计底稿模板修订", department: "合规", amount: 0 },
  { title: "外包人员入场安全评估", department: "合规", amount: 0 },
  { title: "数据中心机柜扩容预算", department: "财务", amount: 780_000 },
  { title: "测试环境云资源年度续费", department: "财务", amount: 1_260_000 },
  { title: "客户经理移动展业终端升级", department: "科技", amount: 540_000 },
  { title: "统一身份认证对接统一门户", department: "科技", amount: 0 },
];

const cycle = (index: number): ApprovalState =>
  index % 5 === 0 ? "merged" : index % 7 === 3 ? "closed" : "open";

/** 这张单据照 noware-cn/workspace#16 抄录，用来演示 CSV 台账文件的评审。 */
const CSV_PR: Approval = build(
  16,
  "data: 区域银行智能研发中标台账（84 条 A 类，2024-12 至 2026-11）",
  "dantesun",
  "市场",
  0,
  "open",
  "待合并",
  "2026-11-08T05:55:00Z",
  "2026-11-09T05:11:00Z",
  stagesOf(
    "dantesun",
    [
      { name: "张伟", status: "done", day: 1, comment: "台账口径与来源清单已核对" },
      { name: "李静", status: "current", day: 0, comment: "等待审批" },
    ],
    "2026-11-08T05:55:00Z",
  ),
);

export const MOCK_APPROVALS = (): Approval[] => {
  const items: Approval[] = [];
  for (let index = 0; index < 24; index += 1) {
    const spec = SPECS[index % SPECS.length];
    const state = cycle(index);
    const requester = NAMES[index % NAMES.length];
    const first = NAMES[(index + 2) % NAMES.length];
    const second = NAMES[(index + 5) % NAMES.length];
    const createdAt = ago(12 - (index % 10));

    let currentStage = "待合并";
    let approvers: Parameters<typeof stagesOf>[1];

    if (state === "merged") {
      currentStage = "已合并";
      approvers = [
        { name: first, status: "done", day: 8, comment: "符合规范，同意" },
        { name: second, status: "done", day: 6, comment: "同意，按计划执行" },
      ];
    } else if (state === "closed") {
      currentStage = "已关闭";
      approvers = [{ name: first, status: "rejected", day: 7, comment: "口径不清，退回补充材料" }];
    } else if (index % 3 === 0) {
      currentStage = second;
      approvers = [
        { name: first, status: "done", day: 9, comment: "材料齐全" },
        { name: second, status: "current", day: 0, comment: "等待审批" },
      ];
    } else {
      currentStage = "待合并";
      approvers = [
        { name: first, status: "done", day: 10, comment: "同意" },
        { name: second, status: "done", day: 8, comment: "同意" },
      ];
    }

    const stages = stagesOf(requester, approvers, createdAt);
    items.push(
      build(
        index > 11 ? 300 + index : 100 + index,
        spec.title,
        requester,
        spec.department,
        spec.amount,
        state,
        currentStage,
        createdAt,
        ago(index % 5 === 0 ? 2 : index % 4),
        stages,
      ),
    );
  }
  return [CSV_PR, ...items];
};

export const MOCK_DETAIL = (number: number): Approval | null => {
  const found = MOCK_APPROVALS().find((item) => item.number === number);
  return found ?? null;
};
