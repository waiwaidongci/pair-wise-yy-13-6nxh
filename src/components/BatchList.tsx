import { useState } from "react";
import { Batch, BatchLog, DyeRecipe } from "../types";
import { formatRecipe, REVIEW_LABEL } from "../lib/engine";
import { LabApi } from "../lib/useLab";

const LOG_STYLE: Record<BatchLog["kind"], string> = {
  offline: "离线暂存",
  remote: "别处/服务端",
  sync: "合并处理",
  conflict: "差异冲突",
  protect: "评审保护",
  error: "失败保留",
};

export function BatchList({
  lab,
  selectedId,
  onSelect,
  filter,
}: {
  lab: LabApi;
  selectedId?: string;
  filter: string;
  onSelect: (id: string) => void;
}) {
  const list = lab.batches.filter(
    (b) => !filter || b.customerOrder.toLowerCase().includes(filter.toLowerCase()) ||
      b.fabric.includes(filter) ||
      b.id.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>小样批次</p>
          <h2>批次列表（{list.length}）</h2>
        </div>
      </div>
      <div className="batch-list">
        {list.map((b) => (
          <BatchCard
            key={b.id}
            batch={b}
            selected={b.id === selectedId}
            onSelect={() => onSelect(b.id)}
            lab={lab}
          />
        ))}
        {list.length === 0 && <p className="empty">没有匹配批次</p>}
      </div>
    </section>
  );
}

function BatchCard({
  batch,
  selected,
  onSelect,
  lab,
}: {
  batch: Batch;
  selected: boolean;
  onSelect: () => void;
  lab: LabApi;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const [showRevise, setShowRevise] = useState(false);

  return (
    <article className={`batch-card ${selected ? "selected" : ""}`} onClick={onSelect}>
      <header>
        <div>
          <h3>
            {batch.id}
            {batch.localOnly && <span className="tag local">仅本地未上送</span>}
          </h3>
          <small>{batch.customerOrder}</small>
        </div>
        <div className="badges">
          <span className="tag version">配方 v{batch.recipeVersion}</span>
          {batch.review && (
            <span className={`tag review ${batch.review.valid ? "valid" : "invalid"}`}>
              {REVIEW_LABEL[batch.review.result]}
              {!batch.review.valid && "（版本变更·待重认）"}
            </span>
          )}
        </div>
      </header>

      <div className="batch-grid">
        <div>
          <small>面料 / 克重</small>
          <p>{batch.fabric} · {batch.weight}</p>
        </div>
        <div>
          <small>染料配方 / 浴比</small>
          <p>{formatRecipe(batch.recipe)}</p>
        </div>
        <div>
          <small>温度曲线 · 保温</small>
          <p>{batch.tempCurve} · {batch.holdMinutes}min</p>
        </div>
        <div>
          <small>后整理</small>
          <p>{batch.finishing}</p>
        </div>
        <div>
          <small>标准 Lab</small>
          <p>
            L {batch.standardLab.L.toFixed(2)} / a {batch.standardLab.a.toFixed(2)} / b{" "}
            {batch.standardLab.b.toFixed(2)}
          </p>
        </div>
        <div>
          <small>复测色差</small>
          {batch.retest ? (
            <p className={batch.retest.valid ? "" : "invalid-text"}>
              ΔE {batch.retest.deltaE}
              {!batch.retest.valid && "（配方版本已变 · 失效，需重新复测）"}
              {batch.retest.valid && batch.retest.deltaE > 1.5 && <em className="overlimit"> 超限</em>}
            </p>
          ) : (
            <p className="muted">暂无复测</p>
          )}
        </div>
      </div>

      {batch.review && (
        <p className={`review-line ${batch.review.valid ? "" : "invalid-text"}`}>
          客户评审（{batch.review.by}，依据 v{batch.review.recipeVersion}）：
          {REVIEW_LABEL[batch.review.result]}
          {batch.review.comment && ` — ${batch.review.comment}`}
          {!batch.review.valid && "；配方版本一变，评审立即失效，需客户重新确认（历史结论保留在处理过程）"}
        </p>
      )}

      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? "收起处理过程" : `查看处理过程（${batch.logs.length}）`}
        </button>
        <button onClick={() => setShowRevise((v) => !v)}>
          模拟"别处"修订配方
        </button>
      </div>

      {showRevise && <ReviseForm batch={batch} lab={lab} onDone={() => setShowRevise(false)} />}

      {showLogs && (
        <ul className="logs" onClick={(e) => e.stopPropagation()}>
          {[...batch.logs].reverse().map((entry, i) => (
            <li key={i} className={`log-${entry.kind}`}>
              <span className="log-kind">{LOG_STYLE[entry.kind]}</span>
              <span className="log-time">{new Date(entry.at).toLocaleString()}</span>
              <span className="log-msg">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ReviseForm({
  batch,
  lab,
  onDone,
}: {
  batch: Batch;
  lab: LabApi;
  onDone: () => void;
}) {
  const [items, setItems] = useState(
    batch.recipe.items.map((i) => `${i.name} ${i.amount}`).join("；")
  );
  const [liquorRatio, setLiquorRatio] = useState(batch.recipe.liquorRatio);
  const [tempCurve, setTempCurve] = useState(batch.tempCurve);
  const [by, setBy] = useState("配色间-陈工");

  const submit = async () => {
    const recipe: DyeRecipe = {
      items: items
        .split(/[;；\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = s.match(/^(.*?)([\d.]+%|[\d.]+\s*g\/L)$/);
          return m
            ? { name: m[1].trim(), amount: m[2].trim() }
            : { name: s, amount: "" };
        }),
      liquorRatio,
    };
    await lab.remoteRevise(batch.id, recipe, tempCurve, by);
    onDone();
  };

  return (
    <div className="revise-box" onClick={(e) => e.stopPropagation()}>
      <p className="conflict-tip">
        模拟离线期间另一台终端修订配方：保存后版本 +1，该批次已有复测与客户评审立即失效并留痕。
      </p>
      <div className="field-grid">
        <label className="wide">
          <span>修订后配方</span>
          <textarea rows={2} value={items} onChange={(e) => setItems(e.target.value)} />
        </label>
        <label>
          <span>浴比</span>
          <input value={liquorRatio} onChange={(e) => setLiquorRatio(e.target.value)} />
        </label>
        <label>
          <span>温度曲线</span>
          <input value={tempCurve} onChange={(e) => setTempCurve(e.target.value)} />
        </label>
        <label>
          <span>修订人</span>
          <input value={by} onChange={(e) => setBy(e.target.value)} />
        </label>
      </div>
      <div className="op-actions">
        <button className="primary" onClick={() => void submit()}>
          保存修订（v{batch.recipeVersion} → v{Number(batch.recipeVersion) + 1}）
        </button>
        <button onClick={onDone}>取消</button>
      </div>
    </div>
  );
}
