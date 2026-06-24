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

import { assembleOutput } from "./assemble.js";
import { extractFile } from "./extractFile.js";
import type { FileExtractionResult } from "./extractFile.js";
import { buildModuleMap } from "./moduleMap.js";
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
  /** 進捗メッセージのコールバック。各フェーズ完了時に呼び出す。 */
  onProgress?: (msg: string) => void;
  /** キャンセル確認。キャンセルされた場合 throw する。vscode 依存なし（単なる () => void）。 */
  checkCancelled?: () => void;
  /**
   * スポット解析用フォーカルファイル ID（backendRoot 相対 POSIX パス。例: "routers/posts.py"）。
   * 指定時は Pass1 をフォーカルファイルと同一ディレクトリ + ルートレベルのファイルに限定する。
   * Pass0（モジュールマップ）は全ファイルを処理し import 解決を保証する。
   */
  focalFileId?: string;
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
 * focalFileId と同じディレクトリ内のファイル + ルートレベルのファイルに絞り込む。
 * ルートレベルファイル（main.py 等）は常に含める（依存解決に必要なため）。
 */
function filterByFocalDir(allFileIds: string[], focalFileId: string): string[] {
  const focalDir = focalFileId.includes("/")
    ? focalFileId.slice(0, focalFileId.lastIndexOf("/"))
    : "";
  if (focalDir === "") {
    return allFileIds.filter((id) => !id.includes("/"));
  }
  return allFileIds.filter((id) => id.startsWith(focalDir + "/") || !id.includes("/"));
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

  const { onProgress, checkCancelled } = options ?? {};
  const collector = new WarningCollector();

  // Pass0: モジュールマップ（構文エラーファイルは skip + 警告記録済み）。
  const map = await buildModuleMap(backendRoot, collector, options?.wasmDir);
  onProgress?.(`バックエンド Pass0 完了: ${map.pathToModule.size} ファイルをスキャン`);
  checkCancelled?.();

  // Pass1: 各パース可能ファイルを抽出 + symbolTable 構築。
  // Pass0 が生成した parsedFiles キャッシュを再利用することで readFile/parse を省略する。
  const perFile = new Map<string, FileExtractionResult>();
  const symbolTables = new Map<string, Map<string, Binding>>();

  // 決定性のため fileId 昇順で処理する。focalFileId が指定された場合は Pass1 を限定する。
  const allFileIds = [...map.pathToModule.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const fileIds = options?.focalFileId
    ? filterByFocalDir(allFileIds, options.focalFileId)
    : allFileIds;

  for (const fileId of fileIds) {
    const cached = map.parsedFiles.get(fileId);
    if (!cached) continue; // fileIds は map 由来なので理論上到達しない
    const { tree } = cached;
    perFile.set(fileId, extractFile(fileId, tree, collector));
    symbolTables.set(fileId, buildSymbolTable(tree, fileId));
  }
  checkCancelled?.();

  // 起点ハンドラ候補（全ファイルの routes を平坦化）。
  const entryHandlers: RouteCandidate[] = [];
  for (const file of perFile.values()) {
    entryHandlers.push(...file.routes);
  }
  onProgress?.(`バックエンド Pass1 完了: ${entryHandlers.length} ルート候補を抽出`);

  // Pass2a: ルートパス解決。
  const routes = resolveRoutePaths(perFile, map, collector, symbolTables);

  // Pass2b: 関数単位呼び出しグラフ → ファイル単位グラフ。
  const functions = buildCallGraph(entryHandlers, perFile, map, symbolTables);
  const files = deriveFileGraph(functions);

  // Pass2c: クロスファイルのスキーマ参照解決。
  const schemaRefsByHandler = resolveSchemaRefs(perFile, map, collector, symbolTables);
  onProgress?.(`バックエンド Pass2 完了: ${routes.length} ルートを解決`);

  // Assembler: 単一の AnalysisOutput に統合。
  return assembleOutput(routes, schemaRefsByHandler, functions, files, collector.warnings);
}
