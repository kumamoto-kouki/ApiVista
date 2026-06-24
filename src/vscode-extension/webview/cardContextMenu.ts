/**
 * ノードカード右クリック時のコンテキストメニュー（webview）。
 *
 * `createDepthSwitchControl` と同様、`vscode` 非依存・DOM 操作のみの薄いファクトリ。
 * グラフの枠（ノードカード）を右クリックした際に「連携関数をコピー」など日本語項目を
 * 表示し、選択時に `onCopy(node)` を呼び出す。配色は VS Code のメニュー系テーマ変数を使う。
 *
 * 閉じ条件: メニュー外クリック（capture フェーズ）/ `Escape` キー / `close()` の明示呼び出し
 * （main.ts は再描画・pan/zoom 時に `close()` を呼ぶ）。
 */
import type { GraphNode } from "./projectDepth.js";

export interface CardContextMenu {
  /**
   * `(x, y)` 画面座標にメニューを開く。
   * 「連携関数をコピー」は `node.functionId` を持つ枠でのみ、「選択した枠をコピー」は
   * `selectedCount > 0` のときのみ表示する。両方とも非表示なら開かない。
   */
  open(x: number, y: number, node: GraphNode, selectedCount: number): void;
  /** メニューを閉じる（表示していなければ no-op）。 */
  close(): void;
  /** メニュー要素と登録したリスナーを破棄する。 */
  dispose(): void;
}

/**
 * カード右クリック用コンテキストメニューを生成する。
 *
 * @param onCopyLinked 「連携関数をコピー」選択時に対象ノードで呼ばれるコールバック
 * @param onCopySelected 「選択した枠をコピー」選択時に呼ばれるコールバック（選択集合は呼び出し側が保持）
 */
export function createCardContextMenu(
  onCopyLinked: (node: GraphNode) => void,
  onCopySelected: () => void,
): CardContextMenu {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.style.cssText = [
    "position:fixed",
    "z-index:9999",
    "display:none",
    "min-width:160px",
    "padding:4px",
    "border-radius:6px",
    "background:var(--vscode-menu-background,#252526)",
    "color:var(--vscode-menu-foreground,#cccccc)",
    "border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,#454545))",
    "box-shadow:0 2px 8px rgba(0,0,0,0.36)",
    "font-size:13px",
    "user-select:none",
  ].join(";");

  let currentNode: GraphNode | null = null;

  /** メニュー項目を生成する（ホバー配色付き）。`onClick` 内で `close()` 済み。 */
  const makeItem = (onClick: () => void): HTMLDivElement => {
    const el = document.createElement("div");
    el.setAttribute("role", "menuitem");
    el.style.cssText = [
      "padding:5px 10px",
      "border-radius:4px",
      "cursor:pointer",
      "white-space:nowrap",
    ].join(";");
    el.addEventListener("mouseenter", () => {
      el.style.background = "var(--vscode-menu-selectionBackground,#04395e)";
      el.style.color = "var(--vscode-menu-selectionForeground,#ffffff)";
    });
    el.addEventListener("mouseleave", () => {
      el.style.background = "transparent";
      el.style.color = "";
    });
    el.addEventListener("click", onClick);
    return el;
  };

  const linkedItem = makeItem(() => {
    const node = currentNode;
    close();
    if (node) onCopyLinked(node);
  });
  linkedItem.textContent = "連携関数をコピー";

  const selectedItem = makeItem(() => {
    close();
    onCopySelected();
  });

  menu.appendChild(linkedItem);
  menu.appendChild(selectedItem);

  document.body.appendChild(menu);

  function close(): void {
    if (menu.style.display === "none") return;
    menu.style.display = "none";
    currentNode = null;
  }

  function open(x: number, y: number, node: GraphNode, selectedCount: number): void {
    currentNode = node;
    // 表示可否: 連携関数=functionId 持ち、選択枠=選択あり。配色はホバー前状態に戻す。
    for (const el of [linkedItem, selectedItem]) {
      el.style.background = "transparent";
      el.style.color = "";
    }
    linkedItem.style.display = node.functionId ? "block" : "none";
    selectedItem.style.display = selectedCount > 0 ? "block" : "none";
    selectedItem.textContent = `選択した枠をコピー (${selectedCount})`;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
  }

  // メニュー外クリックで閉じる（capture で他ハンドラより先に判定）。
  const onDocPointerDown = (e: MouseEvent): void => {
    if (menu.style.display === "none") return;
    if (e.target instanceof Node && menu.contains(e.target)) return;
    close();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("mousedown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);

  function dispose(): void {
    document.removeEventListener("mousedown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    menu.remove();
  }

  return { open, close, dispose };
}
