/**
 * アクティベーション・コマンド登録・全コンポーネントの結線（design.md「extension.ts」,
 * Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 2.5, 6.2, 7.2）。
 *
 * - `activate`は`apivista.showGraph`/`apivista.reanalyze`の2コマンドを登録し、両方の
 *   disposableを`context.subscriptions`へpushする(Req1.2, 1.3)。
 * - `showGraph`: `workspaceScanner.validate()`→（成功時）`vscode.window.withProgress`で
 *   進行状況を表示しながら`analysisOrchestrator.analyze()`→（成功時）`graphPanel.showOrReveal()`で
 *   パネルを生成/reveal→（新規生成時のみ）`reanalysisWatcher`を起動し、パネル破棄時に
 *   そのwatcherインスタンスを`dispose()`する、の順に結線する(Req1.1-1.3, 2.1, 2.4, 6.2)。
 * - `reanalyze`: 同じ`validate→analyze`の手順の後、`graphPanel.showOrReveal`ではなく
 *   `graphPanel.postLinkageUpdate`で既存パネルを更新する(Req6.2)。design.mdは「パネルが
 *   開いていない場合」の挙動を明示しないため、本実装では`showGraph`と同様に
 *   `workspaceScanner.validate`→`analyze`を実行し、`postLinkageUpdate`を呼ぶ(パネル未生成時は
 *   `graphPanel.postLinkageUpdate`内部がno-opとして扱う設計に委ねる)。これにより
 *   `reanalyze`コマンド自体が新たにパネルを生成する責務やwatcherのライフサイクル管理を持つ必要が
 *   なくなり、`extension.ts`内の分岐を増やさずに済む(最小実装)。
 * - `ScopeError`/`AnalysisError`はいずれも`vscode.window.showErrorMessage(error.message)`で表示し、
 *   後続処理(analyze呼び出しやパネル操作)を行わない。既存のパネル表示があれば`graphPanel`側の
 *   実装により変更されない(本モジュールはエラー時に`graphPanel`へ一切アクセスしないため、
 *   既存表示は自然に保持される)。
 * - `reanalysisWatcher`のライフサイクルは「`showGraph`でパネルが新規生成された時点で開始し、その
 *   パネルが破棄された時点で同一インスタンスを破棄する」一対一の関係を保つ必要がある
 *   (research.md「ファイル監視はグラフパネルを開いている間のみ稼働させる」)。`graphPanel.showOrReveal`
 *   の第3引数`onDidDispose`コールバックは新規パネル生成時のみ呼ばれるため、このコールバック内で
 *   `createReanalysisWatcher()`が返した同一インスタンスの`dispose()`を呼ぶようにクロージャで束縛する。
 * - `deactivate`は拡張終了時の安全網として、最後にアクティブだったwatcherが残っていれば`dispose()`する
 *   (パネルが開いたままVSCodeが終了する場合に備える。通常はパネルの`onDidDispose`で先に破棄される)。
 */
import * as vscode from "vscode";

import { analyze, AnalysisError } from "./analysisOrchestrator.js";
import * as graphPanel from "./graphPanel.js";
import { createReanalysisWatcher } from "./reanalysisWatcher.js";
import type { ReanalysisWatcher } from "./reanalysisWatcher.js";
import { validate, ScopeError } from "./workspaceScanner.js";

/** 拡張がdeactivateされる際の安全網として破棄するため、現在アクティブなwatcherを保持する。 */
let activeWatcher: ReanalysisWatcher | undefined;

/** `ScopeError`/`AnalysisError`を`showErrorMessage`で表示する共通ハンドラ。 */
function reportError(error: unknown): void {
  if (error instanceof ScopeError || error instanceof AnalysisError) {
    void vscode.window.showErrorMessage(error.message);
    return;
  }
  throw error;
}

async function runShowGraph(context: vscode.ExtensionContext): Promise<void> {
  let scanned: { backendRoot: string; frontendRoot: string };
  try {
    scanned = validate();
  } catch (error) {
    reportError(error);
    return;
  }

  const { backendRoot, frontendRoot } = scanned;

  let output;
  try {
    output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ApiVista: 解析中..." },
      async () => analyze(backendRoot, frontendRoot),
    );
  } catch (error) {
    reportError(error);
    return;
  }

  const watcher = createReanalysisWatcher();
  graphPanel.showOrReveal({ extensionUri: context.extensionUri }, output, () => {
    watcher.dispose();
    if (activeWatcher === watcher) {
      activeWatcher = undefined;
    }
  });
  watcher.start(backendRoot, frontendRoot, (newOutput) => {
    graphPanel.postLinkageUpdate(newOutput);
  });
  activeWatcher = watcher;
}

async function runReanalyze(): Promise<void> {
  let scanned: { backendRoot: string; frontendRoot: string };
  try {
    scanned = validate();
  } catch (error) {
    reportError(error);
    return;
  }

  const { backendRoot, frontendRoot } = scanned;

  let output;
  try {
    output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ApiVista: 再解析中..." },
      async () => analyze(backendRoot, frontendRoot),
    );
  } catch (error) {
    reportError(error);
    return;
  }

  graphPanel.postLinkageUpdate(output);
}

export function activate(context: vscode.ExtensionContext): void {
  const showGraphDisposable = vscode.commands.registerCommand("apivista.showGraph", () =>
    runShowGraph(context),
  );
  const reanalyzeDisposable = vscode.commands.registerCommand("apivista.reanalyze", () =>
    runReanalyze(),
  );

  context.subscriptions.push(showGraphDisposable, reanalyzeDisposable);
}

export function deactivate(): void {
  activeWatcher?.dispose();
  activeWatcher = undefined;
}
