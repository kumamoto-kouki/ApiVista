/**
 * 公開API(design.md「index.ts(公開API)」、Req1.1-1.3, 6.1, 7.1-7.3)。
 *
 * backend/frontend の `AnalysisOutput` を受け取り、入力検証 → `matchRoutes` →
 * `mergeFunctions`/`mergeFiles` → `assembleLinkage` の順に実行して単一 `LinkageOutput`
 * を返す純粋・同期関数。対象コードは実行しない(与えられたデータのみを静的に変換)。
 *
 * design.md の Boundary Commitments「backend/frontend `models.ts` からは型のみ import
 * (read-only、挙動結合なし)」に従い、入力検証は両モジュールの型ガード/定数を実行時 import
 * せず、本モジュール内にローカルで同等の構造検証(`schemaVersion===1` + 必須配列)を実装する。
 */
import type { AnalysisOutput as BackendAnalysisOutput } from "../backend-analysis/models.js";
import type { AnalysisOutput as FrontendAnalysisOutput } from "../frontend-analysis/models.js";
import { assembleLinkage } from "./assemble.js";
import { mergeFiles, mergeFunctions } from "./graphMerge.js";
import { matchRoutes } from "./matcher.js";
import type { LinkageOutput } from "./models.js";

/** backend/frontend 双方の AnalysisOutput が満たすべきスキーマバージョン(design.md固定)。 */
const EXPECTED_SCHEMA_VERSION = 1;

/** `schemaVersion===1` と必須配列の存在を検証し、不正なら throw する(Req1.2)。 */
function assertValidAnalysisOutput(
  value: unknown,
  requiredArrayKeys: readonly string[],
  label: "backend" | "frontend",
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} AnalysisOutput must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `${label} AnalysisOutput has unsupported schemaVersion ${String(candidate.schemaVersion)} (expected ${EXPECTED_SCHEMA_VERSION})`,
    );
  }
  for (const key of requiredArrayKeys) {
    if (!Array.isArray(candidate[key])) {
      throw new Error(`${label} AnalysisOutput is missing required array field "${key}"`);
    }
  }
}

/**
 * backend/frontend の `AnalysisOutput` を連携付け、単一の `LinkageOutput` を返す。
 * 入力が `schemaVersion=1`・必須配列構造を満たさない場合は throw する(Req1.2)。
 * 対象プロジェクトのコードは実行しない、純粋・同期・決定的な変換(Req1.3/7.1/7.3)。
 */
export function linkRoutes(
  backendOutput: BackendAnalysisOutput,
  frontendOutput: FrontendAnalysisOutput,
): LinkageOutput {
  assertValidAnalysisOutput(backendOutput, ["routes", "functions", "files", "warnings"], "backend");
  assertValidAnalysisOutput(
    frontendOutput,
    ["apiCalls", "functions", "files", "warnings"],
    "frontend",
  );

  const match = matchRoutes(backendOutput.routes, frontendOutput.apiCalls);
  const functions = mergeFunctions(backendOutput.functions, frontendOutput.functions);
  const files = mergeFiles(backendOutput.files, frontendOutput.files);

  return assembleLinkage(match, functions, files, [
    ...backendOutput.warnings,
    ...frontendOutput.warnings,
  ]);
}

export { SCHEMA_VERSION } from "./models.js";
export type {
  ApiCallRef,
  LinkageOutput,
  LinkedFileNode,
  LinkedFunctionNode,
  RouteLinkage,
  RouteRef,
} from "./models.js";
