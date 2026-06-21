/**
 * 保存時自動再解析の統合テスト（task 8.4, design.md "Integration Tests
 * (@vscode/test-electron)" 4番目の項目「ソースファイル保存後、パネル表示中であれば再解析が走ること
 * (6.1)」、Requirements 6.1, 6.3）。
 *
 * - design.md Testing Strategyは、Cytoscape本体の描画初期化（`webview/main.ts`）をDOM/Canvas依存の
 *   ため自動検証の対象外と明記している。本テストはこれに従い、Webview側の実JSバンドルが
 *   実行され`"ready"`メッセージを送り返すことには依存しない（実Electron上でCytoscapeが初期化
 *   できるかは不確実であり、それ自体は本タスクの観測可能な完了状態でもない）。
 * - 代わりにタスクの文言どおり「`graphPanel`へ新しい`LinkageOutput`が渡ること」を、
 *   `vscode.window.createWebviewPanel`自体をテスト実行前にモンキーパッチして検証する。
 *   実VSCode拡張ホスト環境ではテストコードと拡張コードが同一プロセス・同一`vscode`モジュール
 *   名前空間を共有するため（showGraphErrors.test.tsの`showErrorMessage`/`workspaceFolders`の
 *   差し替えと同じ手法）、`graphPanel.ts`が呼ぶ`createWebviewPanel`もこの差し替えの影響を受ける。
 *   差し替え後の`createWebviewPanel`は実パネルを生成したうえで、そのパネルの`webview.postMessage`
 *   をラップして全呼び出しを`capturedMessages`へ記録する。これにより、`graphPanel.ts`内部の
 *   `postMessage`呼び出し（初回の`ready`応答時、および`postLinkageUpdate`経由の再解析後更新時）を
 *   Webview側の実行環境に関わらずホスト側だけで観測できる。
 * - `vscode.window.createWebviewPanel`は`namespace`内の関数エクスポートであり、オブジェクトの
 *   プロパティとして型付けされていないため、代入には`as`によるその場限りの型での回避が必要になる
 *   （`Webview.postMessage`はインターフェースの通常のプロパティのため、こちらは追加のキャスト無しで
 *   差し替えられる）。この1行のみ、コメントで理由を明記したうえで許容する（CONCERNS参照）。
 * - debounce遅延は`reanalysisWatcher.ts`で500ms固定（`DEBOUNCE_DELAY_MS`）。ポーリングのタイムアウトは
 *   debounce待機+実解析（実WASM Pythonパーサ・実ts-morph）の時間を吸収できるよう、showGraph.test.ts等
 *   より長めに設定する。
 * - フィクスチャファイル（`tests/fixtures/vscode_workspace/backend/routers/items.py`）の変更は
 *   他specと共有されるため、各テストで元のバイト列を保存し、アサーション成否に関わらず
 *   `finally`で必ず復元する。
 */
import * as assert from "node:assert";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// リポジトリルート: out-test-electron/vscode-extension/test/suite -> ... -> リポジトリルート
// (runTest.ts/showGraph.test.tsと同じ4階層上の導出ロジック)
const repoRoot = path.resolve(__dirname, "../../../..");
const itemsRouterUri = vscode.Uri.file(
  path.resolve(repoRoot, "tests/fixtures/vscode_workspace/backend/routers/items.py"),
);

const VIEW_TYPE_SUBSTRING = "apivista.graphPanel";

/** `linkageData`メッセージのpayloadが`LinkageOutput`形状であることを示す最小限のフィールド集合。 */
interface LinkageDataMessage {
  type: "linkageData";
  payload: {
    schemaVersion: unknown;
    linkages: unknown;
    unmatchedRoutes: unknown;
    unmatchedApiCalls: unknown;
    functions: unknown;
    files: unknown;
    warnings: unknown;
  };
}

function isLinkageDataMessage(message: unknown): message is LinkageDataMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { type?: unknown; payload?: unknown };
  if (candidate.type !== "linkageData" || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as Record<string, unknown>;
  return (
    "schemaVersion" in payload &&
    "linkages" in payload &&
    "unmatchedRoutes" in payload &&
    "unmatchedApiCalls" in payload &&
    "functions" in payload &&
    "files" in payload &&
    "warnings" in payload
  );
}

