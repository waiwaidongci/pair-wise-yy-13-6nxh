// React 真实挂载冒烟测试：验证 App 在 jsdom 下无渲染/运行时错误，
// 并模拟"断网登记 → 联网自动合并 → 处理日志留痕"的关键交互路径。
// test-env 必须在最前导入（其中完成 JSDOM 与全局环境搭建）。
import { dom } from "./test-env";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import App from "../src/App";

const container = document.getElementById("root")!;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("❌", msg);
    process.exit(1);
  }
  console.log("✅", msg);
}

async function flush(ms = 500) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function click(el: Element) {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

async function main() {
  localStorage.clear();

  await act(async () => {
    createRoot(container).render(React.createElement(App));
  });
  await flush(600);

  assert(container.textContent!.includes("小样批次离线登记与按版本合并"), "App 渲染成功（标题）");
  assert(container.textContent!.includes("LAB-620A"), "种子批次 LAB-620A 已加载");
  assert(container.textContent!.includes("网络在线"), "初始在线状态显示");

  // 1) 模拟断网
  const offlineSwitch = Array.from(container.querySelectorAll("label.switch")).find((el) =>
    el.textContent!.includes("模拟断网")
  )!;
  await act(async () => {
    click(offlineSwitch.querySelector("input")!);
    await new Promise((r) => setTimeout(r, 50));
  });
  assert(container.textContent!.includes("断网离线"), "切换为离线状态");

  // 2) 离线登记一个新批次
  const formPanel = () =>
    Array.from(container.querySelectorAll("section.panel")).find((el) =>
      el.textContent!.includes("小样登记 / 复测")
    )!;
  const formInput = (matcher: (i: HTMLInputElement) => boolean) =>
    Array.from(formPanel().querySelectorAll<HTMLInputElement>("input")).find(matcher)!;

  await act(async () => {
    typeInto(formInput((i) => (i.placeholder ?? "").includes("LAB-630")), "LAB-630Z");
    typeInto(formInput((i) => (i.placeholder ?? "").includes("PO-2430")), "PO-2499 离线客户");
  });

  await act(async () => {
    click(
      Array.from(formPanel().querySelectorAll("button")).find((b) =>
        b.textContent!.includes("离线暂存登记")
      )!
    );
  });
  await flush(100);

  assert(container.textContent!.includes("LAB-630Z"), "离线登记批次出现在列表");
  assert(container.textContent!.includes("仅本地未上送"), "新批次标记仅本地未上送");
  assert(container.textContent!.includes("待合并内容（1）"), "离线队列出现 1 项待办");

  // 3) 恢复网络：自动上送合并
  const onlineSwitch = Array.from(container.querySelectorAll("label.switch")).find((el) =>
    el.textContent!.includes("模拟联网")
  )!;
  await act(async () => {
    click(onlineSwitch.querySelector("input")!);
  });
  await flush(900);

  const text1 = container.textContent!;
  assert(/成功 1 项/.test(text1), "联网后自动合并成功");
  const newBatchSection = text1;
  assert(newBatchSection.includes("LAB-630Z"), "合并后批次仍在列表");

  // 4) 处理过程日志可见（含离线暂存与合并留痕）
  const logBtns = Array.from(container.querySelectorAll("button")).filter((b) =>
    b.textContent!.includes("查看处理过程")
  );
  assert(logBtns.length >= 4, "每个批次都有处理过程入口");
  await act(async () => {
    click(logBtns[0]);
  });
  await flush(50);
  assert(
    container.textContent!.includes("离线暂存") || container.textContent!.includes("离线登记"),
    "处理日志中保留离线记录"
  );

  // 5) 状态指示：无残留失败/冲突
  assert(!/失败 [1-9]/.test(container.textContent!), "无失败待办");

  console.log("\nReact 挂载与关键交互冒烟测试全部通过");
  // jsdom 可能保留定时器句柄，显式退出避免悬挂
  process.exit(0);
}

main().catch((e) => {
  console.error("冒烟测试失败：", e);
  process.exit(1);
});
