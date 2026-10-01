// 合并流水线集成验证：用内存版 localStorage 模拟服务端，走完整离线→恢复→冲突→失败重试流程
import {
  commitFields,
  fetchBatches,
  resetServer,
  reviseRecipe,
  setFaultOnce,
} from "../src/lib/server";
import { runSyncPipeline } from "../src/lib/sync";
import { deltaE, log, now } from "../src/lib/engine";
import type { Batch, LabState, PendingOp, RegistrationDraft } from "../src/types";

// ---- 内存 localStorage ----
const mem = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✅", msg);
  } else {
    fail++;
    console.error("  ❌", msg);
  }
}

function makeDraft(id: string, over: Partial<RegistrationDraft> = {}): RegistrationDraft & { id: string } {
  return {
    id,
    customerOrder: "PO-X 新客户",
    fabric: "棉 100%",
    weight: "120 g/m²",
    recipe: { items: [{ name: "活性红", amount: "1%" }], liquorRatio: "1:15" },
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: { L: 50, a: 10, b: -20 },
    recipeVersion: "1",
    ...over,
  };
}

function localBatchFromDraft(d: RegistrationDraft & { id: string }): Batch {
  const t = now();
  return {
    id: d.id,
    customerOrder: d.customerOrder,
    fabric: d.fabric,
    weight: d.weight,
    recipe: d.recipe,
    tempCurve: d.tempCurve,
    holdMinutes: d.holdMinutes,
    finishing: d.finishing,
    standardLab: d.standardLab,
    recipeVersion: d.recipeVersion,
    recipeUpdatedAt: t,
    localOnly: true,
    createdAt: t,
    logs: [log("offline", "离线登记")],
  };
}

function enqueue(op: PendingOp): LabState {
  return { batches: [], queue: [op], online: true, faultNext: false };
}

