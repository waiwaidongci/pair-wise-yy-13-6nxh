// 核心合并逻辑的端到端验证（不依赖 DOM/localStorage）
import {
  applyRegistration,
  applyRetest,
  deltaE,
  detectRegistrationMerges,
  log,
  reconcileAfterPull,
  retestConflicts,
} from "../src/lib/engine";
import type { Batch, RegistrationDraft, RetestPayload } from "../src/types";

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

const std = { L: 50, a: 10, b: -20 };
const t = new Date().toISOString();

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    id: "LAB-T1",
    customerOrder: "PO-1",
    fabric: "棉",
    weight: "120g",
    recipe: { items: [{ name: "活性红", amount: "1%" }], liquorRatio: "1:15" },
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: std,
    recipeVersion: "1",
    recipeUpdatedAt: t,
    createdAt: t,
    logs: [],
    ...over,
  };
}

console.log("1) ΔE 计算");
assert(deltaE({ L: 0, a: 0, b: 0 }, { L: 3, a: 4, b: 0 }) === 5, "3-4-5 直角 ΔE=5");

console.log("2) 登记差异：仅本地改 → 自动合并不冲突");
{
  const remote = makeBatch();
  const base: RegistrationDraft = {
    customerOrder: "PO-1",
    fabric: "棉",
    weight: "120g",
    recipe: remote.recipe,
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: std,
    recipeVersion: "1",
  };
  const draft: RegistrationDraft = { ...base, fabric: "涤纶" };
  const plan = detectRegistrationMerges(draft, remote, base);
  assert(plan.diffs.join() === "fabric", "只有面料成分一项差异");
  assert(plan.conflicts.length === 0, "仅本地改不产生冲突，自动取离线值");
}

console.log("3) 登记冲突：两边改不同值 → 冲突列出；仅一边改的字段不算冲突");
{
  const base: RegistrationDraft = {
    customerOrder: "PO-1",
    fabric: "棉",
    weight: "120g",
    recipe: makeBatch().recipe,
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: std,
    recipeVersion: "1",
  };
  // 远端：面料→锦纶（两边都改），克重→130g（仅远端改）
  const remote = makeBatch({ fabric: "锦纶", weight: "130g" });
  // 离线：面料→涤纶，克重保持基准
  const draft: RegistrationDraft = { ...base, fabric: "涤纶" };
  const plan = detectRegistrationMerges(draft, remote, base);
  assert(plan.conflicts.join() === "fabric", "只有面料是两边都改的真冲突");
  assert(plan.diffs.includes("weight"), "克重仅远端改：在差异里但不是冲突");
  assert(plan.diffs.length === 2, "恰好 2 项差异（其余一致）");
}

console.log("4) 逐项裁决：本地/远端选择分别生效；无基准时未裁决字段维持服务端");
{
  const remote = makeBatch({ fabric: "锦纶", weight: "130g" });
  const draft: RegistrationDraft = {
    customerOrder: "PO-1",
    fabric: "涤纶",
    weight: "140g",
    recipe: remote.recipe,
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: std,
    recipeVersion: "1",
  };
  const merged = applyRegistration(remote, draft, {
    kind: "registration",
    fields: ["fabric", "weight"],
    resolution: { fabric: "local", weight: "remote" },
  });
  assert(merged.fabric === "涤纶", "面料取离线值");
  assert(merged.weight === "130g", "克重保留服务端值");
  assert(merged.logs.length === 1 && merged.logs[0].kind === "sync", "合并过程写入批次日志");
  assert(merged.localOnly === false, "合并后不再是仅本地批次");
}

console.log("4b) 三方自动合并：仅一边修改的字段各归其主");
{
  const base: RegistrationDraft = {
    customerOrder: "PO-1",
    fabric: "棉",
    weight: "120g",
    recipe: makeBatch().recipe,
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: std,
    recipeVersion: "1",
  };
  const remote = makeBatch({ weight: "130g" }); // 仅远端改克重
  const draft: RegistrationDraft = { ...base, fabric: "涤纶" }; // 仅本地改面料
  const merged = applyRegistration(remote, draft, {
    kind: "registration",
    fields: [],
    base,
  });
  assert(merged.fabric === "涤纶", "面料仅离线改 → 取离线值");
  assert(merged.weight === "130g", "克重仅远端改 → 保留服务端值（不会被离线旧值盖掉）");
}

