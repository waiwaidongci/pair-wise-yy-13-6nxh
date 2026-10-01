// 模拟服务端：离线期间"别处"（配方修订、客户评审）写入的数据源。
// 用 localStorage 持久化，并可注入故障以演示"合并失败保留待重试"。

import { Batch, LabColor, ReviewResult } from "../types";
import { deltaE, log, now } from "./engine";

const SERVER_KEY = "dye-lab-server-v1";
const FAULT_KEY = "dye-lab-fault-v1";

function cLab(L: number, a: number, b: number): LabColor {
  return { L, a, b };
}

function seedBatches(): Batch[] {
  const t = now();
  return [
    {
      id: "LAB-620A",
      customerOrder: "PO-2401 棉府绸衬衫",
      fabric: "棉 100%",
      weight: "120 g/m²",
      recipe: {
        items: [
          { name: "活性红3BS", amount: "1.20%" },
          { name: "元明粉", amount: "40 g/L" },
        ],
        liquorRatio: "1:15",
      },
      tempCurve: "30→60℃，1.5℃/min",
      holdMinutes: 40,
      finishing: "柔软剂 2%",
      standardLab: cLab(56.4, 42.1, -12.3),
      recipeVersion: "3",
      recipeUpdatedAt: t,
      retest: {
        measured: cLab(56.1, 42.6, -12.0),
        deltaE: deltaE(cLab(56.1, 42.6, -12.0), cLab(56.4, 42.1, -12.3)),
        note: "缸差在允收范围",
        at: t,
        recipeVersion: "3",
        valid: true,
      },
      review: {
        result: "approved",
        comment: "客户确认大货色",
        by: "客户-王品控",
        at: t,
        recipeVersion: "3",
        valid: true,
      },
      createdAt: t,
      logs: [log("remote", "批次登记，配方 v3 首版确认")],
    },
    {
      id: "LAB-621C",
      customerOrder: "PO-2407 涤纶针织运动布",
      fabric: "涤纶 100%",
      weight: "180 g/m²",
      recipe: {
        items: [
          { name: "分散蓝2BLN", amount: "0.85%" },
          { name: "匀染剂", amount: "1 g/L" },
        ],
        liquorRatio: "1:10",
      },
      tempCurve: "40→130℃，2℃/min",
      holdMinutes: 45,
      finishing: "定型 170℃×30s",
      standardLab: cLab(33.8, 2.4, -38.6),
      recipeVersion: "2",
      recipeUpdatedAt: t,
      retest: {
        measured: cLab(34.9, 2.1, -36.8),
        deltaE: deltaE(cLab(34.9, 2.1, -36.8), cLab(33.8, 2.4, -38.6)),
        note: "升温曲线偏快，b 值偏黄",
        at: t,
        recipeVersion: "2",
        valid: true,
      },
      review: {
        result: "pending",
        comment: "待复染",
        by: "实验室",
        at: t,
        recipeVersion: "2",
        valid: true,
      },
      createdAt: t,
      logs: [log("remote", "批次登记，配方 v2")],
    },
    {
      id: "LAB-624B",
      customerOrder: "PO-2415 混纺斜纹裤料",
      fabric: "涤棉 65/35",
      weight: "240 g/m²",
      recipe: {
        items: [
          { name: "还原橄榄绿", amount: "1.60%" },
          { name: "活性黄3RS", amount: "0.40%" },
        ],
        liquorRatio: "1:12",
      },
      tempCurve: "40→95℃，1.8℃/min",
      holdMinutes: 50,
      finishing: "柔软剂 2%，预缩",
      standardLab: cLab(28.6, -6.2, 9.8),
      recipeVersion: "1",
      recipeUpdatedAt: t,
      review: {
        result: "pending",
        comment: "客户确认中",
        by: "客户-李采",
        at: t,
        recipeVersion: "1",
        valid: true,
      },
      createdAt: t,
      logs: [log("remote", "批次登记，配方 v1")],
    },
  ];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function readServer(): Batch[] {
  const raw = localStorage.getItem(SERVER_KEY);
  if (!raw) {
    const seed = seedBatches();
    localStorage.setItem(SERVER_KEY, JSON.stringify(seed));
    return seed;
  }
  return JSON.parse(raw) as Batch[];
}

function writeServer(batches: Batch[]) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(batches));
}

export function resetServer(): Batch[] {
  const seed = seedBatches();
  writeServer(seed);
  localStorage.removeItem(FAULT_KEY);
  return clone(seed);
}

/** 故障开关：开启后下一次 fetch/commit 失败，之后自动关闭（模拟偶发网络/服务端错误） */
export function setFaultOnce(on: boolean) {
  localStorage.setItem(FAULT_KEY, on ? "1" : "0");
}

export function faultScheduled(): boolean {
  return localStorage.getItem(FAULT_KEY) === "1";
}

