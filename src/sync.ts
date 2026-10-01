// 离线续办合并引擎
// 断网时把批次/配方版本/复测色差/评审操作暂存为 outbox 项；
// 联网后按版本逐项合并：冲突逐项列出，已确认评审受保护不可覆盖；
// 配方版本一变，既有复测/评审立即失效；失败保留待重试，处理过程留痕。
import type {
  Batch,
  DiffEntry,
  FormulaVersion,
  HistoryEntry,
  ID,
  OutboxItem,
  Retest,
  Review,
  ReviewResult,
} from "./types";
import { REVIEW_RESULT_LABEL } from "./types";
import { now, uid } from "./store";

function hist(kind: HistoryEntry["kind"], detail: string): HistoryEntry {
  return { id: uid(), at: now(), kind, detail };
}

function versionLabel(b: Batch, fvId: ID): string {
  return b.formulaVersions.find((v) => v.id === fvId)?.version ?? "已删除版本";
}

/** 配方版本递增：v1.9 -> v2.0 */
export function nextVersion(b: Batch): string {
  let major = 1;
  let minor = 0;
  for (const v of b.formulaVersions) {
    const m = /^v(\d+)\.(\d+)$/.exec(v.version);
    if (!m) continue;
    const maj = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (maj > major || (maj === major && min > minor)) {
      major = maj;
      minor = min;
    }
  }
  if (minor >= 9) return `v${major + 1}.0`;
  return `v${major}.${minor + 1}`;
}

/**
 * 配方版本变更后，复测与评审立即失效（记录保留，标记 valid=false），
 * 并在处理过程中留痕。
 */
function invalidate(b: Batch, newFvId: ID): Batch {
  const history = [...b.history];
  const oldVersion = versionLabel(b, b.currentFormulaVersionId);
  const retests = b.retests.map((r) => {
    if (r.valid && r.formulaVersionId !== newFvId) {
      history.push(hist("invalidated", `复测 ΔE ${r.deltaE} 基于旧配方版本 ${oldVersion}，已失效，请重新复测`));
      return { ...r, valid: false };
    }
    return r;
  });
  const reviews = b.reviews.map((r) => {
    if (r.valid && r.formulaVersionId !== newFvId) {
      history.push(
        hist(
          "invalidated",
          `评审（${REVIEW_RESULT_LABEL[r.result]}）基于旧配方版本 ${oldVersion}，已失效，需重新确认`,
        ),
      );
      return { ...r, valid: false };
    }
    return r;
  });
  return { ...b, retests, reviews, history };
}

function fail(
  item: OutboxItem,
  batches: Record<ID, Batch>,
  message: string,
): { item: OutboxItem; batches: Record<ID, Batch> } {
  const next: OutboxItem = {
    ...item,
    status: "failed",
    attempts: item.attempts + 1,
    error: message,
    lastTriedAt: now(),
  };
  const b = batches[item.batchId];
  if (b) {
    const nb: Batch = {
      ...b,
      history: [
        ...b.history,
        hist("merge_failed", `合并失败（第 ${next.attempts} 次）：${message}`),
        hist("retry_kept", "已保留待重试内容，联网后可重新合并"),
      ],
    };
    return { item: next, batches: { ...batches, [nb.id]: nb } };
  }
  return { item: next, batches };
}

function diffFormula(payload: Record<string, any>, remote: FormulaVersion): DiffEntry[] {
  const rows: [string, string, string, string][] = [
    ["version", "配方版本", payload.version ?? "（离线修订）", remote.version],
    ["recipe", "染料配方", payload.recipe ?? "", remote.recipe],
    ["liquorRatio", "浴比", payload.liquorRatio ?? "", remote.liquorRatio],
    ["tempCurve", "温度曲线", payload.tempCurve ?? "", remote.tempCurve],
    ["holdTime", "保温时间", payload.holdTime ?? "", remote.holdTime],
  ];
  return rows
    .filter(([, , local, remote]) => local !== remote)
    .map(([field, label, local, remote]) => ({ field, label, local, remote }));
}

