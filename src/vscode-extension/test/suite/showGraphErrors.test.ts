/**
 * 異常系（backend/frontend不在・マルチルート）の統合テスト（task 8.3, design.md
 * "Integration Tests (@vscode/test-electron)" 3番目の項目「backend/frontendディレクトリ不在の
 * ワークスペースでエラーメッセージが表示されること(2.2)」、Requirements 2.2, 2.5）。
 *
 * - `workspaceScanner.validate()`（src/vscode-extension/workspaceScanner.ts）は、単一の
 *   `vscode.workspace.workspaceFolders`でなければ`ScopeError("multi-root")`を、単一ルートだが
 *   直下に`backend/`が無ければ`ScopeError("missing-backend")`を、`frontend/`が無ければ
 *   `ScopeError("missing-frontend")`をthrowする。`extension.ts`の`runShowGraph`はこれを
 *   `reportError`でcatchし`vscode.window.showErrorMessage`を呼ぶのみで、コマンドのPromise自体は
 *   reject **しない**（tasks.md Implementation Notes、showGraph.test.tsのコメント参照）。
 *   そのため本テストでは`executeCommand`がthrowしないことではなく、(a) `showErrorMessage`が
 *   実際に呼ばれたこと、(b) `apivista.graphPanel`のWebviewタブが生成されなかったこと、の2点を
 *   直接観測する。
 * - (a)の観測手段: 実VSCode拡張ホスト環境（@vscode/test-electron）ではテストコードと拡張コードが
 *   同一プロセス・同一`vscode`モジュール名前空間を共有するため、`vscode.window.showErrorMessage`
 *   自体を実行時に差し替える（モンキーパッチ）ことで呼び出しを検知できる。`setup`で元の関数参照を
 *   保存し差し替え、`teardown`で必ず復元する（アサーション失敗時もMochaのhookは実行されるため、
 *   復元漏れは発生しない）。
 * - (b)の観測手段: showGraph.test.ts（task 8.2）の`waitForWebviewTab`と同様の短間隔ポーリングを
 *   用いるが、本テストは「タブが現れないこと」を確認する逆方向の検証であるため、タイムアウトまで
 *   待ち切って`undefined`であることを確認する（タブがまだ生成中で単に遅延しているだけ、という
 *   誤検知を避けるため、8.2と同じ程度の猶予を与えてから「無い」と判定する）。
 * - ワークスペースフォルダの切り替え手段として、当初は`vscode.workspace.updateWorkspaceFolders`を
 *   検討した。しかし実測したところ、単一ルートワークスペースに対してこのAPIを呼び出すと
 *   （folder 0の置換・削除であっても、単純な2件目の追加によるmulti-root化であっても）拡張ホスト
 *   プロセスそのものが再起動し、`extensionTestsPath`（本Mochaスイート全体）が新しいプロセスで
 *   再実行されてしまうことを確認した（`@types/vscode`のドキュメントにある「先頭フォルダの追加・
 *   削除・変更時、またemptyもしくは単一フォルダからmulti-folderへ遷移する際は拡張が終了・再起動
 *   されることがある」という記述どおりの挙動。実行ログで`Started local extension host`が複数回
 *   出現し、Mocha結果が複数回出力されることで実証した）。`@vscode/test-electron`は単一の
 *   `runTests()`呼び出しに対して単一のMocha実行を前提にしているため、この再起動はスイート全体を
 *   不定回数再実行させてしまい、他spec（task 8.1, 8.2, 8.4）の安定動作を壊す。
 *   そのため本ファイルでは`updateWorkspaceFolders`を使わず、`workspaceScanner.validate()`が
 *   読み取る対象である`vscode.workspace.workspaceFolders`プロパティ自体を、`showErrorMessage`と
 *   同じ「実行時の関数/プロパティ差し替え」手法で一時的に上書きする。これは実際のVSCode
 *   ワークスペース構成（ディスク上の状態・拡張ホストのIPC）には一切触れないため、拡張ホストの
 *   再起動を引き起こさない（実測で確認、ログに`Started local extension host`の再出現が無いことで
 *   検証した）。`workspaceScanner.validate()`は`vscode.workspace.workspaceFolders`を読み取るだけで
 *   あり、本拡張のどのコンポーネントも`workspaceFolders`への書き込みやVSCode本体への通知を行わない
 *   ため、この差し替えは`workspaceScanner`の観測範囲に対してのみ意味を持つ安全な手法である。
 */
import * as assert from "node:assert";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// リポジトリルート: out-test-electron/vscode-extension/test/suite -> ... -> リポジトリルート
// (runTest.tsと同じ4階層上の導出ロジック。本ファイルはコンパイル後
// out-test-electron/vscode-extension/test/suite/showGraphErrors.test.js に位置する)
const repoRoot = path.resolve(__dirname, "../../../..");
const noBackendWorkspaceUri = vscode.Uri.file(
  path.resolve(repoRoot, "tests/fixtures/vscode_workspace_no_backend"),
);
// マルチルートシナリオの1件目はbackend/frontendを両方持つ正常系フィクスチャを使う。これにより
// `workspaceScanner.validate()`がエラーをthrowする原因が「multi-root」検出そのものであることを
// 明確にする（もし1件目にも欠落があると、backend/frontend不在の検出と多重ルート検出のどちらが
// 効いたのか区別できず、multi-root判定ロジックの回帰をこのテストが検出できなくなってしまう）。
const validRootUri = vscode.Uri.file(path.resolve(repoRoot, "tests/fixtures/vscode_workspace"));

