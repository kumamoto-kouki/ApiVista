/**
 * Pass0: ファイルマップと名前索引（design.md「fileMap(Pass0)」）。
 *
 * `buildProject`（1.2）が確立した `FrontendProject`（fileId → SourceFile / segments、
 * 構文/SFC エラーは既に skip 済み）を入力に、クロスファイル名前解決の一級索引を構築する:
 * - `fileIds`: 索引対象の fileId 集合（frontendRoot 相対 POSIX）。
 * - `exportIndex`: 関数/composable のエクスポート名 → 定義元 `{fileId, functionId}`
 *   （Nuxt auto-import の名前解決。明示 import が無い呼び出し先をここで引く）。
 * - `componentIndex`: コンポーネント名（Nuxt のディレクトリ接頭辞付き PascalCase 命名規約）
 *   → `.vue` の単一コンポーネントノード `{fileId, functionId}`（template の `<Child/>` 解決用）。
 *
 * あわせて、import 指定子（相対 / `~/` / `@/`）を frontendRoot 起点で fileId へ解決する
 * `resolveSpecifierToFileId` を提供する（明示 import の解決経路。エイリアスは frontendRoot、
 * 相対は currentFileId 起点。拡張子省略 / index.* を解決し、frontend 外は null）。
 *
 * 構文エラーの扱い（Req4.1、二重記録の回避）:
 * - `.vue` の SFC パースエラーは `extractSfc`（1.1）が既に skip + 警告済みで `project.fileIds` に
 *   現れないため、本 Pass0 は索引対象外とするのみ（**再記録しない**）。
 * - `.ts/.js` は `buildProject` が構文診断を行わず Project へ載せるため、本 Pass0 が ts-morph の
 *   **構文診断（syntactic diagnostics）**で構文エラーを検出し、当該ファイルを索引から skip して
 *   `recordParseError` で1件だけ警告する（前段では未記録のため二重記録にならない）。
 *
 * 解析対象は `frontend/` 配下の `.ts/.js/.vue` のみ（Req5.1。`project.fileIds` が既にこの制約を満たす）。
 * `frontend/` 外/未解決は終端の起点になる（resolveSpecifierToFileId が null を返す。Req2.3）。
 *
 * design の「解決の一級手段＝ exportIndex/componentIndex + エイリアス解決」に従い、ts-morph の
 * module 解決には依存しない（対象 tsconfig/依存未インストールでも機能する。Req5.3）。
 */
import { Node, type Project, type SourceFile } from "ts-morph";

import { makeFunctionId } from "./ids.js";
import type { FrontendProject } from "./project.js";
import type { WarningCollector } from "./warnings.js";

/** 名前索引のエントリ（定義元 fileId と FunctionNode.id）。 */
export interface NameIndexEntry {
  /** 定義元 fileId（frontendRoot 相対 POSIX）。 */
  fileId: string;
  /** 対象ノードの `FunctionNode.id`（"<module-path>:<qualname>"）。 */
  functionId: string;
}

/** Pass0 の出力。fileId 集合とエクスポート名/コンポーネント名の索引。 */
export interface FileMap {
  /** fileId（frontendRoot 相対 POSIX）の集合。 */
  fileIds: Set<string>;
  /**
   * エクスポート名 → 定義元 `{fileId, functionId}`（関数/composable の名前解決。
   * auto-import 対応の一級索引）。同名が複数ファイルにある場合は複数エントリを保持し、
   * 解決側（Pass2）が非一意を終端扱いにする。
   */
  exportIndex: Map<string, NameIndexEntry[]>;
  /**
   * コンポーネント名（PascalCase） → `.vue` の単一コンポーネントノード
   * （template の `<Child/>` 解決用）。Nuxt のディレクトリ接頭辞付き命名規約でキーを生成する。
   */
  componentIndex: Map<string, NameIndexEntry[]>;
}

/** `components/` ディレクトリ接頭辞（Nuxt auto-import 命名の起点）。 */
const COMPONENTS_DIR = "components";

/**
 * ファイルマップを構築する（Pass0）。
 *
 * `project.fileIds`（構文/SFC エラー skip 済み）を走査し、`.ts/.js` の公開関数/矢印関数束縛を
 * `exportIndex` へ、各 `.vue` の単一コンポーネントノードを `componentIndex` へ登録する。
 *
 * @param _frontendRoot frontend ルートの絶対パス（fileId は project が既に相対化済みのため未使用。
 *   将来のディスク参照拡張用にシグネチャを design に合わせて保持する）。
 * @param project Pass0 で構築済みの `FrontendProject`（fileId → SourceFile、SFC エラー skip 済み）。
 * @param collector 警告コレクター（`.ts/.js` の構文エラー skip を記録。前段未記録のため二重記録なし）。
 */