function diffBatch(payload: Record<string, any>, remote: Batch): DiffEntry[] {
  const rows: [string, string, string, string][] = [
    ["code", "批次号", payload.code ?? "", remote.code],
    ["fabric", "面料成分", payload.fabric ?? "", remote.fabric],
    ["grams", "克重", payload.grams ?? "", remote.grams],
    ["finish", "后整理", payload.finish ?? "", remote.finish],
    ["orderNo", "客户订单", payload.orderNo ?? "", remote.orderNo],
  ];
  return rows
    .filter(([, , local, remote]) => local !== remote)
    .map(([field, label, local, remote]) => ({ field, label, local, remote }));
}

/** 处理单条续办项；item 返回 null 表示合并成功并移出队列 */
function processOne(
  item: OutboxItem,
  batches: Record<ID, Batch>,
): { item: OutboxItem | null; batches: Record<ID, Batch> } {
  switch (item.op) {
    case "batch_create": {
      const dup = Object.values(batches).find((x) => x.code === item.payload.code);
      if (dup) {
        return {
          item: {
            ...item,
            status: "conflict",
            attempts: item.attempts + 1,
            lastTriedAt: now(),
            conflict: {
              diffs: diffBatch(item.payload, dup),
              protectedReview: false,
              remoteUpdatedAt: dup.updatedAt,
            },
          },
          batches,
        };
      }
      const p = item.payload;
      const fvId: ID = p.fvId ?? uid();
      const t = now();
      const fv: FormulaVersion = {
        id: fvId,
        version: "v1.0",
        recipe: p.recipe ?? "",
        liquorRatio: p.liquorRatio ?? "",
        tempCurve: p.tempCurve ?? "",
        holdTime: p.holdTime ?? "",
        createdAt: t,
        source: "local",
      };
      const batch: Batch = {
        id: item.batchId,
        code: p.code,
        fabric: p.fabric,
        grams: p.grams ?? "",
        finish: p.finish ?? "",
        orderNo: p.orderNo ?? "",
        currentFormulaVersionId: fvId,
        formulaVersions: [fv],
        retests: [],
        reviews: [],
        createdAt: t,
        updatedAt: t,
        history: [
          hist("batch_created", `批次 ${p.code} 离线登记（${p.fabric}）`),
          hist("formula_changed", "配方版本 v1.0 建立"),
          hist("merge_success", "离线登记批次已按版本合并"),
        ],
      };
      return { item: null, batches: { ...batches, [batch.id]: batch } };
    }

    case "formula_update": {
      const b = batches[item.batchId];
      if (!b) {
        return fail(item, batches, "批次在服务端不存在，可能已被他处删除");
      }
      const remoteFv = b.formulaVersions.find((v) => v.id === b.currentFormulaVersionId);
      const remoteChanged =
        b.updatedAt > item.baseUpdatedAt || b.currentFormulaVersionId !== item.baseFormulaVersionId;
      if (remoteChanged) {
        return {
          item: {
            ...item,
            status: "conflict",
            attempts: item.attempts + 1,
            lastTriedAt: now(),
            conflict: {
              diffs: diffFormula(item.payload, remoteFv ?? b.formulaVersions[b.formulaVersions.length - 1]),
              protectedReview: false,
              remoteUpdatedAt: b.updatedAt,
            },
          },
          batches,
        };
      }
      const p = item.payload;
      const newVersion = nextVersion(b);
      const fv: FormulaVersion = {
        id: p.fvId ?? uid(),
        version: newVersion,
        recipe: p.recipe ?? "",
        liquorRatio: p.liquorRatio ?? "",
        tempCurve: p.tempCurve ?? "",
        holdTime: p.holdTime ?? "",
        createdAt: now(),
        source: "local",
      };
      let nb: Batch = {
        ...b,
        formulaVersions: [...b.formulaVersions.filter((v) => v.id !== fv.id), fv],
        currentFormulaVersionId: fv.id,
        updatedAt: now(),
      };
      nb.history = [
        ...nb.history,
        hist("formula_changed", `配方版本 ${remoteFv?.version ?? "?"} → ${fv.version}（离线修订合并）`),
      ];
      // 配方版本一变，复测与评审立即失效
      nb = invalidate(nb, fv.id);
      nb.history = [...nb.history, hist("merge_success", "配方修订已按版本逐项合并")];
      return { item: null, batches: { ...batches, [nb.id]: nb } };
    }

    case "retest_add": {
      const b = batches[item.batchId];
      if (!b) {
        return fail(item, batches, "批次在服务端不存在，复测记录无法合并");
      }
      const p = item.payload;
      const fvId: ID = p.formulaVersionId;
      const valid = fvId === b.currentFormulaVersionId;
      const retest: Retest = {
        id: p.retestId ?? uid(),
        formulaVersionId: fvId,
        deltaE: Number(p.deltaE),
        note: p.note ?? "",
        recordedAt: now(),
        source: "local",
        valid,
      };
      let nb: Batch = {
        ...b,
        retests: [...b.retests.filter((r) => r.id !== retest.id), retest],
      };
      const vl = versionLabel(nb, fvId);
      nb.history = [
        ...nb.history,
        valid
          ? hist("retest_recorded", `复测色差 ΔE ${retest.deltaE}（配方版本 ${vl}）`)
          : hist("invalidated", `复测色差 ΔE ${retest.deltaE} 基于旧配方版本 ${vl}，已失效，请重新复测`),
        hist("merge_success", "复测记录已按版本合并"),
      ];
      return { item: null, batches: { ...batches, [nb.id]: nb } };
    }

    case "review_add": {
      const b = batches[item.batchId];
      if (!b) {
        return fail(item, batches, "批次在服务端不存在，评审记录无法合并");
      }
      // 已确认评审受保护：他处已存在确认评审时，离线评审不得覆盖
      const confirmed = b.reviews.filter((r) => r.confirmed && r.valid);
      if (confirmed.length > 0) {
        const current = confirmed[confirmed.length - 1];
        const diffs: DiffEntry[] = [
          {
            field: "result",
            label: "评审结果",
            local: REVIEW_RESULT_LABEL[item.payload.result as ReviewResult],
            remote: REVIEW_RESULT_LABEL[current.result],
          },
        ];
        return {
          item: {
            ...item,
            status: "conflict",
            attempts: item.attempts + 1,
            lastTriedAt: now(),
            conflict: {
              diffs,
              protectedReview: true,
              remoteUpdatedAt: b.updatedAt,
            },
          },
          batches,
        };
      }
      const p = item.payload;
      const result = p.result as ReviewResult;
      const fvId: ID = p.formulaVersionId;
      const valid = fvId === b.currentFormulaVersionId;
      const review: Review = {
        id: p.reviewId ?? uid(),
        formulaVersionId: fvId,
        result,
        confirmed: false,
        recordedAt: now(),
        source: "local",
        valid,
      };
      let nb: Batch = {
        ...b,
        reviews: [...b.reviews.filter((r) => r.id !== review.id), review],
      };
      const vl = versionLabel(nb, fvId);
      nb.history = [
        ...nb.history,
        hist("review_recorded", `评审结果：${REVIEW_RESULT_LABEL[result]}（配方版本 ${vl}）`),
        ...(valid
          ? []
          : [
              hist(
                "invalidated",
                `评审（${REVIEW_RESULT_LABEL[result]}）基于旧配方版本 ${vl}，已失效，需重新确认`,
              ),
            ]),
        hist("merge_success", "评审记录已按版本合并"),
      ];
      return { item: null, batches: { ...batches, [nb.id]: nb } };
    }

    case "review_confirm": {
      const b = batches[item.batchId];
      if (!b) {
        return fail(item, batches, "批次在服务端不存在，评审确认无法合并");
      }
      const p = item.payload;
      if (p.formulaVersionId !== b.currentFormulaVersionId) {
        return fail(
          item,
          batches,
          "评审基于旧配方版本已失效；请在新配方版本下重新记录评审并确认",
        );
      }
      const target = b.reviews.find((r) => r.id === p.reviewId);
      if (!target) {
        return fail(item, batches, "待确认的评审记录不存在，可能已被他处更新");
      }
      if (target.confirmed) {
        return fail(item, batches, "该评审已确认，无需重复确认");
      }
      const others = b.reviews.filter((r) => r.confirmed && r.valid && r.id !== target.id);
      if (others.length > 0) {
        return {
          item: {
            ...item,
            status: "conflict",
            attempts: item.attempts + 1,
            lastTriedAt: now(),
            conflict: {
              diffs: [
                {
                  field: "result",
                  label: "评审结果",
                  local: REVIEW_RESULT_LABEL[target.result],
                  remote: REVIEW_RESULT_LABEL[others[others.length - 1].result],
                },
              ],
              protectedReview: true,
              remoteUpdatedAt: b.updatedAt,
            },
          },
          batches,
        };
      }
      const reviews = b.reviews.map((r) =>
        r.id === target.id
          ? { ...r, confirmed: true, confirmedAt: now(), pendingConfirm: false, pendingOutboxId: undefined }
          : r,
      );
      let nb: Batch = { ...b, reviews, updatedAt: now() };
      nb.history = [
        ...nb.history,
        hist(
          "review_confirmed",
          `评审已确认：${REVIEW_RESULT_LABEL[target.result]}（配方版本 ${versionLabel(nb, nb.currentFormulaVersionId)}）`,
        ),
        hist("merge_success", "评审确认已按版本合并"),
      ];
      return { item: null, batches: { ...batches, [nb.id]: nb } };
    }
  }
}

