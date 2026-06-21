/**
 * Webviewパネルのライフサイクル管理と拡張⇄Webview間メッセージ中継
 * （design.md「graphPanel」, Requirements 3.1, 5.1, 5.2）。
 *
 * - パネルが既に開いていれば`reveal()`、なければ`createWebviewPanel`で生成する（シングルトン）。
 *   2回目以降の表示要求では既存パネルへ新しい`LinkageOutput`を自動再送しない（design.md
 *   「再解析完了時もホストは同じ`linkageData`メッセージを再送する」は`postLinkageUpdate`
 *   （`reanalysisWatcher`等、後続タスクが呼ぶ）の責務であり、`reveal()`単体の責務ではないため）。
 * - Webviewからの`"ready"`メッセージ受信後に初回の`linkageData`を送信する（design.mdの
 *   メッセージプロトコル: 「`ready`受信後にホストが初回`linkageData`を送る」）。
 * - Webviewからの`"nodeClick"`メッセージを受け取り`sourceJump.reveal`へ委譲する。
 *   `sourceJump.reveal`が失敗（reject）した場合は`vscode.window.showErrorMessage`のみを呼び、
 *   パネルの表示内容（`webview.html`・直近の`postMessage`内容）は変更しない
 *   （design.md「解析失敗時はパネルの表示内容を変更せず...`showErrorMessage`のみを呼ぶ」）。
 * - `onDidDispose`でシングルトン参照をクリアする。
 */
import * as vscode from "vscode";

import type { LinkageOutput } from "../route-linkage/models.js";
import * as sourceJump from "./sourceJump.js";
import type { WebviewToHostMessage } from "./webviewProtocol.js";
import { buildWebviewHtml } from "./webviewHtml.js";

const VIEW_TYPE = "apivista.graphPanel";
const PANEL_TITLE = "ApiVista";

/** `showOrReveal`の呼び出し元（`extension.ts`想定）が渡す最小限のコンテキスト。 */
export interface GraphPanelContext {
  extensionUri: vscode.Uri;
}

let currentPanel: vscode.WebviewPanel | undefined;

function handleNodeClick(
  payload: { file: string; line: number },
  panel: vscode.WebviewPanel,
): void {
  sourceJump.reveal(payload).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`ソースジャンプに失敗しました: ${message}`);
    void panel;
  });
}

function createPanel(
  context: GraphPanelContext,
  initialOutput: LinkageOutput,
  onDidDispose?: () => void,
): vscode.WebviewPanel {
  const localResourceRoot = vscode.Uri.joinPath(context.extensionUri, "media", "webview");

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [localResourceRoot],
  });

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
    if (message.type === "ready") {
      panel.webview.postMessage({ type: "linkageData", payload: initialOutput });
      return;
    }
    if (message.type === "nodeClick") {
      handleNodeClick(message.payload, panel);
    }
  });

  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
    onDidDispose?.();
  });

  return panel;
}

/**
 * グラフ表示コマンド実行時のエントリ。パネルが無ければ生成し初回`linkageData`送信を準備、
 * 既にあれば`reveal()`のみを行う（既存パネルへの新規データ送信は`postLinkageUpdate`の責務）。
 *
 * `onDidDispose`はパネルが**新規生成**された場合のみ、そのパネルの`onDidDispose`発火時に呼ばれる
 * （`reveal()`分岐では既存パネルのライフサイクルに変更がないため呼ばれない）。`extension.ts`が
 * パネル生成と対になる`reanalysisWatcher`の起動/破棄を結線するためのフックとして追加した
 * （design.mdの`graphPanel`自体はwatcherのライフサイクル管理を持たないため、本コールバックは
 * `showOrReveal`の戻り値を持たせない最小限の追加で済ませた）。
 */
export function showOrReveal(
  context: GraphPanelContext,
  initialOutput: LinkageOutput,
  onDidDispose?: () => void,
): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  currentPanel = createPanel(context, initialOutput, onDidDispose);
}

/**
 * 再解析完了等で更新された`LinkageOutput`を、開いている既存パネルへ送信する。
 * パネルが開いていない場合はno-op（design.mdは本関数を明示的に定義していないため、
 * `reanalysisWatcher`（タスク5）が再解析結果を反映するための最小限のAPIとして追加した。
 * CONCERNS参照）。
 */
export function postLinkageUpdate(output: LinkageOutput): void {
  if (!currentPanel) {
    return;
  }
  currentPanel.webview.postMessage({ type: "linkageData", payload: output });
}
