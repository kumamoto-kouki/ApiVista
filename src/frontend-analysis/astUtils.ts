/**
 * ts-morph ノード走査ヘルパ・URL 正規化・位置補正（design.md「astUtils」）。
 *
 * backend の astUtils（位置・文字列リテラル評価）に対応する frontend 版。
 * - 位置: ts-morph は 1 基底。`.vue` 由来ノードは `segments`（sfc.ts）で実ファイル行へ補正する。
 * - URL: 文字列リテラルはそのまま、テンプレートリテラルは `${expr}` を `{}` プレースホルダへ正規化。
 *
 * いずれも純関数（副作用なし）で、同一入力に対し決定的。除外判定（動的 URL/method）は
 * 呼び出し側（extractors/apiCalls = 3.1）が担い、本ユーティリティは正規化と
 * 「正規化不能なら null」を返すことのみを担う（Req1.3 / 補助的に Req4.2）。
 */
import { Node } from "ts-morph";

import type { SourceLocation } from "./models.js";
import type { ScriptSegment } from "./sfc.js";

/** URL テンプレートの動的セグメントを表すプレースホルダ（backend のパスパラメータと静的照合可能）。 */
const PLACEHOLDER = "{}";

/**
 * 結合スクリプト内の行 `combinedLine`（1 基底）を、`segments` を引いて元 `.vue` 実ファイル行へ補正する。
 *
 * `.ts/.js`（segments 空＝恒等）では `combinedLine` をそのまま返す。`.vue` では
 * 該当 segment を引き、design の式 `vueStartLine - 1 + (combinedLine - fromLine + 1)` を適用する
 * （`<script>` + `<script setup>` 併存時も segment 単位で正確）。どの segment にも属さない場合は
 * 補正せず生の行を返す（best-effort）。
 */
export function correctLine(combinedLine: number, segments: ScriptSegment[]): number {
  for (const segment of segments) {
    if (combinedLine >= segment.fromLine && combinedLine <= segment.toLine) {
      return segment.vueStartLine - 1 + (combinedLine - segment.fromLine + 1);
    }
  }
  return combinedLine;
}

/**
 * ノードの開始行を 1 基底で返し、`.vue` 由来なら `segments` で実ファイル行へ補正する。
 * `.ts/.js` は `segments` を空配列で渡せば ts-morph の行をそのまま採用する。
 */
export function line(node: Node, segments: ScriptSegment[]): number {
  return correctLine(node.getStartLineNumber(), segments);
}

/**
 * ノードから `SourceLocation` を構築する。`file` は呼び出し側が渡す fileId、
 * `line` は `segments` 補正後の 1 基底行。
 */
export function toSourceLocation(
  fileId: string,
  node: Node,
  segments: ScriptSegment[],
): SourceLocation {
  return { file: fileId, line: line(node, segments) };
}

/**
 * URL 引数ノードを正規化済み URL パターンへ変換する（Req1.3）。
 *
 * - 文字列リテラル / 静的テンプレートリテラル（置換なし）→ リテラル値をそのまま返す。
 * - 置換ありテンプレートリテラル → 静的リテラル骨格を保持しつつ各 `${expr}` を `{}` に正規化して返す。
 * - 上記いずれでもないノード（変数・関数結果など、骨格が静的に決定不能）→ `null`。
 *
 * 「null＝除外対象」かどうかの最終判断は呼び出し側（extractors/apiCalls）に委ねる。
 */
export function normalizeUrlTemplate(node: Node): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isTemplateExpression(node)) {
    return normalizeTemplateExpression(node);
  }
  return null;
}

/**
 * 置換ありテンプレートリテラルを `head + ({} + spanLiteral)*` として組み立てる。
 * 例: `` `/api/users/${id}/posts/${pid}` `` → `/api/users/{}/posts/{}`。
 */
function normalizeTemplateExpression(node: import("ts-morph").TemplateExpression): string {
  let result = node.getHead().getLiteralText();
  for (const span of node.getTemplateSpans()) {
    result += PLACEHOLDER + span.getLiteral().getLiteralText();
  }
  return result;
}
