/**
 * 出力アセンブラ(design.md「assemble.ts(統合)」、Req5.1/5.4/5.5, 6.1/6.3/6.4, 7.3)。
 *
 * `matchRoutes` の結果・統合済み functions/files・両入力 warnings を単一の `LinkageOutput`
 * へ統合する。`warnings` は両入力 warnings + 連携診断(`match.diagnostics`)をこの順で集約する。
 *
 * **決定性(Req7.3)**: 入力配列の順序揺れに依存しない安定出力のため、各配列を正準ソートする。
 * - `linkages`: (apiCall.location.file, line) → (route.method, route.path) 昇順
 * - `unmatchedRoutes`: (method, path) 昇順
 * - `unmatchedApiCalls`: (location.file, line, urlPattern) 昇順
 * - `functions`/`files`: id 昇順(id は side 接頭辞付きで一意)
 */
import { SCHEMA_VERSION } from "./models.js";
import type {
  LinkageOutput,
  LinkedFileNode,
  LinkedFunctionNode,
  RouteLinkage,
  Warning,
} from "./models.js";
import type { MatchResult } from "./matcher.js";

function compareKeys(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function sortBy<T>(items: readonly T[], keyFn: (item: T) => ReadonlyArray<string | number>): T[] {
  return [...items].sort((a, b) => compareKeys(keyFn(a), keyFn(b)));
}

/**
 * `MatchResult` と統合済みグラフを単一の `LinkageOutput`(`schemaVersion=1`)へ統合する。
 */
export function assembleLinkage(
  match: MatchResult,
  functions: readonly LinkedFunctionNode[],
  files: readonly LinkedFileNode[],
  inputWarnings: readonly Warning[],
): LinkageOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    linkages: sortBy<RouteLinkage>(match.linkages, (l) => [
      l.apiCall.location.file,
      l.apiCall.location.line,
      l.route.method,
      l.route.path,
    ]),
    unmatchedRoutes: sortBy(match.unmatchedRoutes, (r) => [r.method, r.path]),
    unmatchedApiCalls: sortBy(match.unmatchedApiCalls, (c) => [
      c.location.file,
      c.location.line,
      c.urlPattern,
    ]),
    functions: sortBy(functions, (f) => [f.id]),
    files: sortBy(files, (f) => [f.id]),
    warnings: [...inputWarnings, ...match.diagnostics],
  };
}
