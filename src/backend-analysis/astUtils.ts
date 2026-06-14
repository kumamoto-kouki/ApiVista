/**
 * web-tree-sitter ノード走査ヘルパ（ScopeProvider/PositionProvider 等の代替）。
 *
 * libcst の `PositionProvider`（行番号）・`SimpleString.evaluated_value`（クオート除去）・
 * qualname provider を、tree-sitter ノード上の小さな純関数として提供する。
 */
import type { Node, Tree } from "web-tree-sitter";

import type { SourceLocation } from "./models.js";

/** qualname の境界となるノード型（クラス/関数定義のみ。module/if 等は含めない）。 */
const QUALNAME_BOUNDARY_TYPES = new Set(["class_definition", "function_definition"]);

/** 文字列リテラル接頭辞に使われる文字（r/R b/B f/F u/U の組み合わせ）。 */
const STRING_PREFIX_CHARS = new Set(["r", "R", "b", "B", "f", "F", "u", "U"]);

/**
 * ノードの開始行を 1 基底で返す（tree-sitter の `row` は 0 基底のため +1）。
 */
export function line(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * ノードから `SourceLocation` を構築する。`file` は呼び出し側が渡す fileId。
 */
export function toSourceLocation(fileId: string, node: Node): SourceLocation {
  return { file: fileId, line: line(node) };
}

/**
 * `node.childForFieldName(name)` の型付き薄ラッパ。該当が無ければ `null`。
 */
export function fieldChild(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

/**
 * `function_definition` / `class_definition` の `name` フィールドのテキストを返す。
 * 取得できない場合は `null`。
 */
function definitionName(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode === null ? null : nameNode.text;
}

/**
 * 対象 `function_definition` ノードの qualname を構築する。
 *
 * 祖先方向に `class_definition` / `function_definition` を辿り、各祖先の `name` を
 * 外側→内側の順に `.` 連結し、末尾に自身の関数名を付す。`module` / 条件分岐ノードは
 * セグメントに含めない。
 *
 * - トップレベル関数 → `"get_item"`
 * - クラスメソッド → `"ItemRouter.get_item"`
 * - ネスト関数 → `"outer.inner"`
 */
export function computeQualname(node: Node): string {
  const segments: string[] = [];

  const own = definitionName(node);
  if (own !== null) {
    segments.push(own);
  }

  let current: Node | null = node.parent;
  while (current !== null) {
    if (QUALNAME_BOUNDARY_TYPES.has(current.type)) {
      const name = definitionName(current);
      if (name !== null) {
        segments.push(name);
      }
    }
    current = current.parent;
  }

  return segments.reverse().join(".");
}

/**
 * 文字列リテラルのノードテキストから、接頭辞と囲みクオートを除去して内側テキストを返す。
 *
 * 対応: 接頭辞 r/R b/B f/F u/U（組み合わせ可）、囲み `'` `"` `'''` `"""`。
 * f-string 全体は別ノード型のため、本関数は素の string リテラルテキストのみを対象とする。
 */
export function stripStringLiteral(text: string): string {
  let body = text;

  // 接頭辞（最大数文字）を剥がす。
  let prefixEnd = 0;
  while (prefixEnd < body.length && STRING_PREFIX_CHARS.has(body[prefixEnd]!)) {
    prefixEnd += 1;
  }
  body = body.slice(prefixEnd);

  // 三連クオート → 単一クオートの順に判定。
  for (const quote of ['"""', "'''", '"', "'"]) {
    if (body.startsWith(quote) && body.endsWith(quote) && body.length >= quote.length * 2) {
      return body.slice(quote.length, body.length - quote.length);
    }
  }

  return body;
}

/**
 * 構文エラーの有無を返す（`rootNode.hasError` のラッパ）。`Tree` / `Node` の両方を受け付ける。
 */
export function hasSyntaxError(treeOrNode: Tree | Node): boolean {
  const node = "rootNode" in treeOrNode ? treeOrNode.rootNode : treeOrNode;
  return node.hasError;
}
