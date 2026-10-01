// 离线续办相关数据模型：小样批次、配方版本、复测色差、客户评审、待办与处理日志

export interface DyeRecipe {
  /** 染料/助剂名称及用量，如 "活性红 1.2%" */
  items: { name: string; amount: string }[];
  /** 浴比，如 1:15 */
  liquorRatio: string;
}

export interface LabColor {
  L: number;
  a: number;
  b: number;
}

export type ReviewResult = "approved" | "rejected" | "pending";

export interface Review {
  result: ReviewResult;
  comment: string;
  /** 客户/评审人 */
  by: string;
  at: string;
  /** 评审所依据的配方版本 */
  recipeVersion: string;
  /** 配方版本变更后置为 false，需要重新确认 */
  valid: boolean;
}

export interface Retest {
  /** 复测时测得的 Lab 值 */
  measured: LabColor;
  /** 与标准样的色差值 ΔE */
  deltaE: number;
  note: string;
  at: string;
  /** 复测所依据的配方版本 */
  recipeVersion: string;
  /** 配方版本变更后置为 false，需要重新复测确认 */
  valid: boolean;
}

export interface Batch {
  id: string;
  customerOrder: string;
  fabric: string;
  weight: string;
  recipe: DyeRecipe;
  /** 温度曲线摘要，如 30→130℃ 2℃/min */
  tempCurve: string;
  holdMinutes: number;
  finishing: string;
  /** 标准样 Lab 值（复测对比基准） */
  standardLab: LabColor;
  recipeVersion: string;
  recipeUpdatedAt: string;
  retest?: Retest;
  review?: Review;
  /** 仅存在于本地、尚未同步上送的登记批次 */
  localOnly?: boolean;
  createdAt: string;
  /** 处理过程：修订、复测、评审、合并、失效、冲突等全部留痕 */
  logs: BatchLog[];
}

export interface BatchLog {
  at: string;
  /** offline=离线操作，remote=服务端拉取，sync=合并处理，conflict=冲突，protect=评审保护 */
  kind: "offline" | "remote" | "sync" | "conflict" | "protect" | "error";
  message: string;
}

/** 待合并字段（登记时逐字段记录，离线期间逐项合并） */
export type BatchField =
  | "customerOrder"
  | "fabric"
  | "weight"
  | "recipe"
  | "tempCurve"
  | "holdMinutes"
  | "finishing"
  | "standardLab";

export const REGISTRATION_FIELDS: BatchField[] = [
  "customerOrder",
  "fabric",
  "weight",
  "recipe",
  "tempCurve",
  "holdMinutes",
  "finishing",
  "standardLab",
];

/** 复测色差逐分量合并（ΔE 由分量合并结果自动重算） */
export type RetestPart = "L" | "a" | "b" | "note";

/** 离线登记草稿：逐字段记录，恢复网络后逐项与远端合并 */
export interface RegistrationDraft {
  customerOrder: string;
  fabric: string;
  weight: string;
  recipe: DyeRecipe;
  tempCurve: string;
  holdMinutes: number;
  finishing: string;
  standardLab: LabColor;
  recipeVersion: string;
}

/** 登记三方合并基准：离线开始时批次各字段的快照（无 recipeVersion 以外的差异） */
export type RegistrationBase = RegistrationDraft;

export interface RetestPayload {
  measured: LabColor;
  note: string;
  /** 离线开始复测时所基于的批次快照，用于与远端逐项对比 */
  base: {
    recipeVersion: string;
    retest?: Retest;
  };
}

/** 冲突逐项裁决：字段 -> 保留 local（离线所记）还是 remote（别处已更新） */
export type ConflictResolution<T extends string> = Partial<Record<T, "local" | "remote">>;

export interface PendingConflict {
  /** registration=登记字段冲突；retest=复测色差分量冲突 */
  kind: "registration" | "retest";
  /** 两边都改过且取值不同、必须人工裁决的字段/分量 */
  fields: BatchField[] | RetestPart[];
  /**
   * 登记合并的三方比对基准（离线开始时的批次快照）。
   * 仅一边修改的字段据此自动合并，无需人工裁决。
   */
  base?: RegistrationBase;
  resolution?: ConflictResolution<BatchField | RetestPart>;
}

export type PendingStatus =
  | "queued" // 离线暂存，等待网络恢复
  | "conflict" // 两边都改过，差异已列清，等待逐项裁决
  | "stale" // 配方版本已变，离线复测内容失效，需基于新版本重新确认
  | "failed" // 合并失败，内容保留待重试
  | "applied"; // 已成功合并

export interface PendingOp {
  opId: string;
  batchId: string;
  type: "registration" | "retest";
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** 冲突时本地快照（registration=登记草稿；retest=离线复测） */
  draft?: RegistrationDraft;
  /** 登记时该批次的三方合并基准（全新批次时为空） */
  registrationBase?: RegistrationBase;
  payload?: RetestPayload;
  conflict?: PendingConflict;
  status: PendingStatus;
}

export interface LabState {
  batches: Batch[];
  queue: PendingOp[];
  online: boolean;
  /** 下一次服务端请求是否注入故障（用于演示合并失败后保留重试） */
  faultNext: boolean;
}