/**
 * `vscode.window.tabGroups.all`の反映ラグ（showGraph.test.tsのコメント参照）を踏まえ、
 * `viewTypeSubstring`を含むWebviewタブが現れるまで短間隔でポーリングする。
 * タイムアウトまで現れなければ`undefined`を返す（「パネルが生成されなかった」ことの確認に使う）。
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

/**
 * `vscode.workspace.workspaceFolders`を指定の配列に一時的に差し替える。
 *
 * 上記ファイル冒頭コメントの通り、実際のVSCodeワークスペース構成を変更する
 * `updateWorkspaceFolders`は拡張ホストの再起動を引き起こすため使用しない。代わりに
 * `workspaceScanner.validate()`が読み取るプロパティそのものを実行時に上書きする
 * （`showErrorMessage`と同様の正当なモンキーパッチ手法）。`vscode.workspace`の
 * `workspaceFolders`はgetterとして定義されているため`Object.defineProperty`で上書きし、
 * 元のディスクリプタを返して呼び出し元が復元できるようにする。
 */
function patchWorkspaceFolders(
  folders: readonly vscode.WorkspaceFolder[] | undefined,
): PropertyDescriptor | undefined {
  const original = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    enumerable: true,
    get: () => folders,
  });
  return original;
}

/** `patchWorkspaceFolders`が返した元のディスクリプタを使って`workspaceFolders`を復元する。 */
function restoreWorkspaceFolders(original: PropertyDescriptor | undefined): void {
  if (original) {
    Object.defineProperty(vscode.workspace, "workspaceFolders", original);
  }
}

/** テスト用の最小`WorkspaceFolder`を構築する（`index`/`name`は本テストの検証では使われない）。 */
function makeWorkspaceFolder(uri: vscode.Uri, index: number): vscode.WorkspaceFolder {
  return { uri, name: path.basename(uri.fsPath), index };
}

suite("showGraph error scenarios", () => {
  let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
  let errorMessageCalls: unknown[][];
  let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;

  setup(() => {
    errorMessageCalls = [];
    originalShowErrorMessage = vscode.window.showErrorMessage;
    // 実拡張ホストプロセス内でテストコードと拡張コードは同一の`vscode`モジュール名前空間を
    // 共有するため、この差し替えは`extension.ts`が呼ぶ`vscode.window.showErrorMessage`にも
    // 反映される（vitestモックではなく実行時の関数差し替え）。
    (
      vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }
    ).showErrorMessage = ((...args: unknown[]) => {
      errorMessageCalls.push(args);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showErrorMessage;
    originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(
      vscode.workspace,
      "workspaceFolders",
    );
  });

  teardown(() => {
    // アサーション失敗時もMochaの`teardown`(afterEach相当)は必ず実行されるため、
    // 差し替えた関数参照・プロパティは確実に元へ戻る。
    (
      vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }
    ).showErrorMessage = originalShowErrorMessage;
    restoreWorkspaceFolders(originalWorkspaceFoldersDescriptor);
  });

  test("monkey-patched showErrorMessage actually captures calls", async () => {
    // 差し替え自体が機能していることを検証してから本題のシナリオに進む（指示の「動作することを
    // 確認する」要求に対応）。
    await vscode.window.showErrorMessage("probe");
    assert.strictEqual(errorMessageCalls.length, 1, "showErrorMessage call was not captured");
    assert.strictEqual(errorMessageCalls[0]?.[0], "probe");
  });

  test("monkey-patched workspaceFolders actually reflects the override", () => {
    const fakeFolders = [makeWorkspaceFolder(noBackendWorkspaceUri, 0)];
    patchWorkspaceFolders(fakeFolders);
    assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
    assert.strictEqual(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      noBackendWorkspaceUri.fsPath,
    );
  });

  suite("missing-backend", () => {
    test("shows an error message and does not open a graph panel", async function () {
      this.timeout(20000);

      // 単一ルートだが直下にbackend/が無いワークスペースを模す
      // （`tests/fixtures/vscode_workspace_no_backend/`にはfrontend/のみ存在する）。
      patchWorkspaceFolders([makeWorkspaceFolder(noBackendWorkspaceUri, 0)]);

      await vscode.commands.executeCommand("apivista.showGraph");

      const webviewTab = await waitForWebviewTab("apivista.graphPanel", 2000);
      assert.strictEqual(
        webviewTab,
        undefined,
        "a graph webview panel was unexpectedly created for a workspace missing backend/",
      );
      assert.ok(
        errorMessageCalls.length > 0,
        "showErrorMessage was not called for a workspace missing backend/",
      );
    });
  });

  suite("multi-root", () => {
    test("shows an error message and does not open a graph panel", async function () {
      this.timeout(20000);

      // 1件目は正常系フィクスチャ(backend/frontend両方あり)、2件目はそれ以外の任意の既存ディレクトリ。
      // workspaceScannerはフォルダ数のみで multi-root を判定するため、2件目の内容自体は無関係だが、
      // 1件目を正常系にしておくことで「multi-root検出」自体が効いていることを明確にする
      // （上記`validRootUri`のコメント参照）。
      patchWorkspaceFolders([
        makeWorkspaceFolder(validRootUri, 0),
        makeWorkspaceFolder(noBackendWorkspaceUri, 1),
      ]);
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 2);

      await vscode.commands.executeCommand("apivista.showGraph");

      const webviewTab = await waitForWebviewTab("apivista.graphPanel", 2000);
      assert.strictEqual(
        webviewTab,
        undefined,
        "a graph webview panel was unexpectedly created for a multi-root workspace",
      );
      assert.ok(
        errorMessageCalls.length > 0,
        "showErrorMessage was not called for a multi-root workspace",
      );
    });
  });
});
