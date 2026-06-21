/**
 * アクティベーション・コマンド登録の統合テスト（task 8.1, design.md "Integration Tests
 * (@vscode/test-electron)" 1番目の項目「拡張アクティベーション時にコマンドが登録されていること」）。
 *
 * - `package.json`に`publisher`フィールドが存在しないため、`vscode.extensions.getExtension`を
 *   推測したidで呼ぶことはできない。`vscode.extensions.all`を走査し`packageJSON.name === "apivista"`
 *   で本拡張のハンドルを確実に特定する（publisher未設定時の標準的な識別方法）。
 * - 本拡張の`activationEvents`は`onStartupFinished`であり、`@vscode/test-electron`は
 *   ワークスペースを開いた状態でテストランナーを起動するため、テスト実行時点で
 *   `onStartupFinished`は通常既に発火済みである。ただしタイミング依存を排除するため、
 *   `extension.isActive`が`false`の場合は明示的に`activate()`を呼んでawaitする。
 * - `contributes.commands`で宣言したコマンドはアクティベーション前でも`getCommands()`の
 *   結果に現れる（VSCodeはpackage.jsonの宣言からコマンドパレット表示用のメタデータを
 *   静的に登録するため）が、アクティベーションを保証してからコマンド一覧を検証することで
 *   「ハンドラが実際に登録されている」状態の確認に近づける。
 */
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("extension activation", () => {
  test("activates and registers apivista commands", async () => {
    const extension = vscode.extensions.all.find(
      (candidate) => candidate.packageJSON.name === "apivista",
    );
    assert.ok(extension, "ApiVista extension (package.json name=apivista) was not found");

    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, "ApiVista extension did not activate");

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("apivista.showGraph"),
      "apivista.showGraph command was not registered",
    );
    assert.ok(
      commands.includes("apivista.reanalyze"),
      "apivista.reanalyze command was not registered",
    );
  });
});
