/**
 * ファイル単位シンボルテーブル（libcst `ScopeProvider` の代替）。
 *
 * 1 ファイル（モジュール）のトップレベル文だけを走査し、import / class / def が
 * 導入する名前を `Binding` へ解決する表を構築する。スコープ解決をファイル内に限定し、
 * クロスモジュール解決は呼び出し側（schema 抽出 2.5 / call graph 2c）が `ModuleMap` と
 * 組み合わせて行う前提（design.md「symbolTable(ScopeProvider代替)」）。
 *
 * - トップレベル `class Foo: ...` → `Foo` => `{ kind:"localClass", location }`
 * - トップレベル `def f(): ...`  → `f`   => `{ kind:"other" }`（クラスでないローカル定義）
 * - import 由来              → `{ kind:"import", qualifiedName }`（元名で完全修飾）
 *
 * builtin 判定はルックアップ時（`resolveName`）に適用する。ローカル/import 束縛が存在する
 * 名前はそれが builtin 名であっても束縛が優先される（ローカルスコープが builtin を遮蔽する）。
 */
import type { Node, Tree } from "web-tree-sitter";

import { fieldChild, toSourceLocation } from "./astUtils.js";
import type { SourceLocation } from "./models.js";

/** 名前解決の結果。design.md「symbolTable(ScopeProvider代替)」に厳密準拠。 */
export type Binding =
  | { kind: "localClass"; location: SourceLocation }
  | { kind: "import"; qualifiedName: string }
  | { kind: "builtin" }
  | { kind: "other" };

/**
 * builtin として扱う名前集合（型注釈で頻出するもの + typing の基本名）。
 *
 * これらは「ローカル/import で束縛されていない」場合にのみ builtin と分類する
 * （束縛があれば遮蔽されるため、判定はルックアップ時に行う）。
 */
const BUILTIN_NAMES = new Set<string>([
  "int",
  "str",
  "float",
  "bool",
  "bytes",
  "bytearray",
  "complex",
  "dict",
  "list",
  "tuple",
  "set",
  "frozenset",
  "type",
  "object",
  "None",
  "True",
  "False",
  "Any",
  "Optional",
]);

/**
 * `import_from_statement` / `import_statement` の `name` フィールドに現れる要素から、
 * 束縛名と完全修飾名を取り出す。
 *
 * - `dotted_name`（`import a.b.c` の name）→ bind=先頭セグメント, qualified=全ドット式
 * - `aliased_import`（`X as Y`）→ bind=alias, qualified=元の name（dotted_name のテキスト）
 *
 * @param nameNode `name` フィールドのノード（`dotted_name` か `aliased_import`）
 * @param modulePrefix `from <module> import ...` の `<module>` 文字列。無ければ `null`。
 */
function bindingFromImportName(
  nameNode: Node,
  modulePrefix: string | null,
): { name: string; qualifiedName: string } | null {
  if (nameNode.type === "aliased_import") {
    const original = fieldChild(nameNode, "name");
    const alias = fieldChild(nameNode, "alias");
    if (original === null || alias === null) {
      return null;
    }
    const originalText = original.text;
    const qualifiedName = modulePrefix === null ? originalText : `${modulePrefix}.${originalText}`;
    return { name: alias.text, qualifiedName };
  }

  if (nameNode.type === "dotted_name") {
    const text = nameNode.text;
    if (modulePrefix === null) {
      // `import a.b.c` → bind first segment, qualifiedName = full dotted path.
      const first = text.split(".")[0];
      if (first === undefined || first.length === 0) {
        return null;
      }
      return { name: first, qualifiedName: text };
    }
    // `from <module> import <name>` → bind the imported name itself.
    return { name: text, qualifiedName: `${modulePrefix}.${text}` };
  }

  return null;
}

