/**
 * 出力データモデル（route-linkage-engine / vscode-extension-ui の入力契約）。
 *
 * backend-route-extractor（`src/backend-analysis/models.ts`）と**対称的**なスキーマを定義する。
 * `FunctionNode` / `FileNode` / `Warning` / `SourceLocation` / `SCHEMA_VERSION` は backend と**同形**、
 * `ApiCall` は backend `RouteDefinition` の**対称物**（`schemaRefs` を持たない）。
 *
 * JSON キー名・型・必須性は design.md「Data Contracts & Integration」に厳密準拠する。
 * 当面 frontend-analysis に自己完結で定義する（完成済み backend を非改変＝回帰回避。
 * `src/shared/` への統合は route-linkage-engine 着手時の将来候補）。
 *
 * 本モジュールはランタイム副作用を持たず、型・`SCHEMA_VERSION` 定数・型ガードのみを公開する。
 */

import type { HttpMethod, SourceLocation, Warning } from "../shared/models.js";
export type { HttpMethod, SourceLocation, Warning };

/** 出力スキーマのバージョン。互換性の境界（design.md schemaVersion=1）。 */
export const SCHEMA_VERSION = 1 as const;

/**
 * API 呼び出し（階層1: ルート連携）。backend `RouteDefinition` の対称物。
 * `schemaRefs` は持たず、内包ノード ID（`enclosingFunctionId`）への参照を持つ。
 */
export interface ApiCall {
  /** "GET" | "POST" | "PUT" | "DELETE" | "PATCH"（大文字 string）。既定 "GET"。 */
  method: string;
  /** リテラル or テンプレートリテラル正規化後パターン（動的セグメント=プレースホルダ `{}`）。 */
  urlPattern: string;
  /** 内包する関数/コンポーネント/composable の `FunctionNode.id`（"<module-path>:<qualname>"）。 */
  enclosingFunctionId: string;
  location: SourceLocation;
}

/** 関数ノード（階層3: 関数単位）。backend と同形。 */
export interface FunctionNode {
  /** "<module-path>:<qualname>"。 */
  id: string;
  name: string;
  /** fileId（frontendRoot 相対 POSIX）。 */
  file: string;
  location: SourceLocation;
  /** 呼び出し先 FunctionNode.id（frontend 外は含めない）。 */
  calls: string[];
}

/** ファイルノード（階層2: ファイル単位）。`id === path`（fileId）。backend と同形。 */
export interface FileNode {
  id: string;
  path: string;
  dependsOn: string[];
}

/** 解析結果の単一データセット（backend `AnalysisOutput` の対称物）。 */
export interface AnalysisOutput {
  /** = 1。 */
  schemaVersion: number;
  apiCalls: ApiCall[];
  functions: FunctionNode[];
  files: FileNode[];
  warnings: Warning[];
}

/**
 * `value` が `schemaVersion === 1` の `AnalysisOutput` 構造かを判定する型ガード
 * （backend `models.ts` と対称）。配列フィールドの存在のみを検査し、要素の深い
 * 構造検証は行わない（生成側が型安全に組み立てるため）。
 */
export function isAnalysisOutput(value: unknown): value is AnalysisOutput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(candidate.apiCalls) &&
    Array.isArray(candidate.functions) &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.warnings)
  );
}