async function main() {
  resetServer();

  console.log("A) 离线登记新批次：故障一次 → failed 保留 → 再试成功");
  {
    const d = makeDraft("LAB-NEW1");
    const batch = localBatchFromDraft(d);
    const op: PendingOp = {
      opId: "opA",
      batchId: d.id,
      type: "registration",
      createdAt: now(),
      attempts: 0,
      draft: d,
      status: "queued",
    };
    const state: LabState = { batches: [batch], queue: [op], online: true, faultNext: false };

    const remoteOK = await fetchBatches();
    setFaultOnce(true); // 下一次请求（commitBatch）失败
    const r = await runSyncPipeline(state, remoteOK);
    const failedOp = r.queue[0];
    assert(failedOp.status === "failed", "故障时待办标记 failed 而不是丢失");
    assert(!!failedOp.lastError && failedOp.attempts === 1, "保留失败原因与尝试次数");
    const bAfterFail = r!.batches.find((b) => b.id === d.id)!;
    assert(bAfterFail.logs.some((l) => l.kind === "error"), "失败处理过程写入批次日志");

    // 恢复后重试
    const retryState: LabState = { ...r!, online: true };
    const r2 = await runSyncPipeline(retryState, await fetchBatches());
    assert(r2.queue[0].status === "applied", "重试成功后标记 applied");
    const serverBatches = await fetchBatches();
    assert(!!serverBatches.find((b) => b.id === "LAB-NEW1"), "新批次已落到服务端");
    const saved = r2.batches.find((b) => b.id === "LAB-NEW1")!;
    assert(saved.localOnly === false, "本地批次标记为已上送");
    assert(saved.logs.some((l) => l.message.includes("离线登记")), "离线处理过程保留在批次");
  }

  console.log("B) 同批次两边都改：列差异 → 逐项裁决 → 评审不被盖掉");
  {
    resetServer();
    const server0 = (await fetchBatches()).find((b) => b.id === "LAB-620A")!;

    // 离线开始时的三方基准 = server0 快照
    const base: NonNullable<PendingOp["registrationBase"]> = {
      customerOrder: server0.customerOrder,
      fabric: server0.fabric,
      weight: server0.weight,
      recipe: server0.recipe,
      tempCurve: server0.tempCurve,
      holdMinutes: server0.holdMinutes,
      finishing: server0.finishing,
      standardLab: server0.standardLab,
      recipeVersion: server0.recipeVersion,
    };

    // 离线草稿：面料与克重改了，温度曲线保持基准
    const draft = makeDraft("LAB-620A", {
      ...base,
      fabric: "棉 95% 氨纶 5%",
      weight: "125 g/m²",
    });
    const op: PendingOp = {
      opId: "opB",
      batchId: "LAB-620A",
      type: "registration",
      createdAt: now(),
      attempts: 0,
      draft,
      registrationBase: base,
      status: "queued",
    };
    const local: Batch = { ...server0, logs: [...server0.logs, log("offline", "离线改了面料和克重")] };
    let state: LabState = { batches: [local], queue: [op], online: true, faultNext: false };

    // 离线期间"别处"改了面料（两边都改→冲突）与温度曲线（仅远端改→自动保留）
    await commitFields("LAB-620A", {
      fabric: "棉 97% 弹力 3%（别处改）",
      tempCurve: "30→60℃，1.0℃/min（别处修订）",
    });

    const remote1 = await fetchBatches();
    const r1 = await runSyncPipeline(state, remote1);
    const op1 = r1.queue[0];
    assert(op1.status === "conflict", "面料两边都改成不同值 → conflict 等待裁决");
    assert((op1.conflict!.fields as string[]).join() === "fabric", "冲突清单只有面料一项");
    assert(!!op1.conflict!.base, "冲突待办保留三方基准供自动合并其余字段");
    const conflictLog = r1.batches[0].logs.find((l) => l.kind === "conflict");
    assert(!!conflictLog && conflictLog.message.includes("评审"), "冲突日志提示评审保护");
    assert(conflictLog.message.includes("仅一边修改"), "冲突日志说明其他差异将自动合并");

    // 用户只裁决面料取离线；克重（仅本地改）与温度曲线（仅远端改）自动归位
    const resolution = { fabric: "local" as const };
    const opDecided: PendingOp = { ...op1, status: "queued", conflict: { ...op1.conflict!, resolution } };
    state = { batches: r1.batches, queue: [opDecided], online: true, faultNext: false };
    const r2 = await runSyncPipeline(state, await fetchBatches());
    assert(r2.queue[0].status === "applied", "裁决完成后合并成功");
    const finalBatch = r2.batches.find((b) => b.id === "LAB-620A")!;
    assert(finalBatch.fabric === "棉 95% 氨纶 5%", "面料按裁决取离线值");
    assert(finalBatch.weight === "125 g/m²", "克重仅离线修改 → 自动取离线值");
    assert(finalBatch.tempCurve === "30→60℃，1.0℃/min（别处修订）", "温度曲线仅服务端修改 → 自动保留别处修订值");
    assert(finalBatch.review?.valid === true && finalBatch.review?.result === "approved", "已确认评审结果未被盖掉");
    assert(finalBatch.review?.by === "客户-王品控", "评审人保持不变");

    // 服务端也是一致结果
    const serverFinal = (await fetchBatches()).find((b) => b.id === "LAB-620A")!;
    assert(serverFinal.fabric === "棉 95% 氨纶 5%", "服务端已持久化裁决结果");
    assert(serverFinal.review?.result === "approved", "服务端评审同样保留");
  }

  console.log("C) 配方版本一变：离线复测立即失效；基于新版本重认后有效");
  {
    resetServer();
    const server0 = (await fetchBatches()).find((b) => b.id === "LAB-621C")!;

    // 离线期间先记下复测（基于 v2）
    const measured = { L: 34.2, a: 2.2, b: -38.0 };
    const op: PendingOp = {
      opId: "opC",
      batchId: "LAB-621C",
      type: "retest",
      createdAt: now(),
      attempts: 0,
      payload: {
        measured,
        note: "离线复测",
        base: { recipeVersion: server0.recipeVersion, retest: server0.retest },
      },
      status: "queued",
    };
    const localWithRetest: Batch = {
      ...server0,
      retest: {
        measured,
        deltaE: deltaE(measured, server0.standardLab),
        note: "离线复测",
        at: now(),
        recipeVersion: "2",
        valid: true,
      },
      logs: [...server0.logs, log("offline", "离线复测暂存")],
    };

    // 网络恢复前，"别处"把配方修订到 v3（直接调服务端）
    await reviseRecipe(
      "LAB-621C",
      { items: [{ name: "分散蓝2BLN", amount: "0.70%" }], liquorRatio: "1:10" },
      "40→130℃，1.5℃/min",
      "配色间-陈工"
    );

    const state: LabState = { batches: [localWithRetest], queue: [op], online: true, faultNext: false };
    const r = await runSyncPipeline(state, await fetchBatches());
    assert(r.queue[0].status === "stale", "基于旧版本的复测标记 stale 待重新确认");
    const b = r.batches.find((x) => x.id === "LAB-621C")!;
    assert(b.recipeVersion === "3", "对账到配方 v3");
    assert(b.retest?.valid === false, "旧复测立即失效（数据保留）");
    assert(b.review?.valid === false, "旧评审同样立即失效，结论保留");
    assert(b.logs.some((l) => l.message.includes("重新复测确认")), "日志说明需重新复测");
    assert(b.logs.some((l) => l.message.includes("重新确认") && l.message.includes("评审")), "日志说明评审需重新确认");

    // 基于 v3 重新复测，新待办合并成功
    const newMeasured = { L: 33.9, a: 2.3, b: -38.5 };
    const op2: PendingOp = {
      opId: "opC2",
      batchId: "LAB-621C",
      type: "retest",
      createdAt: now(),
      attempts: 0,
      payload: {
        measured: newMeasured,
        note: "按 v3 重新复测",
        base: { recipeVersion: "3", retest: undefined },
      },
      status: "queued",
    };
    const state2: LabState = { batches: [b], queue: [op2], online: true, faultNext: false };
    const r2 = await runSyncPipeline(state2, await fetchBatches());
    assert(r2.queue[0].status === "applied", "新版本复测合并成功");
    const b2 = r2.batches.find((x) => x.id === "LAB-621C")!;
    assert(b2.retest?.valid === true && b2.retest.recipeVersion === "3", "复测绑定 v3 且有效");
    assert(b2.retest.deltaE === deltaE(newMeasured, b2.standardLab), "ΔE 按服务端标准样重算");
    // 全部过程仍在
    assert(b2.logs.some((l) => l.message.includes("离线复测暂存")), "最初离线复测过程保留");
    assert(b2.logs.some((l) => l.kind === "error" || l.message.includes("失效")), "失效处理过程保留");
  }

  console.log("D) 无冲突的离线复测直接合并，失败不影响队列其他待办");
  {
    resetServer();
    const server0 = (await fetchBatches()).find((b) => b.id === "LAB-624B")!;
    const measured = { L: 28.9, a: -6.0, b: 9.5 };
    const op: PendingOp = {
      opId: "opD",
      batchId: "LAB-624B",
      type: "retest",
      createdAt: now(),
      attempts: 0,
      payload: { measured, note: "追加复测", base: { recipeVersion: server0.recipeVersion, retest: undefined } },
      status: "queued",
    };
    // 批次本身还没存在于"本地"投影时也能处理（按远端补进来）
    const state: LabState = { batches: [server0], queue: [op], online: true, faultNext: false };
    const r = await runSyncPipeline(state, await fetchBatches());
    assert(r.queue[0].status === "applied", "无冲突复测直接合并");
    const b = r.batches.find((x) => x.id === "LAB-624B")!;
    assert(b.retest!.deltaE === deltaE(measured, server0.standardLab), "ΔE 正确");
    assert(b.logs.some((l) => l.kind === "sync" && l.message.includes("离线复测已合并")), "合并过程写日志");
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
}

void main();
