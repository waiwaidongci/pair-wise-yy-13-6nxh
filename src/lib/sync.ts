// 网络恢复后的合并流水线（纯异步函数，不依赖 React，便于测试与复用）
//
// 处理顺序：
// 1. 逐批次与远端对账：配方版本不同 → 旧复测/旧评审立即失效（结论留痕保留）
// 2. 逐项消费队列：
//    - 登记：远端不存在则上送新建；两边都改过则列清差异，裁决后才合并
//    - 复测：版本对不上立即失效待重新确认；Lab 分量两边都改则逐项裁决
//    - 任何一步失败：该待办原样保留（failed），继续处理其他待办
// 3. 已确认的客户评审（valid）在任何合并中都受保护，不被覆盖

import {
  Batch,
  BatchField,
  BatchLog,
  ConflictResolution,
  LabColor,
  LabState,
  PendingOp,
  RetestPart,
} from "../types";
import {
  applyRegistration,
  applyRetest,
  detectRegistrationMerges,
  log,
  reconcileAfterPull,
  retestConflicts,
} from "./engine";
import {
  commitBatch,
  commitFields,
  commitRetest,
} from "./server";

export interface SyncOutcome {
  batches: Batch[];
  queue: PendingOp[];
  notice: string;
}

/** 合并服务端批次更新：保留本地尚未上送的处理日志 */
export function mergeServerBatch(local: Batch, server: Batch): Batch {
  return {
    ...server,
    localOnly: server.localOnly ?? local.localOnly,
    logs: [
      ...local.logs,
      ...server.logs.filter(
        (sl) => !local.logs.some((ll) => ll.at === sl.at && ll.message === sl.message)
      ),
    ],
  };
}

