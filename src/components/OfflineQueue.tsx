import { useState } from "react";
import {
  BatchField,
  LabColor,
  PendingOp,
  RegistrationDraft,
  RetestPart,
} from "../types";
import {
  draftValueText,
  FIELD_LABEL,
  fieldValueText,
  formatLab,
  RETEST_PART_LABEL,
} from "../lib/engine";
import { LabApi } from "../lib/useLab";

const STATUS_TEXT: Record<PendingOp["status"], { text: string; cls: string }> = {
  queued: { text: "等待合并", cls: "queued" },
  conflict: { text: "两边都改 · 待逐项裁决", cls: "warn" },
  stale: { text: "配方版本已变 · 待重新确认", cls: "stale" },
  failed: { text: "合并失败 · 保留待重试", cls: "err" },
  applied: { text: "已合并", cls: "done" },
};

export function OfflineQueue({ lab }: { lab: LabApi }) {
  const active = lab.queue.filter((o) => o.status !== "applied");
  const applied = lab.queue.filter((o) => o.status === "applied");
  const remoteBatch = lab.batches; // 本地已通过拉取对账，含服务端最新值

  return (
    <section className="panel queue-panel">
      <div className="heading">
        <div>
          <p>离线续办队列</p>
          <h2>待合并内容（{active.length}）</h2>
        </div>
        {applied.length > 0 && (
          <button className="ghost" onClick={lab.clearApplied}>
            清除已合并（{applied.length}）
          </button>
        )}
      </div>

      {active.length === 0 ? (
        <p className="empty">
          没有待办。可先"模拟断网"后登记批次/记录复测，再"联网"观察按版本逐项合并。
        </p>
      ) : (
        <div className="queue-list">
          {active.map((op) => (
            <QueueItem key={op.opId} op={op} lab={lab} batches={remoteBatch} />
          ))}
        </div>
      )}

      {applied.length > 0 && (
        <details className="applied-list">
          <summary>已合并记录（{applied.length}）</summary>
          {applied.map((op) => (
            <div key={op.opId} className="op-row done-row">
              <span>{op.batchId}</span>
              <small>{op.type === "registration" ? "登记" : "复测"} · 尝试 {op.attempts} 次后成功</small>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

function QueueItem({
  op,
  lab,
  batches,
}: {
  op: PendingOp;
  lab: LabApi;
  batches: LabApi["batches"];
}) {
  const status = STATUS_TEXT[op.status];
  const batch = batches.find((b) => b.id === op.batchId);
  const [open, setOpen] = useState(op.status === "conflict" || op.status === "stale");

  return (
    <article className={`op-card ${status.cls}`}>
      <header onClick={() => setOpen((v) => !v)}>
        <div>
          <strong>
            {op.batchId} · {op.type === "registration" ? "离线登记" : "离线复测"}
          </strong>
          <small>
            {new Date(op.createdAt).toLocaleTimeString()} · 配方版本基准 v
            {op.type === "registration" ? op.draft?.recipeVersion : op.payload?.base.recipeVersion}
            {op.attempts > 0 && ` · 已尝试 ${op.attempts} 次`}
          </small>
        </div>
        <span className={`tag ${status.cls}`}>{status.text}</span>
      </header>

      {op.lastError && <p className="error-msg">失败原因：{op.lastError}</p>}

      {open && (
        <div className="op-body">
          {op.status === "failed" && (
            <div className="op-actions">
              <button className="primary" onClick={() => lab.retryOp(op.opId)}>
                保留内容 · 立即重试
              </button>
              <button onClick={() => lab.discardOp(op.opId)}>放弃该待办</button>
            </div>
          )}

          {op.status === "conflict" && op.conflict && op.type === "registration" && op.draft && batch && (
            <RegistrationConflict op={op} draft={op.draft} remote={batch} lab={lab} />
          )}
          {op.status === "conflict" && op.conflict && op.type === "retest" && op.payload && batch && (
            <RetestConflict op={op} lab={lab} />
          )}

          {op.status === "stale" && op.type === "retest" && batch && (
            <StaleRetest op={op} lab={lab} />
          )}

          {op.status === "queued" && (
            <div className="op-actions">
              <button className="primary" onClick={() => void lab.runSync()} disabled={!lab.online || lab.syncing}>
                {lab.online ? "立即合并" : "等待网络恢复"}
              </button>
              <button onClick={() => lab.discardOp(op.opId)}>放弃</button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function ChoiceRow({
  label,
  localText,
  remoteText,
  value,
  onChoose,
}: {
  label: string;
  localText: string;
  remoteText: string;
  value: "local" | "remote" | undefined;
  onChoose: (side: "local" | "remote") => void;
}) {
  return (
    <div className="choice-row">
      <div className="choice-label">{label}</div>
      <button
        className={`choice local ${value === "local" ? "pick" : ""}`}
        onClick={() => onChoose("local")}
        title="采用离线时所记的值"
      >
        <small>离线所记</small>
        <b>{localText || "（空）"}</b>
      </button>
      <button
        className={`choice remote ${value === "remote" ? "pick" : ""}`}
        onClick={() => onChoose("remote")}
        title="保留别处已更新到服务端的值"
      >
        <small>服务端现值</small>
        <b>{remoteText || "（空）"}</b>
      </button>
    </div>
  );
}

function RegistrationConflict({
  op,
  draft,
  remote,
  lab,
}: {
  op: PendingOp;
  draft: RegistrationDraft;
  remote: LabApi["batches"][number];
  lab: LabApi;
}) {
  const fields = op.conflict!.fields as BatchField[];
  const resolution = op.conflict!.resolution ?? {};
  const allChosen = fields.every((f) => resolution[f] !== undefined);
  const base = op.conflict!.base;

  // 与服务端有差异、但仅一边修改的字段：合并时自动取修改方，此处仅展示去向
  const autoMerges = base
    ? (Object.keys(FIELD_LABEL) as BatchField[]).filter((f) => {
        if (fields.includes(f)) return false;
        const sameAsRemote = draftValueText(f, draft) === fieldValueText(f, remote);
        if (sameAsRemote) return false;
        const localChanged = draftValueText(f, draft) !== draftValueText(f, base);
        const remoteChanged = fieldValueText(f, remote) !== draftValueText(f, base);
        return localChanged || remoteChanged;
      })
    : [];

  return (
    <div className="conflict-box">
      <p className="conflict-tip">
        同一批次两边都改过，以下 {fields.length} 项取值不同，<b>必须逐项裁决</b>，不会自动覆盖；
        {remote.review?.valid ? (
          <em className="protect">服务端已有确认的客户评审（{remote.review.by}），合并全程受保护，不会被盖掉。</em>
        ) : (
          <em>当前无已确认评审。</em>
        )}
      </p>
      <div className="choices">
        {fields.map((f) => (
          <ChoiceRow
            key={f}
            label={FIELD_LABEL[f]}
            localText={draftValueText(f, draft)}
            remoteText={fieldValueText(f, remote)}
            value={resolution[f] as "local" | "remote" | undefined}
            onChoose={(side) => lab.resolveConflict(op.opId, { [f]: side })}
          />
        ))}
      </div>
      {autoMerges.length > 0 && (
        <div className="auto-merges">
          <small>以下 {autoMerges.length} 项仅一边修改，执行合并时自动处理：</small>
          <ul>
            {autoMerges.map((f) => {
              const localChanged = draftValueText(f, draft) !== draftValueText(f, base!);
              return (
                <li key={f}>
                  {FIELD_LABEL[f]}：{localChanged ? "仅离线修改 → 取离线登记值" : "仅服务端修改 → 保留别处更新"}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="op-actions">
        <button onClick={() => lab.resolveAll(op.opId, "local")}>冲突项全部取离线</button>
        <button onClick={() => lab.resolveAll(op.opId, "remote")}>冲突项全部保留服务端</button>
        <button
          className="primary"
          disabled={!allChosen || !lab.online || lab.syncing}
          onClick={() => void lab.runSync()}
        >
          {allChosen ? "按裁决执行合并" : `还剩 ${fields.filter((f) => resolution[f] === undefined).length} 项待选`}
        </button>
      </div>
    </div>
  );
}

function RetestConflict({ op, lab }: { op: PendingOp; lab: LabApi }) {
  const fields = op.conflict!.fields as RetestPart[];
  const resolution = op.conflict!.resolution ?? {};
  const payload = op.payload!;
  const remote = lab.batches.find((b) => b.id === op.batchId)!;
  const allChosen = fields.every((f) => resolution[f] !== undefined);

  const localText = (p: RetestPart) =>
    p === "note" ? payload.note : payload.measured[p].toFixed(2);
  const remoteText = (p: RetestPart) =>
    p === "note" ? remote.retest?.note ?? "" : remote.retest?.measured[p].toFixed(2) ?? "";

  return (
    <div className="conflict-box">
      <p className="conflict-tip">
        复测色差两边都更新过，逐个 Lab 分量裁决，ΔE 将按最终选择对照标准样（{formatLab(remote.standardLab)}）重算。
      </p>
      <div className="choices">
        {fields.map((f) => (
          <ChoiceRow
            key={f}
            label={RETEST_PART_LABEL[f]}
            localText={localText(f)}
            remoteText={remoteText(f)}
            value={resolution[f] as "local" | "remote" | undefined}
            onChoose={(side) => lab.resolveConflict(op.opId, { [f]: side })}
          />
        ))}
      </div>
      <div className="op-actions">
        <button onClick={() => lab.resolveAll(op.opId, "local")}>全部取离线</button>
        <button onClick={() => lab.resolveAll(op.opId, "remote")}>全部保留服务端</button>
        <button
          className="primary"
          disabled={!allChosen || !lab.online || lab.syncing}
          onClick={() => void lab.runSync()}
        >
          {allChosen ? "按裁决执行合并" : `还剩 ${fields.filter((f) => resolution[f] === undefined).length} 项待选`}
        </button>
      </div>
    </div>
  );
}

function StaleRetest({ op, lab }: { op: PendingOp; lab: LabApi }) {
  const batch = lab.batches.find((b) => b.id === op.batchId)!;
  const [measured, setMeasured] = useState<LabColor>({ ...batch.standardLab });
  const [note, setNote] = useState("");
  const payload = op.payload!;

  return (
    <div className="conflict-box">
      <p className="conflict-tip stale-tip">
        离线复测依据配方 v{payload.base.recipeVersion}，而配方已修订为 v{batch.recipeVersion}：
        原复测（{formatLab(payload.measured)}）立即失效。请按 <b>v{batch.recipeVersion}</b> 重新复测并确认。
      </p>
      <div className="lab-inputs">
        {(["L", "a", "b"] as const).map((k) => (
          <label key={k} className="lab-cell">
            <span>{k}*</span>
            <input
              type="number"
              step="0.01"
              value={measured[k]}
              onChange={(e) => setMeasured({ ...measured, [k]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <input
        className="stale-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="新版本复测备注"
      />
      <div className="op-actions">
        <button className="primary" onClick={() => lab.rebaseRetest(op.opId, measured, note)}>
          {lab.online ? `按 v${batch.recipeVersion} 重新确认并合并` : `按 v${batch.recipeVersion} 重新确认（离线暂存）`}
        </button>
        <button onClick={() => lab.discardOp(op.opId)}>放弃旧复测</button>
      </div>
    </div>
  );
}
