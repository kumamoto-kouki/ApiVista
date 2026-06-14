/**
 * Pass1 統合（design.md「extractFile(Pass1)」, Requirements 1.1, 1.4, 2.1, 3.1, 5.1, 5.2, 5.3）。
 *
 * パース済みの1ファイル分の構文木から、Pass1 の4抽出器
 * (`extractRoutes` / `extractRouterRelations` / `extractSchemaInfo` / `extractCalls`) を
 * 同一の tree/fileId に対して走らせ、`FileExtractionResult` に1パスでまとめる。
 *
 * 構文エラーのあるファイル(`hasSyntaxError(tree)` が true)はスキップ扱いとし、全フィールドを
 * 空配列・`skipped:true` で返したうえで `collector.recordParseError(fileId)` に記録する
 * (Requirement 5.1, throw しない)。ルートパスが静的解決不能な場合の警告(5.2/5.3)は、
 * 共有 `collector` を `extractRoutes` に渡すことで蓄積される。
 */
import type { Tree } from "web-tree-sitter";

import { hasSyntaxError } from "./astUtils.js";
import { extractCalls } from "./extractors/calls.js";
import type { CallExpression, FunctionDefinitionEntry } from "./extractors/calls.js";
import { extractRouterRelations } from "./extractors/routers.js";
import type { FastAPIInstance, IncludeRouterCall, RouterDefinition } from "./extractors/routers.js";
import { extractRoutes } from "./extractors/routes.js";
import type { RouteCandidate } from "./extractors/routes.js";
import { extractSchemaInfo } from "./extractors/schemas.js";
import type { ClassDefinition, SchemaRefCandidate } from "./extractors/schemas.js";
import type { WarningCollector } from "./warnings.js";

// Pass2 が消費するため、Pass1 抽出要素型を本モジュールから再エクスポートする。
export type {
  CallExpression,
  ClassDefinition,
  FastAPIInstance,
  FunctionDefinitionEntry,
  IncludeRouterCall,
  RouteCandidate,
  RouterDefinition,
  SchemaRefCandidate,
};

/**
 * 1ファイル分の Pass1 抽出結果（design.md「FileExtractionResult」）。
 * `skipped:true` のとき全配列は空（構文エラーでスキップされたファイル）。
 */
export interface FileExtractionResult {
  fileId: string;
  skipped: boolean;
  routes: RouteCandidate[];
  routers: RouterDefinition[];
  fastapiInstances: FastAPIInstance[];
  includeRouterCalls: IncludeRouterCall[];
  schemaRefCandidates: SchemaRefCandidate[];
  classDefinitions: ClassDefinition[];
  functionDefinitions: FunctionDefinitionEntry[];
  callExpressions: CallExpression[];
}

/**
 * パース済み1ファイルを Pass1 の4抽出器で1パス抽出し、`FileExtractionResult` に統合する。
 *
 * @param fileId backendRoot 相対 POSIX パス（警告 target / location.file に使用）
 * @param tree パース済み構文木
 * @param collector 全 Pass 共有の警告蓄積先（構文エラー / 静的解決不能を記録）
 */
export function extractFile(
  fileId: string,
  tree: Tree,
  collector: WarningCollector,
): FileExtractionResult {
  if (hasSyntaxError(tree)) {
    // 構文エラーファイルはスキップ扱い + 警告記録（Requirement 5.1, throw しない）。
    collector.recordParseError(fileId);
    return {
      fileId,
      skipped: true,
      routes: [],
      routers: [],
      fastapiInstances: [],
      includeRouterCalls: [],
      schemaRefCandidates: [],
      classDefinitions: [],
      functionDefinitions: [],
      callExpressions: [],
    };
  }

  const routes = extractRoutes(tree, fileId, collector);
  const { routers, fastapiInstances, includeRouterCalls } = extractRouterRelations(tree, fileId);
  const { refCandidates, classDefinitions } = extractSchemaInfo(tree, fileId);
  const { callExpressions, functionDefinitions } = extractCalls(tree, fileId);

  return {
    fileId,
    skipped: false,
    routes,
    routers,
    fastapiInstances,
    includeRouterCalls,
    schemaRefCandidates: refCandidates,
    classDefinitions,
    functionDefinitions,
    callExpressions,
  };
}