export async function runSyncPipeline(
  snapshot: LabState,
  remoteAll: Batch[]
): Promise<SyncOutcome> {
  // 1) 逐批次对账：版本变更立即失效旧复测/旧评审
  let batches: Batch[] = snapshot.batches.map((b) => {
    const remote = remoteAll.find((r) => r.id === b.id);
    return remote ? reconcileAfterPull(b, remote) : b;
  });
  let queue: PendingOp[] = snapshot.queue.map((op) =>
    op.status === "failed" ? { ...op, status: "queued" } : op
  );

  const attachLog = (batchId: string, entry: BatchLog) => {
    batches = batches.map((b) => (b.id === batchId ? { ...b, logs: [...b.logs, entry] } : b));
  };
  const replaceBatch = (batchId: string, next: Batch) => {
    batches = batches.map((b) => (b.id === batchId ? next : b));
  };
  const setOp = (opId: string, patch: Partial<PendingOp>) => {
    queue = queue.map((o) => (o.opId === opId ? { ...o, ...patch } : o));
  };

  // 2) 逐项处理队列
  for (const op of queue) {
    if (op.status !== "queued") continue;
    const remote = remoteAll.find((r) => r.id === op.batchId);

    // ---------- 登记 ----------
    if (op.type === "registration") {
      const draft = op.draft!;

      if (!remote) {
        try {
          const local = batches.find((b) => b.id === op.batchId)!;
          const saved = await commitBatch(local);
          replaceBatch(op.batchId, mergeServerBatch(local, saved));
          setOp(op.opId, { status: "applied", attempts: op.attempts + 1 });
        } catch (e) {
          setOp(op.opId, {
            status: "failed",
            attempts: op.attempts + 1,
            lastError: (e as Error).message,
          });
          attachLog(op.batchId, log("error", `登记上送失败：${(e as Error).message}；登记内容完整保留待重试`));
        }
        continue;
      }

      const plan = detectRegistrationMerges(draft, remote, op.registrationBase);
      const base = op.registrationBase;
      const decided = { ...(op.conflict?.resolution ?? {}) } as ConflictResolution<
        BatchField | RetestPart
      >;
      const unresolved = plan.conflicts.filter((f) => decided[f] === undefined);

      if (unresolved.length > 0) {
        setOp(op.opId, {
          status: "conflict",
          conflict: { kind: "registration", fields: plan.conflicts, base, resolution: decided },
        });
        attachLog(
          op.batchId,
          log(
            "conflict",
            `同一批次两边都改过，${plan.conflicts.length} 项存在差异（${plan.conflicts.join("、")}）：已列清离线登记值与服务端值，等待逐项裁决，不自动覆盖` +
              (plan.diffs.length > plan.conflicts.length
                ? `；另有 ${plan.diffs.length - plan.conflicts.length} 项仅一边修改，将自动按修改方合并`
                : "") +
              (remote.review?.valid
                ? "；服务端已有确认的客户评审结果，已加保护，任何取值都不会盖掉评审"
                : "")
          )
        );
        continue;
      }

      try {
        const reconciled = batches.find((b) => b.id === op.batchId)!;
        const merged0 = applyRegistration(
          reconciled,
          draft,
          plan.conflicts.length || base
            ? { kind: "registration", fields: plan.conflicts, base, resolution: decided }
            : undefined
        );
        const saved = await commitFields(op.batchId, {
          customerOrder: merged0.customerOrder,
          fabric: merged0.fabric,
          weight: merged0.weight,
          recipe: merged0.recipe,
          tempCurve: merged0.tempCurve,
          holdMinutes: merged0.holdMinutes,
          finishing: merged0.finishing,
          standardLab: merged0.standardLab,
          recipeVersion: merged0.recipeVersion,
        });
        // 评审保护：已确认（valid）的客户评审绝不随字段合并被盖掉
        let next = mergeServerBatch(merged0, saved);
        if (reconciled.review?.valid) {
          next = { ...next, review: reconciled.review };
        }
        replaceBatch(op.batchId, next);
        setOp(op.opId, { status: "applied", attempts: op.attempts + 1, conflict: undefined });
      } catch (e) {
        setOp(op.opId, {
          status: "failed",
          attempts: op.attempts + 1,
          lastError: (e as Error).message,
        });
        attachLog(op.batchId, log("error", `登记合并失败：${(e as Error).message}；草稿与裁决均保留，可重试`));
      }
      continue;
    }

    // ---------- 复测 ----------
    if (!remote) {
      setOp(op.opId, { status: "failed", lastError: "服务端不存在该批次" });
      attachLog(op.batchId, log("error", "复测合并失败：服务端不存在该批次；复测内容保留待重试"));
      continue;
    }

    const payload = op.payload!;

    // 配方版本一变：离线复测立即失效，需基于新版本重新复测确认
    if (payload.base.recipeVersion !== remote.recipeVersion) {
      setOp(op.opId, { status: "stale" });
      const current = batches.find((b) => b.id === op.batchId)!;
      replaceBatch(op.batchId, {
        ...current,
        retest: current.retest ? { ...current.retest, valid: false } : current.retest,
        logs: [
          ...current.logs,
          log(
            "conflict",
            `离线复测基于配方 v${payload.base.recipeVersion}，服务端已更新为 v${remote.recipeVersion}：复测立即失效，需按新版本重新复测确认（原测量值保留备查）`
          ),
        ],
      });
      continue;
    }

    const fields = retestConflicts(payload, remote);
    const decided = { ...(op.conflict?.resolution ?? {}) } as ConflictResolution<
      BatchField | RetestPart
    >;
    const unresolved = fields.filter((f) => decided[f] === undefined);
    if (unresolved.length > 0) {
      setOp(op.opId, {
        status: "conflict",
        conflict: { kind: "retest", fields, resolution: decided },
      });
      attachLog(
        op.batchId,
        log(
          "conflict",
          `复测色差两边都更新过，差异分量：${fields.join("、")}；已列出离线值与服务端值供逐项裁决，ΔE 将按裁决结果重算`
        )
      );
      continue;
    }

    try {
      const measured: LabColor = {
        L: decided.L === "remote" ? remote.retest!.measured.L : payload.measured.L,
        a: decided.a === "remote" ? remote.retest!.measured.a : payload.measured.a,
        b: decided.b === "remote" ? remote.retest!.measured.b : payload.measured.b,
      };
      const note = decided.note === "remote" ? (remote.retest?.note ?? "") : payload.note;
      const saved = await commitRetest(op.batchId, measured, note);
      const current = batches.find((b) => b.id === op.batchId)!;
      const merged = mergeServerBatch(current, saved);
      const { batch: withMergeLog } = applyRetest(
        merged,
        payload,
        fields.length ? { kind: "retest", fields, resolution: decided } : undefined
      );
      replaceBatch(op.batchId, withMergeLog);
      setOp(op.opId, { status: "applied", attempts: op.attempts + 1, conflict: undefined });
    } catch (e) {
      setOp(op.opId, {
        status: "failed",
        attempts: op.attempts + 1,
        lastError: (e as Error).message,
      });
      attachLog(op.batchId, log("error", `复测合并失败：${(e as Error).message}；复测内容与裁决保留，可重试`));
    }
  }

  const count = (status: PendingOp["status"]) => queue.filter((o) => o.status === status).length;
  const notice = `同步处理完成：成功 ${count("applied")} 项 · 待逐项裁决 ${count("conflict")} 项 · 版本失效待重认 ${count("stale")} 项 · 失败保留待重试 ${count("failed")} 项`;
  return { batches, queue, notice };
}
