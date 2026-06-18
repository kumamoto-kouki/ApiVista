/**
 * Pass1 API 呼び出し抽出（design.md「extractors/apiCalls(Pass1)」）。
 *
 * 認識対象（呼び出し名ベース。Nuxt auto-import のため import の有無は問わない）:
 * - `$fetch(url, opts?)` / `useFetch(url, opts?)`（識別子呼び出し）
 * - `axios.get|post|put|delete|patch(url, ...)`（属性呼び出し）
 * - `axios(url, { method })` / `$fetch(url, { method })` / `useFetch(url, { method })`（options 形態）
 * これら以外の呼び出し（カスタムクライアント `customClient.fetchData(...)`、未認識の axios 動詞 `axios.head`、
 * 無関係な関数呼び出し）は抽出対象外とし、警告も出さない（Req1.5。対象外＝診断ではない）。
 *
 * 各認識呼び出しから以下を抽出する:
 * - method: 属性名（`.get`→GET）優先 → options の `method` 文字列リテラル → いずれも無ければ既定 GET（Req1.2）。
 *   method が options に存在するが非リテラル（変数等）で静的決定不能 → 当該呼び出しを除外＋警告（Req4.2）。
 * - urlPattern: 第1引数を `astUtils.normalizeUrlTemplate` で正規化（文字列リテラルはそのまま、
 *   テンプレートリテラルは `${expr}`→`{}`）（Req1.3）。第1引数が無い／骨格が動的（変数・関数結果）で
 *   `null` を返す → 当該呼び出しを除外＋警告（Req4.2）。
 * - location: `astUtils.toSourceLocation(fileId, callNode, segments)` で `.vue` 行補正（Req3.3）。
 *
 * `enclosingFunctionId` は本 Pass では確定しない（Req1.4 は 3.1 のスコープ外）。最近傍の包含定義
 * （関数/コンポーネント/composable）への帰属は defs（3.2）と callGraph（4.1, Req1.4）が担うため、
 * ここでは未解決プレースホルダの空文字列を入れ、Pass2 で注釈する（design の責務分担に整合）。
 *
 * 本モジュールは単一 `SourceFile` を受け取る純粋抽出関数。構文エラーファイルの skip は
 * 呼び出し側（fileMap.fileIds 反復、4.1/5.2）の責務であり、ここでは関与しない。
 */
import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";

import { normalizeUrlTemplate, toSourceLocation } from "../astUtils.js";
import type { HttpMethod, SourceLocation } from "../models.js";
import type { ScriptSegment } from "../sfc.js";

/**
 * API 呼び出し候補（design.md「ApiCallCandidate」）。
 *
 * `enclosingFunctionId` は Pass1 では空文字列（未解決プレースホルダ）。Pass2（callGraph, 4.1）が
 * 最近傍の包含ノード id を注釈する。`method` は大文字、`urlPattern` は正規化後パターン。
 */
export interface ApiCallCandidate {
  method: string;
  urlPattern: string;
  enclosingFunctionId: string;
  location: SourceLocation;
}

/** Pass1 では包含ノード未解決を表す空のプレースホルダ（Pass2 で注釈）。 */
const UNRESOLVED_ENCLOSING = "";

/** axios 属性呼び出しで認識する HTTP メソッド動詞（小文字）→ 内部表現（大文字）。 */
const AXIOS_METHOD_VERBS = new Map<string, HttpMethod>([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
]);

/** options で許容する HTTP メソッドリテラル（大文字化後の集合）。 */
const OPTIONS_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "DELETE", "PATCH"]);

/** 識別子呼び出しで認識する関数名（method 既定 GET、options で上書き可）。 */
const IDENTIFIER_CALLERS = new Set<string>(["$fetch", "useFetch"]);

/** axios の options 形態で認識する識別子名（`axios(url, { method })`）。 */
const AXIOS_IDENTIFIER = "axios";

/** axios インスタンス識別子名（`axios.get(...)` 等の属性呼び出しの土台）。 */
const AXIOS_OBJECT = "axios";

/** `record` のみ使うため最小インターフェースで受ける（warnings.ts の構造的契約）。 */
interface WarningCollectorLike {
  record(target: string, reason: string): void;
}

/**
 * 認識済み呼び出しの形態と、解決済み method（属性由来）を表す内部表現。
 * `attributeMethod` が定まっていれば options の method 指定より優先する（Req1.2）。
 */
interface RecognizedCall {
  /** 属性名由来の method（`axios.get`→GET）。識別子呼び出し/options 形態では undefined。 */
  attributeMethod: HttpMethod | undefined;
}

/**
 * 単一 `SourceFile` 内の認識対象 API 呼び出しを抽出する（Pass1）。
 *
 * @param sourceFile 解析対象（`.vue` 由来は仮想 `.ts`。構文エラーファイルは呼び出し側が skip 済み）
 * @param fileId frontendRoot 相対 POSIX（warning target / location.file に使用）
 * @param segments `.vue` 行補正用 segments（`.ts/.js` は空配列＝恒等）
 * @param collector 動的 URL/method 除外の警告蓄積先（Req4.2/4.3）
 */
