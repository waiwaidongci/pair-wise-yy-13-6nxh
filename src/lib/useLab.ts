import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Batch,
  BatchField,
  ConflictResolution,
  LabColor,
  LabState,
  PendingOp,
  RegistrationDraft,
  RetestPart,
  ReviewResult,
} from "../types";
import { deltaE, log, now } from "./engine";
import { mergeServerBatch, runSyncPipeline } from "./sync";
import {
  commitReview,
  faultScheduled,
  fetchBatches,
  resetServer,
  reviseRecipe,
  setFaultOnce,
} from "./server";

const LOCAL_KEY = "dye-lab-local-v1";

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadInitial(): LabState {
  const raw = localStorage.getItem(LOCAL_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as LabState;
    } catch {
      // fall through, reseed
    }
  }
  return { batches: [], queue: [], online: navigator.onLine, faultNext: false };
}

export function useLab() {
  const [state, setState] = useState<LabState>(loadInitial);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string>("");
  // 入队即请求合并：effect 在渲染提交后运行，确保 runSync 读到含新待办的最新状态
  const [syncTick, setSyncTick] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const { batches, queue, online } = state;

  // 首次进入：本地为空则拉取服务端种子批次
  useEffect(() => {
    if (stateRef.current.batches.length === 0 && stateRef.current.queue.length === 0) {
      fetchBatches()
        .then((remote) =>
          setState((s) => (s.batches.length === 0 ? { ...s, batches: remote } : s))
        )
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    const on = () => setState((s) => ({ ...s, online: true }));
    const off = () => setState((s) => ({ ...s, online: false }));
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const setOnline = useCallback((value: boolean) => {
    setState((s) => ({ ...s, online: value }));
    setNotice(
      value
        ? "网络已恢复：将拉取别处更新，并按配方版本逐项合并离线待办"
        : "已切换为离线模式：批次登记与复测色差将暂存，恢复网络后逐项合并"
    );
  }, []);

  const setFault = useCallback((value: boolean) => {
    setFaultOnce(value);
    setState((s) => ({ ...s, faultNext: value }));
  }, []);

  // ---------- 登记批次（离线暂存 + 本地投影） ----------

  const registerBatch = useCallback((draft: RegistrationDraft & { id: string }) => {
    const { id, ...rest } = draft;
    const t = now();
    // 若该批次已存在（对已有批次的离线补登记/修改），记下三方合并基准
    const existing = stateRef.current.batches.find((b) => b.id === id);
    const base: PendingOp["registrationBase"] = existing
      ? {
          customerOrder: existing.customerOrder,
          fabric: existing.fabric,
          weight: existing.weight,
          recipe: existing.recipe,
          tempCurve: existing.tempCurve,
          holdMinutes: existing.holdMinutes,
          finishing: existing.finishing,
          standardLab: existing.standardLab,
          recipeVersion: existing.recipeVersion,
        }
      : undefined;
    const batch: Batch = {
      id,
      ...rest,
      recipeUpdatedAt: t,
      localOnly: !existing || existing.localOnly,
      createdAt: existing?.createdAt ?? t,
      logs: [
        ...(existing?.logs ?? []),
        log(
          "offline",
          `登记批次（配方 v${rest.recipeVersion}）：面料 ${rest.fabric}、克重 ${rest.weight}；${stateRef.current.online ? "在线提交，按版本逐项合并" : "断网暂存，恢复网络后按版本逐项合并"}`
        ),
      ],
    };
    const op: PendingOp = {
      opId: uid("op"),
      batchId: id,
      type: "registration",
      createdAt: t,
      attempts: 0,
      draft: rest,
      registrationBase: base,
      status: "queued",
    };
    setState((s) => ({
      ...s,
      batches: [batch, ...s.batches.filter((b) => b.id !== id)],
      queue: [...s.queue, op],
    }));
    setNotice(
      stateRef.current.online
        ? "已登记，正在上送合并…"
        : "断网状态：批次已暂存，恢复网络后按配方版本逐项合并"
    );
    if (stateRef.current.online) setSyncTick((v) => v + 1);
  }, []);

  // ---------- 离线/在线复测（色差暂存 + 本地投影） ----------

  const addRetest = useCallback((batchId: string, measured: LabColor, note: string) => {
    const target = stateRef.current.batches.find((b) => b.id === batchId);
    if (!target) return;
    const t = now();
    const op: PendingOp = {
      opId: uid("op"),
      batchId,
      type: "retest",
      createdAt: t,
      attempts: 0,
      payload: {
        measured,
        note,
        base: { recipeVersion: target.recipeVersion, retest: target.retest },
      },
      status: "queued",
    };
    const retest = {
      measured,
      deltaE: deltaE(measured, target.standardLab),
      note,
      at: t,
      recipeVersion: target.recipeVersion,
      valid: true,
    };
    setState((s) => ({
      ...s,
      batches: s.batches.map((b) =>
        b.id === batchId
          ? {
              ...b,
              retest,
              logs: [
                ...b.logs,
                log(
                  "offline",
                  `记录复测色差 ΔE ${retest.deltaE}（配方 v${target.recipeVersion}）：${s.online ? "在线上送" : "断网暂存，待恢复后合并"}`
                ),
              ],
            }
          : b
      ),
      queue: [...s.queue, op],
    }));
    setNotice(
      stateRef.current.online
        ? "复测结果正在上送…"
        : "断网状态：复测色差已暂存，恢复网络后按版本合并"
    );
    if (stateRef.current.online) setSyncTick((v) => v + 1);
  }, []);

  // ---------- 冲突逐项裁决 ----------

  const resolveConflict = useCallback(
    (opId: string, resolution: ConflictResolution<BatchField | RetestPart>) => {
      setState((s) => ({
        ...s,
        queue: s.queue.map((op) => {
          if (op.opId !== opId || !op.conflict) return op;
          const mergedResolution = { ...op.conflict.resolution, ...resolution };
          const allDecided = op.conflict.fields.every((f) => mergedResolution[f] !== undefined);
          return {
            ...op,
            conflict: { ...op.conflict, resolution: mergedResolution },
            status: allDecided && op.status === "conflict" ? "queued" : op.status,
          };
        }),
      }));
      setNotice("差异裁决已记录，可执行合并");
    },
    []
  );

  const resolveAll = useCallback((opId: string, side: "local" | "remote") => {
    setState((s) => ({
      ...s,
      queue: s.queue.map((op) => {
        if (op.opId !== opId || !op.conflict) return op;
        const resolution: ConflictResolution<BatchField | RetestPart> = {};
        op.conflict.fields.forEach((f) => (resolution[f] = side));
        return { ...op, status: "queued", conflict: { ...op.conflict, resolution } };
      }),
    }));
    setNotice(side === "local" ? "全部差异取离线所记，待执行合并" : "全部差异保留服务端值，待执行合并");
  }, []);

  // ---------- 版本失效后基于新版本重新复测 ----------

  const rebaseRetest = useCallback((opId: string, measured: LabColor, note: string) => {
    const old = stateRef.current.queue.find((o) => o.opId === opId);
    if (!old) return;
    const target = stateRef.current.batches.find((b) => b.id === old.batchId);
    if (!target) return;
    const t = now();
    const op: PendingOp = {
      opId: uid("op"),
      batchId: target.id,
      type: "retest",
      createdAt: t,
      attempts: 0,
      payload: {
        measured,
        note,
        base: { recipeVersion: target.recipeVersion, retest: target.retest },
      },
      status: "queued",
    };
    setState((s) => ({
      ...s,
      batches: s.batches.map((b) =>
        b.id === target.id
          ? {
              ...b,
              retest: {
                measured,
                deltaE: deltaE(measured, target.standardLab),
                note,
                at: t,
                recipeVersion: target.recipeVersion,
                valid: true,
              },
              logs: [
                ...b.logs,
                log(
                  "offline",
                  `已按最新配方 v${target.recipeVersion} 重新复测确认，ΔE ${deltaE(measured, target.standardLab)}；旧版本待办作废`
                ),
              ],
            }
          : b
      ),
      queue: [...s.queue.filter((o) => o.opId !== opId), op],
    }));
    setNotice("已基于新版本重新复测，新待办将参与合并");
    if (stateRef.current.online) setSyncTick((v) => v + 1);
  }, []);

  const discardOp = useCallback((opId: string) => {
    setState((s) => {
      const op = s.queue.find((o) => o.opId === opId);
      if (!op) return s;
      const batches = s.batches.map((b) => {
        if (b.id !== op.batchId) return b;
        const message =
          op.type === "registration"
            ? "离线登记内容已手动放弃合并（本地记录留存备查）"
            : "离线复测已手动放弃合并，保留服务端当前的复测/评审状态";
        return { ...b, logs: [...b.logs, log("sync", message)] };
      });
      return {
        ...s,
        // 放弃纯本地、从未上送成功的登记时，批次一并从列表移除
        batches:
          op.type === "registration" && op.status !== "applied"
            ? batches.filter((b) => !(b.id === op.batchId && b.localOnly))
            : batches,
        queue: s.queue.filter((o) => o.opId !== opId),
      };
    });
  }, []);

  const retryOp = useCallback((opId: string) => {
    if (!stateRef.current.online) {
      setNotice("仍处于离线状态，失败内容已保留，网络恢复后自动重试");
      return;
    }
    setState((s) => ({
      ...s,
      queue: s.queue.map((o) =>
        o.opId === opId && o.status === "failed"
          ? { ...o, status: "queued", lastError: undefined }
          : o
      ),
    }));
    setNotice("失败内容已重新排入队列，开始重试…");
    setSyncTick((v) => v + 1);
  }, []);

  const clearApplied = useCallback(() => {
    setState((s) => ({ ...s, queue: s.queue.filter((o) => o.status !== "applied") }));
  }, []);

  // ---------- 在线客户评审（确认后受保护） ----------

  const submitReview = useCallback(
    async (batchId: string, result: ReviewResult, comment: string, by: string) => {
      if (!stateRef.current.online) {
        setNotice("当前离线：客户评审需在线提交，以免覆盖别处已确认的结论");
        return;
      }
      try {
        const updated = await commitReview(batchId, result, comment, by);
        setState((s) => ({
          ...s,
          batches: s.batches.map((b) => (b.id === batchId ? mergeServerBatch(b, updated) : b)),
        }));
        setNotice("客户评审已提交并锁定，后续任何逐项合并都不会盖掉该结果");
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    []
  );

  // ---------- "别处"修订配方（模拟另一台终端/系统） ----------

  const remoteRevise = useCallback(
    async (batchId: string, recipe: Batch["recipe"], tempCurve: string, by: string) => {
      try {
        const updated = await reviseRecipe(batchId, recipe, tempCurve, by);
        setState((s) => ({
          ...s,
          batches: s.online
            ? s.batches.map((b) => (b.id === batchId ? mergeServerBatch(b, updated) : b))
            : // 离线期间本地不可见，恢复网络拉取时再对账失效
              s.batches,
        }));
        setNotice(
          stateRef.current.online
            ? `配方已修订至 v${updated.recipeVersion}：复测与评审立即失效，需重新确认`
            : `"别处"已修订配方（当前离线不可见），恢复网络后将触发版本失效与差异对账`
        );
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    []
  );

  // ---------- 核心：网络恢复后的合并流水线 ----------

  const runSync = useCallback(async () => {
    const snapshot = stateRef.current;
    if (!snapshot.online) {
      setNotice("仍处于离线状态，待办已保留，恢复网络后自动合并");
      return;
    }
    setSyncing(true);
    try {
      const remoteAll = await fetchBatches();
      const outcome = await runSyncPipeline(snapshot, remoteAll);
      setState((s) => ({ ...s, batches: outcome.batches, queue: outcome.queue, faultNext: faultScheduled() }));
      setNotice(outcome.notice);
    } catch (e) {
      // 拉取阶段就失败：在途待办原样保留为 failed，处理过程写入批次
      const msg = (e as Error).message;
      setState((s) => ({
        ...s,
        faultNext: faultScheduled(),
        queue: s.queue.map((o) =>
          o.status === "queued" || o.status === "failed"
            ? { ...o, status: "failed", attempts: o.attempts + 1, lastError: msg }
            : o
        ),
        batches: s.batches.map((b) =>
          s.queue.some((o) => o.batchId === b.id && (o.status === "queued" || o.status === "failed"))
            ? { ...b, logs: [...b.logs, log("error", `同步失败：${msg}；待办内容完整保留，可重试`)] }
            : b
        ),
      }));
      setNotice(`同步失败：${msg}。离线内容已保留，网络恢复后可重试`);
    } finally {
      setSyncing(false);
    }
  }, []);

  // 网络恢复或新待办入队时自动触发合并（effect 在状态提交后运行，读到的是最新队列）
  useEffect(() => {
    if (
      syncTick >= 0 &&
      stateRef.current.online &&
      stateRef.current.queue.some(
        (o) => o.status === "queued" || o.status === "failed"
      )
    ) {
      void runSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, syncTick]);

  const resetAll = useCallback(() => {
    const seed = resetServer();
    setState({ batches: seed, queue: [], online: true, faultNext: false });
    setNotice("已重置为演示初始数据");
  }, []);

  const stats = useMemo(() => {
    return {
      total: batches.length,
      pending: queue.filter((o) => o.status !== "applied").length,
      conflict: queue.filter((o) => o.status === "conflict").length,
      stale: queue.filter((o) => o.status === "stale").length,
      failed: queue.filter((o) => o.status === "failed").length,
      overLimit: batches.filter((b) => b.retest?.valid && b.retest.deltaE > 1.5).length,
      orders: new Set(batches.map((b) => b.customerOrder)).size,
    };
  }, [batches, queue]);

  return {
    batches,
    queue,
    online,
    syncing,
    notice,
    stats,
    faultNext: state.faultNext,
    setOnline,
    setFault,
    registerBatch,
    addRetest,
    resolveConflict,
    resolveAll,
    rebaseRetest,
    discardOp,
    retryOp,
    clearApplied,
    submitReview,
    remoteRevise,
    runSync,
    resetAll,
    setNotice,
  };
}

export type LabApi = ReturnType<typeof useLab>;
