/**
 * @vitest-environment jsdom
 */
/**
 * searchBox.ts の単体テスト。表示/非表示・入力・前後/閉じる・件数表示を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSearchBox, type SearchBox } from "../searchBox.js";

function makeHandlers() {
  return { onInput: vi.fn(), onNext: vi.fn(), onPrev: vi.fn(), onClose: vi.fn() };
}

describe("createSearchBox", () => {
  let container: HTMLElement;
  let box: SearchBox;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function input(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[type="text"]')!;
  }

  it("既定は非表示、open で表示される", () => {
    box = createSearchBox(container, makeHandlers());
    expect(box.isOpen()).toBe(false);
    box.open();
    expect(box.isOpen()).toBe(true);
  });

  it("入力で onInput がクエリ付きで呼ばれる", () => {
    const handlers = makeHandlers();
    box = createSearchBox(container, handlers);
    box.open();
    input().value = "posts";
    input().dispatchEvent(new Event("input"));
    expect(handlers.onInput).toHaveBeenCalledWith("posts");
  });

  it("Enter で onNext、Shift+Enter で onPrev", () => {
    const handlers = makeHandlers();
    box = createSearchBox(container, handlers);
    box.open();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(handlers.onPrev).toHaveBeenCalledTimes(1);
  });

  it("Escape で onClose", () => {
    const handlers = makeHandlers();
    box = createSearchBox(container, handlers);
    box.open();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("setCount が件数表示を更新する", () => {
    box = createSearchBox(container, makeHandlers());
    box.open();
    box.setCount(3, 12);
    expect(container.textContent).toContain("3 / 12");
  });

  it("close で非表示になり入力がクリアされる", () => {
    box = createSearchBox(container, makeHandlers());
    box.open();
    input().value = "x";
    box.close();
    expect(box.isOpen()).toBe(false);
    expect(input().value).toBe("");
  });

  it("コンテナがクリアされた後でも mount で復帰し、表示状態を保持する", () => {
    box = createSearchBox(container, makeHandlers());
    box.open();
    expect(box.isOpen()).toBe(true);

    // Cytoscape の cy.destroy() がコンテナの全子要素を除去する状況を再現
    container.replaceChildren();
    expect(container.querySelector('[role="search"]')).toBeNull();

    box.mount();
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    // 同一ノードの再マウントなので open 状態は保持される
    expect(box.isOpen()).toBe(true);
  });
});
