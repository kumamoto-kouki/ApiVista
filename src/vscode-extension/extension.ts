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
 *   (research.md「ファイル監視はグラフパネルを開いている間のみ稼働させる」、design.md
 *   reanalysisWatcherのPreconditions「`start`はパネル生成時に1回のみ呼ばれる」)。`graphPanel.showOrReveal`
 *   の第3引数`onDidDispose`コールバックは新規パネル生成時のみ呼ばれるため、このコールバック内で
 *   `createReanalysisWatcher()`が返した同一インスタンスの`dispose()`を呼ぶようにクロージャで束縛する。
 *   `showOrReveal`の戻り値が`false`（既存パネルを`reveal()`しただけ）の場合は新しいwatcherを
 *   生成・起動しない。既存パネルに紐づく既存watcherがそのパネルの再解析ライフサイクルを継続して
 *   担うため、ここで何もしないことが正しい（生成すると同一パネルに対し複数のwatcherが並行稼働し、
 *   古いwatcherの`FileSystemWatcher`がリークしたまま二重に再解析・`postLinkageUpdate`される）。
 * - `deactivate`は拡張終了時の安全網として、最後にアクティブだったwatcherが残っていれば`dispose()`する
 *   (パネルが開いたままVSCodeが終了する場合に備える。通常はパネルの`onDidDispose`で先に破棄される)。
 */
import * as vscode from "vscode";

import { analyze, AnalysisError } from "./analysisOrchestrator.js";
import { copyFunctionWithLinked } from "./functionCopier.js";
import * as graphPanel from "./graphPanel.js";
import { createReanalysisWatcher } from "./reanalysisWatcher.js";
import type { ReanalysisWatcher } from "./reanalysisWatcher.js";
import { loadCachedResult, saveCachedResult } from "./resultCache.js";
import { validate, ScopeError } from "./workspaceScanner.js";

/** 拡張がdeactivateされる際の安全網として破棄するため、現在アクティブなwatcherを保持する。 */
let activeWatcher: ReanalysisWatcher | undefined;

/** 解析ログを出力する OutputChannel。activate 時に生成し subscriptions で管理する。 */
let outputChannel: vscode.OutputChannel | undefined;

/** `ScopeError`/`AnalysisError`を`showErrorMessage`で表示する共通ハンドラ。 */
function reportError(error: unknown): void {
  if (error instanceof ScopeError || error instanceof AnalysisError) {
    void vscode.window.showErrorMessage(error.message);
    return;
  }
  throw error;
}

/** validate→withProgress(analyze) の共通フロー。エラー時は`null`を返す。 */
async function runAnalysis(
  wasmDir: string,
  progressTitle: string,
  opts?: { focalFile?: string },
): Promise<{
  backendRoot: string;
  frontendRoot: string;
  output: Awaited<ReturnType<typeof analyze>>;
} | null> {
  let scanned: { backendRoot: string; frontendRoot: string };
  try {
    scanned = validate();
  } catch (error) {
    reportError(error);
    return null;
  }

  const { backendRoot, frontendRoot } = scanned;
  const channel = outputChannel;

  const timestamp = new Date().toLocaleTimeString();
  channel?.appendLine(`\n[${timestamp}] ${progressTitle}`);

  let output;
  try {
    output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: true },
      async (_progress, token) => {
        const checkCancelled = () => {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
        };
        const onProgress = (msg: string) => {
          channel?.appendLine(`  ${msg}`);
        };
        return analyze(backendRoot, frontendRoot, wasmDir, {
          onProgress,
          checkCancelled,
          focalFile: opts?.focalFile,
        });
      },
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      channel?.appendLine("  キャンセルされました。");
      return null;
    }
    reportError(error);
    if (channel && (error instanceof AnalysisError || error instanceof Error)) {
      channel.appendLine(`  エラー: ${(error as Error).message}`);
      channel.show(true);
    }
    return null;
  }

  return { backendRoot, frontendRoot, output };
}

/** キャッシュ表示後にバックグラウンドで再解析し、パネルとキャッシュを更新する。 */
async function reanalyzeInBackground(wasmDir: string, storageDir: string): Promise<void> {
  const result = await runAnalysis(wasmDir, "ApiVista: バックグラウンド更新中...");
  if (result === null) return;
  graphPanel.postLinkageUpdate(result.output);
  void saveCachedResult(storageDir, result.output);
}

