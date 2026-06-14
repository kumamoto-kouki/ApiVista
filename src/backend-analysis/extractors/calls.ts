/**
 * Pass1 呼び出し式抽出 + 関数定義レジストリ収集
 * （design.md「extractFile(Pass1) / 抽出ルール: 呼び出し式・関数定義レジストリ」, Requirement 3.1）。
 *
 * - **関数定義レジストリ** (`functionDefinitions`): 当該ファイルの全 `function_definition`
 *   (トップレベル関数・クラスメソッド・ネスト関数) について `name`・`qualname`(=`computeQualname`)・
 *   定義位置(def 行)を収集する。Pass2b がクロスファイルで callee を FunctionNode id へ解決する索引。
 * - **呼び出し式** (`callExpressions`): 各 `call` 式について、最も近い祖先 `function_definition` を
 *   呼び出し元とみなし `callerQualname`(=`computeQualname`)・`calleeName`(call の `function` フィールドの
 *   ソーステキスト。`obj.method` 等のドット式は原形保持)・呼び出し位置を収集する。
 *   設計の「ハンドラ本体内」が主動機だが、Pass2b は handler→helper→helper2 と再帰探索するため、
 *   ルートハンドラに限らず全関数本体の呼び出しを各関数の qualname で索引化する (Requirement 3.1)。
 *   いずれの関数にも囲まれないモジュールトップレベルの `call` は、呼び出し元関数が無いためスキップする。
 */
import type { Node, Tree } from "web-tree-sitter";

import { computeQualname, fieldChild, toSourceLocation } from "../astUtils.js";
import type { SourceLocation } from "../models.js";

/** 呼び出し式エントリ（design.md「CallExpression」）。`calleeName` はドット式可。 */
export interface CallExpression {
  callerQualname: string;
  calleeName: string;
  location: SourceLocation;
}

/** 関数定義レジストリのエントリ（design.md「FunctionDefinitionEntry」）。 */
export interface FunctionDefinitionEntry {
  name: string;
  qualname: string;
  location: SourceLocation;
}

/** `extractCalls` の戻り値（design.md FileExtractionResult の該当2フィールド相当）。 */
export interface CallExtractionResult {
  callExpressions: CallExpression[];
  functionDefinitions: FunctionDefinitionEntry[];
}

/**
 * ファイル全体から呼び出し式と関数定義レジストリを抽出する。
 *
 * @param tree パース済み構文木
 * @param fileId backendRoot 相対 POSIX パス（`SourceLocation.file` に使用）
 */
export function extractCalls(tree: Tree, fileId: string): CallExtractionResult {
  const root = tree.rootNode;

  const functionDefinitions: FunctionDefinitionEntry[] = [];
  const callExpressions: CallExpression[] = [];

  for (const node of iterNodes(root)) {
    if (node.type === "function_definition") {
      const def = functionDefinition(node, fileId);
      if (def !== null) {
        functionDefinitions.push(def);
      }
      continue;
    }
    if (node.type === "call") {
      const call = callExpression(node, fileId);
      if (call !== null) {
        callExpressions.push(call);
      }
    }
  }

  return { callExpressions, functionDefinitions };
}

/** `root` 配下の全ノードを深さ優先で列挙する。 */
function* iterNodes(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child !== null) {
        stack.push(child);
      }
    }
  }
}

/**
 * `function_definition` から関数定義レジストリエントリを構築する。
 * `name` フィールドが取得できない場合は null（名前なしの関数定義は索引化しない）。
 */
function functionDefinition(node: Node, fileId: string): FunctionDefinitionEntry | null {
  const nameNode = fieldChild(node, "name");
  if (nameNode === null) {
    return null;
  }
  return {
    name: nameNode.text,
    qualname: computeQualname(node),
    location: toSourceLocation(fileId, node),
  };
}

/**
 * `call` ノードから呼び出し式エントリを構築する。
 *
 * - `callerQualname`: 最も近い祖先 `function_definition` の `computeQualname`。
 *   囲む関数定義が無い（モジュールトップレベルの呼び出し）場合は null を返してスキップする。
 * - `calleeName`: `function` フィールドのソーステキスト（`obj.method` 等のドット式は原形保持）。
 * - `location`: 呼び出し位置（call ノード開始行）。
 */
function callExpression(node: Node, fileId: string): CallExpression | null {
  const enclosing = enclosingFunction(node);
  if (enclosing === null) {
    return null; // モジュールトップレベルの呼び出し → 呼び出し元関数が無いためスキップ。
  }
  const funcExpr = fieldChild(node, "function");
  if (funcExpr === null) {
    return null;
  }
  return {
    callerQualname: computeQualname(enclosing),
    calleeName: funcExpr.text,
    location: toSourceLocation(fileId, node),
  };
}

/** `node` の祖先方向で最も近い `function_definition` を返す（無ければ null）。 */
function enclosingFunction(node: Node): Node | null {
  let current: Node | null = node.parent;
  while (current !== null) {
    if (current.type === "function_definition") {
      return current;
    }
    current = current.parent;
  }
  return null;
}
