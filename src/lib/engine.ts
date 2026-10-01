import {
  Batch,
  BatchField,
  BatchLog,
  DyeRecipe,
  LabColor,
  PendingConflict,
  RegistrationDraft,
  REGISTRATION_FIELDS,
  Retest,
  RetestPart,
  RetestPayload,
  Review,
} from "../types";

// ---------- 基础工具 ----------

export function now(): string {
  return new Date().toISOString();
}

export function log(
  kind: BatchLog["kind"],
  message: string,
  at = now()
): BatchLog {
  return { at, kind, message };
}

export function deltaE(a: LabColor, b: LabColor): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.round(Math.sqrt(dL * dL + da * da + db * db) * 100) / 100;
}

export const REVIEW_LABEL: Record<Review["result"], string> = {
  approved: "评审通过",
  rejected: "评审不通过",
  pending: "待评审",
};

export const FIELD_LABEL: Record<BatchField, string> = {
  customerOrder: "客户订单",
  fabric: "面料成分",
  weight: "克重",
  recipe: "染料配方",
  tempCurve: "温度曲线",
  holdMinutes: "保温时间",
  finishing: "后整理方式",
  standardLab: "标准Lab",
};

export const RETEST_PART_LABEL: Record<RetestPart, string> = {
  L: "L*",
  a: "a*",
  b: "b*",
  note: "复测备注",
};

export function formatLab(c: LabColor): string {
  return `L ${c.L.toFixed(2)} / a ${c.a.toFixed(2)} / b ${c.b.toFixed(2)}`;
}

export function formatRecipe(r: DyeRecipe): string {
  return r.items.map((i) => `${i.name} ${i.amount}`).join("，") + `；浴比 ${r.liquorRatio}`;
}

export function fieldValueText(field: BatchField, b: { [K in BatchField]: Batch[K] }): string {
  switch (field) {
    case "recipe":
      return formatRecipe(b.recipe);
    case "standardLab":
      return formatLab(b.standardLab);
    case "holdMinutes":
      return `${b.holdMinutes} min`;
    default:
      return String(b[field]);
  }
}

