/**
 * 開発 / E2E 用の薄い CLI ラッパ(design.md「cli.ts(開発/E2E用・薄いラッパ)」、Req6.1, 7.2)。
 *
 * 2つの `AnalysisOutput` JSON ファイルパス(backend/frontend の順)を引数に取り、
 * `linkRoutes` の結果を単一 JSON として **標準出力** へ書き出す。エラーは **標準エラー**
 * へのみ出力し、標準出力は単一の JSON オブジェクトだけを占有する。
 *
 * 解析の実行(`analyzeBackend`/`analyzeFrontend`)は本specの責務外で、JSON入力前提
 * (design.md「対象コードは実行しない」)。`linkRoutes` 自体が純粋・同期のため、本CLIも同期。
 *
 * 終了コード規約:
 * - 引数が2つ未満 → usage を stderr に出し、非0(2)で終了。
 * - 連携が成立 → 0 で終了。
 * - ファイル不在/JSON不正/`linkRoutes` の入力検証エラー → エラーメッセージを stderr に出し、非0(1)で終了。
 *
 * パッケージへ bin エントリは追加しない(本タスクのスコープ外)。ビルド後
 * `node out/route-linkage/cli.js <backendJson> <frontendJson>` で起動する想定。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { AnalysisOutput as BackendAnalysisOutput } from "../backend-analysis/models.js";
import type { AnalysisOutput as FrontendAnalysisOutput } from "../frontend-analysis/models.js";
import { linkRoutes } from "./index.js";

const USAGE = "usage: cli <backendAnalysisJsonPath> <frontendAnalysisJsonPath>";

interface ParsedArgs {
  backendPath: string;
  frontendPath: string;
}

/** 位置引数2つ(backend/frontend JSONパス)を取り出す。不足時は `null`。 */
function parseArgs(argv: string[]): ParsedArgs | null {
  const [backendPath, frontendPath] = argv;
  if (backendPath === undefined || frontendPath === undefined) {
    return null;
  }
  return { backendPath, frontendPath };
}

/**
 * CLI 本体。テスト可能なように `argv` を受け取り終了コードを返す(`process.exit` しない)。
 *
 * @param argv `process.argv.slice(2)` 相当の引数列
 * @returns 終了コード(0 = 成功、2 = 引数不足、1 = 連携エラー)
 */
export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const backendOutput = JSON.parse(
      readFileSync(parsed.backendPath, "utf-8"),
    ) as BackendAnalysisOutput;
    const frontendOutput = JSON.parse(
      readFileSync(parsed.frontendPath, "utf-8"),
    ) as FrontendAnalysisOutput;
    const output = linkRoutes(backendOutput, frontendOutput);
    // stdout は単一 JSON 専用(ログは出さない)。
    process.stdout.write(JSON.stringify(output));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

// スクリプトとして直接起動された場合のみ実行する(テストからの import 時は実行しない)。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