/** 合并全部待办项（按队列顺序逐项处理） */
export function processOutbox(
  batches: Record<ID, Batch>,
  outbox: OutboxItem[],
  opts: { simulateFail: boolean },
): { batches: Record<ID, Batch>; outbox: OutboxItem[] } {
  let bs = { ...batches };
  const items = [...outbox];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.status === "conflict") continue; // 冲突需人工解决，不自动覆盖
    if (opts.simulateFail) {
      const res = fail(item, bs, "模拟服务端不可用：网络中断，待重试内容已保留");
      bs = res.batches;
      items[i] = res.item;
      continue;
    }
    const res = processOne(item, bs);
    bs = res.batches;
    if (res.item === null) {
      items.splice(i, 1);
      i--;
    } else {
      items[i] = res.item;
    }
  }
  return { batches: bs, outbox: items };
}

/** 解决冲突：保留他处（丢弃本地待办）或采用本地修订（仅非评审保护场景） */
export function resolveConflict(
  batches: Record<ID, Batch>,
  outbox: OutboxItem[],
  itemId: ID,
  action: "keep_remote" | "keep_local",
): { batches: Record<ID, Batch>; outbox: OutboxItem[] } {
  const item = outbox.find((i) => i.id === itemId);
  if (!item) return { batches, outbox };
  let bs = batches;

  if (action === "keep_local") {
    if (item.op !== "formula_update" || item.conflict?.protectedReview) {
      return { batches, outbox };
    }
    const res = processOne({ ...item, status: "pending", attempts: 0, conflict: undefined }, bs);
    bs = res.batches;
    return { batches: bs, outbox: outbox.filter((i) => i.id !== itemId) };
  }

  // keep_remote：丢弃本地待办，清理乐观更新，留痕
  const b = bs[item.batchId];
  if (b) {
    const nb = cleanupPending(b, item);
    nb.history = [
      ...nb.history,
      hist(
        "conflict_resolved",
        item.conflict?.protectedReview
          ? "他处已确认评审结果受保护，离线修订未采用，保留他处结果"
          : "已保留他处版本，离线修订丢弃",
      ),
    ];
    bs = { ...bs, [nb.id]: nb };
  } else if (item.op === "batch_create") {
    bs = Object.fromEntries(Object.entries(bs).filter(([id]) => id !== item.batchId));
  }
  return { batches: bs, outbox: outbox.filter((i) => i.id !== itemId) };
}

