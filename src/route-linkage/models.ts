/**
 * 出力データモデル（route-linkage-engine / vscode-extension-ui の入力契約）。
 *
 * backend-route-extractor（`src/backend-analysis/models.ts`）と frontend-call-extractor
 * （`src/frontend-analysis/models.ts`）の `AnalysisOutput` を入力に、ルート連携（階層1）/
 * ファイル単位（階層2）/関数単位（階層3）を統合した単一の `LinkageOutput` を表現する。
 *
 * 入力型は両抽出器の `models.ts` から型のみ import して参照し（read-only・非改変）、
 * 出力型は本モジュールに**自己完結**で定義する（`src/shared/` への物理統合は v1 では行わない。
 * 完成済み2スペックの改変＝回帰回避。design.md「共有型の設計判断」に準拠）。
 *
 * 補助型 `SourceLocation` / `Warning` / `SchemaReference` は入力側（backend/frontend）と
 * 同形だが、依存方向を出力モジュールに閉じるため再宣言する。
 *
 * 本モジュールはランタイム副作用を持たず、型・`SCHEMA_VERSION` 定数・型ガードのみを公開する。
 */

/** 出力スキーマのバージョン。互換性の境界（design.md schemaVersion=1）。 */
export const SCHEMA_VERSION = 1 as const;

/** ノード・識別子の出自。`"backend:"` / `"frontend:"` 名前空間に対応する。 */
export type Side = "backend" | "frontend";

/** パスマッチングの種別。`exact`=完全一致、`suffix`=baseURL/共通プレフィックス差の吸収一致。 */
export type MatchKind = "exact" | "suffix";

/** ソース位置（入力側と同形・自己完結再宣言）。`line` は 1 基底。 */
export interface SourceLocation {
  file: string;
  line: number;
}

/** 機械可読な警告・診断情報（入力側と同形・自己完結再宣言）。 */
export interface Warning {
  target: string;
  reason: string;
}

/** ルートに関連付くリクエスト/レスポンスモデル参照（backend と同形・表示用付帯）。 */
export interface SchemaReference {
  className: string;
  location: SourceLocation;
  role: "request" | "response";
}

/**
 * 連携に含まれるバックエンドルートへの参照（階層1）。
 * `entryFunctionId` は名前空間化済み（`"backend:<id>"`）で `functions` 配列のノードを指す。
 * `schemaRefs` は表示用の付帯情報（連携の絞り込みには使用しない）。
 */
export interface RouteRef {
  method: string;
  path: string;
  handler: SourceLocation;
  /** 名前空間化済み `"backend:<id>"`。 */
  entryFunctionId: string;
  /** 表示用付帯（disambiguation には非使用）。 */
  schemaRefs: SchemaReference[];
}

/**
 * 連携に含まれるフロントエンドAPI呼び出しへの参照（階層1）。
 * `enclosingFunctionId` は名前空間化済み（`"frontend:<id>"`）で `functions` 配列のノードを指す。
 */
export interface ApiCallRef {
  method: string;
  urlPattern: string;
  /** 名前空間化済み `"frontend:<id>"`。 */
  enclosingFunctionId: string;
  location: SourceLocation;
}

/** ルート連携（階層1）。フロント呼び出しとバックエンドルートのマッチング結果。 */
export interface RouteLinkage {
  route: RouteRef;
  apiCall: ApiCallRef;
  matchKind: MatchKind;
}

/**
 * 統合された関数ノード（階層3）。`id` / `file` / `calls[]` は名前空間化済みで、
 * `side` により出自を一意識別する。
 */
export interface LinkedFunctionNode {
  /** 名前空間化済み `"<side>:<originalId>"`。 */
  id: string;
  side: Side;
  name: string;
  /** 名前空間化済み fileId（`LinkedFileNode.id` を指す）。 */
  file: string;
  location: SourceLocation;
  /** 名前空間化済み呼び出し先 `LinkedFunctionNode.id`。 */
  calls: string[];
}

/**
 * 統合されたファイルノード（階層2）。`id` / `dependsOn[]` は名前空間化済みで、
 * `side` により出自を一意識別する。
 */
export interface LinkedFileNode {
  /** 名前空間化済み `"<side>:<originalId>"`。 */
  id: string;
  side: Side;
  path: string;
  /** 名前空間化済み依存先 `LinkedFileNode.id`。 */
  dependsOn: string[];
}

/** 3階層を統合した単一の構造化出力（vscode-extension-ui の入力契約）。 */
export interface LinkageOutput {
  /** = 1（`SCHEMA_VERSION`）。 */
  schemaVersion: number;
  /** ルート連携（多重一致は全保持）。 */
  linkages: RouteLinkage[];
  /** 一致するフロント呼び出しが無いバックエンドルート。 */
  unmatchedRoutes: RouteRef[];
  /** 一致するバックエンドルートが無いフロント呼び出し。 */
  unmatchedApiCalls: ApiCallRef[];
  /** 両側統合・名前空間化済みの関数ノード（階層3）。 */
  functions: LinkedFunctionNode[];
  /** 両側統合・名前空間化済みのファイルノード（階層2）。 */
  files: LinkedFileNode[];
  /** 両入力由来の警告 + 本エンジンの診断を集約。 */
  warnings: Warning[];
}

/**
 * `value` が `schemaVersion === SCHEMA_VERSION` の `LinkageOutput` 構造かを判定する型ガード。
 *
 * frontend `models.ts` の `isAnalysisOutput` と対称の参照実装。必須配列の存在のみを
 * 検査し、要素の深い構造検証は行わない（生成側が型安全に組み立てるため）。
 */
export function isLinkageOutput(value: unknown): value is LinkageOutput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(candidate.linkages) &&
    Array.isArray(candidate.unmatchedRoutes) &&
    Array.isArray(candidate.unmatchedApiCalls) &&
    Array.isArray(candidate.functions) &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.warnings)
  );
}
