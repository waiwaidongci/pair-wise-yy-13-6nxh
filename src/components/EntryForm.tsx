import { useState } from "react";
import { LabColor, RegistrationDraft } from "../types";
import { deltaE } from "../lib/engine";
import { LabApi } from "../lib/useLab";

interface Props {
  lab: LabApi;
  selectedBatchId?: string;
}

type Mode = "register" | "retest";

function emptyLab(): LabColor {
  return { L: 50, a: 0, b: 0 };
}

export function EntryForm({ lab, selectedBatchId }: Props) {
  const [mode, setMode] = useState<Mode>("register");
  const [id, setId] = useState("");
  const [customerOrder, setCustomerOrder] = useState("");
  const [fabric, setFabric] = useState("棉 100%");
  const [weight, setWeight] = useState("120 g/m²");
  const [dye, setDye] = useState("活性红3BS 1.20%");
  const [liquorRatio, setLiquorRatio] = useState("1:15");
  const [tempCurve, setTempCurve] = useState("30→60℃，1.5℃/min");
  const [holdMinutes, setHoldMinutes] = useState(40);
  const [finishing, setFinishing] = useState("柔软剂 2%");
  const [std, setStd] = useState<LabColor>({ L: 56.4, a: 42.1, b: -12.3 });
  const [recipeVersion, setRecipeVersion] = useState("1");
  const [measured, setMeasured] = useState<LabColor>(emptyLab());
  const [note, setNote] = useState("");
  const [reviewer, setReviewer] = useState("实验室-小张");

  const selected = lab.batches.find((b) => b.id === selectedBatchId);

  const switchMode = (m: Mode) => {
    setMode(m);
    if (m === "retest" && selected) {
      setMeasured({ ...selected.standardLab });
      setNote("");
    }
  };

  const submitRegister = () => {
    if (!id.trim() || !customerOrder.trim()) {
      lab.setNotice("批次号与客户订单必填");
      return;
    }
    const draft: RegistrationDraft & { id: string } = {
      id: id.trim().toUpperCase(),
      customerOrder: customerOrder.trim(),
      fabric,
      weight,
      recipe: {
        items: dye
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
      },
      tempCurve,
      holdMinutes: Number(holdMinutes) || 0,
      finishing,
      standardLab: std,
      recipeVersion,
    };
    lab.registerBatch(draft);
    setId("");
    setCustomerOrder("");
  };

  const submitRetest = () => {
    if (!selected) {
      lab.setNotice("请先在批次列表中选择要复测的批次");
      return;
    }
    lab.addRetest(selected.id, measured, note);
    setNote("");
  };

  const previewDelta = selected ? deltaE(measured, selected.standardLab) : 0;

  return (
    <section className="panel form-panel">
      <div className="heading">
        <div>
          <p>离线续办</p>
          <h2>小样登记 / 复测</h2>
        </div>
        <div className="seg">
          <button className={mode === "register" ? "on" : ""} onClick={() => switchMode("register")}>
            逐个登记批次
          </button>
          <button className={mode === "retest" ? "on" : ""} onClick={() => switchMode("retest")}>
            送样复测
          </button>
        </div>
      </div>

      {mode === "register" ? (
        <>
          <div className="field-grid">
            <label>
              <span>批次号</span>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="如 LAB-630F" />
            </label>
            <label>
              <span>客户订单</span>
              <input value={customerOrder} onChange={(e) => setCustomerOrder(e.target.value)} placeholder="如 PO-2430 客户名" />
            </label>
            <label>
              <span>面料成分</span>
              <input value={fabric} onChange={(e) => setFabric(e.target.value)} />
            </label>
            <label>
              <span>克重</span>
              <input value={weight} onChange={(e) => setWeight(e.target.value)} />
            </label>
            <label className="wide">
              <span>染料配方（多项用分号或换行分隔）</span>
              <textarea rows={2} value={dye} onChange={(e) => setDye(e.target.value)} />
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
              <span>保温时间（min）</span>
              <input type="number" value={holdMinutes} onChange={(e) => setHoldMinutes(Number(e.target.value))} />
            </label>
            <label>
              <span>后整理方式</span>
              <input value={finishing} onChange={(e) => setFinishing(e.target.value)} />
            </label>
            <label>
              <span>配方版本（送样所依据版本）</span>
              <input value={recipeVersion} onChange={(e) => setRecipeVersion(e.target.value)} />
            </label>
            <LabTriad label="标准样 Lab" value={std} onChange={setStd} />
          </div>
          <div className="form-foot">
            <span className="hint">
              {lab.online
                ? "在线提交将立即上送；若同批次别处已登记/修改，自动列出逐项差异"
                : "断网提交：批次与配方版本暂存本地，恢复网络后按版本逐项合并"}
            </span>
            <button className="primary" onClick={submitRegister}>
              {lab.online ? "登记并上送" : "离线暂存登记"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="field-grid">
            <label className="wide">
              <span>复测批次</span>
              <input
                value={selected ? `${selected.id}（配方 v${selected.recipeVersion}）` : ""}
                readOnly
                placeholder="请在下方批次列表中选择"
              />
            </label>
            <LabTriad label="实测 Lab" value={measured} onChange={setMeasured} />
            <label className="wide">
              <span>复测备注</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如 升温偏快、b 值偏黄" />
            </label>
          </div>
          <div className="form-foot">
            <span className="hint">
              {selected
                ? `标准样 Lab ${selected.standardLab.L.toFixed(1)}/${selected.standardLab.a.toFixed(1)}/${selected.standardLab.b.toFixed(1)}，当前 ΔE 预估 ${previewDelta}（以所依据配方 v${selected.recipeVersion} 为准）`
                : "未选择批次"}
            </span>
            <button className="primary" onClick={submitRetest} disabled={!selected}>
              {lab.online ? "复测并上送" : "离线暂存复测"}
            </button>
          </div>
          <div className="review-row">
            <span>客户在线评审（仅联网可用，确认后受保护）：</span>
            <input
              className="reviewer"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              placeholder="评审人"
            />
            <button
              disabled={!lab.online || !selected}
              onClick={() => selected && lab.submitReview(selected.id, "approved", "在线确认", reviewer)}
            >
              评审通过
            </button>
            <button
              disabled={!lab.online || !selected}
              onClick={() => selected && lab.submitReview(selected.id, "rejected", "需复染", reviewer)}
            >
              不通过
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function LabTriad({
  label,
  value,
  onChange,
}: {
  label: string;
  value: LabColor;
  onChange: (v: LabColor) => void;
}) {
  return (
    <label className="wide">
      <span>{label}</span>
      <div className="lab-inputs">
        {(["L", "a", "b"] as const).map((k) => (
          <label key={k} className="lab-cell">
            <span>{k}*</span>
            <input
              type="number"
              step="0.01"
              value={value[k]}
              onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </label>
  );
}
