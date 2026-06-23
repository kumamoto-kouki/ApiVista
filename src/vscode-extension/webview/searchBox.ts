/**
 * グラフ右上に表示する文字列検索ボックス（webview）。
 *
 * `createDepthSwitchControl` / `createCardContextMenu` と同様、`vscode` 非依存・DOM 操作のみの
 * 薄いファクトリ。一致判定・ハイライト・中央寄せといった検索ロジックは呼び出し側(main.ts)が
 * ハンドラで担い、本モジュールは UI（入力・件数・前後/閉じる操作）に専念する。
 *
 * 既定は非表示。`open()` で表示しフォーカス、`Escape`/閉じるボタンで `onClose`。
 * `Enter`=`onNext` / `Shift+Enter`=`onPrev`。
 */
export interface SearchBoxHandlers {
  /** 入力が変わるたびに呼ばれる（クエリ文字列）。 */
  onInput(query: string): void;
  /** 次の一致へ（Enter / ▼）。 */
  onNext(): void;
  /** 前の一致へ（Shift+Enter / ▲）。 */
  onPrev(): void;
  /** 検索を閉じる（Escape / ×）。 */
  onClose(): void;
}

export interface SearchBox {
  /** 表示して入力欄へフォーカスする。 */
  open(): void;
  /** 非表示にする（入力値は保持しない＝クリア）。 */
  close(): void;
  /** 表示中かどうか。 */
  isOpen(): boolean;
  /** 件数表示を更新する（current は 1 始まり、該当なしは 0/0）。 */
  setCount(current: number, total: number): void;
  /**
   * ボックスをコンテナへ(再)マウントする。
   * Cytoscape の `cy.destroy()` はコンテナの全子要素を除去するため（グラフ再描画のたびに発生）、
   * 同じコンテナを共有する本ボックスも一緒に切り離される。再描画後に呼び出して復帰させる。
   * 既にマウント済みなら no-op（同一ノードの appendChild は移動のみ）。表示/入力状態は保持される。
   */
  mount(): void;
}

/**
 * 検索ボックスを `container`（グラフコンテナ想定）内の右上に生成する。
 *
 * @param container 絶対配置の基準となる要素（`position:relative` 前提）
 * @param handlers 入力・前後・閉じるのコールバック
 */
export function createSearchBox(container: HTMLElement, handlers: SearchBoxHandlers): SearchBox {
  const box = document.createElement("div");
  box.setAttribute("role", "search");
  box.style.cssText = [
    "position:absolute",
    "top:8px",
    "right:8px",
    "z-index:10",
    "display:none",
    "align-items:center",
    "gap:4px",
    "padding:4px 6px",
    "border-radius:6px",
    "background:var(--vscode-editorWidget-background,#252526)",
    "border:1px solid var(--vscode-widget-border,#454545)",
    "box-shadow:0 2px 8px rgba(0,0,0,0.36)",
    "pointer-events:auto",
  ].join(";");

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "枠を検索...";
  input.style.cssText = [
    "width:180px",
    "padding:3px 6px",
    "font-size:13px",
    "border-radius:4px",
    "border:1px solid var(--vscode-input-border,transparent)",
    "background:var(--vscode-input-background,#3c3c3c)",
    "color:var(--vscode-input-foreground,#cccccc)",
    "outline:none",
  ].join(";");

  const count = document.createElement("span");
  count.style.cssText =
    "font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);min-width:42px;text-align:center;white-space:nowrap;";
  count.textContent = "0 / 0";

  const mkButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = [
      "padding:2px 6px",
      "font-size:12px",
      "border:none",
      "border-radius:4px",
      "cursor:pointer",
      "background:transparent",
      "color:var(--vscode-foreground,#cccccc)",
    ].join(";");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
      input.focus();
    });
    return btn;
  };

  const prevBtn = mkButton("▲", "前の一致 (Shift+Enter)", () => handlers.onPrev());
  const nextBtn = mkButton("▼", "次の一致 (Enter)", () => handlers.onNext());
  const closeBtn = mkButton("✕", "閉じる (Esc)", () => handlers.onClose());

  input.addEventListener("input", () => handlers.onInput(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) handlers.onPrev();
      else handlers.onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handlers.onClose();
    }
  });

  box.appendChild(input);
  box.appendChild(count);
  box.appendChild(prevBtn);
  box.appendChild(nextBtn);
  box.appendChild(closeBtn);
  container.appendChild(box);

  function open(): void {
    box.style.display = "flex";
    input.focus();
    input.select();
  }

  function close(): void {
    box.style.display = "none";
    input.value = "";
    count.textContent = "0 / 0";
  }

  function isOpen(): boolean {
    return box.style.display !== "none";
  }

  function setCount(current: number, total: number): void {
    count.textContent = `${current} / ${total}`;
  }

  function mount(): void {
    container.appendChild(box);
  }

  return { open, close, isOpen, setCount, mount };
}
