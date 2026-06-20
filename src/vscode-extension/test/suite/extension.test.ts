/**
 * プレースホルダ統合テスト（task 1.3）。
 *
 * 目的は @vscode/test-electron + Mocha のテスト実行基盤そのものが実VSCodeを起動し
 * 正常終了することの確認のみ。実際の拡張アクティベーション検証は task 8.1 の責務。
 */
import * as assert from "node:assert";

suite("placeholder", () => {
  test("loads", () => {
    assert.ok(true);
  });
});
