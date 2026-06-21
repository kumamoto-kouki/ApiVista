/**
 * 警告一覧表示ロジック(design.md「webview/warningsPanel」, tasks.md 4.3)。
 *
 * `LinkageOutput.warnings`(`Warning[]`)の件数・内容を`container`内に視認可能な形で表示する
 * 薄いDOM操作モジュール。`projectDepth.ts`/`depthSwitchControl.ts`同様、表示ロジック自体は
 * 状態を持たず、呼び出しごとに`container`の中身を入れ替えるステートレスな再描画方式を採る
 * (`webview/main.ts`が新しい`linkageData`受信時に呼び直す想定、design.mdの結線方針と一致)。
 *
 * `vscode`モジュールへの依存は持たない(Webview実行時の制約上、直接import自体が不可能)。
 * インジェクション対策として`innerHTML`は使用せず、`document.createElement`/`.textContent`のみ
 * で構築する(`target`/`reason`は現状machine-generatedで信頼できる値だが、確立済みパターン
 * `depthSwitchControl.ts`を踏襲する多重防御)。
 */
import type { Warning } from "../../route-linkage/models.js";

/**
 * `container`の既存の子要素をすべて取り除いたうえで、`warnings`の件数・内容を再描画する。
 *
 * Preconditions: `container`はDOMに接続済みの要素であること。
 * Postconditions: `container`の中身は呼び出し前の状態に関わらず`warnings`のみを反映した
 * 内容に完全に置き換わる(前回呼び出しの残留ノードは残らない)。
 * Invariants: `warnings.length === 0`の場合と`> 0`の場合は、テストから構造的に区別可能な
 * 表示になる(0件は件数バッジのみ、1件以上は件数バッジ+一覧)。
 */
export function renderWarnings(container: HTMLElement, warnings: readonly Warning[]): void {
  container.replaceChildren();

  const count = document.createElement("p");
  count.textContent = warnings.length === 0 ? "警告: 0件" : `警告: ${warnings.length}件`;
  container.appendChild(count);

  if (warnings.length === 0) {
    return;
  }

  const list = document.createElement("ul");
  for (const warning of warnings) {
    const item = document.createElement("li");

    const target = document.createElement("span");
    target.textContent = warning.target;

    const reason = document.createElement("span");
    reason.textContent = warning.reason;

    item.appendChild(target);
    item.appendChild(reason);
    list.appendChild(item);
  }
  container.appendChild(list);
}
