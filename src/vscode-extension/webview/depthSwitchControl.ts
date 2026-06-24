/**
 * 深度切替UI操作ロジック(design.md「webview/depthSwitchControl」, tasks.md 4.2)。
 *
 * 3段階の深度(ルート連携/ファイル単位/関数単位)をタブ形式のボタングループで提示し、
 * ユーザーが選択を変更した際にコールバックで対応する`Depth`を通知する薄いDOM操作モジュール。
 * `projectDepth.ts`の投影ロジック自体には依存せず、`Depth`型のみを型としてimportする。
 *
 * Claude Design実装: handoff.md §1・§8-6 に基づきタブUI＋ツールバーレイアウトに変更。
 * ツールバーには左端のタイトル、中央のタブグループ、右端の方向説明ラベルを配置する。
 * `onDepthChange` コールバックのシグネチャは既存と同一（main.ts/テスト互換）。
 */
import type { Depth } from "./projectDepth.js";

const DEPTH_OPTIONS: ReadonlyArray<{ value: Depth; label: string }> = [
  { value: "route", label: "ルート連携" },
  { value: "file", label: "ファイル単位" },
  { value: "function", label: "関数単位" },
];

/**
 * `container`内にツールバーを生成する。
 * - 左端: "ApiVista" タイトル + サブタイトル
 * - 中央: タブ形式の粒度切替ボタングループ
 * - 右端: "矢印=方向 (source → target)" の説明ラベル
 *
 * Preconditions: `container`はDOMに接続済みの要素であること。
 * Postconditions: `container`にツールバー要素が追加され、選択変更時に`onDepthChange`が呼ばれる。
 * Invariants: マウント直後は`onDepthChange`を呼び出さない。
 */
export function createDepthSwitchControl(
  container: HTMLElement,
  onDepthChange: (depth: Depth) => void,
  onReanalyze?: () => void,
): void {
  const toolbar = document.createElement("div");
  toolbar.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "padding:6px 12px",
    "border-bottom:1px solid var(--vscode-widget-border,#2b2b2b)",
    "background:var(--vscode-editor-background,#1f1f1f)",
    "gap:8px",
    "flex-shrink:0",
  ].join(";");

  // タイトル
  const title = document.createElement("span");
  title.style.cssText =
    "font-size:12px;font-weight:600;color:var(--vscode-foreground,#cccccc);white-space:nowrap;display:flex;align-items:center;gap:6px;";
  const icon = document.createElement("span");
  icon.textContent = "■";
  icon.style.color = "var(--vscode-charts-blue,#3794ff)";
  const titleText = document.createElement("span");
  titleText.textContent = "ApiVista";
  title.appendChild(icon);
  title.appendChild(titleText);

  // タブグループ
  const tabGroup = document.createElement("div");
  tabGroup.style.cssText = "display:flex;gap:2px;";

  let activeButton: HTMLButtonElement | null = null;

  for (const option of DEPTH_OPTIONS) {
    const btn = document.createElement("button");
    btn.textContent = option.label;
    btn.dataset["value"] = option.value;
    btn.style.cssText = [
      "padding:3px 10px",
      "font-size:11px",
      "border:1px solid transparent",
      "border-radius:4px",
      "cursor:pointer",
      "background:transparent",
      "color:var(--vscode-foreground,#cccccc)",
      "transition:background 0.1s",
    ].join(";");

    const setActive = (b: HTMLButtonElement, active: boolean) => {
      if (active) {
        b.style.background = "var(--vscode-button-background,#0e639c)";
        b.style.color = "var(--vscode-button-foreground,#ffffff)";
        b.style.borderColor = "var(--vscode-focusBorder,#007acc)";
      } else {
        b.style.background = "transparent";
        b.style.color = "var(--vscode-foreground,#cccccc)";
        b.style.borderColor = "transparent";
      }
    };

    if (option.value === "route") {
      setActive(btn, true);
      activeButton = btn;
    }

    btn.addEventListener("click", () => {
      if (activeButton) {
        setActive(activeButton, false);
      }
      setActive(btn, true);
      activeButton = btn;
      onDepthChange(option.value);
    });

    tabGroup.appendChild(btn);
  }

  // 右端: 説明ラベル + 再解析ボタン
  const right = document.createElement("div");
  right.style.cssText = "display:flex;align-items:center;gap:10px;";

  const hint = document.createElement("span");
  hint.textContent = "矢印 = 方向 (source → target)";
  hint.style.cssText =
    "font-size:10px;color:var(--vscode-descriptionForeground,#9d9d9d);white-space:nowrap;";
  right.appendChild(hint);

  if (onReanalyze !== undefined) {
    const reanalyzeBtn = document.createElement("button");
    reanalyzeBtn.textContent = "⟳ 再解析";
    reanalyzeBtn.title = "対象プロジェクトを再解析する";
    reanalyzeBtn.style.cssText = [
      "padding:3px 10px",
      "font-size:11px",
      "border:1px solid var(--vscode-button-border,transparent)",
      "border-radius:4px",
      "cursor:pointer",
      "background:var(--vscode-button-secondaryBackground,#313131)",
      "color:var(--vscode-button-secondaryForeground,#cccccc)",
      "white-space:nowrap",
    ].join(";");
    reanalyzeBtn.addEventListener("click", () => onReanalyze());
    right.appendChild(reanalyzeBtn);
  }

  toolbar.appendChild(title);
  toolbar.appendChild(tabGroup);
  toolbar.appendChild(right);
  container.appendChild(toolbar);
}
