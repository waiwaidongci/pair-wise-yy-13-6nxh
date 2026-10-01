import { useMemo, useState } from "react";
import "./styles.css";
import { useDyeLab } from "./useDyeLab";
import {
  BatchDetail,
  BatchForm,
  BatchList,
  NetworkBadge,
  OutboxPanel,
} from "./components";

function App() {
  const lab = useDyeLab();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showBatchForm, setShowBatchForm] = useState(false);

  const displayBatches = useMemo(
    () => Object.values(lab.batches).sort((a, b) => b.createdAt - a.createdAt),
    [lab.batches],
  );
  const selected = selectedId ? lab.batches[selectedId] : null;

  const pendingCount = lab.outbox.filter((i) => i.status === "pending").length;
  const conflictCount = lab.outbox.filter((i) => i.status === "conflict").length;
  const failedCount = lab.outbox.filter((i) => i.status === "failed").length;

  const overLimitCount = useMemo(() => {
    return Object.values(lab.batches).filter((b) => {
      const latest = [...b.retests]
        .filter((r) => r.valid)
        .sort((a, c) => c.recordedAt - a.recordedAt)[0];
      return latest && latest.deltaE > 1;
    }).length;
  }, [lab.batches]);

  const passRate = useMemo(() => {
    const confirmed = Object.values(lab.batches).flatMap((b) =>
      b.reviews.filter((r) => r.confirmed),
    );
    if (!confirmed.length) return "—";
    const passed = confirmed.filter((r) => r.result === "passed").length;
    return `${Math.round((passed / confirmed.length) * 100)}%`;
  }, [lab.batches]);

  const metrics = [
    { label: "小样批次", value: displayBatches.length },
    { label: "待同步续办", value: lab.outbox.length },
    { label: "色差超限批次", value: overLimitCount },
    { label: "评审通过率", value: passRate },
  ];

  return (
    <main className="app">
      <header className="hero">
        <div className="hero-top">
          <div>
            <p>hxyfront-62012 · 源提示词 7 · 离线续办</p>
            <h1>纺织染整小样管理</h1>
            <span>
              断网时登记批次、配方版本与复测色差，联网后按版本逐项合并；两边都改过时列清差异，已确认评审结果不可覆盖；
              配方版本一变，复测与评审立即失效并重新确认；合并失败保留待重试，处理过程全程留痕。
            </span>
          </div>
          <NetworkBadge online={lab.isOnline} />
        </div>
        <div className="toolbar">
          <button
            className={lab.forceOffline ? "primary" : ""}
            onClick={() => lab.setForceOffline((v) => !v)}
          >
            {lab.forceOffline ? "恢复联网" : "模拟断网"}
          </button>
          <label className="switch">
            <input
              type="checkbox"
              checked={lab.simulateFail}
              onChange={(e) => lab.setSimulateFail(e.target.checked)}
            />
            <span>模拟合并失败</span>
          </label>
          <button onClick={lab.simulateRemoteUpdateAction}>模拟他处更新</button>
          <button className="primary" onClick={lab.syncNow} disabled={!lab.isOnline || lab.syncing}>
            {lab.syncing ? "同步中…" : "立即同步"}
          </button>
        </div>
      </header>

      {lab.notice && (
        <div className={`notice ${lab.notice.type}`}>
          <span>{lab.notice.text}</span>
          <button className="link" onClick={() => lab.setNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {!lab.isOnline && (
        <div className="offline-banner">
          <strong>离线续办模式：</strong>
          批次登记、配方修订、复测色差与评审记录仍可正常填写，内容暂存在本机；联网后自动按版本逐项合并。
          他处已确认的评审结果受保护，不会被离线修订覆盖。
        </div>
      )}

      <section className="metrics">
        {metrics.map((m) => (
          <article key={m.label}>
            <small>{m.label}</small>
            <strong>{m.value}</strong>
          </article>
        ))}
      </section>

      <section className="workspace three-col">
        <aside className="panel list-panel">
          <div className="heading">
            <div>
              <p>小样批次</p>
              <h2>批次列表</h2>
            </div>
            <button className="primary" onClick={() => setShowBatchForm((v) => !v)}>
              {showBatchForm ? "收起" : "新增批次"}
            </button>
          </div>
          {showBatchForm && (
            <BatchForm
              onSubmit={(data) => {
                lab.addBatch(data);
                setShowBatchForm(false);
              }}
            />
          )}
          <BatchList
            batches={displayBatches}
            outbox={lab.outbox}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>

        <section className="panel detail-panel">
          {selected ? (
            <BatchDetail
              batch={selected}
              outbox={lab.outbox}
              onFormula={(data) => lab.updateFormula(selected.id, data)}
              onRetest={(deltaE, note) => lab.addRetest(selected.id, { deltaE, note })}
              onReview={(result) => lab.addReview(selected.id, result)}
              onConfirm={(reviewId) => lab.confirmReview(selected.id, reviewId)}
            />
          ) : (
            <div className="empty-detail">
              <h2>选择一个批次</h2>
              <p>查看配方版本、复测色差、评审结果与处理过程；离线时填写的内容会在此排队，联网后逐项合并。</p>
            </div>
          )}
        </section>

        <aside className="panel outbox-panel">
          <div className="heading">
            <div>
              <p>离线续办</p>
              <h2>
                续办中心
                {(pendingCount + conflictCount + failedCount > 0) && (
                  <span className="heading-count">
                    {pendingCount} 待同步 · {conflictCount} 冲突 · {failedCount} 待重试
                  </span>
                )}
              </h2>
            </div>
          </div>
          <OutboxPanel
            outbox={lab.outbox}
            batches={lab.batches}
            isOnline={lab.isOnline}
            onResolve={lab.resolveConflictAction}
            onDiscard={lab.discardAction}
            onRetry={lab.retryAction}
            onSelect={setSelectedId}
          />
        </aside>
      </section>

      <footer className="footnote">
        <span>
          合并规则：按版本逐项合并；同一批次两边都改时列出字段级差异；已确认评审结果受保护不可覆盖；
          配方版本变更后复测与评审立即失效，需重新复测 / 确认；合并失败保留待重试内容，处理过程留痕于批次。
        </span>
      </footer>
    </main>
  );
}

export default App;
