/**
 * Output Assembler（design.md「assemble — Output Assembler」, Requirements 3.1, 3.2, 3.3）。
 *
 * Pass2（resolver/callGraph）の解決結果——内包ノード解決済みの API 呼び出し / 関数ノード /
 * ファイルノード / 警告——を単一の `AnalysisOutput`（`schemaVersion=1`）へ統合する。
 * backend-route-extractor の `assembleOutput` と対称だが、frontend は `routes`/`schemaRefs` を持たず
 * `apiCalls` を束ねる（`ApiCall` は `enclosingFunctionId` 注釈済みで Pass2 から渡る）ため、本モジュールは
 * 変換を行わず四つの配列を `schemaVersion` 付きで束ねるだけの純関数である（Req 3.1）。
 *
 * 参照貫通の不変条件（Req 3.2/3.3）——`ApiCall.enclosingFunctionId == FunctionNode.id`、
 * `FunctionNode.file == FileNode.id`、`calls[]/dependsOn[] == 実在 id`——は各 Pass が採番済みの ID を
 * そのまま素通しすることで貫通する（本モジュールは ID を生成・改変しない）。
 *
 * 入力配列の順序は保持し（決定性）、入力オブジェクトは変更しない。ランタイム副作用を持たない。
 */
import type { AnalysisOutput, ApiCall, FileNode, FunctionNode, Warning } from "./models.js";
import { SCHEMA_VERSION } from "./models.js";

/**
 * 各 Pass の結果を単一の `AnalysisOutput` に統合する（Req 3.1）。
 *
 * `apiCalls` / `functions` / `files` / `warnings` をそのまま素通しし、`schemaVersion=1` を付与する。
 * 入力は変更せず、入力順を保持する。参照貫通（Req 3.2/3.3）は素通しにより維持される。
 */
export function assembleOutput(
  apiCalls: ApiCall[],
  functions: FunctionNode[],
  files: FileNode[],
  warnings: Warning[],
): AnalysisOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    apiCalls,
    functions,
    files,
    warnings,
  };
}
