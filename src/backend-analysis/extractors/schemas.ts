/**
 * Pass1 スキーマ参照候補 + トップレベルクラス定義レジストリ抽出
 * （design.md「extractFile(Pass1) / 抽出ルール: スキーマ参照・クラス定義レジストリ」）。
 *
 * - スキーマ参照: ルートハンドラ(=`@<obj>.<method>(...)` で `<method>∈{get,post,put,delete,patch}`
 *   のデコレータを持つ関数。routes.ts と同一規則)の引数アノテーション→`role:"request"`、
 *   戻り値アノテーション→`role:"response"`。各アノテーションが単純名(identifier)で、`symbolTable`
 *   の `resolveName` でローカル class(→`localLocation`) か import(→`importedQualifiedName`) に
 *   解決される場合のみ候補化する。builtin / other / 単純名でない注釈(subscript/attribute/欠落)は
 *   候補化しない (Requirement 2.1)。
 * - クラス定義レジストリ: トップレベル `class` 定義のクラス名・基底クラス名(Name/Attribute のみ)・
 *   定義位置を収集する。
 */
import type { Node, Tree } from "web-tree-sitter";

import { computeQualname, fieldChild, toSourceLocation } from "../astUtils.js";
import type { SourceLocation } from "../models.js";
import { buildSymbolTable, resolveName } from "../symbolTable.js";
import type { Binding } from "../symbolTable.js";

/**
 * ルートハンドラのリクエスト/レスポンスモデル参照候補。
 * `localLocation` / `importedQualifiedName` は相互排他（解決種別により一方のみ非 null）。
 */
export interface SchemaRefCandidate {
  role: "request" | "response";
  className: string;
  handlerQualname: string;
  /** アノテーション型がローカル class 定義に解決されたときの定義位置。import 由来時は null。 */
  localLocation: SourceLocation | null;
  /** アノテーション型が import 由来のときの完全修飾名。ローカル定義時は null。 */
  importedQualifiedName: string | null;
}

/** トップレベルクラス定義レジストリのエントリ。 */
export interface ClassDefinition {
  className: string;
  baseClassNames: string[];
  location: SourceLocation;
}

/** `extractSchemaInfo` の戻り値（design.md SchemaExtractionResult 相当）。 */
export interface SchemaExtractionResult {
  refCandidates: SchemaRefCandidate[];
  classDefinitions: ClassDefinition[];
}

/** routes.ts と同一の HTTP メソッド属性名集合（小文字）。 */
const HTTP_METHOD_ATTRS = new Set<string>(["get", "post", "put", "delete", "patch"]);

/**
 * ファイル全体からスキーマ参照候補とトップレベルクラス定義を抽出する。
 *
 * @param tree パース済み構文木
 * @param fileId backendRoot 相対 POSIX パス（`SourceLocation.file` に使用）
 */
export function extractSchemaInfo(tree: Tree, fileId: string): SchemaExtractionResult {
  const table = buildSymbolTable(tree, fileId);
  const root = tree.rootNode;

  const refCandidates: SchemaRefCandidate[] = [];
  for (const handler of iterRouteHandlers(root)) {
    refCandidates.push(...handlerRefCandidates(handler, table));
  }

  const classDefinitions: ClassDefinition[] = [];
  for (const child of root.namedChildren) {
    if (child !== null && child.type === "class_definition") {
      const def = classDefinition(child, fileId);
      if (def !== null) {
        classDefinitions.push(def);
      }
    }
  }

  return { refCandidates, classDefinitions };
}

/**
 * `rootNode` 配下で「ルートデコレータを持つ関数」(=ハンドラ)を深さ優先で列挙する。
 * `decorated_definition` を辿り、被装飾が `function_definition` でデコレータ条件を満たすものだけ返す。
 */
function* iterRouteHandlers(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "decorated_definition") {
      const func = decoratedFunction(node);
      if (func !== null && hasRouteDecorator(node)) {
        yield func;
      }
    }
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child !== null) {
        stack.push(child);
      }
    }
  }
}

/** `decorated_definition` の被装飾 `function_definition` を返す（関数以外は null）。 */
function decoratedFunction(decorated: Node): Node | null {
  const definition = fieldChild(decorated, "definition");
  if (definition !== null && definition.type === "function_definition") {
    return definition;
  }
  for (let i = 0; i < decorated.childCount; i += 1) {
    const child = decorated.child(i);
    if (child !== null && child.type === "function_definition") {
      return child;
    }
  }
  return null;
}

/**
 * `decorated_definition` のデコレータに HTTP メソッド属性呼び出し
 * `@<obj>.<get|post|put|delete|patch>(...)` が1つでも含まれるか判定する（routes.ts と同一規則）。
 */
function hasRouteDecorator(decorated: Node): boolean {
  for (let i = 0; i < decorated.childCount; i += 1) {
    const decorator = decorated.child(i);
    if (decorator === null || decorator.type !== "decorator") {
      continue;
    }
    const callNode = decoratorCall(decorator);
    if (callNode === null) {
      continue;
    }
    const funcExpr = fieldChild(callNode, "function");
    if (funcExpr === null || funcExpr.type !== "attribute") {
      continue;
    }
    const attrNode = fieldChild(funcExpr, "attribute");
    if (attrNode !== null && HTTP_METHOD_ATTRS.has(attrNode.text)) {
      return true;
    }
  }
  return false;
}

