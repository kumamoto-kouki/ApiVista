/**
 * Pass1 定義レジストリ抽出（design.md「extractors/defs, calls, templates(Pass1)」）。
 *
 * 単一 `SourceFile` から、後段（3.3 呼び出し式・4.1 呼び出しグラフ/API 注釈）の起点となる
 * 「定義ノード」を収集する。収集対象（design「定義の種類」, Req2.1）:
 * - トップレベル関数宣言（`function foo() {}`）
 * - 名前付き矢印関数 / 関数式の変数束縛（`const bar = () => {}` / `const useUsers = () => {}`。
 *   `use*` composable も「名前付き束縛」の一種であり特別扱いしない）
 * - 各 `.vue` は **単一のコンポーネントノード**（ファイル/ディレクトリ由来 PascalCase 名）。
 *   名前付き関数に内包されない `<script setup>` 直下の呼び出し（例 `useFetch(...)`）は
 *   このコンポーネントノードに帰属する（Req1.4 / Issue 2）。
 *
 * **命名・ID の単一情報源**: コンポーネントノードの qualname は `fileMap.componentNameFromFileId`、
 * modulePath は `fileMap.stripExtension` を再利用する。これにより `componentIndex` のキー
 * （template `<Child/>` 解決）と defs のコンポーネントノード id が一致し、4.1 の連結が破綻しない。
 * functionId は `makeFunctionId(modulePath, qualname)` で採番する（backend と対称、参照貫通の不変条件）。
 *
 * **責務境界**: 本 Pass は「定義の収集」と「定義候補（FunctionDef）の生成」までを担う。
 * 呼び出し式の収集は 3.3、エッジ構築・API 呼び出しの `enclosingFunctionId` 注釈は 4.1 が担う。
 * 4.1 が「最近傍の包含定義」を引けるよう、各 FunctionDef は宣言/ノード参照と
 * `findEnclosingDef` を提供する（design「最近傍の包含定義を defs 索引から特定」）。
 *
 * 本モジュールは純粋抽出関数（副作用なし）。`.vue` 由来の位置は `segments` で実ファイル行へ補正する。
 */
import { Node, type SourceFile } from "ts-morph";

import { line } from "../astUtils.js";
import { componentNameFromFileId, stripExtension } from "../fileMap.js";
import { makeFunctionId } from "../ids.js";
import type { SourceLocation } from "../models.js";
import type { ScriptSegment } from "../sfc.js";

/** `.vue` fileId 判定（仮想 `.ts` ではなく索引キーである `.vue` 拡張子で判定する）。 */
const VUE_EXTENSION = ".vue";

/**
 * 収集した定義（関数 / composable / `.vue` コンポーネントノード）。
 *
 * `id`/`name`/`file`/`location` は後段で `FunctionNode` へそのまま展開できる（4.1）。
 * `node` は宣言の実体（関数宣言 / 矢印関数・関数式の本体ノード / コンポーネントノードは
 * SourceFile）で、`findEnclosingDef` の包含判定（祖先走査）に用いる。
 */
export interface FunctionDef {
  /** `<module-path>:<qualname>`（FunctionNode.id と一致）。 */
  id: string;
  /** 表示名（qualname と同一）。 */
  name: string;
  /** 宣言名 / `.vue` のコンポーネント名。 */
  qualname: string;
  /** fileId（frontendRoot 相対 POSIX。`.vue` は `.vue` 拡張子のまま）。 */
  file: string;
  location: SourceLocation;
  /** `.vue` の単一コンポーネントノードなら true。通常の関数/composable は false。 */
  isComponentNode: boolean;
  /**
   * 包含判定用の実体ノード。
   * - 関数/composable: 関数宣言 / 矢印関数 / 関数式ノード（その本体内の呼び出しが帰属）。
   * - コンポーネントノード: `SourceFile`（名前付き関数に内包されないトップレベル呼び出しが帰属）。
   */
  node: Node;
}

/**
 * 単一 `SourceFile` から定義レジストリを抽出する（Pass1）。
 *
 * @param sourceFile 解析対象（`.vue` 由来は仮想 `.ts`。構文エラーファイルは呼び出し側が skip 済み）
 * @param fileId frontendRoot 相対 POSIX（`.vue` は `.vue` 拡張子のまま。id/location.file/種別判定に使用）
 * @param segments `.vue` 行補正用 segments（`.ts/.js` は空配列＝恒等）
 */