function maybeFault() {
  if (faultScheduled()) {
    localStorage.setItem(FAULT_KEY, "0");
    throw new Error("网络中断/服务端 503：合并请求失败，内容已保留，可稍后重试");
  }
}

/** 拉取全量批次（网络恢复对账用） */
export function fetchBatches(): Promise<Batch[]> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        maybeFault();
        resolve(clone(readServer()));
      } catch (e) {
        reject(e);
      }
    }, 350);
  });
}

function commitUpdate(batchId: string, mutate: (b: Batch) => Batch): Promise<Batch> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        maybeFault();
        const all = readServer();
        const idx = all.findIndex((b) => b.id === batchId);
        if (idx < 0) {
          reject(new Error(`服务端不存在批次 ${batchId}`));
          return;
        }
        const next = mutate(clone(all[idx]));
        all[idx] = next;
        writeServer(all);
        resolve(clone(next));
      } catch (e) {
        reject(e);
      }
    }, 350);
  });
}

/** 离线登记的新批次上送 */
export function commitBatch(batch: Batch): Promise<Batch> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        maybeFault();
        const all = readServer();
        const idx = all.findIndex((b) => b.id === batch.id);
        if (idx >= 0) {
          // 离线期间该批次已在别处登记：返回服务端版本，交由前端逐项合并
          resolve(clone(all[idx]));
          return;
        }
        const next = { ...clone(batch), localOnly: false };
        all.push(next);
        writeServer(all);
        resolve(clone(next));
      } catch (e) {
        reject(e);
      }
    }, 350);
  });
}

/** 离线登记批次与服务端同批次逐项裁决后的字段合并结果上送 */
export function commitFields(
  batchId: string,
  fields: Partial<
    Pick<
      Batch,
      | "customerOrder"
      | "fabric"
      | "weight"
      | "recipe"
      | "tempCurve"
      | "holdMinutes"
      | "finishing"
      | "standardLab"
      | "recipeVersion"
    >
  >
): Promise<Batch> {
  return commitUpdate(batchId, (b) => ({
    ...b,
    ...clone(fields),
    logs: [
      ...b.logs,
      log("sync", "离线登记逐项合并结果已上送，服务端已确认的评审结果原样保留"),
    ],
  }));
}

/** 复测结果上送 */
export function commitRetest(
  batchId: string,
  measured: LabColor,
  note: string
): Promise<Batch> {
  return commitUpdate(batchId, (b) => {
    const retest = {
      measured: clone(measured),
      deltaE: deltaE(measured, b.standardLab),
      note,
      at: now(),
      recipeVersion: b.recipeVersion,
      valid: true,
    };
    return {
      ...b,
      retest,
      logs: [...b.logs, log("sync", `复测结果已上送服务端，ΔE ${retest.deltaE}`)],
    };
  });
}

/** 在线提交客户评审（已确认结果受保护，合并时不得被离线内容覆盖） */
export function commitReview(
  batchId: string,
  result: ReviewResult,
  comment: string,
  by: string
): Promise<Batch> {
  return commitUpdate(batchId, (b) => ({
    ...b,
    review: {
      result,
      comment,
      by,
      at: now(),
      recipeVersion: b.recipeVersion,
      valid: true,
    },
    logs: [
      ...b.logs,
      log("remote", `${by} 提交客户评审：${result === "approved" ? "评审通过" : result === "rejected" ? "评审不通过" : "待评审"}${comment ? `（${comment}）` : ""}`),
    ],
  }));
}

/** "别处"修订配方：版本号 +1，复测/评审立即失效（保留历史结论与留痕） */
export function reviseRecipe(
  batchId: string,
  recipe: Batch["recipe"],
  tempCurve: string,
  by: string
): Promise<Batch> {
  return commitUpdate(batchId, (b) => {
    const nextVersion = String(Number(b.recipeVersion) + 1);
    const logs = [...b.logs];
    if (b.retest?.valid) {
      b.retest = { ...b.retest, valid: false };
      logs.push(
        log(
          "remote",
          `配方修订为 v${nextVersion}：v${b.recipeVersion} 的复测（ΔE ${b.retest.deltaE}）立即失效，需重新复测确认`
        )
      );
    }
    if (b.review?.valid) {
      const prev = b.review;
      b.review = { ...prev, valid: false };
      logs.push(
        log(
          "remote",
          `配方修订为 v${nextVersion}：客户评审历史结论「${prev.result === "approved" ? "评审通过" : prev.result === "rejected" ? "评审不通过" : "待评审"}」失效，需重新确认`
        )
      );
    }
    return {
      ...b,
      recipe: clone(recipe),
      tempCurve,
      recipeVersion: nextVersion,
      recipeUpdatedAt: now(),
      logs: [
        ...logs,
        log("remote", `${by} 在别处修订配方至 v${nextVersion}：${recipe.items.map((i) => i.name + " " + i.amount).join("，")}`),
      ],
    };
  });
}
