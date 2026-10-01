// 染整小样离线续办 —— 状态管理
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Batch,
  BatchFormData,
  FormulaFormData,
  ID,
  OutboxItem,
  Retest,
  Review,
} from "./types";
import { REVIEW_RESULT_LABEL } from "./types";
import { loadBatches, loadOutbox, now, saveBatches, saveOutbox, uid } from "./store";
import { discardItem, nextVersion, processOutbox, resolveConflict, simulateRemoteUpdate } from "./sync";

export type Notice = { type: "ok" | "warn" | "err"; text: string } | null;

export function useDyeLab() {
  const [batches, setBatches] = useState<Record<ID, Batch>>(() => loadBatches());
  const [outbox, setOutbox] = useState<OutboxItem[]>(() => loadOutbox());
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [forceOffline, setForceOffline] = useState(false);
  const [simulateFail, setSimulateFail] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const isOnline = !forceOffline && online;

  useEffect(() => {
    saveBatches(batches);
  }, [batches]);
  useEffect(() => {
    saveOutbox(outbox);
  }, [outbox]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const runSync = useCallback(
    (bs: Record<ID, Batch>, items: OutboxItem[]) => {
      if (forceOffline || !online) return;
      setSyncing(true);
      // 让同步状态渲染一帧
      window.setTimeout(() => {
        const res = processOutbox(bs, items, { simulateFail });
        setBatches(res.batches);
        setOutbox(res.outbox);
        setSyncing(false);
        const conflicts = res.outbox.filter((i) => i.status === "conflict");
        const failed = res.outbox.filter((i) => i.status === "failed");
        if (conflicts.length || failed.length) {
          setNotice({
            type: "warn",
            text: `同步完成：${conflicts.length} 项冲突待处理，${failed.length} 项失败已保留待重试。`,
          });
        } else {
          setNotice({ type: "ok", text: "离线续办已全部按版本逐项合并完成。" });
        }
      }, 350);
    },
    [forceOffline, online, simulateFail],
  );

  const syncNow = useCallback(() => {
    if (forceOffline || !online) {
      setNotice({ type: "warn", text: "当前处于离线状态，续办内容已暂存本机，联网后将自动合并。" });
      return;
    }
    runSync(batches, outbox);
  }, [forceOffline, online, batches, outbox, runSync]);

  // 联网瞬间自动续办
  const prevOnline = useRef(isOnline);
  useEffect(() => {
    if (isOnline && !prevOnline.current) {
      runSync(batches, outbox);
    }
    prevOnline.current = isOnline;
  }, [isOnline, batches, outbox, runSync]);

  const addBatch = useCallback(
    (data: BatchFormData) => {
      const id = uid();
      const fvId = uid();
      const t = now();
      const item: OutboxItem = {
        id: uid(),
        op: "batch_create",
        batchId: id,
        batchCode: data.code,
        status: "pending",
        attempts: 0,
        queuedAt: t,
        baseUpdatedAt: 0,
        baseFormulaVersionId: "",
        payload: { id, fvId, ...data },
      };
      const provisional: Batch = {
        id,
        code: data.code,
        fabric: data.fabric,
        grams: data.grams,
        finish: data.finish,
        orderNo: data.orderNo,
        currentFormulaVersionId: fvId,
        formulaVersions: [
          {
            id: fvId,
            version: "v1.0",
            recipe: data.recipe,
            liquorRatio: data.liquorRatio,
            tempCurve: data.tempCurve,
            holdTime: data.holdTime,
            createdAt: t,
            source: "local",
            pending: !isOnline,
          },
        ],
        retests: [],
        reviews: [],
        createdAt: t,
        updatedAt: t,
        pending: !isOnline,
        history: [
          { id: uid(), at: t, kind: "batch_created", detail: `批次 ${data.code} 登记（${data.fabric}）` },
          { id: uid(), at: t, kind: "formula_changed", detail: "配方版本 v1.0 建立" },
          ...(isOnline
            ? []
            : [
                {
                  id: uid(),
                  at: t,
                  kind: "queued" as const,
                  detail: "已离线暂存，联网后自动按版本合并",
                },
              ]),
        ],
      };
      const newBatches = { ...batches, [id]: provisional };
      const newOutbox = [...outbox, item];
      setBatches(newBatches);
      setOutbox(newOutbox);
      if (isOnline) runSync(newBatches, newOutbox);
      else setNotice({ type: "warn", text: `批次 ${data.code} 已离线登记并暂存，联网后自动合并。` });
    },
    [batches, outbox, isOnline, runSync],
  );

  const updateFormula = useCallback(
    (batchId: ID, data: FormulaFormData) => {
      const b = batches[batchId];
      if (!b) return;
      const fvId = uid();
      const version = nextVersion(b);
      const t = now();
      const item: OutboxItem = {
        id: uid(),
        op: "formula_update",
        batchId,
        batchCode: b.code,
        status: "pending",
        attempts: 0,
        queuedAt: t,
        baseUpdatedAt: b.updatedAt,
        baseFormulaVersionId: b.currentFormulaVersionId,
        payload: { fvId, version, ...data },
      };
      const fv = {
        id: fvId,
        version,
        recipe: data.recipe,
        liquorRatio: data.liquorRatio,
        tempCurve: data.tempCurve,
        holdTime: data.holdTime,
        createdAt: t,
        source: "local" as const,
        pending: !isOnline,
      };
      let nb: Batch = {
        ...b,
        formulaVersions: [...b.formulaVersions, fv],
        currentFormulaVersionId: fvId,
      };
      nb.history = [
        ...b.history,
        { id: uid(), at: t, kind: "formula_changed", detail: `配方版本 ${version} 已修订（待联网合并）` },
        ...(isOnline
          ? []
          : [{ id: uid(), at: t, kind: "queued" as const, detail: "已离线暂存，联网后按版本逐项合并" }]),
      ];
      const newBatches = { ...batches, [batchId]: nb };
      const newOutbox = [...outbox, item];
      setBatches(newBatches);
      setOutbox(newOutbox);
      if (isOnline) runSync(newBatches, newOutbox);
      else setNotice({ type: "warn", text: `配方版本 ${version} 已离线修订；合并后复测与评审将自动失效，需重新确认。` });
    },
    [batches, outbox, isOnline, runSync],
  );

  const addRetest = useCallback(
    (batchId: ID, data: { deltaE: number; note: string }) => {
      const b = batches[batchId];
      if (!b) return;
      const retestId = uid();
      const t = now();
      const item: OutboxItem = {
        id: uid(),
        op: "retest_add",
        batchId,
        batchCode: b.code,
        status: "pending",
        attempts: 0,
        queuedAt: t,
        baseUpdatedAt: b.updatedAt,
        baseFormulaVersionId: b.currentFormulaVersionId,
        payload: { retestId, formulaVersionId: b.currentFormulaVersionId, deltaE: data.deltaE, note: data.note },
      };
      const retest: Retest = {
        id: retestId,
        formulaVersionId: b.currentFormulaVersionId,
        deltaE: data.deltaE,
        note: data.note,
        recordedAt: t,
        source: "local",
        valid: true,
        pending: !isOnline,
        pendingOutboxId: isOnline ? undefined : item.id,
      };
      const nb: Batch = {
        ...b,
        retests: [...b.retests, retest],
        history: [
          ...b.history,
          ...(isOnline
            ? []
            : [
                {
                  id: uid(),
                  at: t,
                  kind: "queued" as const,
                  detail: `复测色差 ΔE ${data.deltaE} 已离线暂存，联网后按版本合并`,
                },
              ]),
        ],
      };
      const newBatches = { ...batches, [batchId]: nb };
      const newOutbox = [...outbox, item];
      setBatches(newBatches);
      setOutbox(newOutbox);
      if (isOnline) runSync(newBatches, newOutbox);
      else setNotice({ type: "warn", text: "复测色差已离线暂存，联网后自动按版本合并。" });
    },
    [batches, outbox, isOnline, runSync],
  );

  const addReview = useCallback(
    (batchId: ID, result: Review["result"]) => {
      const b = batches[batchId];
      if (!b) return;
      const reviewId = uid();
      const t = now();
      const item: OutboxItem = {
        id: uid(),
        op: "review_add",
        batchId,
        batchCode: b.code,
        status: "pending",
        attempts: 0,
        queuedAt: t,
        baseUpdatedAt: b.updatedAt,
        baseFormulaVersionId: b.currentFormulaVersionId,
        payload: { reviewId, formulaVersionId: b.currentFormulaVersionId, result },
      };
      const review: Review = {
        id: reviewId,
        formulaVersionId: b.currentFormulaVersionId,
        result,
        confirmed: false,
        recordedAt: t,
        source: "local",
        valid: true,
        pending: !isOnline,
        pendingOutboxId: isOnline ? undefined : item.id,
      };
      const nb: Batch = {
        ...b,
        reviews: [...b.reviews, review],
        history: [
          ...b.history,
          ...(isOnline
            ? []
            : [
                {
                  id: uid(),
                  at: t,
                  kind: "queued" as const,
                  detail: `评审结果「${REVIEW_RESULT_LABEL[result]}」已离线暂存，联网后按版本合并`,
                },
              ]),
        ],
      };
      const newBatches = { ...batches, [batchId]: nb };
      const newOutbox = [...outbox, item];
      setBatches(newBatches);
      setOutbox(newOutbox);
      if (isOnline) runSync(newBatches, newOutbox);
      else setNotice({ type: "warn", text: "评审结果已离线暂存，联网后自动按版本合并。" });
    },
    [batches, outbox, isOnline, runSync],
  );

  const confirmReview = useCallback(
    (batchId: ID, reviewId: ID) => {
      const b = batches[batchId];
      if (!b) return;
      const review = b.reviews.find((r) => r.id === reviewId);
      if (!review) return;
      if (review.formulaVersionId !== b.currentFormulaVersionId) {
        setNotice({ type: "err", text: "该评审基于旧配方版本已失效，请在新配方版本下重新记录评审并确认。" });
        return;
      }
      if (review.confirmed) {
        setNotice({ type: "warn", text: "该评审已确认，无需重复操作。" });
        return;
      }
      const t = now();
      const item: OutboxItem = {
        id: uid(),
        op: "review_confirm",
        batchId,
        batchCode: b.code,
        status: "pending",
        attempts: 0,
        queuedAt: t,
        baseUpdatedAt: b.updatedAt,
        baseFormulaVersionId: b.currentFormulaVersionId,
        payload: { reviewId, formulaVersionId: b.currentFormulaVersionId },
      };
      const nb: Batch = {
        ...b,
        reviews: b.reviews.map((r) =>
          r.id === reviewId
            ? { ...r, pendingConfirm: !isOnline, pendingOutboxId: isOnline ? undefined : item.id }
            : r,
        ),
        history: [
          ...b.history,
          ...(isOnline
            ? []
            : [
                {
                  id: uid(),
                  at: t,
                  kind: "queued" as const,
                  detail: `评审确认「${REVIEW_RESULT_LABEL[review.result]}」已离线暂存，联网后合并`,
                },
              ]),
        ],
      };
      const newBatches = { ...batches, [batchId]: nb };
      const newOutbox = [...outbox, item];
      setBatches(newBatches);
      setOutbox(newOutbox);
      if (isOnline) runSync(newBatches, newOutbox);
      else setNotice({ type: "warn", text: "评审确认已离线暂存，联网后自动合并。" });
    },
    [batches, outbox, isOnline, runSync],
  );

  const resolveConflictAction = useCallback(
    (itemId: ID, action: "keep_remote" | "keep_local") => {
      const res = resolveConflict(batches, outbox, itemId, action);
      setBatches(res.batches);
      setOutbox(res.outbox);
      setNotice({
        type: action === "keep_remote" ? "ok" : "warn",
        text: action === "keep_remote" ? "已保留他处版本，离线待办丢弃。" : "已采用本地修订并合并。",
      });
    },
    [batches, outbox],
  );

  const discardAction = useCallback(
    (itemId: ID) => {
      const res = discardItem(batches, outbox, itemId);
      setBatches(res.batches);
      setOutbox(res.outbox);
      setNotice({ type: "ok", text: "离线待办已放弃，处理过程已记录在批次中。" });
    },
    [batches, outbox],
  );

  const retryAction = useCallback(
    (itemId: ID) => {
      const item = outbox.find((i) => i.id === itemId);
      if (!item) return;
      const newOutbox = outbox.map((i) => (i.id === itemId ? { ...i, status: "pending" as const, error: undefined } : i));
      setOutbox(newOutbox);
      if (isOnline) {
        runSync(batches, newOutbox);
      } else {
        setNotice({ type: "warn", text: "当前离线，待重试内容已保留，联网后将自动重试合并。" });
      }
    },
    [outbox, batches, isOnline, runSync],
  );

  const simulateRemoteUpdateAction = useCallback(() => {
    setBatches((prev) => simulateRemoteUpdate(prev));
    setNotice({ type: "warn", text: "已模拟送样期间他处更新（配方/复测/评审可能已变化），请注意联网后的冲突提示。" });
  }, []);

  return {
    batches,
    outbox,
    isOnline,
    forceOffline,
    setForceOffline,
    simulateFail,
    setSimulateFail,
    syncing,
    notice,
    setNotice,
    addBatch,
    updateFormula,
    addRetest,
    addReview,
    confirmReview,
    syncNow,
    resolveConflictAction,
    discardAction,
    retryAction,
    simulateRemoteUpdateAction,
  };
}
