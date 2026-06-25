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

/**
 * Webview が現在表示している最新の `LinkageOutput`。`copyLinked` 受信時のコピー対象として使う。
 * `createPanel`（初期値）と `postLinkageUpdate`（再解析更新）で同期する。
 */
let latestOutput: LinkageOutput | undefined;

/** 新規パネル生成直後に流す保留フォーカス（revealInGraph 用、ready で消費）。 */
let pendingFocus: { file: string; line: number } | undefined;

/** `copyLinked` メッセージを処理するためにホスト側（extension.ts）が注入するコールバック。 */
export type CopyLinkedHandler = (output: LinkageOutput, payload: { functionId: string }) => void;

/** `copySelected` メッセージを処理するためにホスト側が注入するコールバック。 */
export type CopySelectedHandler = (
  output: LinkageOutput,
  payload: { functionIds: string[] },
) => void;

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
  onCopyLinked?: CopyLinkedHandler,
  onCopySelected?: CopySelectedHandler,
): vscode.WebviewPanel {
  const localResourceRoot = vscode.Uri.joinPath(context.extensionUri, "media", "webview");

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [localResourceRoot],
    // タブを別エディタに移して戻ってもWebviewのDOM/JS状態（選択中の粒度タブ・ズーム・検索など）を
    // 破棄せず保持する。これが無いと裏に回るたびにWebviewが再生成され、粒度タブが既定へ戻る。
    retainContextWhenHidden: true,
  });

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
    if (message.type === "ready") {
      panel.webview.postMessage({ type: "linkageData", payload: initialOutput });
      // 新規パネル生成直後の revealInGraph 用: 保留フォーカスがあればデータ送信後に流す。
      if (pendingFocus) {
        panel.webview.postMessage({ type: "focusNode", payload: pendingFocus });
        pendingFocus = undefined;
      }
      return;
    }
    if (message.type === "nodeClick") {
      handleNodeClick(message.payload, panel);
      return;
    }
    if (message.type === "copyLinked") {
      if (latestOutput) {
        onCopyLinked?.(latestOutput, message.payload);
      }
      return;
    }
    if (message.type === "copySelected") {
      if (latestOutput) {
        onCopySelected?.(latestOutput, message.payload);
      }
      return;
    }
    if (message.type === "reanalyze") {
      // Webview の再解析ボタン → 既存の reanalyze コマンドへ委譲（解析後 postLinkageUpdate で反映）。
      void vscode.commands.executeCommand("apivista.reanalyze");
    }
  });

  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
      latestOutput = undefined;
      pendingFocus = undefined;
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
 * パネル生成と対になる`reanalysisWatcher`の起動/破棄を結線するためのフックとして追加した。
 *
 * 戻り値は新規パネルを生成した場合は`true`、既存パネルを`reveal()`しただけの場合は`false`を返す。
 * design.md「`start`はパネル生成時に1回のみ呼ばれる」(reanalysisWatcherのPreconditions)を
 * `extension.ts`側で守らせるために追加した最小限の戻り値であり、`onDidDispose`コールバックの
 * 結線・発火条件自体は変更していない。
 */
export function showOrReveal(
  context: GraphPanelContext,
  initialOutput: LinkageOutput,
  onDidDispose?: () => void,
  onCopyLinked?: CopyLinkedHandler,
  onCopySelected?: CopySelectedHandler,
): boolean {
  if (currentPanel) {
    currentPanel.reveal();
    return false;
  }

  latestOutput = initialOutput;
  currentPanel = createPanel(context, initialOutput, onDidDispose, onCopyLinked, onCopySelected);
  return true;
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
  latestOutput = output;
  currentPanel.webview.postMessage({ type: "linkageData", payload: output });
}

/**
 * コード位置（root 相対ファイル＋行）を現在パネルへ送り、対応する枠をフォーカスさせる（逆遷移）。
 * 既存パネルへは即時送信。新規生成直後（webview 未 ready）の取りこぼしに備え `pendingFocus` にも保持し、
 * `ready` 受信時に流す（ready は dispose まで再発火しないため二重発火はしない）。
 */
export function postFocusNode(payload: { file: string; line: number }): void {
  pendingFocus = payload;
  currentPanel?.webview.postMessage({ type: "focusNode", payload });
}
