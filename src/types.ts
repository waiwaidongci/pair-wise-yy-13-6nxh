// 染整小样离线续办 —— 数据模型

export type ID = string;

/** 评审结果 */
export type ReviewResult = "passed" | "rework" | "confirming" | "pending";

export const REVIEW_RESULT_LABEL: Record<ReviewResult, string> = {
  passed: "评审通过",
  rework: "待复染",
  confirming: "客户确认中",
  pending: "待评审",
};

/** 配方版本 */
export interface FormulaVersion {
  id: ID;
  version: string; // v1.0 / v1.1 ...
  recipe: string; // 染料配方
  liquorRatio: string; // 浴比
  tempCurve: string; // 温度曲线
  holdTime: string; // 保温时间
  createdAt: number;
  source: "local" | "remote";
  /** 离线暂存、尚未合并 */
  pending?: boolean;
}

/** 复测色差记录 */
export interface Retest {
  id: ID;
  formulaVersionId: ID; // 复测时所依据的配方版本
  deltaE: number; // 色差 ΔE
  note: string;
  recordedAt: number;
  source: "local" | "remote";
  /** 依据旧配方版本 -> 已失效，需重新复测 */
  valid: boolean;
  pending?: boolean;
  pendingOutboxId?: ID;
}

/** 评审记录 */
export interface Review {
  id: ID;
  formulaVersionId: ID; // 评审所依据的配方版本
  result: ReviewResult;
  confirmed: boolean; // 已确认（受保护，离线合并不得覆盖）
  recordedAt: number;
  confirmedAt?: number;
  source: "local" | "remote";
  /** 依据旧配方版本 -> 已失效，需重新确认 */
  valid: boolean;
  pending?: boolean;
  /** 离线发起的确认，待联网合并 */
  pendingConfirm?: boolean;
  pendingOutboxId?: ID;
}

/** 处理过程（留痕）类型 */
export type HistoryKind =
  | "batch_created"
  | "formula_changed"
  | "retest_recorded"
  | "review_recorded"
  | "review_confirmed"
  | "invalidated"
  | "queued"
  | "merge_success"
  | "merge_conflict"
  | "merge_failed"
  | "retry_kept"
  | "conflict_resolved";

export const HISTORY_KIND_LABEL: Record<HistoryKind, string> = {
  batch_created: "批次登记",
  formula_changed: "配方变更",
  retest_recorded: "复测记录",
  review_recorded: "评审记录",
  review_confirmed: "评审确认",
  invalidated: "失效标记",
  queued: "离线暂存",
  merge_success: "合并成功",
  merge_conflict: "合并冲突",
  merge_failed: "合并失败",
  retry_kept: "待重试保留",
  conflict_resolved: "冲突已解决",
};

export interface HistoryEntry {
  id: ID;
  at: number;
  kind: HistoryKind;
  detail: string;
}

/** 小样批次 */
export interface Batch {
  id: ID;
  code: string; // 批次号 LAB-xxx
  fabric: string; // 面料成分
  grams: string; // 克重
  finish: string; // 后整理方式
  orderNo: string; // 客户订单号
  currentFormulaVersionId: ID; // 当前配方版本
  formulaVersions: FormulaVersion[];
  retests: Retest[];
  reviews: Review[];
  createdAt: number;
  updatedAt: number;
  history: HistoryEntry[];
  /** 离线登记、尚未合并 */
  pending?: boolean;
}

/** 离线续办操作类型 */
export type OutboxOpType =
  | "batch_create"
  | "formula_update"
  | "retest_add"
  | "review_add"
  | "review_confirm";

export const OP_LABEL: Record<OutboxOpType, string> = {
  batch_create: "登记批次",
  formula_update: "配方修订",
  retest_add: "复测色差",
  review_add: "评审记录",
  review_confirm: "评审确认",
};

export type OutboxStatus = "pending" | "conflict" | "failed";

export interface DiffEntry {
  field: string;
  label: string;
  local: string;
  remote: string;
}

/** 离线暂存队列中的一项（待续办内容） */
export interface OutboxItem {
  id: ID;
  op: OutboxOpType;
  batchId: ID;
  batchCode: string;
  payload: Record<string, any>;
  /** 离线时所依据的服务端状态，用于判断"两边是否都改过" */
  baseUpdatedAt: number;
  baseFormulaVersionId: ID;
  status: OutboxStatus;
  attempts: number;
  error?: string;
  queuedAt: number;
  lastTriedAt?: number;
  conflict?: {
    diffs: DiffEntry[];
    /** 他处已存在确认评审，受保护不可覆盖 */
    protectedReview: boolean;
    remoteUpdatedAt: number;
  };
}

export interface BatchFormData {
  code: string;
  fabric: string;
  grams: string;
  finish: string;
  orderNo: string;
  recipe: string;
  liquorRatio: string;
  tempCurve: string;
  holdTime: string;
}

export interface FormulaFormData {
  recipe: string;
  liquorRatio: string;
  tempCurve: string;
  holdTime: string;
}

export interface RetestFormData {
  deltaE: number;
  note: string;
}
