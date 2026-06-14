/**
 * Pass1 router 関係抽出（design.md「extractFile(Pass1) / 抽出ルール: router関係」）。
 *
 * 3種の関係を1パスで抽出する:
 * - `<name> = APIRouter(prefix="...")`（トップレベル代入）→ `RouterDefinition`。
 *   関数名が素の識別子 `APIRouter` の呼び出しのみ対象。`prefix` キーワード引数が
 *   文字列リテラルなら `stripStringLiteral` でクオート除去、無い/非リテラルなら `""`。
 * - `<name> = FastAPI(...)`（トップレベル代入）→ `FastAPIInstance`。
 *   関数名が素の識別子 `FastAPI` の呼び出しのみ対象。Pass2a が全ファイル横断で一意な
 *   起点を選び、ルートパス解決の BFS 起点候補としてマークする。
 * - `<obj>.include_router(<routerExpr>, prefix="...")`（任意箇所）→ `IncludeRouterCall`。
 *   関数が属性式で属性名が `include_router`、かつオブジェクトが単純識別子の呼び出しのみ
 *   対象。`routerExpr` は第1位置引数ノードのソーステキスト（ドット式をそのまま保持）。
 *
 * 本タスクでは警告は出さない（非リテラル prefix は静かに `""`。未解決 router の警告は
 * Pass2a が担う）。
 */
import type { Node, Tree } from "web-tree-sitter";

import { fieldChild, stripStringLiteral, toSourceLocation } from "../astUtils.js";
import type { SourceLocation } from "../models.js";

/** `<name> = APIRouter(prefix=...)` から得る router 定義。 */
export interface RouterDefinition {
  variableName: string;
  prefix: string;
  location: SourceLocation;
}

/** `<name> = FastAPI(...)` から得る FastAPI インスタンス（BFS 起点候補）。 */
export interface FastAPIInstance {
  variableName: string;
  location: SourceLocation;
}

/** `<obj>.include_router(<routerExpr>, prefix=...)` 呼び出し。 */
export interface IncludeRouterCall {
  targetName: string;
  routerExpr: string;
  prefix: string;
  location: SourceLocation;
}

/** `extractRouterRelations` の戻り値（3種をまとめて返す）。 */
export interface RouterExtractionResult {
  routers: RouterDefinition[];
  fastapiInstances: FastAPIInstance[];
  includeRouterCalls: IncludeRouterCall[];
}

/**
 * ファイル内の router 関係（APIRouter 定義 / FastAPI インスタンス / include_router 呼び出し）を抽出する。
 *
 * @param tree パース済み構文木
 * @param fileId backendRoot 相対 POSIX パス（location.file に使用）
 */
export function extractRouterRelations(tree: Tree, fileId: string): RouterExtractionResult {
  const routers: RouterDefinition[] = [];
  const fastapiInstances: FastAPIInstance[] = [];
  const includeRouterCalls: IncludeRouterCall[] = [];

  for (const node of iterNodes(tree.rootNode)) {
    if (node.type === "assignment") {
      const router = routerFromAssignment(node, fileId);
      if (router !== null) {
        routers.push(router);
      }
      const fastapi = fastapiFromAssignment(node, fileId);
      if (fastapi !== null) {
        fastapiInstances.push(fastapi);
      }
    } else if (node.type === "call") {
      const include = includeRouterFromCall(node, fileId);
      if (include !== null) {
        includeRouterCalls.push(include);
      }
    }
  }

  return { routers, fastapiInstances, includeRouterCalls };
}

/** `rootNode` 配下の全ノードを深さ優先で列挙する。 */
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
 * `<name> = APIRouter(prefix=...)` 代入から `RouterDefinition` を判定する。
 * 関数名が素の識別子 `APIRouter` の呼び出しでなければ `null`。
 */