/** `decorator` 直下の `call` ノードを返す（呼び出し形でなければ null）。 */
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
 * 単一ハンドラ関数から request/response 参照候補を生成する。
 * 引数アノテーション(各 typed_parameter)→request、戻り値アノテーション→response。
 */
function handlerRefCandidates(funcNode: Node, table: Map<string, Binding>): SchemaRefCandidate[] {
  const handlerQualname = computeQualname(funcNode);
  const candidates: SchemaRefCandidate[] = [];

  const params = fieldChild(funcNode, "parameters");
  if (params !== null) {
    for (const param of params.namedChildren) {
      if (param === null) {
        continue;
      }
      // `= Depends(...)` / `= Security(...)` を持つ引数は FastAPI の依存性注入（DBセッション・
      // クエリパラメータ・サービス等）であり、リクエストボディではないため request 候補にしない。
      if (isDependencyParameter(param)) {
        continue;
      }
      const annotation = parameterAnnotationName(param);
      const candidate = candidateFor("request", annotation, handlerQualname, table);
      if (candidate !== null) {
        candidates.push(candidate);
      }
    }
  }

  const returnTypeNode = fieldChild(funcNode, "return_type");
  const returnName = returnTypeNode === null ? null : simpleTypeName(returnTypeNode);
  const responseCandidate = candidateFor("response", returnName, handlerQualname, table);
  if (responseCandidate !== null) {
    candidates.push(responseCandidate);
  }

  return candidates;
}

/** FastAPI の依存性注入マーカー（デフォルト値の呼び出し関数名）。 */
const DEPENDENCY_MARKERS = new Set<string>(["Depends", "Security"]);

/**
 * 引数が `= Depends(...)` / `= Security(...)` を持つ依存性注入かを判定する。
 * `typed_default_parameter` の `value`（デフォルト値）が当該マーカーの呼び出しなら true。
 * `Depends(...)`（identifier）と `fastapi.Depends(...)`（attribute）の双方を認識する。
 */
function isDependencyParameter(param: Node): boolean {
  if (param.type !== "typed_default_parameter") {
    return false;
  }
  const value = fieldChild(param, "value");
  if (value === null || value.type !== "call") {
    return false;
  }
  const fn = fieldChild(value, "function");
  if (fn === null) {
    return false;
  }
  const name =
    fn.type === "attribute"
      ? (fieldChild(fn, "attribute")?.text ?? null)
      : fn.type === "identifier"
        ? fn.text
        : null;
  return name !== null && DEPENDENCY_MARKERS.has(name);
}

/**
 * `typed_parameter` / `typed_default_parameter` の `type` フィールドが単純名注釈ならその
 * identifier テキストを返す。アノテーション無し・単純名でない場合は null。
 */
function parameterAnnotationName(param: Node): string | null {
  if (param.type !== "typed_parameter" && param.type !== "typed_default_parameter") {
    return null;
  }
  const typeNode = fieldChild(param, "type");
  if (typeNode === null) {
    return null;
  }
  return simpleTypeName(typeNode);
}

/**
 * `type` ノードが単純名注釈(単一 `identifier` を包む)ならその識別子テキストを返す。
 * `list[Foo]`(subscript) / `module.Foo`(attribute) / `Optional[Foo]` 等の複合注釈は null。
 */
function simpleTypeName(typeNode: Node): string | null {
  if (typeNode.type !== "type") {
    // 文法差異フォールバック: 注釈が直接 identifier の場合のみ許容。
    return typeNode.type === "identifier" ? typeNode.text : null;
  }
  const named = typeNode.namedChildren.filter((c): c is Node => c !== null);
  if (named.length !== 1) {
    return null;
  }
  const inner = named[0]!;
  return inner.type === "identifier" ? inner.text : null;
}

/**
 * 注釈名を `resolveName` で解決し、localClass / import のときだけ候補を返す。
 * builtin / other / 注釈無し(name===null)は null（候補化しない）。
 */
function candidateFor(
  role: "request" | "response",
  className: string | null,
  handlerQualname: string,
  table: Map<string, Binding>,
): SchemaRefCandidate | null {
  if (className === null) {
    return null;
  }
  const binding = resolveName(table, className);
  if (binding.kind === "localClass") {
    return {
      role,
      className,
      handlerQualname,
      localLocation: binding.location,
      importedQualifiedName: null,
    };
  }
  if (binding.kind === "import") {
    return {
      role,
      className,
      handlerQualname,
      localLocation: null,
      importedQualifiedName: binding.qualifiedName,
    };
  }
  return null;
}

/**
 * `class_definition` から `ClassDefinition` を構築する。
 * 基底クラスは `argument_list` の `identifier`(単純名)/`attribute`(ドット式)のみ採用し、
 * subscript 等の複合基底はスキップする。位置は class 行。
 */
function classDefinition(node: Node, fileId: string): ClassDefinition | null {
  const nameNode = fieldChild(node, "name");
  if (nameNode === null) {
    return null;
  }
  const baseClassNames: string[] = [];
  const superclasses = fieldChild(node, "superclasses");
  if (superclasses !== null) {
    for (const base of superclasses.namedChildren) {
      if (base === null) {
        continue;
      }
      if (base.type === "identifier" || base.type === "attribute") {
        baseClassNames.push(base.text);
      }
    }
  }
  return {
    className: nameNode.text,
    baseClassNames,
    location: toSourceLocation(fileId, node),
  };
}
