/**
 * Pass1 呼び出し式抽出（design.md「extractors/defs, calls, templates(Pass1)」, Req2.1）。
 *
 * 単一 `SourceFile` 内の各 `CallExpression` を走査し、それを内包する定義
 * （関数 / composable / `.vue` コンポーネントノード）へ帰属させて
 * `{callerQualname, calleeText, location}` として収集する。これは Pass2（callGraph, 4.1）が
 * 呼び出し元→呼び出し先の有向エッジを構築するための入力となる。
 *
 * **責務境界（3.3 は callee の「名」の収集まで）**:
 * - caller 帰属: 3.2 の `findEnclosingDef`（祖先走査で最近傍の名前付き関数 → 無ければ
 *   `.vue` コンポーネントノード）を再利用する。`<script setup>` 直下など名前付き関数に
 *   内包されない呼び出しはコンポーネントノードに帰属する（Req1.4 / Issue 2）。
 *   どの定義にも帰属しない呼び出し（`.vue` でない `.ts/.js` のトップレベル呼び出し等）は
 *   起点ノードが存在しないため収集しない（`findEnclosingDef` が undefined を返す）。
 * - callee: 呼び出し式の callee 式テキスト（`foo()`→`foo`、`obj.method()`→`obj.method`）を
 *   そのまま記録する。どの fileId のどの定義かの**解決**は 3.3 の責務ではなく 4.1
 *   （exportIndex / エイリアス解決 / componentIndex）。ここでは名前収集に徹する。
 *
 * **API 呼び出しとの関係**: `$fetch`/`axios.get` 等の API 呼び出しも `CallExpression` であり、
 * 本 Pass は呼び出しグラフ用の**一般的な呼び出し収集**としてこれらも含めて収集する
 * （API 固有の method/URL 抽出は extractors/apiCalls=3.1、各ノードへの API 注釈は 4.1 が担う。
 * 別管理であって除外ではない）。
 *
 * 本モジュールは単一 `SourceFile` を受け取る純粋抽出関数（副作用なし）。`.vue` 由来の位置は
 * `segments` で実ファイル行へ補正する（Req3.3）。構文エラーファイルの skip は呼び出し側の責務。
 */
import { SyntaxKind, type SourceFile } from "ts-morph";

import { toSourceLocation } from "../astUtils.js";
import type { SourceLocation } from "../models.js";
import type { ScriptSegment } from "../sfc.js";

import { extractDefs, findEnclosingDef } from "./defs.js";

/**
 * 収集した呼び出しサイト（design.md「calls: {callerQualname, calleeText, location}」, Pass2 入力）。
 *
 * `callerQualname` は帰属先定義の qualname（4.1 が `FunctionNode.id` を引く起点）。
 * `calleeText` は callee 式の生テキスト（名前のみ。解決は 4.1）。`location` は `.vue` 補正済み。
 */
export interface CallSiteEntry {
  /** 呼び出し元定義の qualname（関数名 / `.vue` コンポーネント名）。 */
  callerQualname: string;
  /** callee 式テキスト（`foo` / `obj.method`）。fileId/定義への解決は 4.1。 */
  calleeText: string;
  location: SourceLocation;
}

/**
 * 単一 `SourceFile` 内の呼び出し式を、内包定義へ帰属させて収集する（Pass1）。
 *
 * @param sourceFile 解析対象（`.vue` 由来は仮想 `.ts`。構文エラーファイルは呼び出し側が skip 済み）
 * @param fileId frontendRoot 相対 POSIX（`.vue` は `.vue` 拡張子のまま。location.file / 帰属判定に使用）
 * @param segments `.vue` 行補正用 segments（`.ts/.js` は空配列＝恒等）
 */
export function extractCalls(
  sourceFile: SourceFile,
  fileId: string,
  segments: ScriptSegment[],
): CallSiteEntry[] {
  // caller 帰属は 3.2 の定義レジストリを再利用する（命名・id の単一情報源を共有）。
  const defs = extractDefs(sourceFile, fileId, segments);
  const entries: CallSiteEntry[] = [];

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const enclosing = findEnclosingDef(call, defs);
    if (enclosing === undefined) {
      // どの定義にも内包されない呼び出し（`.vue` でない .ts/.js のトップレベル呼び出し等）。
      // 起点ノードが無いため呼び出しグラフに載せられず収集対象外。
      continue;
    }

    entries.push({
      callerQualname: enclosing.qualname,
      calleeText: call.getExpression().getText(),
      location: toSourceLocation(fileId, call, segments),
    });
  }

  return entries;
}
