// 必须在任何 React/App 模块导入前完成 JSDOM 环境搭建
// （ESM import 会被提升，因此独立成模块并置于导入链最前）
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:62012/",
  pretendToBeVisual: true,
});

Object.assign(globalThis as unknown as Record<string, unknown>, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  InputEvent: dom.window.InputEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
});

(globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame = ((
  cb: FrameRequestCallback
) => setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame;
(globalThis as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame = ((id: number) =>
  clearTimeout(id as unknown as NodeJS.Timeout)) as typeof cancelAnimationFrame;
(globalThis as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { dom };
