import { useState } from "react";
import "./styles.css";
import { useLab } from "./lib/useLab";
import { StatusBar } from "./components/StatusBar";
import { EntryForm } from "./components/EntryForm";
import { OfflineQueue } from "./components/OfflineQueue";
import { BatchList } from "./components/BatchList";

function App() {
  const lab = useLab();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("");

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62012 · 纺织染整小样管理 · 离线续办</p>
        <h1>小样批次离线登记与按版本合并</h1>
        <span>
          断网时记下批次、配方版本与复测色差；网络恢复后按版本逐项合并。同一批次两边都改过则列清差异逐项裁决，
          已确认的客户评审结果受保护不被盖掉；配方版本一变，复测与评审立即失效并重新确认；合并失败保留待重试，全部处理过程随批次留痕。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>小样批次</small>
          <strong>{lab.stats.total}</strong>
        </article>
        <article>
          <small>离线待办</small>
          <strong>{lab.stats.pending}</strong>
        </article>
        <article>
          <small>色差超限（ΔE&gt;1.5）</small>
          <strong>{lab.stats.overLimit}</strong>
        </article>
        <article>
          <small>客户订单</small>
          <strong>{lab.stats.orders}</strong>
        </article>
      </section>

      <StatusBar lab={lab} />

      <section className="workspace offline-workspace">
        <EntryForm lab={lab} selectedBatchId={selectedId} />
        <OfflineQueue lab={lab} />
      </section>

      <section className="panel filter-panel">
        <label>
          <span>按客户订单 / 面料 / 批次号筛选</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="如 PO-2401、棉、LAB-620"
          />
        </label>
      </section>

      <BatchList lab={lab} selectedId={selectedId} onSelect={setSelectedId} filter={filter} />

      <section className="panel flow-note">
        <h2>离线续办处理规则</h2>
        <ol>
          <li>断网登记/复测：批次、配方版本、复测 Lab 色差进入离线队列，本地立即可见。</li>
          <li>网络恢复：先拉取"别处"更新对账——配方版本不同则旧复测、旧评审立即标记失效（历史结论保留留痕）。</li>
          <li>逐项合并：本地改远端未改取本地，反之取远端；两边都改且不同的字段/色差分量列清差异，逐项裁决后才写入。</li>
          <li>评审保护：服务端已确认（valid）的客户评审，任何字段合并都不会覆盖。</li>
          <li>失效重认：复测基于新版本重新提交；评审需客户在线重新确认。</li>
          <li>失败保留：上送/合并失败的待办原样保留在队列并记录原因，可随时重试；处理过程全部写入批次日志。</li>
        </ol>
      </section>
    </main>
  );
}

export default App;