/** `showGraph` のパネル生成 + watcher 起動の共通ロジック。 */
function openPanelAndStartWatcher(
  context: vscode.ExtensionContext,
  output: Awaited<ReturnType<typeof analyze>>,
  backendRoot: string,
  frontendRoot: string,
): void {
  const watcherRef: { current: ReanalysisWatcher | undefined } = { current: undefined };
  const isNewPanel = graphPanel.showOrReveal({ extensionUri: context.extensionUri }, output, () => {
    watcherRef.current?.dispose();
    if (activeWatcher === watcherRef.current) {
      activeWatcher = undefined;
    }
  });
  if (!isNewPanel) {
    return;
  }
  const newWatcher = createReanalysisWatcher();
  watcherRef.current = newWatcher;
  newWatcher.start(backendRoot, frontendRoot, (newOutput) => {
    graphPanel.postLinkageUpdate(newOutput);
  });
  activeWatcher = newWatcher;
}

async function runShowGraph(context: vscode.ExtensionContext, wasmDir: string): Promise<void> {
  const storageDir = context.storageUri?.fsPath;

  // キャッシュ確認は validate() 不要。storageDir から直接読み込む。
  if (storageDir) {
    const cached = await loadCachedResult(storageDir);
    if (cached) {
      // キャッシュあり: validate して watcher 用 roots を取得してから即時表示。
      let scanned: { backendRoot: string; frontendRoot: string };
      try {
        scanned = validate();
      } catch (error) {
        reportError(error);
        return;
      }
      const { backendRoot, frontendRoot } = scanned;
      openPanelAndStartWatcher(context, cached, backendRoot, frontendRoot);
      void reanalyzeInBackground(wasmDir, storageDir);
      return;
    }
  }

  // キャッシュなし → 通常フロー。runAnalysis 内で validate() を呼ぶ。
  const result = await runAnalysis(wasmDir, "ApiVista: 解析中...");
  if (result === null) return;

  if (storageDir) {
    void saveCachedResult(storageDir, result.output);
  }
  openPanelAndStartWatcher(context, result.output, result.backendRoot, result.frontendRoot);
}

async function runReanalyze(wasmDir: string, storageDir?: string): Promise<void> {
  const result = await runAnalysis(wasmDir, "ApiVista: 再解析中...");
  if (result === null) return;
  graphPanel.postLinkageUpdate(result.output);
  if (storageDir) {
    void saveCachedResult(storageDir, result.output);
  }
}

async function runAnalyzeActiveFile(
  context: vscode.ExtensionContext,
  wasmDir: string,
  storageDir: string | undefined,
  uri?: vscode.Uri,
): Promise<void> {
  const focalFile = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  const result = await runAnalysis(wasmDir, "ApiVista: スポット解析中...", { focalFile });
  if (result === null) return;
  if (storageDir) void saveCachedResult(storageDir, result.output);
  openPanelAndStartWatcher(context, result.output, result.backendRoot, result.frontendRoot);
}

async function runCopyFunctionWithLinked(storageDir: string | undefined): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  if (!storageDir) {
    void vscode.window.showErrorMessage(
      "ApiVista: 先に「Show Route Linkage Graph」で解析を実行してください。",
    );
    return;
  }
  const cached = await loadCachedResult(storageDir);
  if (!cached) {
    void vscode.window.showErrorMessage(
      "ApiVista: 解析結果がキャッシュされていません。先に解析を実行してください。",
    );
    return;
  }
  let scanned: { backendRoot: string; frontendRoot: string };
  try {
    scanned = validate();
  } catch (error) {
    reportError(error);
    return;
  }
  const count = await copyFunctionWithLinked(
    editor.document,
    editor.selection.active,
    cached,
    scanned.backendRoot,
    scanned.frontendRoot,
  );
  if (count === 0) {
    void vscode.window.showInformationMessage(
      "ApiVista: カーソルを関数内に置いてください（連携関数が見つかりませんでした）。",
    );
  } else {
    void vscode.window.showInformationMessage(
      `ApiVista: ${count}個の関数をクリップボードにコピーしました。`,
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const wasmDir = vscode.Uri.joinPath(context.extensionUri, "media", "wasm").fsPath;
  const storageDir = context.storageUri?.fsPath;

  outputChannel = vscode.window.createOutputChannel("ApiVista");
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("apivista.showGraph", () => runShowGraph(context, wasmDir)),
    vscode.commands.registerCommand("apivista.reanalyze", () => runReanalyze(wasmDir, storageDir)),
    vscode.commands.registerCommand("apivista.analyzeActiveFile", (uri?: vscode.Uri) =>
      runAnalyzeActiveFile(context, wasmDir, storageDir, uri),
    ),
    vscode.commands.registerCommand("apivista.copyFunctionWithLinked", () =>
      runCopyFunctionWithLinked(storageDir),
    ),
  );
}

export function deactivate(): void {
  activeWatcher?.dispose();
  activeWatcher = undefined;
}