console.log("5) 评审保护：字段合并不动已确认评审");
{
  const remote = makeBatch({
    fabric: "锦纶",
    review: {
      result: "approved",
      comment: "客户已确认",
      by: "客户-A",
      at: t,
      recipeVersion: "1",
      valid: true,
    },
  });
  const draft: RegistrationDraft = {
    customerOrder: "PO-1",
    fabric: "涤纶",
    weight: "120g",
    recipe: remote.recipe,
    tempCurve: "30→60",
    holdMinutes: 40,
    finishing: "柔软剂",
    standardLab: std,
    recipeVersion: "1",
  };
  const merged = applyRegistration(remote, draft, {
    kind: "registration",
    fields: ["fabric"],
    resolution: { fabric: "local" },
  });
  assert(merged.review?.result === "approved" && merged.review?.valid === true, "已确认评审结果未被盖掉");
  assert(merged.review?.by === "客户-A", "评审人保留");
}

console.log("6) 复测冲突：Lab 分量两边都改 → 只列真冲突的分量，ΔE 按裁决重算");
{
  const baseRetest = {
    measured: { L: 50, a: 10, b: -20 },
    deltaE: 0,
    note: "初测",
    at: t,
    recipeVersion: "1",
    valid: true,
  };
  const remote = makeBatch({
    retest: { ...baseRetest, measured: { L: 52, a: 10, b: -20 } },
  });
  const payload: RetestPayload = {
    measured: { L: 53, a: 12, b: -20 },
    note: "离线改了L和a",
    base: { recipeVersion: "1", retest: baseRetest },
  };
  const fields = retestConflicts(payload, remote);
  assert(fields.join() === "L", "只有 L 两边都改且不同；a 仅本地改不算冲突");

  const { batch } = applyRetest(remote, payload, {
    kind: "retest",
    fields: ["L"],
    resolution: { L: "remote" },
  });
  assert(batch.retest!.measured.L === 52, "L 保留服务端 52");
  assert(batch.retest!.measured.a === 12, "a 仅本地改 → 采用离线 12");
  const expected = deltaE({ L: 52, a: 12, b: -20 }, std);
  assert(batch.retest!.deltaE === expected, `ΔE 按裁决结果重算 = ${expected}`);
}

console.log("7) 配方版本变更：旧复测与旧评审立即失效，但历史结论保留在日志");
{
  const local = makeBatch({
    recipeVersion: "1",
    retest: {
      measured: { L: 51, a: 11, b: -19 },
      deltaE: 1.73,
      note: "v1 复测",
      at: t,
      recipeVersion: "1",
      valid: true,
    },
    review: {
      result: "approved",
      comment: "通过",
      by: "客户",
      at: t,
      recipeVersion: "1",
      valid: true,
    },
    logs: [log("offline", "本地日志")],
  });
  const remote = makeBatch({
    recipeVersion: "2",
    retest: undefined,
    review: undefined,
    logs: [log("remote", "别处修订配方 v2")],
  });
  const merged = reconcileAfterPull(local, remote);
  assert(merged.recipeVersion === "2", "对账到 v2");
  assert(merged.retest?.valid === false, "v1 复测立即标记失效");
  assert(merged.review?.valid === false && merged.review?.result === "approved", "评审标记失效但结论保留");
  const msgs = merged.logs.map((l) => l.message).join("|");
  assert(msgs.includes("复测") && msgs.includes("失效"), "日志记录复测失效");
  assert(msgs.includes("评审") && msgs.includes("历史结论保留"), "日志记录评审失效且历史结论保留");
  assert(msgs.includes("别处修订配方 v2"), "远端日志合并进来");
  assert(msgs.includes("本地日志"), "本地处理日志不丢");
}

console.log("8) 版本相同对账：以远端评审为准（别处更新）");
{
  const local = makeBatch({
    recipeVersion: "1",
    review: { result: "pending", comment: "待评审", by: "实验室", at: t, recipeVersion: "1", valid: true },
  });
  const remote = makeBatch({
    recipeVersion: "1",
    review: { result: "approved", comment: "客户确认", by: "客户-B", at: t, recipeVersion: "1", valid: true },
  });
  const merged = reconcileAfterPull(local, remote);
  assert(merged.review?.result === "approved" && merged.review?.by === "客户-B", "同版本以远端最新评审为准");
}

console.log("9) 失效复测基于新版本重认后 valid=true");
{
  const remote = makeBatch({
    recipeVersion: "2",
    retest: undefined,
  });
  const payload: RetestPayload = {
    measured: { L: 50.5, a: 10.2, b: -19.8 },
    note: "按 v2 重新复测",
    base: { recipeVersion: "2", retest: undefined },
  };
  const { batch } = applyRetest(remote, payload, undefined);
  assert(batch.retest!.valid === true, "基于当前版本的复测有效");
  assert(batch.retest!.recipeVersion === "2", "复测绑定 v2");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