export function buildFileMap(
  _frontendRoot: string,
  project: FrontendProject,
  collector: WarningCollector,
): FileMap {
  const fileIds = new Set<string>();
  const exportIndex = new Map<string, NameIndexEntry[]>();
  const componentIndex = new Map<string, NameIndexEntry[]>();

  for (const fileId of project.fileIds) {
    if (fileId.endsWith(".vue")) {
      // SFC エラーの .vue は既に project.fileIds に現れない（extractSfc が skip+警告済み）。
      fileIds.add(fileId);
      indexComponent(fileId, componentIndex);
      continue;
    }

    const sourceFile = project.getSourceFile(fileId);
    if (sourceFile === undefined) {
      continue;
    }
    if (hasSyntaxError(project.project, sourceFile)) {
      // .ts/.js の構文エラーは前段未検出のため、ここで skip + 1件だけ記録する（Req4.1）。
      collector.recordParseError(fileId);
      continue;
    }
    fileIds.add(fileId);
    indexExports(fileId, sourceFile, exportIndex);
  }

  return { fileIds, exportIndex, componentIndex };
}

/**
 * `.ts/.js` SourceFile に**構文エラー**があるか判定する（Req4.1）。
 *
 * 型エラー（semantic diagnostics）は対象 tsconfig/依存未インストール下で大量に出るため除外し、
 * パーサ由来の **syntactic diagnostics のみ**を見る。これにより `useBroken.ts` のような
 * 純粋な構文崩れだけを skip 対象とし、解決可能な健全ファイルを誤って落とさない（Req5.3 整合）。
 */
function hasSyntaxError(project: Project, sourceFile: SourceFile): boolean {
  const program = project.getProgram().compilerObject;
  return program.getSyntacticDiagnostics(sourceFile.compilerNode).length > 0;
}

/**
 * `.ts/.js` の公開トップレベル名（エクスポートされた関数宣言・矢印関数等の変数束縛）を
 * `exportIndex` へ登録する。ts-morph の `getExportedDeclarations()` を用い、宣言名から
 * `functionId = makeFunctionId(modulePath, name)` を採番する。
 */
function indexExports(
  fileId: string,
  sourceFile: SourceFile,
  exportIndex: Map<string, NameIndexEntry[]>,
): void {
  const modulePath = stripExtension(fileId);
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    if (!declarations.some(isCallableDeclaration)) {
      continue;
    }
    addEntry(exportIndex, name, {
      fileId,
      functionId: makeFunctionId(modulePath, name),
    });
  }
}

/**
 * エクスポート宣言が関数/composable（呼び出し可能な定義）かを判定する。
 * - 関数宣言（`export function f`）
 * - 矢印関数/関数式を束縛した変数宣言（`export const f = () => ...`）
 * 型エイリアス・interface・通常の値定数などは callee 解決の対象外として除外する。
 */
function isCallableDeclaration(decl: Node): boolean {
  if (Node.isFunctionDeclaration(decl)) {
    return true;
  }
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    return (
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
    );
  }
  return false;
}

/**
 * `.vue` の単一コンポーネントノードを `componentIndex` へ登録する（Issue 2）。
 * キーは Nuxt のディレクトリ接頭辞付き PascalCase 命名規約で生成する
 * （`components/UserList.vue`→`UserList`、`components/base/Button.vue`→`BaseButton`、
 * `components/user/List.vue`→`UserList`）。`components/` 外（`pages/` 等）は単純ファイル名由来。
 */
function indexComponent(fileId: string, componentIndex: Map<string, NameIndexEntry[]>): void {
  const componentName = componentNameFromFileId(fileId);
  const modulePath = stripExtension(fileId);
  addEntry(componentIndex, componentName, {
    fileId,
    functionId: makeFunctionId(modulePath, componentName),
  });
}

/**
 * `.vue` の fileId から Nuxt のコンポーネント名（PascalCase）を導出する。
 *
 * `components/` 配下は**ディレクトリ接頭辞**を含めた PascalCase 名にする
 * （`components/base/Button.vue`→`BaseButton`、`components/user/List.vue`→`UserList`）。
 * 隣接セグメント間で冗長な重複（`user/User...` の `User`）は Nuxt 準拠で除去する。
 * `components/` 外は単純ファイル名由来の PascalCase（`pages/users.vue`→`Users`）。
 * 完全一致しないケースは best-effort（解決漏れは終端＝誤エッジを作らない）。
 *
 * `extractors/defs`（3.2）の単一コンポーネントノード命名にも再利用される
 * （`componentIndex` キーと defs のコンポーネントノード qualname を一致させ、4.1 の template 参照
 * →コンポーネントノード解決を破綻させないため。命名規約の単一情報源）。
 */
export function componentNameFromFileId(fileId: string): string {
  const withoutExt = stripExtension(fileId);
  const segments = withoutExt.split("/");

  if (segments[0] === COMPONENTS_DIR) {
    // `components/` を除いたディレクトリ + ファイル名を接頭辞付きで結合する。
    const nameSegments = segments.slice(1).map(toPascalCase);
    return dedupeAdjacentSegments(nameSegments).join("");
  }

  // components/ 外は末尾ファイル名のみを PascalCase 化する。
  const last = segments[segments.length - 1] ?? "";
  return toPascalCase(last);
}

