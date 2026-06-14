/**
 * Pass0: モジュールマップ構築（design.md「moduleMap(Pass0)」）。
 *
 * `backendRoot` 配下の `.py` を再帰走査し、
 * - モジュールのドット表記 ↔ ファイルID(fileId) の対応
 * - 各モジュールの公開トップレベル名(class/def/import束縛名)
 * を構築する。構文エラーのファイルは構文木のエラーフラグで検出してスキップし、
 * 警告を1件記録する（Requirements 1.3, 3.3, 5.1, 6.1）。
 *
 * ID非対称性の注意（design.md）: `moduleToPath` のドット表記は `backendRoot` の
 * basename をルートに含む(`sample_app.routers.items`)が、`makeFileId` はこれを
 * 含まない相対パス(`routers/items.py`)を返す。両者は文字列変換ではなく本マップの
 * ルックアップで相互対応させる。
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Node, Tree } from "web-tree-sitter";

import { fieldChild, hasSyntaxError } from "./astUtils.js";
import { makeFileId } from "./ids.js";
import { getPythonParser } from "./parser.js";
import type { WarningCollector } from "./warnings.js";

/** Pass0 の出力。モジュール↔パス対応と公開名。 */
export interface ModuleMap {
  /** ドット表記モジュール名 → fileId。例 `"sample_app.routers.items"` → `"routers/items.py"`。 */
  moduleToPath: Map<string, string>;
  /** fileId → ドット表記モジュール名（`moduleToPath` の逆引き）。 */
  pathToModule: Map<string, string>;
  /** モジュール → 公開トップレベル名（class/def/import束縛名）。 */
  exportedNames: Map<string, Set<string>>;
}

/**
 * fileId(backendRoot相対POSIX) からドット表記モジュール名を導出する。
 *
 * `.py` 除去 → `/` を `.` 化、`__init__` は末尾セグメント削除（パッケージ名のみ）、
 * 先頭に `basename(backendRoot)` をルートセグメントとして付与する。
 *
 * - `routers/items.py`   → `<root>.routers.items`
 * - `routers/__init__.py`→ `<root>.routers`
 * - `__init__.py`        → `<root>`
 */
function fileIdToModule(fileId: string, rootSegment: string): string {
  const withoutExt = fileId.slice(0, -".py".length);
  const segments = withoutExt.split("/");
  if (segments[segments.length - 1] === "__init__") {
    segments.pop();
  }
  return [rootSegment, ...segments].join(".");
}

/**
 * `import_statement` の束縛名（`import a.b.c` → `a`、`import x as y` → `y`）を集める。
 */
function bindNamesFromImport(statement: Node, into: Set<string>): void {
  for (const nameNode of statement.childrenForFieldName("name")) {
    if (nameNode === null) {
      continue;
    }
    if (nameNode.type === "aliased_import") {
      const alias = fieldChild(nameNode, "alias");
      if (alias !== null) {
        into.add(alias.text);
      }
      continue;
    }
    if (nameNode.type === "dotted_name") {
      // `import a.b.c` は先頭セグメントを束縛する。
      const first = nameNode.text.split(".")[0];
      if (first !== undefined && first.length > 0) {
        into.add(first);
      }
    }
  }
}

/**
 * `from m import ...` の束縛名（`Y` → `Y`、`Y as z` → `z`、`*` はスキップ）を集める。
 */
function bindNamesFromImportFrom(statement: Node, into: Set<string>): void {
  for (const nameNode of statement.childrenForFieldName("name")) {
    if (nameNode === null) {
      continue;
    }
    if (nameNode.type === "aliased_import") {
      const alias = fieldChild(nameNode, "alias");
      if (alias !== null) {
        into.add(alias.text);
      }
      continue;
    }
    if (nameNode.type === "dotted_name") {
      // `from m import Y` は名前そのものを束縛する。
      into.add(nameNode.text);
    }
    // wildcard_import (`*`) は束縛名を生成しないためスキップ。
  }
}

/**
 * モジュールのトップレベル文から公開名（class/def/import束縛名）を収集する。
 */
function collectExportedNames(tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const child of tree.rootNode.children) {
    if (child === null) {
      continue;
    }
    // デコレータ付き定義は `decorated_definition` に包まれるため、内側の定義を取り出す。
    const statement =
      child.type === "decorated_definition" ? (fieldChild(child, "definition") ?? child) : child;
    switch (statement.type) {
      case "class_definition":
      case "function_definition": {
        const nameNode = fieldChild(statement, "name");
        if (nameNode !== null) {
          names.add(nameNode.text);
        }
        break;
      }
      case "import_statement":
        bindNamesFromImport(statement, names);
        break;
      case "import_from_statement":
        bindNamesFromImportFrom(statement, names);
        break;
      default:
        break;
    }
  }
  return names;
}

/**
 * `backendRoot` 配下の `.py` ファイル絶対パスを再帰列挙する（決定性のため昇順ソート）。
 */
async function listPythonFiles(backendRoot: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of sorted) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.isFile() && dirent.name.endsWith(".py")) {
        results.push(full);
      }
    }
  }

  await walk(backendRoot);
  return results;
}

/**
 * モジュールマップを構築する（Pass0）。
 *
 * @param backendRoot 解析対象 backend ルートの絶対パス
 * @param collector 構文エラーskipを記録する警告コレクター
 * @param wasmDir parser の WASM 同梱ディレクトリ（省略時は node_modules 解決）
 */
export async function buildModuleMap(
  backendRoot: string,
  collector: WarningCollector,
  wasmDir?: string,
): Promise<ModuleMap> {
  const parser = await getPythonParser(wasmDir);
  const rootSegment = basename(backendRoot);

  const moduleToPath = new Map<string, string>();
  const pathToModule = new Map<string, string>();
  const exportedNames = new Map<string, Set<string>>();

  const files = await listPythonFiles(backendRoot);
  for (const filePath of files) {
    const fileId = makeFileId(backendRoot, filePath);
    const source = await readFile(filePath, "utf8");
    const tree = parser.parse(source);
    if (tree === null) {
      collector.recordParseError(fileId);
      continue;
    }
    if (hasSyntaxError(tree)) {
      collector.recordParseError(fileId);
      continue;
    }

    const moduleName = fileIdToModule(fileId, rootSegment);
    moduleToPath.set(moduleName, fileId);
    pathToModule.set(fileId, moduleName);
    exportedNames.set(moduleName, collectExportedNames(tree));
  }

  return { moduleToPath, pathToModule, exportedNames };
}

/**
 * `moduleName` またはその祖先パッケージが内部モジュールかを判定する（Requirement 3.3）。
 *
 * `moduleName` 自体、またはドット表記の祖先プレフィックスのいずれかが
 * `moduleToPath` のキーに存在すれば true。例: `sample_app.routers.items` が存在、
 * もしくは `sample_app.routers` / `sample_app` が存在すれば true。`fastapi` は false。
 */
export function isInternalModule(map: ModuleMap, moduleName: string): boolean {
  const segments = moduleName.split(".");
  for (let end = segments.length; end >= 1; end -= 1) {
    const prefix = segments.slice(0, end).join(".");
    if (map.moduleToPath.has(prefix)) {
      return true;
    }
  }
  return false;
}
