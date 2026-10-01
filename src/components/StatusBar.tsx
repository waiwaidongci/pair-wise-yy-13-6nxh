import { LabApi } from "../lib/useLab";

export function StatusBar({ lab }: { lab: LabApi }) {
  const { online, syncing, notice, stats, setOnline, setFault, runSync, resetAll, faultNext } = lab;

  return (
    <section className="panel statusbar">
      <div className={`net-dot ${online ? "on" : "off"}`} />
      <div className="net-state">
        <strong>{online ? "网络在线" : "断网离线"}</strong>
        <small>
          {online
            ? "可上送合并、提交客户评审"
            : "登记批次与复测色差仅本地暂存，恢复后自动按版本合并"}
        </small>
      </div>

      <div className="queue-mini">
        <span>待办 {stats.pending}</span>
        {stats.conflict > 0 && <span className="tag warn">待裁决 {stats.conflict}</span>}
        {stats.stale > 0 && <span className="tag stale">待重认 {stats.stale}</span>}
        {stats.failed > 0 && <span className="tag err">失败 {stats.failed}</span>}
      </div>

      <div className="status-actions">
        <label className="switch">
          <input
            type="checkbox"
            checked={online}
            onChange={(e) => setOnline(e.target.checked)}
          />
          <span>模拟{online ? "断网" : "联网"}</span>
        </label>
        <label className="switch" title="开启后下一次服务端请求将失败，用于验证失败保留重试">
          <input
            type="checkbox"
            checked={faultNext}
            onChange={(e) => setFault(e.target.checked)}
          />
          <span>注入一次故障</span>
        </label>
        <button onClick={() => void runSync()} disabled={!online || syncing}>
          {syncing ? "合并中…" : "立即同步合并"}
        </button>
        <button className="ghost" onClick={resetAll}>
          重置演示数据
        </button>
      </div>

      {notice && <p className="notice">{notice}</p>}
    </section>
  );
}
