/**
 * 開発 / E2E 用の薄い CLI ラッパ（design.md「cli.ts」, Requirements 3.1, 4.3, 5.1）。
 *
 * 公開 API `analyzeFrontend` を呼び出し、単一の `AnalysisOutput` を JSON として
 * **標準出力**へ書き出す。診断 / 進捗ログは **標準エラー**へのみ出力し、標準出力は
 * 単一の JSON オブジェクトだけを占有する（消費側がそのままパイプ＝JSON.parse できる）。
 *
 * 終了コード規約:
 * - frontendRoot 引数なし → usage を stderr に出し、非0（2）で終了。
 * - 解析が成立した場合 → 警告（warnings）を含んでいても 0 で終了（warnings はデータで
 *   あり失敗ではない。Requirement 5.1）。
 * - frontendRoot が不正（存在しない / ディレクトリでない等で `analyzeFrontend` が throw）
 *   → エラーメッセージを stderr に出し、非0（1）で終了（Requirement 5.1）。
 *
 * パッケージへ bin エントリは追加しない（本タスクのスコープ外）。ビルド後
 * `node out/frontend-analysis/cli.js <dir>` で起動する想定。backend `cli.ts` と対称だが、
 * `analyzeFrontend` は同期（ts-morph 同期）のため本ラッパも非 async。
 */
import { pathToFileURL } from "node:url";

import { analyzeFrontend } from "./index.js";

const USAGE = "usage: cli <frontendRoot>";

/**
 * `argv`（実行ファイル名を除いた引数列）を解析する。
 * 最初の位置引数を `frontendRoot` として扱う。`frontendRoot` が無い場合は `null` を返す
 * （呼び出し側が usage を出して非0終了する）。
 *
 * `AnalyzeFrontendOptions.include` は v1 では未配線（index.ts 参照）のため、CLI もフラグを
 * 受け付けない（将来 include を配線する際に拡張する）。
 */
function parseArgs(argv: string[]): string | null {
  for (const arg of argv) {
    return arg;
  }
  return null;
}

/**
 * CLI 本体。テスト可能なように `argv` を受け取り終了コードを返す（process.exit しない）。
 *
 * @param argv `process.argv.slice(2)` 相当の引数列
 * @returns 終了コード（0 = 成功、2 = 引数不足、1 = 解析エラー）
 */
export function main(argv: string[]): number {
  const frontendRoot = parseArgs(argv);
  if (frontendRoot === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const output = analyzeFrontend(frontendRoot);
    // stdout は単一 JSON 専用（ログは出さない）。
    process.stdout.write(JSON.stringify(output));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

// スクリプトとして直接起動された場合のみ実行する（テストからの import 時は実行しない）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