/** 放弃一条待重试/冲突项 */
export function discardItem(
  batches: Record<ID, Batch>,
  outbox: OutboxItem[],
  itemId: ID,
): { batches: Record<ID, Batch>; outbox: OutboxItem[] } {
  const item = outbox.find((i) => i.id === itemId);
  if (!item) return { batches, outbox };
  let bs = batches;
  const b = bs[item.batchId];
  if (b) {
    const nb = cleanupPending(b, item);
    nb.history = [...nb.history, hist("conflict_resolved", `离线待办已放弃：${item.batchCode} ${opText(item)}`)];
    bs = { ...bs, [nb.id]: nb };
  } else if (item.op === "batch_create") {
    bs = Object.fromEntries(Object.entries(bs).filter(([id]) => id !== item.batchId));
  }
  return { batches: bs, outbox: outbox.filter((i) => i.id !== itemId) };
}

function opText(item: OutboxItem): string {
  switch (item.op) {
    case "batch_create":
      return "登记批次";
    case "formula_update":
      return "配方修订";
    case "retest_add":
      return "复测色差";
    case "review_add":
      return "评审记录";
    case "review_confirm":
      return "评审确认";
  }
}

/** 清理离线乐观更新留下的 pending 数据 */
function cleanupPending(b: Batch, item: OutboxItem): Batch {
  let nb: Batch = { ...b, formulaVersions: [...b.formulaVersions], retests: [...b.retests], reviews: [...b.reviews], history: [...b.history] };
  if (item.op === "formula_update") {
    const fvId = item.payload.fvId;
    nb.formulaVersions = nb.formulaVersions.filter((v) => !(v.pending && v.id === fvId));
    if (nb.currentFormulaVersionId === fvId) {
      nb.currentFormulaVersionId = item.baseFormulaVersionId;
    }
  } else if (item.op === "retest_add") {
    nb.retests = nb.retests.filter((r) => !(r.pending && r.id === item.payload.retestId));
  } else if (item.op === "review_add") {
    nb.reviews = nb.reviews.filter((r) => !(r.pending && r.id === item.payload.reviewId));
  } else if (item.op === "review_confirm") {
    nb.reviews = nb.reviews.map((r) =>
      r.pendingOutboxId === item.id ? { ...r, pendingConfirm: false, pendingOutboxId: undefined } : r,
    );
  }
  return nb;
}