export function extractApiCalls(
  sourceFile: SourceFile,
  fileId: string,
  segments: ScriptSegment[],
  collector: WarningCollectorLike,
): ApiCallCandidate[] {
  const candidates: ApiCallCandidate[] = [];

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const recognized = recognizeCall(call);
    if (recognized === null) {
      continue; // 認識対象外（Req1.5）: 抽出せず、警告も出さない。
    }
    const candidate = buildCandidate(call, recognized, fileId, segments, collector);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

/**
 * 呼び出し式が認識対象パターンかを判定する。対象なら `RecognizedCall`、対象外は `null`（Req1.1/1.5）。
 *
 * - `$fetch(...)` / `useFetch(...)`（識別子）
 * - `axios(...)`（識別子・options 形態）
 * - `axios.get|post|put|delete|patch(...)`（属性。それ以外の axios 動詞は対象外）
 */
function recognizeCall(call: CallExpression): RecognizedCall | null {
  const expr = call.getExpression();

  if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    if (IDENTIFIER_CALLERS.has(name) || name === AXIOS_IDENTIFIER) {
      return { attributeMethod: undefined };
    }
    return null;
  }

  if (Node.isPropertyAccessExpression(expr)) {
    const object = expr.getExpression();
    if (Node.isIdentifier(object) && object.getText() === AXIOS_OBJECT) {
      const verb = AXIOS_METHOD_VERBS.get(expr.getName());
      if (verb !== undefined) {
        return { attributeMethod: verb };
      }
    }
    return null; // axios.head など未認識の動詞、または axios 以外の属性呼び出し。
  }

  return null;
}

/**
 * 認識済み呼び出しから候補を構築する。URL 骨格が動的 / method が静的決定不能なら除外＋警告し `null`（Req4.2）。
 */
function buildCandidate(
  call: CallExpression,
  recognized: RecognizedCall,
  fileId: string,
  segments: ScriptSegment[],
  collector: WarningCollectorLike,
): ApiCallCandidate | null {
  const args = call.getArguments();

  // URL: 第1引数。無い / 動的骨格（normalizeUrlTemplate が null）→ 除外＋警告（Req4.2）。
  const urlArg = args[0];
  const urlPattern = urlArg === undefined ? null : normalizeUrlTemplate(urlArg);
  if (urlPattern === null) {
    collector.record(fileId, dynamicReason("URL", call, segments));
    return null;
  }

  // method: 属性名優先 → options の method リテラル → 既定 GET。options に非リテラル method があれば除外。
  const method = resolveMethod(recognized, args[1]);
  if (method === null) {
    collector.record(fileId, dynamicReason("method", call, segments));
    return null;
  }

  return {
    method,
    urlPattern,
    enclosingFunctionId: UNRESOLVED_ENCLOSING,
    location: toSourceLocation(fileId, call, segments),
  };
}

/**
 * method を解決する（Req1.2）。
 * - 属性由来 method（`axios.get`）があればそれを優先（options を見ない）。
 * - 無ければ options（第2引数オブジェクトリテラル）の `method` を見る:
 *   - 文字列リテラルかつ有効な HTTP メソッド → 大文字化して採用。
 *   - `method` キーが存在するが非リテラル/無効 → `null`（静的決定不能、除外対象）。
 *   - `method` キーが無い → 既定 GET。
 * - options 自体が無い → 既定 GET。
 */
function resolveMethod(
  recognized: RecognizedCall,
  optionsArg: Node | undefined,
): HttpMethod | null {
  if (recognized.attributeMethod !== undefined) {
    return recognized.attributeMethod;
  }

  const optionsMethod = readOptionsMethod(optionsArg);
  if (optionsMethod === "absent") {
    return "GET"; // method 指定なし → 既定 GET。
  }
  return optionsMethod; // HttpMethod または null（静的決定不能）。
}

/**
 * options 引数オブジェクトリテラルの `method` プロパティを読む。
 * - キーが無い / options がオブジェクトリテラルでない → `"absent"`（既定 GET にフォールバック）。
 * - 値が文字列リテラルで有効メソッド → `HttpMethod`。
 * - 値が存在するが非リテラル/無効 → `null`（静的決定不能、Req4.2 で除外）。
 */
function readOptionsMethod(optionsArg: Node | undefined): HttpMethod | null | "absent" {
  if (optionsArg === undefined || !Node.isObjectLiteralExpression(optionsArg)) {
    return "absent";
  }

  const methodProp = optionsArg.getProperty("method");
  if (methodProp === undefined) {
    return "absent";
  }
  if (!Node.isPropertyAssignment(methodProp)) {
    // ショートハンド `{ method }` / スプレッド等は静的決定不能。
    return null;
  }

  const initializer = methodProp.getInitializer();
  if (
    initializer === undefined ||
    !(Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer))
  ) {
    return null; // 変数・式など非リテラル → 静的決定不能。
  }

  const upper = initializer.getLiteralValue().toUpperCase();
  return OPTIONS_METHODS.has(upper as HttpMethod) ? (upper as HttpMethod) : null;
}

/** 除外理由文字列（除外種別と補正済み行を含む機械可読メッセージ）。 */
function dynamicReason(
  kind: "URL" | "method",
  call: CallExpression,
  segments: ScriptSegment[],
): string {
  const location = toSourceLocation("", call, segments);
  return `excluded api call: ${kind} not statically determinable (line ${location.line})`;
}
