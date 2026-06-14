/**
 * 出力データモデル（route-linkage-engine / vscode-extension-ui の入力契約）。
 *
 * JSON キー名・型・必須性は design.md「Data Contracts & Integration」に厳密準拠する。
 * 本モジュールはランタイム副作用を持たず、型と `SCHEMA_VERSION` 定数のみを公開する。
 */

/** 出力スキーマのバージョン。互換性の境界（design.md schemaVersion=1）。 */
export const SCHEMA_VERSION = 1 as const;

/** HTTP メソッドの内部表現。`RouteDefinition.method` は大文字 string として直列化する。 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** スキーマ参照の役割。 */
export type SchemaRole = "request" | "response";

/** ソース位置。`file` は backendRoot 相対 POSIX パス、`line` は 1 基底。 */
export interface SourceLocation {
  file: string;
  line: number;
}

/** 機械可読な除外・診断情報。 */
export interface Warning {
  target: string;
  reason: string;
}

/** ルートに関連付くリクエスト/レスポンスモデル参照。 */
export interface SchemaReference {
  className: string;
  location: SourceLocation;
  role: SchemaRole;
}

/** ルート定義（階層1: ルート連携）。 */
export interface RouteDefinition {
  /** "GET" | "POST" | "PUT" | "DELETE" | "PATCH"（大文字 string）。 */
  method: string;
  /** prefix 結合済みの完全 URL パス。 */
  path: string;
  handler: SourceLocation;
  /** "<module-dotted-path>:<qualname>"。 */
  entryFunctionId: string;
  schemaRefs: SchemaReference[];
}

/** 関数ノード（階層3: 関数単位）。 */
export interface FunctionNode {
  /** "<module-dotted-path>:<qualname>"。 */
  id: string;
  name: string;
  /** fileId（backendRoot 相対 POSIX）。 */
  file: string;
  location: SourceLocation;
  /** 呼び出し先 FunctionNode.id（backend 外は含めない）。 */
  calls: string[];
}

/** ファイルノード（階層2: ファイル単位）。`id === path`（fileId）。 */
export interface FileNode {
  id: string;
  path: string;
  dependsOn: string[];
}

/** 解析結果の単一データセット。 */
export interface AnalysisOutput {
  /** = 1。 */
  schemaVersion: number;
  routes: RouteDefinition[];
  functions: FunctionNode[];
  files: FileNode[];
  warnings: Warning[];
}
