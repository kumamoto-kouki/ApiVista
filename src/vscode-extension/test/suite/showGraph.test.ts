/**
 * グラフ表示コマンドのEnd-to-End統合テスト（task 8.2, design.md "Integration Tests
 * (@vscode/test-electron)" 2番目の項目「フィクスチャワークスペース...でグラフ表示コマンドを
 * 実行し、Webviewパネルが生成されること(2.1, 3.1)」、Requirements 2.1, 3.1, 8.1, 8.2）。
 *
 * - `extension.test.ts`（task 8.1）と同じ手法で拡張ハンドルを特定する
 *   （`package.json`に`publisher`が無いため`vscode.extensions.all`を`packageJSON.name`で走査する）。
 * - `apivista.showGraph`を実行すると、実際にフィクスチャワークスペース
 *   （`tests/fixtures/vscode_workspace/{backend,frontend}/`、`runTest.ts`の`launchArgs`で開かれている）
 *   に対して`workspaceScanner.validate()`→`analysisOrchestrator.analyze()`
 *   （実WASMベースのPythonパーサによる`analyzeBackend`、実ts-morphによる`analyzeFrontend`、
 *   `linkRoutes`）→`graphPanel.showOrReveal()`が実行される。これは外部ランタイム不要・
 *   対象コード非実行（Req8.1, 8.2）を実環境で証明する。フィクスチャ内の`broken.py`/
 *   `BrokenWidget.vue`等は意図的に解析失敗ではなく「警告付きスキップ」として扱われる設計
 *   （各ファイル内のコメント参照）であるため、`showGraph`がエラーをthrow/表示せず完走することが
 *   期待される。
 * - `extension.ts`の`showGraph`ハンドラは`async`であり、`vscode.commands.executeCommand`が
 *   返すPromiseはハンドラ内部の`await vscode.window.withProgress(...)`の完了まで解決を待つ
 *   （`registerCommand`に渡したコールバックが返すPromiseをVSCode側が連鎖して待つため）。
 *   よって本テストで`await`するだけで拡張ホスト側の解析・`createWebviewPanel`呼び出し完了後の
 *   状態を検証できる。ただし`vscode.window.tabGroups.all`への反映はレンダラー側のタブUI更新を
 *   経由するため、`executeCommand`の解決と同一マイクロタスクでは反映されない（実測で
 *   数百ms〜2秒程度のラグを確認した）。そのため`waitForWebviewTab`で短い間隔のポーリングを行う
 *   （固定の長いsleepではなく、タブが現れた時点で即座に進む）。
 * - Webviewパネルが実際に開いたことの検証は`vscode.window.tabGroups.all`を走査し、
 *   `TabInputWebview`型のtabを探す。`@types/vscode`の`TabInputWebview.viewType`は
 *   `WebviewPanel`の`viewType`にマップされるとドキュメントされているが、実際のElectron
 *   ランタイムでは内部的にプレフィックスが付与される可能性がある（VSCode拡張ホストと
 *   レンダラー間のRPCチャネル識別のための内部実装詳細で、`@types/vscode`には明文化されていない）。
 *   本テスト実行時に実際の値をログ出力して確認したところ、`graphPanel.ts`の`VIEW_TYPE`
 *   （`"apivista.graphPanel"`）と完全一致していたが、環境依存で変わる可能性を踏まえ
 *   厳密一致ではなく部分文字列として含むかで判定する。
 * - エラーが発生しなかったことの主要な信号は、`executeCommand`がrejectしなかったこと自体
 *   （`showGraph`ハンドラは`ScopeError`/`AnalysisError`を内部でcatchし`reportError`経由で
 *   `showErrorMessage`を呼ぶのみでthrowし直さないため、ハンドラ内の想定外の例外のみが
 *   ここでのrejectとして現れる）と、Webviewパネルが実際に生成されたことの組み合わせで判断する。
 *   実VSCode環境で`showErrorMessage`呼び出し自体をプログラム的にスパイする手段はない
 *   （vitestモックは拡張ホスト単体テストでのみ可能）ため、本テストでは追跡しない。
 * - 後続テスト（task 8.3/8.4）への状態漏れを防ぐため、テスト終了時に開いたWebviewタブを閉じる。
 */
import * as assert from "node:assert";
import * as vscode from "vscode";

/**
 * `vscode.window.tabGroups.all`の反映ラグを吸収するため、viewTypeが部分一致するWebviewタブが
 * 現れるまで短い間隔でポーリングする。タイムアウトした場合は`undefined`を返す（呼び出し元で
 * アサーション失敗として扱う）。
 */
async function waitForWebviewTab(
  viewTypeSubstring: string,
  timeoutMs: number,
): Promise<vscode.Tab | undefined> {
  const pollIntervalMs = 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.includes(viewTypeSubstring),
      );
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return undefined;
}

suite("showGraph command", () => {
  test("runs the full analysis pipeline and opens a graph webview panel", async function () {
    this.timeout(20000);

    const extension = vscode.extensions.all.find(
      (candidate) => candidate.packageJSON.name === "apivista",
    );
    assert.ok(extension, "ApiVista extension (package.json name=apivista) was not found");

    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, "ApiVista extension did not activate");

    // 実パイプライン全体（workspaceScanner→analysisOrchestrator→graphPanel）を実行する。
    // rejectしないこと自体が「想定外の例外が拡張ハンドラ外まで伝播しなかった」ことの証拠となる。
    await vscode.commands.executeCommand("apivista.showGraph");

    const webviewTab = await waitForWebviewTab("apivista.graphPanel", 5000);

    assert.ok(
      webviewTab,
      `apivista.graphPanel webview tab was not found within timeout. Open tabs: ${JSON.stringify(
        vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.map((tab) => ({
            label: tab.label,
            viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : null,
          })),
        ),
      )}`,
    );

    if (webviewTab) {
      await vscode.window.tabGroups.close(webviewTab);
    }
  });
});
