/**
 * `analyzeBackend`/`analyzeFrontend`/`linkRoutes`の順次呼び出しとエラー正規化
 * （design.md「analysisOrchestrator」, Requirements 2.1, 2.3, 6.2, 8.2）。
 *
 * - `analyzeBackend`(真の非同期・WASM初期化を伴う)→`analyzeFrontend`(同期)→`linkRoutes`(同期)
 *   の順に呼び出す。`analyzeFrontend`/`linkRoutes`は同期だが、本関数はasync関数内から通常の
 *   戻り値として扱うことで、3関数間の非対称性(真の非同期/同期)を吸収する。
 * - いずれかがthrow/rejectした場合は`AnalysisError`でラップして呼び出し元に伝播させる
 *   （対象プロジェクトのコードは実行しない。3spec共通契約を踏襲しthrowを握り潰さない）。
 * - 3specの`warnings`は`linkRoutes`の出力(`LinkageOutput.warnings`)に既に集約されているため、
 *   本コンポーネントは追加の警告処理を行わない。
 */
import { analyzeBackend } from "../backend-analysis/index.js";
import { analyzeFrontend } from "../frontend-analysis/index.js";
import { linkRoutes } from "../route-linkage/index.js";
import type { LinkageOutput } from "../route-linkage/index.js";

/**
 * `analyzeBackend`/`analyzeFrontend`/`linkRoutes`のいずれかが失敗した際の正規化エラー。
 * 元の例外を`cause`として保持し、握り潰さずに呼び出し元へ伝播させる。
 */
export class AnalysisError extends Error {
  constructor(
    public readonly cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

/**
 * `backendRoot`/`frontendRoot`を解析し、単一の`LinkageOutput`を返す。
 *
 * @param backendRoot 解析対象backendルートの絶対パス(存在するディレクトリ。workspaceScannerが検証済み)
 * @param frontendRoot 解析対象frontendルートの絶対パス(存在するディレクトリ。workspaceScannerが検証済み)
 * @throws `AnalysisError` `analyzeBackend`/`analyzeFrontend`/`linkRoutes`のいずれかが失敗した場合
 */
export async function analyze(backendRoot: string, frontendRoot: string): Promise<LinkageOutput> {
  try {
    const backendOutput = await analyzeBackend(backendRoot);
    const frontendOutput = analyzeFrontend(frontendRoot);
    return linkRoutes(backendOutput, frontendOutput);
  } catch (error) {
    throw new AnalysisError(error, "ApiVistaの解析処理に失敗しました。");
  }
}