/**
 * `vscode.window.tabGroups.all`の反映ラグ（showGraph.test.tsのコメント参照）を踏まえ、
 * `viewTypeSubstring`を含むWebviewタブが現れるまで短間隔でポーリングする。
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

/** 指定した条件を満たすまで短間隔でポーリングする（タイムアウトでfalseを返す）。 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const pollIntervalMs = 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return predicate();
}

/**
 * `panel`の`onDidDispose`が発火するまで待つ（タイムアウトで諦めて戻る）。
 *
 * `vscode.window.tabGroups.close(tab)`はタブUI上のクローズを要求するだけであり、拡張ホスト側の
 * `WebviewPanel.onDidDispose`（＝`graphPanel.ts`の`currentPanel`クリアや`reanalysisWatcher.dispose()`の
 * 結線）が実際に完了するより先に解決してしまうことがある（task 8.4レビューで発見されたteardown
 * レース）。次のテストの`setup`が走る前に確実に同一パネルの`onDidDispose`完了を待つことで、
 * 前のテストのwatcherが破棄され切っていない状態のまま次のテストの`showGraph`が新パネルを生成し、
 * 2つのwatcherが並行稼働するという、本remediationが修正した不具合と類似の状況を
 * テスト側で誤って作り出さないようにする。
 */
async function waitForPanelDispose(
  panel: vscode.WebviewPanel,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const disposable = panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        disposable.dispose();
        resolve(true);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        disposable.dispose();
        resolve(false);
      }
    }, timeoutMs);
  });
}

