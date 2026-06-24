/**
 * @vitest-environment jsdom
 */
/**
 * `depthSwitchControl`の単体テスト(design.md「webview/depthSwitchControl」, tasks.md 4.2)。
 *
 * Claude Design実装により`<select>`→タブ形式ボタングループに変更。
 * 3深度の選択肢提示・ボタンクリック時のコールバック発火・マウント時の非発火・
 * 複数インスタンスの独立性をカバーする(Requirement 4.1)。
 */
import { describe, expect, it, vi } from "vitest";

import type { Depth } from "../projectDepth.js";
import { createDepthSwitchControl } from "../depthSwitchControl.js";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** data-value 属性が一致するボタンを返す */
function getDepthButton(container: HTMLElement, depth: Depth): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[data-value="${depth}"]`);
  if (!btn) throw new Error(`button[data-value="${depth}"] not found`);
  return btn;
}

describe("createDepthSwitchControl", () => {
  it("renders exactly 3 buttons corresponding to the 3 Depth values", () => {
    const container = createContainer();

    createDepthSwitchControl(container, vi.fn());

    const buttons = Array.from(container.querySelectorAll("button"));
    const values = buttons.map((b) => b.dataset["value"]);

    expect(values).toHaveLength(3);
    expect(new Set(values)).toEqual(new Set<Depth>(["route", "file", "function"]));
  });

  it("does not invoke the callback just from rendering/mounting", () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);

    expect(onDepthChange).not.toHaveBeenCalled();
  });

  it('invokes the callback with "route" when the user clicks the route button', () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);
    getDepthButton(container, "route").click();

    expect(onDepthChange).toHaveBeenCalledTimes(1);
    expect(onDepthChange).toHaveBeenCalledWith("route");
  });

  it('invokes the callback with "file" when the user clicks the file button', () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);
    getDepthButton(container, "file").click();

    expect(onDepthChange).toHaveBeenCalledTimes(1);
    expect(onDepthChange).toHaveBeenCalledWith("file");
  });

  it('invokes the callback with "function" when the user clicks the function button', () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);
    getDepthButton(container, "function").click();

    expect(onDepthChange).toHaveBeenCalledTimes(1);
    expect(onDepthChange).toHaveBeenCalledWith("function");
  });

  it("does not cross-wire callbacks between two independent control instances", () => {
    const containerA = createContainer();
    const containerB = createContainer();
    const onDepthChangeA = vi.fn();
    const onDepthChangeB = vi.fn();

    createDepthSwitchControl(containerA, onDepthChangeA);
    createDepthSwitchControl(containerB, onDepthChangeB);

    getDepthButton(containerA, "function").click();

    expect(onDepthChangeA).toHaveBeenCalledTimes(1);
    expect(onDepthChangeA).toHaveBeenCalledWith("function");
    expect(onDepthChangeB).not.toHaveBeenCalled();
  });

  it("does not render a reanalyze button when onReanalyze is omitted", () => {
    const container = createContainer();
    createDepthSwitchControl(container, vi.fn());
    const reanalyze = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("再解析"),
    );
    expect(reanalyze).toBeUndefined();
  });

  it("renders a reanalyze button that invokes onReanalyze on click", () => {
    const container = createContainer();
    const onReanalyze = vi.fn();
    createDepthSwitchControl(container, vi.fn(), onReanalyze);

    const reanalyze = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("再解析"),
    );
    expect(reanalyze).toBeDefined();
    reanalyze?.click();
    expect(onReanalyze).toHaveBeenCalledTimes(1);
  });
});
