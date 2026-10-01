// 染整小样离线续办 —— UI 组件
import { useMemo, useState } from "react";
import type {
  Batch,
  BatchFormData,
  FormulaFormData,
  HistoryKind,
  ID,
  OutboxItem,
  ReviewResult,
} from "./types";
import { HISTORY_KIND_LABEL, OP_LABEL, REVIEW_RESULT_LABEL } from "./types";

/* ---------------- 通用小部件 ---------------- */

export function NetworkBadge({ online }: { online: boolean }) {
  return (
    <span className={`net-badge ${online ? "online" : "offline"}`}>
      <i className="dot" />
      {online ? "在线" : "离线"}
    </span>
  );
}

function StatusBadge({ status }: { status: OutboxItem["status"] }) {
  const map = {
    pending: { text: "待同步", cls: "pending" },
    conflict: { text: "冲突", cls: "conflict" },
    failed: { text: "待重试", cls: "failed" },
  } as const;
  const m = map[status];
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}

function SourceTag({ source }: { source: "local" | "remote" }) {
  return <span className={`src-tag ${source}`}>{source === "local" ? "本地离线" : "他处"}</span>;
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function latestRetest(b: Batch) {
  return [...b.retests].sort((a, c) => c.recordedAt - a.recordedAt)[0];
}

function latestValidReview(b: Batch) {
  return [...b.reviews]
    .filter((r) => r.valid)
    .sort((a, c) => c.recordedAt - a.recordedAt)[0];
}

/* ---------------- 批次列表 ---------------- */

const FILTERS = ["全部", "棉", "涤纶", "锦纶", "混纺"];

export function BatchList({
  batches,
  outbox,
  selectedId,
  onSelect,
}: {
  batches: Batch[];
  outbox: OutboxItem[];
  selectedId: ID | null;
  onSelect: (id: ID) => void;
}) {
  const [filter, setFilter] = useState("全部");
  const [query, setQuery] = useState("");

  const pendingCount = (batchId: ID) =>
    outbox.filter((i) => i.batchId === batchId && i.status === "pending").length;
  const conflictCount = (batchId: ID) =>
    outbox.filter((i) => i.batchId === batchId && i.status === "conflict").length;
  const failedCount = (batchId: ID) =>
    outbox.filter((i) => i.batchId === batchId && i.status === "failed").length;

  const list = useMemo(() => {
    return batches
      .filter((b) => (filter === "全部" ? true : b.fabric.includes(filter)))
      .filter((b) =>
        query.trim()
          ? b.code.includes(query.trim()) ||
            b.orderNo.includes(query.trim()) ||
            b.fabric.includes(query.trim())
          : true,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [batches, filter, query]);

  return (
    <div className="batch-list">
      <input
        className="search"
        placeholder="搜批次号 / 客户订单 / 面料"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={filter === f ? "active" : ""}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="batch-cards">
        {list.length === 0 && <p className="empty">暂无匹配批次</p>}
        {list.map((b) => {
          const lr = latestRetest(b);
          const review = latestValidReview(b);
          const pc = pendingCount(b.id);
          const cc = conflictCount(b.id);
          const fc = failedCount(b.id);
          return (
            <button
              key={b.id}
              className={`batch-card ${selectedId === b.id ? "selected" : ""} ${b.pending ? "provisional" : ""}`}
              onClick={() => onSelect(b.id)}
            >
              <div className="batch-card-head">
                <strong>{b.code}</strong>
                {b.pending && <span className="badge pending">待同步</span>}
                {cc > 0 && <span className="badge conflict">{cc} 冲突</span>}
                {fc > 0 && <span className="badge failed">{fc} 待重试</span>}
                {pc > 0 && !cc && !fc && <span className="badge pending">{pc} 待同步</span>}
              </div>
              <div className="batch-card-meta">
                <span>{b.fabric}</span>
                <span>{b.grams}</span>
                {b.orderNo && <span>订单 {b.orderNo}</span>}
              </div>
              <div className="batch-card-status">
                <span className="fv-tag">
                  {b.formulaVersions.find((v) => v.id === b.currentFormulaVersionId)?.version ?? "—"}
                </span>
                {lr && <span className={lr.deltaE > 1 ? "delta over" : "delta"}>ΔE {lr.deltaE}</span>}
                {review && (
                  <span className={`review-tag ${review.confirmed ? "confirmed" : ""}`}>
                    {REVIEW_RESULT_LABEL[review.result]}
                    {review.confirmed ? " · 已确认" : ""}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 新增批次表单 ---------------- */

export function BatchForm({ onSubmit }: { onSubmit: (data: BatchFormData) => void }) {
  const [form, setForm] = useState<BatchFormData>({
    code: "",
    fabric: "棉",
    grams: "",
    finish: "",
    orderNo: "",
    recipe: "",
    liquorRatio: "1:20",
    tempCurve: "",
    holdTime: "",
  });
  const set = (k: keyof BatchFormData, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.code.trim()) return;
    onSubmit(form);
    setForm({ code: "", fabric: "棉", grams: "", finish: "", orderNo: "", recipe: "", liquorRatio: "1:20", tempCurve: "", holdTime: "" });
  };
  return (
    <div className="form-card">
      <h3>离线登记批次</h3>
      <div className="form-grid">
        <label>
          <span>批次号 *</span>
          <input value={form.code} placeholder="如 LAB-625A" onChange={(e) => set("code", e.target.value)} />
        </label>
        <label>
          <span>面料成分</span>
          <select value={form.fabric} onChange={(e) => set("fabric", e.target.value)}>
            {FILTERS.filter((f) => f !== "全部").map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>克重</span>
          <input value={form.grams} placeholder="如 120g/m²" onChange={(e) => set("grams", e.target.value)} />
        </label>
        <label>
          <span>后整理方式</span>
          <input value={form.finish} placeholder="如 柔软整理" onChange={(e) => set("finish", e.target.value)} />
        </label>
        <label>
          <span>客户订单号</span>
          <input value={form.orderNo} placeholder="如 PO-2026-100" onChange={(e) => set("orderNo", e.target.value)} />
        </label>
        <label>
          <span>染料配方</span>
          <input value={form.recipe} placeholder="如 活性红 3BF 2.0%" onChange={(e) => set("recipe", e.target.value)} />
        </label>
        <label>
          <span>浴比</span>
          <input value={form.liquorRatio} onChange={(e) => set("liquorRatio", e.target.value)} />
        </label>
        <label>
          <span>温度曲线</span>
          <input value={form.tempCurve} placeholder="如 2℃/min 升至 60℃" onChange={(e) => set("tempCurve", e.target.value)} />
        </label>
        <label>
          <span>保温时间</span>
          <input value={form.holdTime} placeholder="如 40min" onChange={(e) => set("holdTime", e.target.value)} />
        </label>
      </div>
      <button className="primary" onClick={submit} disabled={!form.code.trim()}>
        登记批次{form.code ? ` ${form.code}` : ""}
      </button>
    </div>
  );
}

/* ---------------- 批次详情 ---------------- */

type Tab = "overview" | "formula" | "retest" | "review" | "history";

export function BatchDetail({
  batch,
  outbox,
  onFormula,
  onRetest,
  onReview,
  onConfirm,
}: {
  batch: Batch;
  outbox: OutboxItem[];
  onFormula: (data: FormulaFormData) => void;
  onRetest: (deltaE: number, note: string) => void;
  onReview: (result: ReviewResult) => void;
  onConfirm: (reviewId: ID) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [showFormulaForm, setShowFormulaForm] = useState(false);
  const [showRetestForm, setShowRetestForm] = useState(false);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [formula, setFormula] = useState<FormulaFormData>({
    recipe: "",
    liquorRatio: "1:20",
    tempCurve: "",
    holdTime: "",
  });
  const [deltaE, setDeltaE] = useState("");
  const [note, setNote] = useState("");
  const [reviewResult, setReviewResult] = useState<ReviewResult>("passed");

  const pendingItems = outbox.filter((i) => i.batchId === batch.id);
  const currentFv = batch.formulaVersions.find((v) => v.id === batch.currentFormulaVersionId);
  const lr = latestRetest(batch);
  const review = latestValidReview(batch);
  const invalidRetests = batch.retests.filter((r) => !r.valid);
  const invalidReviews = batch.reviews.filter((r) => !r.valid);

  const submitFormula = () => {
    onFormula(formula);
    setShowFormulaForm(false);
    setFormula({ recipe: "", liquorRatio: "1:20", tempCurve: "", holdTime: "" });
  };
  const submitRetest = () => {
    const v = parseFloat(deltaE);
    if (Number.isNaN(v)) return;
    onRetest(v, note);
    setDeltaE("");
    setNote("");
    setShowRetestForm(false);
  };
  const submitReview = () => {
    onReview(reviewResult);
    setShowReviewForm(false);
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <p className="eyebrow">批次详情</p>
          <h2>
            {batch.code}
            {batch.pending && <span className="badge pending">待同步</span>}
          </h2>
          <p className="detail-sub">
            {batch.fabric} · {batch.grams} · {batch.finish}
            {batch.orderNo ? ` · 订单 ${batch.orderNo}` : ""}
          </p>
        </div>
        <div className="detail-status">
          <span className="fv-tag big">{currentFv?.version ?? "—"}</span>
          {lr && <span className={lr.deltaE > 1 ? "delta over" : "delta"}>最近 ΔE {lr.deltaE}</span>}
          {review && (
            <span className={`review-tag ${review.confirmed ? "confirmed" : ""}`}>
              {REVIEW_RESULT_LABEL[review.result]}
              {review.confirmed ? " · 已确认" : ""}
            </span>
          )}
        </div>
      </div>

      {batch.pending && (
        <div className="inline-notice warn">
          该批次为离线登记，暂存于本机待续办队列，联网后自动合并。
        </div>
      )}
      {pendingItems.some((i) => i.status === "conflict") && (
        <div className="inline-notice err">
          该批次有 {pendingItems.filter((i) => i.status === "conflict").length} 项离线修订与他处冲突，请在下方续办中心处理。
        </div>
      )}
      {pendingItems.some((i) => i.status === "failed") && (
        <div className="inline-notice err">
          该批次有 {pendingItems.filter((i) => i.status === "failed").length} 项合并失败，内容已保留待重试。
        </div>
      )}

      <div className="tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          概览
        </button>
        <button className={tab === "formula" ? "active" : ""} onClick={() => setTab("formula")}>
          配方版本 {batch.formulaVersions.length}
        </button>
        <button className={tab === "retest" ? "active" : ""} onClick={() => setTab("retest")}>
          复测色差 {batch.retests.length}
          {invalidRetests.length > 0 && <em className="tab-dot">{invalidRetests.length}</em>}
        </button>
        <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>
          评审结果 {batch.reviews.length}
          {invalidReviews.length > 0 && <em className="tab-dot">{invalidReviews.length}</em>}
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          处理过程 {batch.history.length}
        </button>
      </div>

      <div className="tab-body">
        {tab === "overview" && (
          <div className="overview">
            <dl className="kv">
              <div>
                <dt>当前配方版本</dt>
                <dd>{currentFv?.version ?? "—"}</dd>
              </div>
              <div>
                <dt>染料配方</dt>
                <dd>{currentFv?.recipe ?? "—"}</dd>
              </div>
              <div>
                <dt>浴比</dt>
                <dd>{currentFv?.liquorRatio ?? "—"}</dd>
              </div>
              <div>
                <dt>温度曲线</dt>
                <dd>{currentFv?.tempCurve ?? "—"}</dd>
              </div>
              <div>
                <dt>保温时间</dt>
                <dd>{currentFv?.holdTime ?? "—"}</dd>
              </div>
              <div>
                <dt>后整理</dt>
                <dd>{batch.finish || "—"}</dd>
              </div>
            </dl>
            <div className="overview-actions">
              <button onClick={() => setTab("formula")}>修订配方版本</button>
              <button onClick={() => setTab("retest")}>记录复测色差</button>
              <button onClick={() => setTab("review")}>记录评审结果</button>
            </div>
            {(invalidRetests.length > 0 || invalidReviews.length > 0) && (
              <div className="inline-notice warn">
                配方版本已变更：{invalidRetests.length} 条复测、{invalidReviews.length} 条评审已失效，需按新版本重新复测 / 确认。
              </div>
            )}
          </div>
        )}

        {tab === "formula" && (
          <div className="version-list">
            <div className="tab-actions">
              <button
                className="primary"
                onClick={() => setShowFormulaForm((v) => !v)}
              >
                {showFormulaForm ? "收起" : "修订配方版本"}
              </button>
            </div>
            {showFormulaForm && (
              <div className="form-card">
                <h3>修订配方（将生成新版本，复测与评审随即失效）</h3>
                <div className="form-grid">
                  <label>
                    <span>染料配方</span>
                    <input
                      value={formula.recipe}
                      placeholder="如 活性红 3BF 1.8%"
                      onChange={(e) => setFormula((f) => ({ ...f, recipe: e.target.value }))}
                    />
                  </label>
                  <label>
                    <span>浴比</span>
                    <input
                      value={formula.liquorRatio}
                      onChange={(e) => setFormula((f) => ({ ...f, liquorRatio: e.target.value }))}
                    />
                  </label>
                  <label>
                    <span>温度曲线</span>
                    <input
                      value={formula.tempCurve}
                      placeholder="如 2℃/min 升至 60℃"
                      onChange={(e) => setFormula((f) => ({ ...f, tempCurve: e.target.value }))}
                    />
                  </label>
                  <label>
                    <span>保温时间</span>
                    <input
                      value={formula.holdTime}
                      placeholder="如 40min"
                      onChange={(e) => setFormula((f) => ({ ...f, holdTime: e.target.value }))}
                    />
                  </label>
                </div>
                <button className="primary" onClick={submitFormula}>
                  生成新版本
                </button>
              </div>
            )}
            {[...batch.formulaVersions]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((v) => (
                <article key={v.id} className={`record-card ${v.pending ? "pending-row" : ""}`}>
                  <div className="record-main">
                    <div className="record-title">
                      <strong>{v.version}</strong>
                      {v.id === batch.currentFormulaVersionId && <span className="badge current">当前</span>}
                      {v.pending && <span className="badge pending">待同步</span>}
                      <SourceTag source={v.source} />
                    </div>
                    <p className="record-line">
                      {v.recipe} · 浴比 {v.liquorRatio} · {v.tempCurve} · 保温 {v.holdTime}
                    </p>
                    <p className="record-time">{fmtTime(v.createdAt)}</p>
                  </div>
                </article>
              ))}
          </div>
        )}

        {tab === "retest" && (
          <div className="retest-list">
            <div className="tab-actions">
              <button className="primary" onClick={() => setShowRetestForm((v) => !v)}>
                {showRetestForm ? "收起" : "记录复测色差"}
              </button>
            </div>
            {showRetestForm && (
              <div className="form-card">
                <h3>复测色差（依据当前配方版本 {currentFv?.version}）</h3>
                <div className="form-grid">
                  <label>
                    <span>色差 ΔE *</span>
                    <input
                      value={deltaE}
                      inputMode="decimal"
                      placeholder="如 0.84"
                      onChange={(e) => setDeltaE(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>备注</span>
                    <input value={note} placeholder="可选" onChange={(e) => setNote(e.target.value)} />
                  </label>
                </div>
                <button className="primary" onClick={submitRetest} disabled={deltaE === ""}>
                  记录复测
                </button>
              </div>
            )}
            {invalidRetests.length > 0 && (
              <div className="inline-notice warn">
                {invalidRetests.length} 条复测基于旧配方版本已失效，请按当前版本 {currentFv?.version} 重新复测。
              </div>
            )}
            {[...batch.retests]
              .sort((a, b) => b.recordedAt - a.recordedAt)
              .map((r) => (
                <article key={r.id} className={`record-card ${r.pending ? "pending-row" : ""} ${!r.valid ? "invalid" : ""}`}>
                  <div className="record-main">
                    <div className="record-title">
                      <strong className={r.deltaE > 1 ? "delta over" : "delta"}>ΔE {r.deltaE}</strong>
                      {r.valid ? (
                        <span className="badge valid">有效</span>
                      ) : (
                        <span className="badge invalid">已失效</span>
                      )}
                      {r.pending && <span className="badge pending">待同步</span>}
                      <SourceTag source={r.source} />
                    </div>
                    <p className="record-line">
                      依据配方版本{" "}
                      {batch.formulaVersions.find((v) => v.id === r.formulaVersionId)?.version ?? "已删除版本"}
                      {r.note ? ` · ${r.note}` : ""}
                    </p>
                    <p className="record-time">{fmtTime(r.recordedAt)}</p>
                  </div>
                  {!r.valid && (
                    <button
                      className="mini"
                      onClick={() => {
                        setShowRetestForm(true);
                        setNote("重新复测（旧版本已失效）");
                      }}
                    >
                      重新复测
                    </button>
                  )}
                </article>
              ))}
          </div>
        )}

        {tab === "review" && (
          <div className="review-list">
            <div className="tab-actions">
              <button className="primary" onClick={() => setShowReviewForm((v) => !v)}>
                {showReviewForm ? "收起" : "记录评审结果"}
              </button>
            </div>
            {showReviewForm && (
              <div className="form-card">
                <h3>记录评审（依据当前配方版本 {currentFv?.version}，记录后需确认）</h3>
                <div className="form-grid">
                  <label>
                    <span>评审结果</span>
                    <select value={reviewResult} onChange={(e) => setReviewResult(e.target.value as ReviewResult)}>
                      <option value="passed">评审通过</option>
                      <option value="rework">待复染</option>
                      <option value="confirming">客户确认中</option>
                    </select>
                  </label>
                </div>
                <button className="primary" onClick={submitReview}>
                  记录评审
                </button>
              </div>
            )}
            {invalidReviews.length > 0 && (
              <div className="inline-notice warn">
                {invalidReviews.length} 条评审基于旧配方版本已失效，请按当前版本 {currentFv?.version} 重新记录并确认。
              </div>
            )}
            {[...batch.reviews]
              .sort((a, b) => b.recordedAt - a.recordedAt)
              .map((r) => (
                <article key={r.id} className={`record-card ${r.pending ? "pending-row" : ""} ${!r.valid ? "invalid" : ""}`}>
                  <div className="record-main">
                    <div className="record-title">
                      <strong>{REVIEW_RESULT_LABEL[r.result]}</strong>
                      {r.confirmed && <span className="badge confirmed">已确认</span>}
                      {r.valid ? (
                        <span className="badge valid">有效</span>
                      ) : (
                        <span className="badge invalid">已失效</span>
                      )}
                      {r.pending && <span className="badge pending">待同步</span>}
                      {r.pendingConfirm && <span className="badge pending">确认待同步</span>}
                      <SourceTag source={r.source} />
                    </div>
                    <p className="record-line">
                      依据配方版本{" "}
                      {batch.formulaVersions.find((v) => v.id === r.formulaVersionId)?.version ?? "已删除版本"}
                      {r.confirmed && r.confirmedAt ? ` · 确认于 ${fmtTime(r.confirmedAt)}` : ""}
                    </p>
                    <p className="record-time">{fmtTime(r.recordedAt)}</p>
                  </div>
                  {r.valid && !r.confirmed && (
                    <button className="mini primary" onClick={() => onConfirm(r.id)}>
                      确认评审
                    </button>
                  )}
                  {!r.valid && (
                    <button
                      className="mini"
                      onClick={() => {
                        setShowReviewForm(true);
                      }}
                    >
                      重新记录评审
                    </button>
                  )}
                </article>
              ))}
          </div>
        )}

        {tab === "history" && (
          <ol className="timeline">
            {[...batch.history]
              .sort((a, b) => b.at - a.at)
              .map((h) => (
                <li key={h.id} className={`timeline-item kind-${h.kind}`}>
                  <span className="timeline-dot" />
                  <div>
                    <p className="timeline-title">
                      <em>{HISTORY_KIND_LABEL[h.kind as HistoryKind]}</em>
                      <time>{fmtTime(h.at)}</time>
                    </p>
                    <p className="timeline-detail">{h.detail}</p>
                  </div>
                </li>
              ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ---------------- 续办中心（离线暂存 / 冲突 / 待重试） ---------------- */

export function OutboxPanel({
  outbox,
  batches,
  isOnline,
  onResolve,
  onDiscard,
  onRetry,
  onSelect,
}: {
  outbox: OutboxItem[];
  batches: Record<ID, Batch>;
  isOnline: boolean;
  onResolve: (itemId: ID, action: "keep_remote" | "keep_local") => void;
  onDiscard: (itemId: ID) => void;
  onRetry: (itemId: ID) => void;
  onSelect: (id: ID) => void;
}) {
  if (outbox.length === 0) {
    return (
      <div className="outbox-empty">
        <p>暂无待续办内容</p>
        <span>离线登记的批次、配方修订、复测与评审会在此排队，联网后按版本逐项合并。</span>
      </div>
    );
  }
  return (
    <div className="outbox-list">
      {outbox.map((item) => {
        const b = batches[item.batchId];
        return (
          <article key={item.id} className={`outbox-card status-${item.status}`}>
            <div className="outbox-head">
              <span className="op-tag">{OP_LABEL[item.op]}</span>
              <button className="link" onClick={() => b && onSelect(b.id)}>
                {item.batchCode}
              </button>
              <StatusBadge status={item.status} />
            </div>
            <p className="outbox-summary">
              {summarize(item, (fvId) => {
                const b = batches[item.batchId];
                return b?.formulaVersions.find((v) => v.id === fvId)?.version ?? "已删除版本";
              })}
            </p>
            {item.status === "conflict" && item.conflict && (
              <div className="conflict-box">
                {item.conflict.protectedReview && (
                  <div className="inline-notice err">
                    他处已存在确认评审，受保护不可覆盖。只能保留他处结果；本地评审内容不会被采用。
                  </div>
                )}
                <table className="diff-table">
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th>本地离线</th>
                      <th>他处（服务端）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.conflict.diffs.map((d) => (
                      <tr key={d.field}>
                        <td>{d.label}</td>
                        <td className="local">{d.local || "—"}</td>
                        <td className="remote">{d.remote || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="outbox-actions">
                  <button className="primary" onClick={() => onResolve(item.id, "keep_remote")}>
                    保留他处{item.conflict.protectedReview ? "已确认评审" : "版本"}
                  </button>
                  {!item.conflict.protectedReview && item.op === "formula_update" && (
                    <button onClick={() => onResolve(item.id, "keep_local")}>采用本地修订</button>
                  )}
                  <button className="ghost" onClick={() => onDiscard(item.id)}>
                    放弃该条
                  </button>
                </div>
              </div>
            )}
            {item.status === "failed" && (
              <div className="failed-box">
                <p className="error-msg">
                  第 {item.attempts} 次合并失败：{item.error}
                </p>
                <p className="retry-note">待重试内容已保留，联网后可重新合并。</p>
                <div className="outbox-actions">
                  <button
                    className="primary"
                    onClick={() => onRetry(item.id)}
                    disabled={!isOnline}
                  >
                    立即重试
                  </button>
                  <button className="ghost" onClick={() => onDiscard(item.id)}>
                    放弃该条
                  </button>
                </div>
              </div>
            )}
            {item.status === "pending" && (
              <div className="outbox-foot">
                <span>{isOnline ? "等待合并…" : "离线排队中，联网后自动合并"}</span>
                <button className="ghost" onClick={() => onDiscard(item.id)}>
                  放弃
                </button>
              </div>
            )}
            <p className="outbox-time">暂存于 {fmtTime(item.queuedAt)}</p>
          </article>
        );
      })}
    </div>
  );
}

function summarize(item: OutboxItem, versionLabel: (fvId: ID) => string): string {
  const p = item.payload;
  switch (item.op) {
    case "batch_create":
      return `新批次 ${p.code}（${p.fabric}）`;
    case "formula_update":
      return `配方版本 → ${p.version}：${p.recipe || "（未填配方）"}`;
    case "retest_add":
      return `复测色差 ΔE ${p.deltaE}${p.note ? `（${p.note}）` : ""}，依据配方版本 ${versionLabel(p.formulaVersionId)}`;
    case "review_add":
      return `评审结果：${REVIEW_RESULT_LABEL[p.result as ReviewResult]}，依据配方版本 ${versionLabel(p.formulaVersionId)}`;
    case "review_confirm":
      return `确认评审（依据配方版本 ${versionLabel(p.formulaVersionId)}）`;
  }
}