/** 模拟"送样期间他处更新"：配方变更 / 复测 / 评审确认 */
export function simulateRemoteUpdate(batches: Record<ID, Batch>): Record<ID, Batch> {
  const ids = Object.keys(batches);
  if (!ids.length) return batches;
  const id = ids[Math.floor(Math.random() * ids.length)];
  const b = batches[id];
  const action = Math.floor(Math.random() * 3);
  const history = [...b.history];
  let nb: Batch = { ...b, history };

  if (action === 0) {
    const old = b.formulaVersions.find((v) => v.id === b.currentFormulaVersionId)!;
    const fv: FormulaVersion = {
      id: uid(),
      version: nextVersion(b),
      recipe: old.recipe,
      liquorRatio: old.liquorRatio,
      tempCurve: old.tempCurve,
      holdTime: old.holdTime,
      createdAt: now(),
      source: "remote",
    };
    nb = {
      ...nb,
      formulaVersions: [...nb.formulaVersions, fv],
      currentFormulaVersionId: fv.id,
      updatedAt: now(),
    };
    nb.history.push(hist("formula_changed", `配方版本 ${old.version} → ${fv.version}（他处修订）`));
    nb = invalidate(nb, fv.id);
  } else if (action === 1) {
    const deltaE = Math.round((0.5 + Math.random() * 1.4) * 100) / 100;
    const retest: Retest = {
      id: uid(),
      formulaVersionId: b.currentFormulaVersionId,
      deltaE,
      note: "他处送样复测",
      recordedAt: now(),
      source: "remote",
      valid: true,
    };
    nb = { ...nb, retests: [...nb.retests, retest] };
    nb.history.push(hist("retest_recorded", `复测色差 ΔE ${deltaE}（他处记录）`));
  } else {
    const results: ReviewResult[] = ["passed", "rework", "confirming"];
    const result = results[Math.floor(Math.random() * results.length)];
    const review: Review = {
      id: uid(),
      formulaVersionId: b.currentFormulaVersionId,
      result,
      confirmed: true,
      recordedAt: now(),
      confirmedAt: now(),
      source: "remote",
      valid: true,
    };
    nb = { ...nb, reviews: [...nb.reviews, review], updatedAt: now() };
    nb.history.push(hist("review_recorded", `评审结果：${REVIEW_RESULT_LABEL[result]}（他处记录）`));
    nb.history.push(hist("review_confirmed", `评审已确认：${REVIEW_RESULT_LABEL[result]}（他处确认）`));
  }
  return { ...batches, [id]: nb };
}