suite("reanalysis on save", () => {
  let originalCreateWebviewPanel: typeof vscode.window.createWebviewPanel;
  let capturedMessages: unknown[];
  let originalItemsRouterBytes: Uint8Array;
  // `createWebviewPanel`の差し替えを通じて捕捉した、本テスト内で生成された実パネル。teardownで
  // このパネル自身の`onDidDispose`完了を待つために保持する（CONCERNS参照、teardownレースの修正）。
  let capturedPanel: vscode.WebviewPanel | undefined;

  setup(async () => {
    capturedMessages = [];
    capturedPanel = undefined;
    originalItemsRouterBytes = await vscode.workspace.fs.readFile(itemsRouterUri);

    originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    // `vscode.window.createWebviewPanel`は`namespace`内の関数エクスポートとして型付けられており、
    // 通常のオブジェクトプロパティとして代入可能な型を持たない。実行時には単純なモジュール
    // プロパティであり代入自体は可能だが、これをTSの型システムへ説明する手段が
    // `@types/vscode`側に用意されていないため、この1行のみ最小範囲で型を緩める
    // （CONCERNS参照。showGraphErrors.test.tsの`showErrorMessage`差し替えも同様の制約を持つ）。
    (
      vscode.window as {
        createWebviewPanel: typeof vscode.window.createWebviewPanel;
      }
    ).createWebviewPanel = ((
      ...args: Parameters<typeof vscode.window.createWebviewPanel>
    ): vscode.WebviewPanel => {
      const panel = originalCreateWebviewPanel.apply(vscode.window, args);
      capturedPanel = panel;
      const originalPostMessage = panel.webview.postMessage.bind(panel.webview);
      panel.webview.postMessage = (message: unknown): Thenable<boolean> => {
        capturedMessages.push(message);
        return originalPostMessage(message);
      };
      return panel;
    }) as typeof vscode.window.createWebviewPanel;
  });

  teardown(async function () {
    // パネル破棄待ち+ファイル復元を吸収するため、mocha既定のフックタイムアウト(2000ms)を
    // 明示的に伸ばす。`this`を使うためアロー関数ではなく通常の`function`で登録する必要がある。
    this.timeout(10000);

    (
      vscode.window as {
        createWebviewPanel: typeof vscode.window.createWebviewPanel;
      }
    ).createWebviewPanel = originalCreateWebviewPanel;

    // フィクスチャは他spec/タスクと共有のため、アサーション成否に関わらず必ず元のバイト列へ復元する。
    await vscode.workspace.fs.writeFile(itemsRouterUri, originalItemsRouterBytes);

    if (capturedPanel) {
      // `vscode.window.tabGroups.close(tab)`はタブUIのクローズを要求するのみで、本テスト実行
      // 環境(--no-sandbox/GPU無効のheadless @vscode/test-electron)ではレンダラー側のタブ
      // クローズ要求が拡張ホスト側`WebviewPanel.onDidDispose`の発火に確実につながるとは限らず、
      // 実測で20秒待っても発火しないケースを確認した（GPUコンテキスト生成の継続的な失敗ログ
      // `ContextResult::kTransientFailure`と同根の、本テスト環境特有の制約と判断した）。
      // `WebviewPanel.dispose()`を直接呼ぶ経路は`vscode.window.createWebviewPanel`が返す
      // パネル自身のメソッドであり、タブUIのレンダリング往復を経由せず即座に`onDidDispose`を
      // 発火させる、より直接的かつ確実な破棄手段である。本来のreveal/closeのユーザー操作経路を
      // 再現する目的ではなく「次のテストの前に前のwatcherが確実に破棄されていること」を保証する
      // ことが本teardownの目的のため、ここでは`dispose()`の直接呼び出しに切り替える。
      const panelToAwait = capturedPanel;
      const disposed = waitForPanelDispose(panelToAwait, 5000);
      panelToAwait.dispose();
      if (!(await disposed)) {
        throw new Error(
          "webview panel was not disposed within timeout during teardown; " +
            "a stale reanalysisWatcher may leak into the next test",
        );
      }
    }
  });

  test("saving a backend file triggers a reanalysis and posts a new LinkageOutput (Req 6.1)", async function () {
    this.timeout(30000);

    await vscode.commands.executeCommand("apivista.showGraph");
    const webviewTab = await waitForWebviewTab(VIEW_TYPE_SUBSTRING, 5000);
    assert.ok(webviewTab, "apivista.graphPanel webview tab was not found within timeout");

    const baselineCount = capturedMessages.length;

    const originalText = Buffer.from(originalItemsRouterBytes).toString("utf-8");
    const modifiedText = `${originalText}\n# apivista reanalysis.test.ts: trivial comment for Req6.1\n`;
    await vscode.workspace.fs.writeFile(itemsRouterUri, Buffer.from(modifiedText, "utf-8"));

    // debounce(500ms固定) + 実解析(WASM Pythonパーサ + ts-morph)の時間を吸収するため、
    // showGraph.test.ts等より長めのタイムアウトでポーリングする。
    const increased = await waitUntil(() => capturedMessages.length > baselineCount, 8000);
    assert.ok(
      increased,
      `capturedMessages did not increase beyond baseline (${baselineCount}) within timeout; current length: ${capturedMessages.length}`,
    );

    const newMessage = capturedMessages[capturedMessages.length - 1];
    assert.ok(
      isLinkageDataMessage(newMessage),
      `the newly captured message was not a linkageData message with a LinkageOutput-shaped payload: ${JSON.stringify(
        newMessage,
      )}`,
    );
  });

  test("two rapid saves within the debounce window collapse into a single reanalysis (Req 6.3)", async function () {
    this.timeout(30000);

    await vscode.commands.executeCommand("apivista.showGraph");
    const webviewTab = await waitForWebviewTab(VIEW_TYPE_SUBSTRING, 5000);
    assert.ok(webviewTab, "apivista.graphPanel webview tab was not found within timeout");

    const baselineCount = capturedMessages.length;

    const originalText = Buffer.from(originalItemsRouterBytes).toString("utf-8");
    const firstWrite = `${originalText}\n# apivista reanalysis.test.ts: rapid save 1 for Req6.3\n`;
    const secondWrite = `${originalText}\n# apivista reanalysis.test.ts: rapid save 2 for Req6.3\n`;

    // 2回の書き込みを間に遅延を入れず連続実行する。いずれも500msのdebounce windowに
    // 十分収まるため、reanalysisWatcherの実装上は1回の再解析に集約されるはずである。
    await vscode.workspace.fs.writeFile(itemsRouterUri, Buffer.from(firstWrite, "utf-8"));
    await vscode.workspace.fs.writeFile(itemsRouterUri, Buffer.from(secondWrite, "utf-8"));

    const increased = await waitUntil(() => capturedMessages.length > baselineCount, 8000);
    assert.ok(
      increased,
      `capturedMessages did not increase beyond baseline (${baselineCount}) within timeout; current length: ${capturedMessages.length}`,
    );

    // さらに余裕を持たせてから件数を固定し、2回目のdebounce後解析が別途追加で発火していないこと
    // （集約が崩れて2回postMessageされていないこと）を確認する。
    await new Promise((resolve) => setTimeout(resolve, 1000));

    assert.strictEqual(
      capturedMessages.length - baselineCount,
      1,
      `expected exactly 1 new postMessage call from the two rapid saves collapsing into a single reanalysis, ` +
        `but observed ${capturedMessages.length - baselineCount}`,
    );

    const newMessage = capturedMessages[capturedMessages.length - 1];
    assert.ok(
      isLinkageDataMessage(newMessage),
      `the newly captured message was not a linkageData message with a LinkageOutput-shaped payload: ${JSON.stringify(
        newMessage,
      )}`,
    );
  });
});