/**
 * `import_from_statement` の `module_name` フィールド（`dotted_name` か `relative_import`）を
 * 文字列化する。相対 import は先頭のドットを書かれたまま保持する（例: `..schemas`）。
 *
 * 解決不能な `from . import x`（モジュール本体が無いドットのみ）でも、`relative_import` の
 * テキストをそのまま使う（例: `.`）。
 */
function moduleNameText(moduleNode: Node): string {
  return moduleNode.text;
}

/** トップレベルの `class` 定義を表へ登録する。 */
function addClassBinding(node: Node, fileId: string, table: Map<string, Binding>): void {
  const nameNode = fieldChild(node, "name");
  if (nameNode === null) {
    return;
  }
  table.set(nameNode.text, { kind: "localClass", location: toSourceLocation(fileId, node) });
}

/** トップレベルの `def` 定義（クラスでないローカル定義）を `other` として登録する。 */
function addFunctionBinding(node: Node, table: Map<string, Binding>): void {
  const nameNode = fieldChild(node, "name");
  if (nameNode === null) {
    return;
  }
  table.set(nameNode.text, { kind: "other" });
}

/**
 * `import_statement`（`import a.b.c` / `import x as y`）の各 name を登録する。
 */
function addPlainImports(node: Node, table: Map<string, Binding>): void {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type !== "dotted_name" && child.type !== "aliased_import") {
      continue;
    }
    const binding = bindingFromImportName(child, null);
    if (binding !== null) {
      table.set(binding.name, { kind: "import", qualifiedName: binding.qualifiedName });
    }
  }
}

/**
 * `import_from_statement`（`from <module> import A, B as C` / `from m import *`）の
 * 各 name を登録する。`wildcard_import` は列挙不能のためスキップする。
 */
function addFromImports(node: Node, table: Map<string, Binding>): void {
  const moduleNode = fieldChild(node, "module_name");
  if (moduleNode === null) {
    return;
  }
  const modulePrefix = moduleNameText(moduleNode);

  for (const nameNode of node.childrenForFieldName("name")) {
    if (nameNode === null) {
      continue;
    }
    const binding = bindingFromImportName(nameNode, modulePrefix);
    if (binding !== null) {
      table.set(binding.name, { kind: "import", qualifiedName: binding.qualifiedName });
    }
  }
}

/**
 * ファイルのトップレベル import / class / def を走査し、`name -> Binding` を構築する。
 *
 * 走査対象はモジュール直下の文のみ（ネストした class/def やローカル import は対象外）。
 * builtin 分類はここでは行わず、`resolveName` がルックアップ時に補う。
 *
 * @param tree パース済み構文木
 * @param fileId backendRoot 相対 POSIX パス（`SourceLocation.file` に使う）
 */
export function buildSymbolTable(tree: Tree, fileId: string): Map<string, Binding> {
  const table = new Map<string, Binding>();
  const root = tree.rootNode;

  for (const child of root.namedChildren) {
    if (child === null) {
      continue;
    }
    switch (child.type) {
      case "class_definition":
        addClassBinding(child, fileId, table);
        break;
      case "function_definition":
        addFunctionBinding(child, table);
        break;
      case "import_statement":
        addPlainImports(child, table);
        break;
      case "import_from_statement":
        addFromImports(child, table);
        break;
      default:
        break;
    }
  }

  return table;
}

/**
 * 任意の名前を `Binding` へ解決する。表に束縛があればそれを返し（ローカル/import が
 * builtin を遮蔽する）、無ければ builtin 集合を、それも外れれば `{ kind:"other" }` を返す。
 *
 * schema 抽出（2.5）が「この注釈名はローカルクラスか import か、無視すべき builtin か」を
 * 一意に判定するための入口。
 */
export function resolveName(table: Map<string, Binding>, name: string): Binding {
  const bound = table.get(name);
  if (bound !== undefined) {
    return bound;
  }
  if (BUILTIN_NAMES.has(name)) {
    return { kind: "builtin" };
  }
  return { kind: "other" };
}
