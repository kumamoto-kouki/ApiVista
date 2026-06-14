/**
 * 公開API（design.md「index — analyzeBackend」, Requirements 4.1, 4.2, 4.3, 6.2, 6.3, 6.4）。
 *
 * `backendRoot` を受け取り、Pass0（moduleMap）→ Pass1（extractFile / symbolTable）→
 * Pass2a（routePaths）/ Pass2b（callGraph）/ Pass2c（schemaRefs）→ Assembler を順に実行し、
 * 単一の `AnalysisOutput` を返す拡張ホスト内インプロセス公開API。
 *
 * - 対象コードは実行せず静的解析のみ（WASM パーサで AST 化するだけ。Requirement 6.2）。
 * - 解析自体が成立すれば、部分的失敗（構文エラー / 静的解決不能）は `warnings` に記録した
 *   うえで正常に値を返す（throw しない）。
 * - 引数不正（`backendRoot` が存在しない / ディレクトリでない）のみ `Error` を throw する。
 * - 決定性: ファイル走査は fileId 昇順で固定する（同一入力 → 同一出力）。
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assembleOutput } from "./assemble.js";
import { extractFile } from "./extractFile.js";
import type { FileExtractionResult } from "./extractFile.js";
import { buildModuleMap } from "./moduleMap.js";
import { getPythonParser } from "./parser.js";
import { buildCallGraph, deriveFileGraph } from "./resolver/callGraph.js";
import { resolveRoutePaths } from "./resolver/routePaths.js";
import { resolveSchemaRefs } from "./resolver/schemaRefs.js";
import { buildSymbolTable } from "./symbolTable.js";
import type { Binding } from "./symbolTable.js";
import { WarningCollector } from "./warnings.js";

import type { RouteCandidate } from "./extractFile.js";

// 消費側（route-linkage-engine / vscode-extension-ui）がパッケージ入口から型を import
// できるよう、出力契約の公開型・定数を再エクスポートする。
export type {
  AnalysisOutput,
  FileNode,
  FunctionNode,
  RouteDefinition,
  SchemaReference,
  SourceLocation,
  Warning,
} from "./models.js";
export { SCHEMA_VERSION } from "./models.js";

import type { AnalysisOutput } from "./models.js";

/** `analyzeBackend` のオプション。 */
export interface AnalyzeOptions {
  /**
   * Python 文法 WASM の所在ディレクトリ。拡張は `context.extensionUri` 由来の同梱パスを渡す。
   * 未指定時は Node 解決（node_modules）。
   */
  wasmDir?: string;
}

/**
 * `backendRoot` が解析可能なディレクトリであることを検証する。
 * 存在しない / ディレクトリでない場合は `Error` を throw する（Requirement 6.x）。
 * 対象コードは実行しない（同期 stat のみ）。
 */
function assertBackendRoot(backendRoot: string): void {
  let stats;
  try {
    stats = statSync(backendRoot);
  } catch {
    throw new Error(`backendRoot does not exist: ${backendRoot}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`backendRoot is not a directory: ${backendRoot}`);
  }
}

/**
 * `backendRoot` 配下の FastAPI コードを静的解析し、単一の `AnalysisOutput` を返す。
 *
 * @param backendRoot 解析対象 backend ルートの絶対パス（存在するディレクトリであること）
 * @param options WASM 同梱ディレクトリ等のオプション
 * @throws `backendRoot` が存在しない / ディレクトリでない場合
 */
export async function analyzeBackend(
  backendRoot: string,
  options?: AnalyzeOptions,
): Promise<AnalysisOutput> {
  assertBackendRoot(backendRoot);

  const collector = new WarningCollector();

  // Pass0: モジュールマップ（構文エラーファイルは skip + 警告記録済み）。
  const map = await buildModuleMap(backendRoot, collector, options?.wasmDir);

  // Pass1: 各パース可能ファイル（map に載ったもの）を抽出 + symbolTable 構築。
  // broken.py は map に不在のためここでは再パースされず、parse-error の二重記録は起きない。
  const parser = await getPythonParser(options?.wasmDir);
  const perFile = new Map<string, FileExtractionResult>();
  const symbolTables = new Map<string, Map<string, Binding>>();

  // 決定性のため fileId 昇順で処理する。
  const fileIds = [...map.pathToModule.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const fileId of fileIds) {
    const source = await readFile(join(backendRoot, fileId), "utf8");
    const tree = parser.parse(source);
    if (tree === null) {
      // map に載っているが再パースで null（理論上発生しないが防御的に記録）。
      collector.recordParseError(fileId);
      continue;
    }
    perFile.set(fileId, extractFile(fileId, tree, collector));
    symbolTables.set(fileId, buildSymbolTable(tree, fileId));
  }

  // 起点ハンドラ候補（全ファイルの routes を平坦化）。
  const entryHandlers: RouteCandidate[] = [];
  for (const file of perFile.values()) {
    entryHandlers.push(...file.routes);
  }

  // Pass2a: ルートパス解決。
  const routes = resolveRoutePaths(perFile, map, collector, symbolTables);

  // Pass2b: 関数単位呼び出しグラフ → ファイル単位グラフ。
  const functions = buildCallGraph(entryHandlers, perFile, map, symbolTables);
  const files = deriveFileGraph(functions);

  // Pass2c: クロスファイルのスキーマ参照解決。
  const schemaRefsByHandler = resolveSchemaRefs(perFile, map, collector);

  // Assembler: 単一の AnalysisOutput に統合。
  return assembleOutput(routes, schemaRefsByHandler, functions, files, collector.warnings);
}
