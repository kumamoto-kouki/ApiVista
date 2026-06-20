/**
 * 深度切替UI操作ロジック(design.md「webview/depthSwitchControl」, tasks.md 4.2)。
 *
 * 3段階の深度(ルート連携/ファイル単位/関数単位)を`<select>`で提示し、ユーザーが選択を変更した
 * 際にコールバックで対応する`Depth`を通知する薄いDOM操作モジュール。`projectDepth.ts`の投影
 * ロジック自体には依存せず、`Depth`型のみを型としてimportする(design.mdが定める
 * Webview層内の責務分離: 本モジュールはDOM結線のみを担い、投影ロジックは持たない)。
 *
 * `vscode`モジュールへの依存は持たない(Webview実行時の制約上、直接import自体が不可能)。
 */
import type { Depth } from "./projectDepth.js";

/** 深度切替`<select>`に表示するラベル(requirements.mdの用語: ルート連携/ファイル単位/関数単位)。 */
const DEPTH_OPTIONS: ReadonlyArray<{ value: Depth; label: string }> = [
  { value: "route", label: "ルート連携" },
  { value: "file", label: "ファイル単位" },
  { value: "function", label: "関数単位" },
];

/**
 * `container`内に3段階の深度切替UI(`<select>`+3`<option>`)を生成し、選択変更時に
 * `onDepthChange`を対応する`Depth`で呼び出す。
 *
 * Preconditions: `container`はDOMに接続済みの要素であること。
 * Postconditions: `container`に`<select>`要素が1つ追加され、3つの`Depth`に対応する`<option>`を持つ。
 * Invariants: マウント直後は`onDepthChange`を呼び出さない(ユーザー操作由来の`change`イベントのみ
 * 通知する)。複数回呼び出した場合、各呼び出しの`container`/`onDepthChange`は互いに独立する。
 */
export function createDepthSwitchControl(
  container: HTMLElement,
  onDepthChange: (depth: Depth) => void,
): void {
  const select = document.createElement("select");

  for (const { value, label } of DEPTH_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  select.addEventListener("change", () => {
    onDepthChange(select.value as Depth);
  });

  container.appendChild(select);
}
