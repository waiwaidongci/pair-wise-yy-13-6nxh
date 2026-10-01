// 本地持久化（模拟服务端数据 + 离线暂存队列）与种子数据
import type { Batch, ID, OutboxItem, ReviewResult } from "./types";
import { REVIEW_RESULT_LABEL } from "./types";

const BATCHES_KEY = "dyelab.batches.v1";
const OUTBOX_KEY = "dyelab.outbox.v1";

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function now(): number {
  return Date.now();
}

function seedBatches(): Record<ID, Batch> {
  const t = now();
  const mk = (over: {
    code: string;
    fabric: string;
    grams: string;
    finish: string;
    orderNo: string;
    recipe: string;
    liquorRatio: string;
    tempCurve: string;
    holdTime: string;
    deltaE: number;
    result: ReviewResult;
  }): Batch => {
    const id = uid();
    const fvId = uid();
    const retestId = uid();
    const reviewId = uid();
    return {
      id,
      code: over.code,
      fabric: over.fabric,
      grams: over.grams,
      finish: over.finish,
      orderNo: over.orderNo,
      currentFormulaVersionId: fvId,
      formulaVersions: [
        {
          id: fvId,
          version: "v1.0",
          recipe: over.recipe,
          liquorRatio: over.liquorRatio,
          tempCurve: over.tempCurve,
          holdTime: over.holdTime,
          createdAt: t - 86400000 * 2,
          source: "remote",
        },
      ],
      retests: [
        {
          id: retestId,
          formulaVersionId: fvId,
          deltaE: over.deltaE,
          note: "",
          recordedAt: t - 86400000,
          source: "remote",
          valid: true,
        },
      ],
      reviews: [
        {
          id: reviewId,
          formulaVersionId: fvId,
          result: over.result,
          confirmed: true,
          recordedAt: t - 86400000,
          confirmedAt: t - 86400000,
          source: "remote",
          valid: true,
        },
      ],
      createdAt: t - 86400000 * 2,
      updatedAt: t - 86400000,
      history: [
        { id: uid(), at: t - 86400000 * 2, kind: "batch_created", detail: `批次 ${over.code} 登记（${over.fabric}）` },
        { id: uid(), at: t - 86400000 * 2, kind: "formula_changed", detail: "配方版本 v1.0 建立" },
        { id: uid(), at: t - 86400000, kind: "retest_recorded", detail: `复测色差 ΔE ${over.deltaE}` },
        { id: uid(), at: t - 86400000, kind: "review_recorded", detail: `评审结果：${REVIEW_RESULT_LABEL[over.result]}` },
        { id: uid(), at: t - 86400000, kind: "review_confirmed", detail: `评审已确认：${REVIEW_RESULT_LABEL[over.result]}` },
      ],
    };
  };

  const list: Batch[] = [
    mk({
      code: "LAB-620A",
      fabric: "棉府绸",
      grams: "120g/m²",
      finish: "柔软整理",
      orderNo: "PO-2026-071",
      recipe: "活性红 3BF 2.0%（o.w.f）",
      liquorRatio: "1:20",
      tempCurve: "2℃/min 升至 60℃",
      holdTime: "40min",
      deltaE: 0.84,
      result: "passed",
    }),
    mk({
      code: "LAB-621C",
      fabric: "涤纶针织",
      grams: "180g/m²",
      finish: "亲水整理",
      orderNo: "PO-2026-084",
      recipe: "分散蓝 2BLN 1.5%（o.w.f）",
      liquorRatio: "1:15",
      tempCurve: "3℃/min 升至 130℃",
      holdTime: "30min",
      deltaE: 1.62,
      result: "rework",
    }),
    mk({
      code: "LAB-624B",
      fabric: "混纺斜纹",
      grams: "210g/m²",
      finish: "柔软整理 2%",
      orderNo: "PO-2026-092",
      recipe: "活性/分散拼混 2.5%（o.w.f）",
      liquorRatio: "1:18",
      tempCurve: "2.5℃/min 升至 80℃",
      holdTime: "35min",
      deltaE: 0.92,
      result: "confirming",
    }),
  ];

  return Object.fromEntries(list.map((b) => [b.id, b]));
}

export function loadBatches(): Record<ID, Batch> {
  try {
    const raw = localStorage.getItem(BATCHES_KEY);
    if (raw) return JSON.parse(raw) as Record<ID, Batch>;
  } catch {
    // 数据损坏时重新播种
  }
  const seed = seedBatches();
  saveBatches(seed);
  return seed;
}

export function saveBatches(batches: Record<ID, Batch>): void {
  try {
    localStorage.setItem(BATCHES_KEY, JSON.stringify(batches));
  } catch {
    // 存储不可用时静默降级为内存态
  }
}

export function loadOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (raw) return JSON.parse(raw) as OutboxItem[];
  } catch {
    // ignore
  }
  return [];
}

export function saveOutbox(outbox: OutboxItem[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch {
    // ignore
  }
}
