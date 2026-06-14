/**
 * Pass1 ルートデコレータ抽出（design.md「extractFile(Pass1) / 抽出ルール: ルートデコレータ」）。
 *
 * `@<obj>.<method>(...)` 形のデコレータのうち `<method> ∈ {get,post,put,delete,patch}`
 * （属性呼び出し）のみをルート候補として認識する。`@app.add_api_route(...)` 等の
 * プログラム的登録や、HTTP メソッド以外の属性デコレータ・素のデコレータは候補化しない
 * (Requirement 1.4)。
 *
 * 第1位置引数が文字列リテラルのときのみ `stripStringLiteral` でクオートを除去して
 * `path` を確定する。位置引数が無い／文字列リテラルでない（変数参照・f-string・呼び出し等）
 * 場合は候補化せず、`collector.record` に静的解決不能として記録する
 * (Requirements 5.2, 5.3)。`method` は大文字化して保持する。
 */
import type { Node, Tree } from "web-tree-sitter";

import { computeQualname, fieldChild, stripStringLiteral, toSourceLocation } from "../astUtils.js";
import type { HttpMethod, SourceLocation } from "../models.js";

/** ルート候補（design.md「RouteCandidate」）。`method` は大文字 `HttpMethod`。 */
export interface RouteCandidate {
  method: HttpMethod;
  path: string;
  handlerName: string;
  qualname: string;
  location: SourceLocation;
}

/** HTTP メソッド属性名（小文字）→ 内部表現（大文字）への対応。 */
const HTTP_METHOD_ATTRS = new Map<string, HttpMethod>([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
]);

/**
 * ファイル内の全 `decorated_definition` を走査し、ルート候補を抽出する。
 *
 * @param tree パース済み構文木
 * @param fileId backendRoot 相対 POSIX パス（警告 target / location.file に使用）
 * @param collector 静的解決不能パスの警告蓄積先
 */
export function extractRoutes(
  tree: Tree,
  fileId: string,
  collector: WarningCollectorLike,
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];

  for (const decorated of iterDecoratedDefinitions(tree.rootNode)) {
    const funcNode = decoratedFunction(decorated);
    if (funcNode === null) {
      continue;
    }

    for (const decorator of decoratorChildren(decorated)) {
      const route = routeFromDecorator(decorator, funcNode, fileId, collector);
      if (route !== null) {
        candidates.push(route);
      }
    }
  }

  return candidates;
}

/** `collector.record` のみを使うため、WarningCollector の最小インターフェースで受ける。 */
interface WarningCollectorLike {
  record(target: string, reason: string): void;
}

/** `rootNode` 配下の全 `decorated_definition` を深さ優先で列挙する（ネストも対象）。 */
function* iterDecoratedDefinitions(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "decorated_definition") {
      yield node;
    }
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child !== null) {
        stack.push(child);
      }
    }
  }
}

/**
 * `decorated_definition` の被装飾 `function_definition` を返す。
 * クラス定義など関数以外が装飾されている場合は `null`。
 */
function decoratedFunction(decorated: Node): Node | null {
  const definition = fieldChild(decorated, "definition");
  if (definition !== null && definition.type === "function_definition") {
    return definition;
  }
  // フィールド名が取れない文法バージョンへのフォールバック。
  for (let i = 0; i < decorated.childCount; i += 1) {
    const child = decorated.child(i);
    if (child !== null && child.type === "function_definition") {
      return child;
    }
  }
  return null;
}

/** `decorated_definition` 直下の `decorator` ノードを列挙する。 */
function decoratorChildren(decorated: Node): Node[] {
  const decorators: Node[] = [];
  for (let i = 0; i < decorated.childCount; i += 1) {
    const child = decorated.child(i);
    if (child !== null && child.type === "decorator") {
      decorators.push(child);
    }
  }
  return decorators;
}

/**
 * 単一デコレータからルート候補を判定する。
 *
 * - 属性呼び出し `@<obj>.<method>(...)` で `<method>` が HTTP メソッドのときのみ候補化対象。
 * - 第1位置引数が文字列リテラル → path 確定して候補返却。
 * - 位置引数なし／非リテラル → 候補化せず警告記録して `null`。
 * - それ以外（HTTP メソッド外・呼び出しでない・属性式でない）は静かに `null`。
 */
function routeFromDecorator(
  decorator: Node,
  funcNode: Node,
  fileId: string,
  collector: WarningCollectorLike,
): RouteCandidate | null {
  const callNode = decoratorCall(decorator);
  if (callNode === null) {
    return null; // 素のデコレータ（呼び出しでない）→ 非対象。
  }

  const funcExpr = fieldChild(callNode, "function");
  if (funcExpr === null || funcExpr.type !== "attribute") {
    return null; // `@deco(...)` のような非属性呼び出し → 非対象。
  }

  const attrNode = fieldChild(funcExpr, "attribute");
  if (attrNode === null) {
    return null;
  }
  const method = HTTP_METHOD_ATTRS.get(attrNode.text);
  if (method === undefined) {
    return null; // add_api_route / websocket 等 → 非対象 (Req 1.4)。
  }

  const handlerName = functionName(funcNode);
  const qualname = computeQualname(funcNode);
  const location = toSourceLocation(fileId, funcNode);

  const firstArg = firstPositionalArg(fieldChild(callNode, "arguments"));
  if (firstArg === null || firstArg.type !== "string") {
    // 位置引数なし／文字列リテラルでない → 静的解決不能 (Req 5.2, 5.3)。
    collector.record(
      `${fileId}:${handlerName}`,
      "route path could not be statically resolved (first argument is not a string literal)",
    );
    return null;
  }

  return {
    method,
    path: stripStringLiteral(firstArg.text),
    handlerName,
    qualname,
    location,
  };
}

/** `decorator` 直下の `call` ノードを返す（呼び出し形でなければ `null`）。 */
function decoratorCall(decorator: Node): Node | null {
  for (let i = 0; i < decorator.childCount; i += 1) {
    const child = decorator.child(i);
    if (child !== null && child.type === "call") {
      return child;
    }
  }
  return null;
}

/**
 * `argument_list` の第1位置引数（`keyword_argument` でない最初の式ノード）を返す。
 * 引数リストが無い／位置引数が無い場合は `null`。
 */
function firstPositionalArg(argumentList: Node | null): Node | null {
  if (argumentList === null) {
    return null;
  }
  for (let i = 0; i < argumentList.childCount; i += 1) {
    const child = argumentList.child(i);
    if (child === null || !child.isNamed) {
      continue; // 括弧・カンマ等のアンカー/区切りは除外。
    }
    if (child.type === "keyword_argument") {
      continue; // キーワード引数は位置引数でない。
    }
    return child;
  }
  return null;
}

/** `function_definition` の `name` フィールドテキストを返す（取得不能時は空文字）。 */
function functionName(funcNode: Node): string {
  const nameNode = fieldChild(funcNode, "name");
  return nameNode === null ? "" : nameNode.text;
}
