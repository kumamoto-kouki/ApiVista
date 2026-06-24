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
    functionId: "backend:fn-getUser",
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
    menu = createCardContextMenu(onCopy, vi.fn());
    const node = makeNode();

    menu.open(100, 120, node, 0);
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
    menu = createCardContextMenu(onCopy, vi.fn());
    menu.open(0, 0, makeNode(), 0);

    expect(getMenu()!.style.display).toBe("block");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(getMenu()!.style.display).toBe("none");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("メニュー外の mousedown で閉じる", () => {
    const onCopy = vi.fn();
    menu = createCardContextMenu(onCopy, vi.fn());
    menu.open(0, 0, makeNode(), 0);

    expect(getMenu()!.style.display).toBe("block");

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(getMenu()!.style.display).toBe("none");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("dispose でメニュー要素が DOM から除去される", () => {
    menu = createCardContextMenu(vi.fn(), vi.fn());
    menu.open(0, 0, makeNode(), 0);
    expect(getMenuItem()).not.toBeNull();

    menu.dispose();
    menu = undefined;

    expect(getMenuItem()).toBeNull();
  });

  it("選択あり時のみ「選択した枠をコピー」を表示し、クリックで onCopySelected を呼ぶ", () => {
    const onCopySelected = vi.fn();
    menu = createCardContextMenu(vi.fn(), onCopySelected);
    const items = () =>
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const selectedItem = () =>
      items().find((el) => el.textContent?.includes("選択した枠をコピー"))!;

    // 選択0件 → 非表示
    menu.open(0, 0, makeNode(), 0);
    expect(selectedItem().style.display).toBe("none");

    // 選択2件 → 件数付きで表示
    menu.open(0, 0, makeNode(), 2);
    expect(selectedItem().style.display).toBe("block");
    expect(selectedItem().textContent).toBe("選択した枠をコピー (2)");

    selectedItem().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCopySelected).toHaveBeenCalledTimes(1);
    expect(getMenu()!.style.display).toBe("none");
  });

  it("functionId の無い枠では「連携関数をコピー」を非表示にする", () => {
    menu = createCardContextMenu(vi.fn(), vi.fn());
    menu.open(0, 0, makeNode({ functionId: undefined }), 1);
    const linked = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((el) => el.textContent === "連携関数をコピー")!;
    expect(linked.style.display).toBe("none");
  });
});