export function draftValueText(field: BatchField, d: RegistrationDraft): string {
  switch (field) {
    case "recipe":
      return formatRecipe(d.recipe);
    case "standardLab":
      return formatLab(d.standardLab);
    case "holdMinutes":
      return `${d.holdMinutes} min`;
    default:
      return String(d[field]);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

// ---------- 网络恢复后的批次对账 ----------
//
// 原则：远端配方版本一变，针对旧版本的复测和评审立即失效，需要重新确认；
// 已确认的评审结果不删除，保留在处理过程（日志）里可追溯。

export function reconcileAfterPull(local: Batch, remote: Batch): Batch {
  if (local.recipeVersion === remote.recipeVersion) {
    // 版本相同：以远端最新确认为准（离线期间评审可能在别处更新）
    return {
      ...remote,
      localOnly: local.localOnly,
      logs: [
        ...local.logs,
        ...remote.logs.filter(
          (rlog) => !local.logs.some((llog) => llog.at === rlog.at && llog.message === rlog.message)
        ),
      ],
    };
  }

  const merged: Batch = {
    ...remote,
    localOnly: local.localOnly,
    logs: [...local.logs],
  };

  // 本地复测若基于旧版本，立即失效（远端 retest 已由 ...remote 带入）
  if (local.retest && local.retest.recipeVersion !== remote.recipeVersion) {
    merged.retest = { ...local.retest, valid: false };
    merged.logs.push(
      log(
        "remote",
        `配方版本由 v${local.recipeVersion} 升至 v${remote.recipeVersion}：基于旧版本的复测（ΔE ${local.retest.deltaE}）立即失效，需按新版本重新复测确认`
      )
    );
  }

  // 旧版本评审失效，评审结论留痕
  const staleReview =
    local.review && local.review.recipeVersion !== remote.recipeVersion
      ? local.review
      : remote.review && remote.review.recipeVersion !== remote.recipeVersion
        ? remote.review
        : undefined;
  if (staleReview) {
    merged.review = { ...staleReview, valid: false };
    merged.logs.push(
      log(
        "remote",
        `配方版本由 v${staleReview.recipeVersion} 升至 v${remote.recipeVersion}：客户评审「${REVIEW_LABEL[staleReview.result]}」随版本变更失效，需重新确认（历史结论保留）`
      )
    );
  }

  merged.logs.push(
    ...remote.logs.filter(
      (rlog) => !merged.logs.some((llog) => llog.at === rlog.at && llog.message === rlog.message)
    )
  );
  return merged;
}

// ---------- 登记：逐字段三方合并 ----------
//
// 以"离线开始时的批次快照 base"为基准做三方比对：
// 仅本地改 → 用离线登记值；仅远端改 → 用服务端值；两边都改成不同值 → 冲突，逐项裁决，不自动盖值

export interface RegistrationMergePlan {
  /** 与服务端存在差异的全部字段（含仅一边修改） */
  diffs: BatchField[];
  /** 两边都改成不同值、必须人工裁决的字段 */
  conflicts: BatchField[];
}

export function detectRegistrationMerges(
  draft: RegistrationDraft,
  remote: Batch,
  base?: RegistrationDraft
): RegistrationMergePlan {
  const diffs = REGISTRATION_FIELDS.filter((f) => !deepEqual(draft[f], remote[f]));
  if (!base) {
    // 没有离线基准（旧数据）：全部差异都当作冲突，保守处理
    return { diffs, conflicts: diffs };
  }
  const conflicts = diffs.filter((f) => {
    const localChanged = !deepEqual(base[f], draft[f]);
    const remoteChanged = !deepEqual(base[f], remote[f]);
    return localChanged && remoteChanged;
  });
  return { diffs, conflicts };
}

/** 三方合并登记字段：冲突字段按裁决，其余按"谁改取谁"，都没改维持服务端 */
export function applyRegistration(
  batch: Batch,
  draft: RegistrationDraft,
  conflict: PendingConflict | undefined
): Batch {
  const resolution = conflict?.resolution ?? {};
  const base = conflict?.base;
  // 配方版本以服务端为准：离线草稿可能基于旧版本，绝不能把版本号盖回去
  const versionChanged = draft.recipeVersion !== batch.recipeVersion;
  const merged: Batch = {
    ...batch,
    recipeVersion: batch.recipeVersion,
    localOnly: false,
  };
  const taken: string[] = [];

  for (const f of REGISTRATION_FIELDS) {
    const choice = resolution[f];
    if (choice === "local") {
      (merged[f] as unknown) = draft[f] as never;
      taken.push(`${FIELD_LABEL[f]}取离线登记`);
    } else if (choice === "remote") {
      taken.push(`${FIELD_LABEL[f]}保留服务端`);
    } else if (!base) {
      // 无基准的旧数据：未裁决字段维持服务端
      taken.push(`${FIELD_LABEL[f]}维持服务端`);
    } else {
      const localChanged = !deepEqual(base[f], draft[f]);
      const remoteChanged = !deepEqual(base[f], batch[f]);
      if (localChanged && !remoteChanged) {
        (merged[f] as unknown) = draft[f] as never;
        taken.push(`${FIELD_LABEL[f]}仅离线修改，按离线登记合并`);
      } else if (remoteChanged && !localChanged) {
        taken.push(`${FIELD_LABEL[f]}仅服务端修改，保留服务端值`);
      } else if (localChanged && remoteChanged && deepEqual(draft[f], batch[f])) {
        taken.push(`${FIELD_LABEL[f]}两边改为相同值`);
      } else {
        taken.push(`${FIELD_LABEL[f]}未修改，维持服务端`);
      }
    }
  }

  merged.logs.push(
    log(
      "sync",
      `登记内容按版本 v${batch.recipeVersion} 逐项合并完成：${taken.join("；")}` +
        (versionChanged
          ? `（离线草稿基于 v${draft.recipeVersion}，服务端已为 v${batch.recipeVersion}，版本以服务端为准；字段差异已逐项合并）`
          : "")
    )
  );
  return merged;
}

// ---------- 复测：色差逐分量合并 ----------

export function retestConflicts(payload: RetestPayload, remote: Batch): RetestPart[] {
  const base = payload.base.retest;
  // 服务端已失效（配方版本变更导致）的复测不构成"当前值"，不作为两边同改的保护对象
  const current = remote.retest?.valid ? remote.retest : undefined;
  const changed: RetestPart[] = [];

  (["L", "a", "b"] as const).forEach((part) => {
    const baseV = base ? base.measured[part] : undefined;
    const localV = payload.measured[part];
    const remoteV = current ? current.measured[part] : undefined;
    const localChanged = baseV !== localV;
    const remoteChanged = baseV !== remoteV;
    if (localChanged && remoteChanged && localV !== remoteV) changed.push(part);
  });

  if (
    (base?.note ?? "") !== payload.note &&
    (base?.note ?? "") !== (current?.note ?? "") &&
    payload.note !== (current?.note ?? "")
  ) {
    changed.push("note");
  }
  return changed;
}

export interface RetestApplyResult {
  batch: Batch;
}

export function applyRetest(
  batch: Batch,
  payload: RetestPayload,
  conflict: PendingConflict | undefined
): RetestApplyResult {
  const resolution = conflict?.resolution ?? {};
  const parts: string[] = [];
  const measured: LabColor = {
    L: resolution.L === "remote" ? batch.retest!.measured.L : payload.measured.L,
    a: resolution.a === "remote" ? batch.retest!.measured.a : payload.measured.a,
    b: resolution.b === "remote" ? batch.retest!.measured.b : payload.measured.b,
  };
  const note =
    resolution.note === "remote" ? (batch.retest?.note ?? "") : payload.note;

  (["L", "a", "b"] as const).forEach((p) => {
    parts.push(`${RETEST_PART_LABEL[p]}=${resolution[p] === "remote" ? "保留服务端" : "采用离线复测"}`);
  });
  if ((conflict?.fields ?? []).some((f) => f === "note")) {
    parts.push(`备注${resolution.note === "remote" ? "保留服务端" : "采用离线复测"}`);
  }

  const valid = payload.base.recipeVersion === batch.recipeVersion;
  const retest: Retest = {
    measured,
    deltaE: deltaE(measured, batch.standardLab),
    note,
    at: now(),
    recipeVersion: batch.recipeVersion,
    valid,
  };

  const merged: Batch = { ...batch, retest };
  if (conflict && conflict.fields.length > 0) {
    merged.logs.push(log("sync", `复测色差逐项合并完成：${parts.join("；")}，重算 ΔE ${retest.deltaE}`));
  } else {
    merged.logs.push(
      log(
        "sync",
        valid
          ? `离线复测已合并：ΔE ${retest.deltaE}（基于 v${batch.recipeVersion}，复测有效）`
          : `离线复测已合并但版本已升至 v${batch.recipeVersion}：ΔE ${retest.deltaE}，标记失效需重新确认`
      )
    );
  }
  return { batch: merged };
}
