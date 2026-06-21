/**
 * グラフパネル表示中のファイル監視+debounce再解析（design.md「reanalysisWatcher」,
 * Requirements 6.1, 6.3）。
 *
 * - `start`はグラフパネル生成時に呼ばれ、`backendRoot`・`frontendRoot`配下を
 *   `vscode.workspace.createFileSystemWatcher`（`vscode.RelativePattern`でディレクトリを絶対パスの
 *   文字列ベースとして指定）で監視する。`backendRoot`/`frontendRoot`はワークスペースルートそのもの
 *   とは限らない絶対パスのため、`RelativePattern`の`base`は`WorkspaceFolder`ではなく文字列を渡す
 *   （research.md「ファイル監視・ソースジャンプ」、design.md`RelativePattern`コンストラクタは
 *   `WorkspaceFolder | Uri | string`を受け付ける）。
 * - `onDidChange`/`onDidCreate`/`onDidDelete`いずれのイベントも同一のdebounceハンドラへ集約する。
 * - debounce遅延は500ms固定とする（design.md/research.mdに具体的な値の指定はないため、
 *   保存直後の連続書き込み（エディタの自動保存・フォーマッタ等）を1回に集約するのに十分な値として
 *   実装者判断で選定。設定可能にする要件は本タスクの範囲外）。
 * - debounce window中に複数回イベントが発生しても、タイマーが最終的に発火した時点で
 *   `analysisOrchestrator.analyze`は1回だけ呼ばれる（Req6.3）。
 * - `analyze`が失敗（reject）した場合は`onReanalyzed`を呼ばない。エラー表示の責務は
 *   `extension.ts`側（呼び出し元）にあり、design.mdは本コンポーネントにエラー表示責務を割り当てて
 *   いないため、ここでは握り潰さず単に`onReanalyzed`を呼ばないという最小の挙動に留める
 *   （reject自体はこの関数内で完結させ、未処理rejectionを発生させない）。
 * - `dispose`はファイル監視を破棄し、保留中のdebounceタイマーをクリアする。さらに、`dispose`呼び出し
 *   後に進行中だった`analyze`呼び出しが後から解決しても`onReanalyzed`を呼ばないよう、破棄済みフラグで
 *   ガードする（パネルが閉じている間の再解析結果はもはや意味を持たないため）。
 */
import * as vscode from "vscode";

import { analyze } from "./analysisOrchestrator.js";
import type { LinkageOutput } from "../route-linkage/index.js";

/** debounce遅延（ミリ秒）。短時間内の連続保存を1回の再解析に集約するための待機時間。 */
const DEBOUNCE_DELAY_MS = 500;

export interface ReanalysisWatcher {
  start(
    backendRoot: string,
    frontendRoot: string,
    onReanalyzed: (output: LinkageOutput) => void,
  ): void;
  dispose(): void;
}

/** `root`配下の全ファイル変更を監視する`FileSystemWatcher`を生成する。 */
function watchDirectory(root: string): vscode.FileSystemWatcher {
  const pattern = new vscode.RelativePattern(root, "**/*");
  return vscode.workspace.createFileSystemWatcher(pattern);
}

/**
 * `ReanalysisWatcher`の新しいインスタンスを生成する。
 *
 * `extension.ts`がグラフパネルごとに独立したインスタンスを保持できるよう、
 * モジュール単一状態ではなくファクトリ関数として提供する（design.mdのService Interfaceが
 * インスタンスメソッド`start`/`dispose`を持つ`ReanalysisWatcher`を定義しているため）。
 */
export function createReanalysisWatcher(): ReanalysisWatcher {
  let watchers: vscode.FileSystemWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function clearPendingTimer(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  }

  function start(
    backendRoot: string,
    frontendRoot: string,
    onReanalyzed: (output: LinkageOutput) => void,
  ): void {
    const onFileEvent = (): void => {
      clearPendingTimer();
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        analyze(backendRoot, frontendRoot)
          .then((output) => {
            if (!disposed) {
              onReanalyzed(output);
            }
          })
          .catch(() => {
            // analyzeの失敗時はonReanalyzedを呼ばない。エラー表示は呼び出し元（extension.ts）の責務。
          });
      }, DEBOUNCE_DELAY_MS);
    };

    for (const root of [backendRoot, frontendRoot]) {
      const watcher = watchDirectory(root);
      watcher.onDidChange(onFileEvent);
      watcher.onDidCreate(onFileEvent);
      watcher.onDidDelete(onFileEvent);
      watchers.push(watcher);
    }
  }

  function dispose(): void {
    disposed = true;
    clearPendingTimer();
    for (const watcher of watchers) {
      watcher.dispose();
    }
    watchers = [];
  }

  return { start, dispose };
}