/**
 * 隣接する PascalCase セグメント間の冗長な接頭辞重複を除去する（Nuxt 準拠）。
 * 例: `["User", "UserList"]` → `["User", "List"]`（"UserList" の先頭 "User" を削る）。
 * 完全一致するセグメントはそのまま残す（誤った過剰除去を避ける）。
 */
function dedupeAdjacentSegments(segments: string[]): string[] {
  const result: string[] = [];
  for (const segment of segments) {
    const prev = result[result.length - 1];
    if (prev !== undefined && prev !== segment && segment.startsWith(prev)) {
      result.push(segment.slice(prev.length));
    } else {
      result.push(segment);
    }
  }
  return result;
}

/**
 * 識別子セグメントを PascalCase へ正規化する。
 * `user-list` / `userList` / `UserList` → `UserList`。先頭を大文字化し、
 * `-`/`_` 区切りは各セグメントを連結する（既に camelCase の内部大文字は保持）。
 */
function toPascalCase(segment: string): string {
  return segment
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * fileId/相対パスから既知の拡張子（`.ts`/`.js`/`.vue`）を除いた modulePath を返す。
 * `extractors/defs`（3.2）の functionId 採番にも再利用する（modulePath 表現の単一情報源）。
 */
export function stripExtension(fileId: string): string {
  return fileId.replace(/\.(ts|js|vue)$/, "");
}

/** 索引 Map に多値エントリを追加する（重複 functionId は追加しない）。 */
function addEntry(index: Map<string, NameIndexEntry[]>, key: string, entry: NameIndexEntry): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [entry]);
    return;
  }
  if (!existing.some((e) => e.functionId === entry.functionId)) {
    existing.push(entry);
  }
}

/** import 指定子の種別（エイリアス / 相対 / 外部）。 */
const ALIAS_PREFIXES = ["~/", "@/"] as const;
/** 拡張子省略時に試す拡張子の解決順（design: `.ts`/`.js`/`.vue`/index.*）。 */
const RESOLVE_EXTENSIONS = [".ts", ".js", ".vue"] as const;

/**
 * import 指定子（相対 / `~/` / `@/` エイリアス）を frontendRoot 起点の fileId へ解決する。
 *
 * - `~/` / `@/`: frontendRoot 起点（接頭辞を剥がした残りを root 相対パスとして解決）。
 * - `./` / `../`: `currentFileId` のディレクトリ起点で正規化して解決。
 * - それ以外（`axios`/`vue` 等のベアモジュール）: frontend 外 → `null`（Req2.3 の終端起点）。
 *
 * 拡張子省略は `.ts`/`.js`/`.vue`、ディレクトリ指定は `index.*` を `fileMap.fileIds` に対して
 * 試行する。索引に存在する fileId が見つからなければ `null`（frontend 外/未解決）。
 *
 * @param specifier import 指定子（例 `~/composables/useUserApi`、`./useUserApi`）
 * @param currentFileId import 元の fileId（相対解決の基点）
 * @param fileMap 解決対象 fileId 集合を持つ Pass0 出力
 */
export function resolveSpecifierToFileId(
  specifier: string,
  currentFileId: string,
  fileMap: FileMap,
): string | null {
  const basePath = toBasePath(specifier, currentFileId);
  if (basePath === null) {
    return null; // 外部（ベアモジュール）→ 終端。
  }
  return resolveAgainstFiles(basePath, fileMap.fileIds);
}

/**
 * 指定子を frontendRoot 相対の「拡張子なしベースパス」へ正規化する。
 * エイリアス/相対以外（外部）は `null`。
 */
function toBasePath(specifier: string, currentFileId: string): string | null {
  for (const prefix of ALIAS_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return normalizePosix(specifier.slice(prefix.length));
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const currentDir = posixDirname(currentFileId);
    return normalizePosix(joinPosix(currentDir, specifier));
  }
  return null;
}

/**
 * 拡張子なしベースパスを `fileMap.fileIds` に対して解決する。
 * `base.ts`/`base.js`/`base.vue`、次いで `base/index.{ts,js,vue}` を順に試す。
 * いずれも存在しなければ `null`。
 */
function resolveAgainstFiles(basePath: string, fileIds: Set<string>): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (fileIds.has(candidate)) {
      return candidate;
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${basePath}/index${ext}`;
    if (fileIds.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** POSIX の dirname（`a/b/c.ts` → `a/b`、ルート直下は `""`）。 */
function posixDirname(fileId: string): string {
  const idx = fileId.lastIndexOf("/");
  return idx === -1 ? "" : fileId.slice(0, idx);
}

/** POSIX セグメント結合（空 base は relative をそのまま返す）。 */
function joinPosix(base: string, relative: string): string {
  return base.length === 0 ? relative : `${base}/${relative}`;
}

/**
 * POSIX パスの `.`/`..` を解決し、末尾区切りを取り除いた正規形を返す。
 * 範囲外への `..` は残さず除去する（best-effort。範囲外なら後段の索引照合で null になる）。
 */
function normalizePosix(path: string): string {
  const result: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      result.pop();
      continue;
    }
    result.push(segment);
  }
  return result.join("/");
}
