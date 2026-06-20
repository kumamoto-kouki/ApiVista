/**
 * @vitest-environment jsdom
 */
/**
 * `depthSwitchControl`の単体テスト(design.md「webview/depthSwitchControl」, tasks.md 4.2)。
 *
 * DOM操作ロジックのため`vitest + jsdom`で検証する(vitest.config.tsはデフォルト`node`環境のため、
 * このファイルのみ`@vitest-environment jsdom`で明示的にjsdomへ切り替える)。
 * 3深度の選択肢提示・選択変更時のコールバック発火・マウント時の非発火・複数インスタンスの
 * 独立性をカバーする(Requirement 4.1)。
 */
import { describe, expect, it, vi } from "vitest";

import type { Depth } from "../projectDepth.js";
import { createDepthSwitchControl } from "../depthSwitchControl.js";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

function getSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector("select");
  if (!select) {
    throw new Error("select element not found in container");
  }
  return select;
}

function selectDepth(select: HTMLSelectElement, depth: Depth): void {
  select.value = depth;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("createDepthSwitchControl", () => {
  it("renders exactly 3 selectable options corresponding to the 3 Depth values", () => {
    const container = createContainer();

    createDepthSwitchControl(container, vi.fn());

    const select = getSelect(container);
    const values = Array.from(select.options).map((option) => option.value);

    expect(values).toHaveLength(3);
    expect(new Set(values)).toEqual(new Set<Depth>(["route", "file", "function"]));
  });

  it("does not invoke the callback just from rendering/mounting", () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);

    expect(onDepthChange).not.toHaveBeenCalled();
  });

  it('invokes the callback with "route" when the user selects route', () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);
    selectDepth(getSelect(container), "route");

    expect(onDepthChange).toHaveBeenCalledTimes(1);
    expect(onDepthChange).toHaveBeenCalledWith("route");
  });

  it('invokes the callback with "file" when the user selects file', () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);
    selectDepth(getSelect(container), "file");

    expect(onDepthChange).toHaveBeenCalledTimes(1);
    expect(onDepthChange).toHaveBeenCalledWith("file");
  });

  it('invokes the callback with "function" when the user selects function', () => {
    const container = createContainer();
    const onDepthChange = vi.fn();

    createDepthSwitchControl(container, onDepthChange);
    selectDepth(getSelect(container), "function");

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

    selectDepth(getSelect(containerA), "function");

    expect(onDepthChangeA).toHaveBeenCalledTimes(1);
    expect(onDepthChangeA).toHaveBeenCalledWith("function");
    expect(onDepthChangeB).not.toHaveBeenCalled();
  });
});
