/**
 * 開発 / E2E 用の薄い CLI ラッパ（design.md「cli.ts」, Requirements 4.1, 4.3, 5.1）。
 *
 * 公開 API `analyzeBackend` を呼び出し、単一の `AnalysisOutput` を JSON として
 * **標準出力**へ書き出す。診断 / 進捗ログは **標準エラー**へのみ出力し、標準出力は
 * 単一の JSON オブジェクトだけを占有する（消費側がそのままパイプできる）。
 *
 * 終了コード規約:
 * - backendRoot 引数なし → usage を stderr に出し、非0（2）で終了。
 * - 解析が成立した場合 → 警告（warnings）を含んでいても 0 で終了（warnings はデータで
 *   あり失敗ではない。Requirement 5.1）。
 * - backendRoot が不正（存在しない / ディレクトリでない等で `analyzeBackend` が throw）
 *   → エラーメッセージを stderr に出し、非0（1）で終了。
 *
 * パッケージへ bin エントリは追加しない（本タスクのスコープ外）。ビルド後
 * `node out/backend-analysis/cli.js <dir>` で起動する想定。
 */
import { pathToFileURL } from "node:url";

import { analyzeBackend } from "./index.js";
import type { AnalyzeOptions } from "./index.js";

const USAGE = "usage: cli <backendRoot> [--wasm-dir <path>]";

/** 引数解析結果（最小・手動パース、新規依存なし）。 */
interface ParsedArgs {
  backendRoot: string;
  options: AnalyzeOptions;
}

/**
 * `argv`（実行ファイル名を除いた引数列）を解析する。
 * 最初の位置引数を `backendRoot`、`--wasm-dir <path>` を `options.wasmDir` として扱う。
 * `backendRoot` が無い場合は `null` を返す（呼び出し側が usage を出して非0終了する）。
 */
function parseArgs(argv: string[]): ParsedArgs | null {
  let backendRoot: string | undefined;
  const options: AnalyzeOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wasm-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return null;
      }
      options.wasmDir = value;
      i++;
      continue;
    }
    if (backendRoot === undefined) {
      backendRoot = arg;
    }
  }

  if (backendRoot === undefined) {
    return null;
  }
  return { backendRoot, options };
}

/**
 * CLI 本体。テスト可能なように `argv` を受け取り終了コードを返す（process.exit しない）。
 *
 * @param argv `process.argv.slice(2)` 相当の引数列
 * @returns 終了コード（0 = 成功、2 = 引数不足、1 = 解析エラー）
 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const output = await analyzeBackend(parsed.backendRoot, parsed.options);
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
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
