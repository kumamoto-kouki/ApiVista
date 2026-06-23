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
  /** `(x, y)` 画面座標にメニューを開き、選択時 `onCopy(node)` を発火する。 */
  open(x: number, y: number, node: GraphNode): void;
  /** メニューを閉じる（表示していなければ no-op）。 */
  close(): void;
  /** メニュー要素と登録したリスナーを破棄する。 */
  dispose(): void;
}

/**
 * カード右クリック用コンテキストメニューを生成する。
 *
 * @param onCopy 「連携関数をコピー」選択時に対象ノードで呼ばれるコールバック
 */
export function createCardContextMenu(onCopy: (node: GraphNode) => void): CardContextMenu {
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

  const item = document.createElement("div");
  item.setAttribute("role", "menuitem");
  item.textContent = "連携関数をコピー";
  item.style.cssText = [
    "padding:5px 10px",
    "border-radius:4px",
    "cursor:pointer",
    "white-space:nowrap",
  ].join(";");
  item.addEventListener("mouseenter", () => {
    item.style.background = "var(--vscode-menu-selectionBackground,#04395e)";
    item.style.color = "var(--vscode-menu-selectionForeground,#ffffff)";
  });
  item.addEventListener("mouseleave", () => {
    item.style.background = "transparent";
    item.style.color = "";
  });
  item.addEventListener("click", () => {
    const node = currentNode;
    close();
    if (node) onCopy(node);
  });
  menu.appendChild(item);

  document.body.appendChild(menu);

  function close(): void {
    if (menu.style.display === "none") return;
    menu.style.display = "none";
    currentNode = null;
  }

  function open(x: number, y: number, node: GraphNode): void {
    currentNode = node;
    item.style.background = "transparent";
    item.style.color = "";
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
