/**
 * Output Assembler（design.md「assemble — Output Assembler」, Requirements 4.1, 4.2, 4.3）。
 *
 * 各 Pass の解決結果（ルート定義 / 起点関数IDでキー化したスキーマ参照 / 関数ノード /
 * ファイルノード / 警告）を単一の `AnalysisOutput`（`schemaVersion=1`）へ統合する。
 *
 * 唯一の変換は `RouteDefinition.schemaRefs` のマージで、`entryFunctionId` 一致により
 * `schemaRefsByHandler` から参照を引く。該当キーが無いハンドラは空配列とする（型注釈なし
 * ハンドラ = Req 2.2）。入力配列の順序は保持し（決定性）、入力オブジェクトは変更しない。
 *
 * `routes[].entryFunctionId` → `functions[].id` → `functions[].file` → `files[].id` の
 * 相互参照（4.2/4.3）は各 Pass が採番済みの ID をそのまま素通しすることで貫通する。
 * 本モジュールはランタイム副作用を持たない純関数。
 */
import type {
  AnalysisOutput,
  FileNode,
  FunctionNode,
  RouteDefinition,
  SchemaReference,
  Warning,
} from "./models.js";
import { SCHEMA_VERSION } from "./models.js";

/**
 * 各 Pass の結果を単一の `AnalysisOutput` に統合する。
 *
 * - `routes` は `entryFunctionId` で `schemaRefsByHandler` を引いて `schemaRefs` を埋めた
 *   新しいオブジェクト配列に置き換える（入力は変更しない）。該当なしは空配列（Req 2.2）。
 * - `functions` / `files` / `warnings` はそのまま素通しする。
 */
export function assembleOutput(
  routes: RouteDefinition[],
  schemaRefsByHandler: Map<string, SchemaReference[]>,
  functions: FunctionNode[],
  files: FileNode[],
  warnings: Warning[],
): AnalysisOutput {
  const mergedRoutes: RouteDefinition[] = routes.map((route) => ({
    ...route,
    schemaRefs: schemaRefsByHandler.get(route.entryFunctionId) ?? [],
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    routes: mergedRoutes,
    functions,
    files,
    warnings,
  };
}
