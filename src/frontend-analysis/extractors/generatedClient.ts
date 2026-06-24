/**
 * Pass1 生成 OpenAPI クライアント（openapi-generator typescript-axios）の API 呼び出し抽出。
 *
 * 背景: アプリ側が `new XxxApi().operation(...)` 経由で呼ぶ生成クライアントは、$fetch/axios の
 * 直呼びを前提とする `extractApiCalls` では一切拾えない（実プロジェクトで apiCalls=0 になり、
 * 当該ファイルが連携グラフに現れない原因）。本抽出器は生成物のパターンを直接認識し、各エンドポイント
 * （method + path）を `ApiCallCandidate` として起こす。これによりバックエンドのルートと突合できる。
 *
 * 認識対象は `XxxApiAxiosParamCreator` 内の各オペレーションメソッド本体に現れる、次の2要素の組:
 * - `const localVarPath = `/v1/devices/{device_id}`` （文字列/テンプレートリテラル。openapi-generator は
 *   パスパラメータを `.replace(...)` で差し込むため、`.replace()` チェーンの基底リテラルを取り出す）。
 * - 同じ関数内のリクエストオプション `{ method: 'GET', ... }`（リテラルのみ。無ければ既定 GET）。
 *
 * 誤検出抑止: 識別子名がちょうど `localVarPath` の変数宣言のみを起点とする（openapi-generator 固有の
 * 命名。手書きコードでこの名前が使われることはまず無い）。骨格が静的に決定できない（変数等）パスは
 * canonicalize できずマッチに使えないため除外する（警告は出さない＝対象外＝診断ではない）。
 */
import { Node, SyntaxKind, type SourceFile, type VariableDeclaration } from "ts-morph";

import { normalizeUrlTemplate, toSourceLocation } from "../astUtils.js";
import type { HttpMethod } from "../models.js";
import type { ScriptSegment } from "../sfc.js";
import type { ApiCallCandidate } from "./apiCalls.js";

/** openapi-generator が生成するパス変数の固定名。これを検出の起点にする。 */
const PATH_VARIABLE_NAME = "localVarPath";

/** リクエストオプションで許容する HTTP メソッドリテラル（大文字化後）。 */
const HTTP_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "DELETE", "PATCH"]);

/** Pass1 では包含ノード未解決（Pass2 callGraph が注釈。生成物では未解決のままになり得る）。 */
const UNRESOLVED_ENCLOSING = "";

/**
 * 単一 `SourceFile` から生成クライアントのエンドポイントを抽出する（Pass1）。
 * 生成物でないファイルでは `localVarPath` 宣言が無いため空配列を返す（実質 no-op）。
 *
 * @param sourceFile 解析対象（`.vue` 由来仮想 `.ts` も可。生成クライアントは通常 `.ts`）
 * @param fileId frontendRoot 相対 POSIX（location.file に使用）
 * @param segments `.vue` 行補正用 segments（`.ts/.js` は空配列＝恒等）
 */
export function extractGeneratedClientApiCalls(
  sourceFile: SourceFile,
  fileId: string,
  segments: ScriptSegment[],
): ApiCallCandidate[] {
  const candidates: ApiCallCandidate[] = [];

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== PATH_VARIABLE_NAME) {
      continue;
    }
    const urlPattern = extractUrlPattern(decl);
    if (urlPattern === null) {
      continue; // 骨格が動的で canonicalize 不能 → マッチに使えないため除外。
    }
    const method = extractMethodFromEnclosing(decl);
    candidates.push({
      method,
      urlPattern,
      enclosingFunctionId: UNRESOLVED_ENCLOSING,
      location: toSourceLocation(fileId, decl, segments),
    });
  }

  return candidates;
}

/**
 * `localVarPath` 宣言の右辺から URL パターンを取り出す。
 * openapi-generator は `` `/path/{p}`.replace(...).replace(...) `` の形でパスパラメータを差し込むため、
 * `.replace()` 呼び出しチェーンを剥がして基底の文字列/テンプレートリテラルを正規化する。
 */
function extractUrlPattern(decl: VariableDeclaration): string | null {
  const initializer = decl.getInitializer();
  if (initializer === undefined) {
    return null;
  }
  const base = unwrapReplaceChain(initializer);
  return normalizeUrlTemplate(base);
}

/** `X.replace(...).replace(...)` の基底（最左の被メソッド式）まで剥がす。 */
function unwrapReplaceChain(node: Node): Node {
  let current = node;
  while (Node.isCallExpression(current)) {
    const expr = current.getExpression();
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === "replace") {
      current = expr.getExpression();
    } else {
      break;
    }
  }
  return current;
}

/**
 * `localVarPath` 宣言を内包する関数本体から、リクエストオプションの `method: '<VERB>'` リテラルを探す。
 * 見つからない / 非リテラルなら既定 GET（openapi-generator は常にリテラルで出力する）。
 */
function extractMethodFromEnclosing(decl: VariableDeclaration): HttpMethod {
  const enclosing = decl.getFirstAncestor(
    (a) =>
      Node.isArrowFunction(a) ||
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
  if (enclosing === undefined) {
    return "GET";
  }
  for (const prop of enclosing.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() !== "method") {
      continue;
    }
    const value = prop.getInitializer();
    if (value !== undefined && Node.isStringLiteral(value)) {
      const upper = value.getLiteralValue().toUpperCase() as HttpMethod;
      if (HTTP_METHODS.has(upper)) {
        return upper;
      }
    }
  }
  return "GET";
}