function routerFromAssignment(assignment: Node, fileId: string): RouterDefinition | null {
  const variableName = simpleAssignmentTarget(assignment);
  if (variableName === null) {
    return null;
  }
  const callNode = assignmentRhsCall(assignment);
  if (callNode === null || !isBareCallTo(callNode, "APIRouter")) {
    return null;
  }
  return {
    variableName,
    prefix: keywordStringLiteral(fieldChild(callNode, "arguments"), "prefix"),
    location: toSourceLocation(fileId, assignment),
  };
}

/**
 * `<name> = FastAPI(...)` 代入から `FastAPIInstance` を判定する。
 * 関数名が素の識別子 `FastAPI` の呼び出しでなければ `null`。
 */
function fastapiFromAssignment(assignment: Node, fileId: string): FastAPIInstance | null {
  const variableName = simpleAssignmentTarget(assignment);
  if (variableName === null) {
    return null;
  }
  const callNode = assignmentRhsCall(assignment);
  if (callNode === null || !isBareCallTo(callNode, "FastAPI")) {
    return null;
  }
  return {
    variableName,
    location: toSourceLocation(fileId, assignment),
  };
}

/**
 * `<obj>.include_router(<routerExpr>, prefix=...)` 呼び出しから `IncludeRouterCall` を判定する。
 * 関数が属性式で属性名 `include_router`、かつオブジェクトが単純識別子でなければ `null`。
 */
function includeRouterFromCall(callNode: Node, fileId: string): IncludeRouterCall | null {
  const funcExpr = fieldChild(callNode, "function");
  if (funcExpr === null || funcExpr.type !== "attribute") {
    return null;
  }
  const attrNode = fieldChild(funcExpr, "attribute");
  if (attrNode === null || attrNode.text !== "include_router") {
    return null;
  }
  const objNode = fieldChild(funcExpr, "object");
  if (objNode === null || objNode.type !== "identifier") {
    return null;
  }

  const argumentList = fieldChild(callNode, "arguments");
  const firstArg = firstPositionalArg(argumentList);
  if (firstArg === null) {
    return null; // included router 式が無ければ関係を構築できない。
  }

  return {
    targetName: objNode.text,
    routerExpr: firstArg.text,
    prefix: keywordStringLiteral(argumentList, "prefix"),
    location: toSourceLocation(fileId, callNode),
  };
}

/**
 * 単純代入 `<identifier> = ...` の左辺識別子名を返す。
 * 左辺が単純識別子でない（タプル代入・添字代入・属性代入等）場合は `null`。
 */
function simpleAssignmentTarget(assignment: Node): string | null {
  const left = fieldChild(assignment, "left");
  if (left === null || left.type !== "identifier") {
    return null;
  }
  return left.text;
}

/** 代入の右辺が `call` ならそのノードを返す（それ以外は `null`）。 */
function assignmentRhsCall(assignment: Node): Node | null {
  const right = fieldChild(assignment, "right");
  if (right === null || right.type !== "call") {
    return null;
  }
  return right;
}

/** 呼び出しの関数が素の識別子 `name` か判定する。 */
function isBareCallTo(callNode: Node, name: string): boolean {
  const funcExpr = fieldChild(callNode, "function");
  return funcExpr !== null && funcExpr.type === "identifier" && funcExpr.text === name;
}

/**
 * `argument_list` 中の指定キーワード引数の値が文字列リテラルなら、クオート除去した
 * 内側テキストを返す。無い／非リテラルなら `""`。
 */
function keywordStringLiteral(argumentList: Node | null, keyword: string): string {
  if (argumentList === null) {
    return "";
  }
  for (let i = 0; i < argumentList.childCount; i += 1) {
    const child = argumentList.child(i);
    if (child === null || child.type !== "keyword_argument") {
      continue;
    }
    const nameNode = fieldChild(child, "name");
    if (nameNode === null || nameNode.text !== keyword) {
      continue;
    }
    const valueNode = fieldChild(child, "value");
    if (valueNode === null || valueNode.type !== "string") {
      return "";
    }
    return stripStringLiteral(valueNode.text);
  }
  return "";
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
