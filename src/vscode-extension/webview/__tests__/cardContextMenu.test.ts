/**
 * @vitest-environment jsdom
 */
/**
 * cardContextMenu.ts の単体テスト。
 *
 * DOM 操作のみのファクトリのため jsdom で検証する。`open` で表示・項目クリックで `onCopy`、
 * `Escape`/外側クリック/`close` で閉じることを確認する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCardContextMenu, type CardContextMenu } from "../cardContextMenu.js";
import type { GraphNode } from "../projectDepth.js";

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "route:GET:/api/users/{id}:backend/routes/users.ts:10",
    kind: "route",
    side: "backend",
    label: "GET /api/users/{id}",
    unmatched: false,
    sourceLocation: { file: "backend/routes/users.ts", line: 10 },
    ...overrides,
  };
}

/** メニュー項目「連携関数をコピー」要素を取得する。 */
function getMenuItem(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="menuitem"]');
}

/** メニューコンテナ要素を取得する。 */
function getMenu(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="menu"]');
}

describe("createCardContextMenu", () => {
  let menu: CardContextMenu | undefined;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    menu?.dispose();
    menu = undefined;
  });

  it("open で項目が表示され、クリックで onCopy(node) が呼ばれ閉じる", () => {
    const onCopy = vi.fn();
    menu = createCardContextMenu(onCopy);
    const node = makeNode();

    menu.open(100, 120, node);
    const item = getMenuItem();
    expect(item).not.toBeNull();
    expect(item!.textContent).toBe("連携関数をコピー");
    expect(getMenu()!.style.display).toBe("block");

    item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith(node);
    expect(getMenu()!.style.display).toBe("none");
  });

  it("Escape キーで閉じ、onCopy は呼ばれない", () => {
    const onCopy = vi.fn();
    menu = createCardContextMenu(onCopy);
    menu.open(0, 0, makeNode());

    expect(getMenu()!.style.display).toBe("block");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(getMenu()!.style.display).toBe("none");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("メニュー外の mousedown で閉じる", () => {
    const onCopy = vi.fn();
    menu = createCardContextMenu(onCopy);
    menu.open(0, 0, makeNode());

    expect(getMenu()!.style.display).toBe("block");

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(getMenu()!.style.display).toBe("none");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("dispose でメニュー要素が DOM から除去される", () => {
    menu = createCardContextMenu(vi.fn());
    menu.open(0, 0, makeNode());
    expect(getMenuItem()).not.toBeNull();

    menu.dispose();
    menu = undefined;

    expect(getMenuItem()).toBeNull();
  });
});