export function extractDefs(
  sourceFile: SourceFile,
  fileId: string,
  segments: ScriptSegment[],
): FunctionDef[] {
  const modulePath = stripExtension(fileId);
  const defs: FunctionDef[] = [];

  // `.vue` は単一コンポーネントノードを先頭に登録する（名前付き関数外のトップレベル呼び出しの帰属先）。
  if (fileId.endsWith(VUE_EXTENSION)) {
    defs.push(buildComponentNode(sourceFile, fileId, modulePath, segments));
  }

  collectNamedFunctions(sourceFile, fileId, modulePath, segments, defs);

  return defs;
}

/**
 * `.vue` の単一コンポーネントノードを構築する。qualname/命名は `fileMap` の規約を再利用し
 * （`componentIndex` キーと一致）、`node` は SourceFile（トップレベル呼び出しの帰属先）。
 */
function buildComponentNode(
  sourceFile: SourceFile,
  fileId: string,
  modulePath: string,
  segments: ScriptSegment[],
): FunctionDef {
  const qualname = componentNameFromFileId(fileId);
  return {
    id: makeFunctionId(modulePath, qualname),
    name: qualname,
    qualname,
    file: fileId,
    location: { file: fileId, line: line(sourceFile, segments) },
    isComponentNode: true,
    node: sourceFile,
  };
}

/**
 * トップレベルの名前付き関数定義を収集する:
 * - 関数宣言 `function foo() {}`
 * - 矢印関数 / 関数式を束縛した変数宣言 `const bar = () => {}` / `const baz = function () {}`
 *
 * 非呼び出し可能な変数束縛（定数・オブジェクト等）は callee 解決対象外として収集しない
 * （fileMap.exportIndex の登録判定と同流儀）。ネスト宣言は本 Pass の対象外（design「トップレベル」）。
 */
function collectNamedFunctions(
  sourceFile: SourceFile,
  fileId: string,
  modulePath: string,
  segments: ScriptSegment[],
  defs: FunctionDef[],
): void {
  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      const name = statement.getName();
      if (name !== undefined && name.length > 0) {
        defs.push(buildFunctionDef(name, statement, fileId, modulePath, segments));
      }
      continue;
    }

    if (Node.isVariableStatement(statement)) {
      for (const decl of statement.getDeclarationList().getDeclarations()) {
        const bodyNode = callableBodyNode(decl);
        if (bodyNode === null) {
          continue;
        }
        defs.push(buildFunctionDef(decl.getName(), bodyNode, fileId, modulePath, segments));
      }
    }
  }
}

/**
 * 変数宣言が矢印関数 / 関数式を束縛していればその本体ノード（包含判定の起点）を返す。
 * それ以外（定数・オブジェクト等、呼び出し不能）は `null`。
 */
function callableBodyNode(decl: import("ts-morph").VariableDeclaration): Node | null {
  const initializer = decl.getInitializer();
  if (initializer === undefined) {
    return null;
  }
  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return initializer;
  }
  return null;
}

/** 通常の関数/composable 定義（非コンポーネントノード）を構築する。 */
function buildFunctionDef(
  qualname: string,
  node: Node,
  fileId: string,
  modulePath: string,
  segments: ScriptSegment[],
): FunctionDef {
  return {
    id: makeFunctionId(modulePath, qualname),
    name: qualname,
    qualname,
    file: fileId,
    location: { file: fileId, line: line(node, segments) },
    isComponentNode: false,
    node,
  };
}

/**
 * 任意ノードを内包する最近傍の定義を返す（design「最近傍の包含定義を defs 索引から特定」, Req1.4）。
 *
 * 解決規則:
 * 1. ノードの祖先を辿り、`defs` の関数/composable 定義ノード（関数宣言/矢印関数/関数式）に
 *    最初に到達したらその定義を返す（最近傍優先）。
 * 2. どの名前付き関数にも内包されない場合、当該ファイルにコンポーネントノードがあれば
 *    （`.vue`）それを返す（`<script setup>` 直下のトップレベル呼び出しの帰属先）。
 * 3. いずれにも該当しなければ `undefined`（`.ts/.js` のトップレベル呼び出し等）。
 *
 * @param node 帰属先を求めたいノード（API 呼び出し / 呼び出し式など）
 * @param defs 同一ファイルから `extractDefs` で収集した定義群
 */
export function findEnclosingDef(node: Node, defs: FunctionDef[]): FunctionDef | undefined {
  const functionDefByNode = new Map<Node, FunctionDef>();
  let componentNode: FunctionDef | undefined;
  for (const def of defs) {
    if (def.isComponentNode) {
      componentNode = def;
    } else {
      functionDefByNode.set(def.node, def);
    }
  }

  for (let current: Node | undefined = node; current !== undefined; current = current.getParent()) {
    const match = functionDefByNode.get(current);
    if (match !== undefined) {
      return match;
    }
  }

  return componentNode;
}
