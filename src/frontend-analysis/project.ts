/**
 * Pass0 解析基盤: ts-morph Project 構築（design.md「project / sfc」）。
 *
 * `frontendRoot` 配下の `.ts/.js` と、`extractSfc`（1.1）で抽出した `.vue` の
 * `<script>`/`<script setup>` 結合本文を **仮想 `.ts`** として、単一の ts-morph Project へ投入する。
 * 各 SourceFile は fileId（frontendRoot 相対 POSIX。`.vue` は拡張子そのまま `.vue`）から引ける。
 *
 * 静的解析のみ（対象コードを実行しない・型チェックしない・対象 tsconfig/依存を読まない、
 * Req5.2/5.3）。インメモリ FS 上に投入し、構文/シンボル解決のみ ts-morph に委ねる。
 * `.vue` の行番号補正に使う `segments`（1.1 の `ScriptSegment[]`）を fileId に紐づけて保持する
 * （後段の Pass1/Pass2 が `toSourceLocation` で `.vue` 実ファイル行へ補正する。design 行オフセット保持）。
 *
 * SFC パースエラーの `.vue` は `extractSfc` が `script=null` + `recordParseError` するため
 * Project へ載せずスキップし、他ファイルの解析を継続する（Req4.1）。
 *
 * 注: `SfcWarningCollector`/`SourceLocation`/`ScriptSegment` は 1.1（sfc.ts）の構造的暫定型を
 * 再利用する。正準 models/warnings への統合は 1.3 の担当（ここでは新たな正準型を作らない）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { Project, type SourceFile } from "ts-morph";

import { extractSfc, type ScriptSegment, type SfcWarningCollector } from "./sfc.js";

/** 解析対象拡張子（Req5.1: frontend/ 配下の Vue/TS/JS のみ）。 */
const TS_JS_EXTENSIONS = [".ts", ".js"] as const;
const VUE_EXTENSION = ".vue";

/**
 * Pass0 の出力。ts-morph Project と、fileId→SourceFile / fileId→segments の索引。
 *
 * `.ts/.js` の fileId はそのまま（`.vue` は拡張子そのまま `.vue`）。`.vue` 由来 SourceFile は
 * 仮想 `.ts` として Project に投入されるが、本索引は `.vue` の fileId をキーに引ける。
 */
export interface FrontendProject {
  /** ts-morph Project 本体（クロスファイル解決などで後段が利用）。 */
  readonly project: Project;
  /** 投入済み fileId の集合（昇順）。 */
  readonly fileIds: ReadonlySet<string>;
  /** fileId に紐づく SourceFile を返す。未登録は `undefined`。 */
  getSourceFile(fileId: string): SourceFile | undefined;
  /**
   * fileId に紐づく行オフセット segments を返す。
   * `.ts/.js` は恒等（空配列）。`.vue` は `<script>`/`<script setup>` 由来の segments。
   * 未登録の fileId も空配列を返す。
   */
  getSegments(fileId: string): ScriptSegment[];
  /**
   * `.vue` fileId に紐づく**生ソース**（原文）を返す。未登録 / 非 `.vue` は `undefined`。
   *
   * Pass2（callGraph, 4.1）の template コンポーネント参照抽出（`extractTemplateRefs`）は
   * `extractSfc` 再利用のため `.vue` 生ソースを要求するが、Project へ載るのは抽出済み仮想 `.ts`
   * のみで生ソースは保持されない。ここで `.vue` の生ソースを保持・公開し、4.1 が二重 parse
   * （extractSfc 再実行）で template 参照を引けるようにする（design 行オフセット保持と独立）。
   */
  getVueSource(fileId: string): string | undefined;
}

/**
 * `frontendRoot` 配下を走査して ts-morph Project を構築する（Pass0）。
 *
 * `.ts/.js` は原文を、`.vue` は `extractSfc` の結合スクリプトを仮想 `.ts` として投入する。
 * SFC パースエラー/スクリプト無しの `.vue` は Project へ載せず継続する（Req4.1）。
 * 型チェック・対象 tsconfig/依存解決は行わない（インメモリ FS・依存解決スキップ。Req5.2/5.3）。
 *
 * @param frontendRoot 解析対象 frontend ルートの絶対パス（不在/非ディレクトリは throw）
 * @param collector SFC パースエラーを記録する警告コレクター
 */
export function buildProject(
  frontendRoot: string,
  collector: SfcWarningCollector,
): FrontendProject {
  const rootStat = statSync(frontendRoot); // 不在/非ディレクトリは throw（致命的エラー）
  if (!rootStat.isDirectory()) {
    throw new Error(`frontendRoot is not a directory: ${frontendRoot}`);
  }

  // 対象コードを実行/型チェックせず、対象 tsconfig/依存も読まない純粋な構文解析用 Project。
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: true },
  });

  const sourceFiles = new Map<string, SourceFile>();
  const segmentsByFileId = new Map<string, ScriptSegment[]>();
  const vueSourceByFileId = new Map<string, string>();

  for (const fileId of listSourceFileIds(frontendRoot)) {
    const absPath = join(frontendRoot, ...fileId.split("/"));
    if (fileId.endsWith(VUE_EXTENSION)) {
      addVueFile(
        project,
        absPath,
        fileId,
        sourceFiles,
        segmentsByFileId,
        vueSourceByFileId,
        collector,
      );
    } else {
      addScriptFile(project, absPath, fileId, sourceFiles, segmentsByFileId);
    }
  }

  const fileIds = new Set<string>([...sourceFiles.keys()].sort(compareAscending));

  return {
    project,
    fileIds,
    getSourceFile(fileId: string): SourceFile | undefined {
      return sourceFiles.get(fileId);
    },
    getSegments(fileId: string): ScriptSegment[] {
      return segmentsByFileId.get(fileId) ?? [];
    },
    getVueSource(fileId: string): string | undefined {
      return vueSourceByFileId.get(fileId);
    },
  };
}

/**
 * `.ts/.js` を原文のまま Project に投入する。`.vue` と衝突しない仮想パスとして
 * fileId をそのまま使う（インメモリ FS は先頭に `/` を補うだけで相対構造を保つ）。
 * segments は恒等（空配列）。
 */
function addScriptFile(
  project: Project,
  absPath: string,
  fileId: string,
  sourceFiles: Map<string, SourceFile>,
  segmentsByFileId: Map<string, ScriptSegment[]>,
): void {
  const source = readFileUtf8(absPath);
  const sourceFile = project.createSourceFile(fileId, source, { overwrite: true });
  sourceFiles.set(fileId, sourceFile);
  segmentsByFileId.set(fileId, []);
}

/**
 * `.vue` を `extractSfc` で抽出し、結合スクリプトを **仮想 `.ts`** として投入する。
 * 仮想パスは `<fileId>.ts`（`.vue` 由来であることを保ちつつ ts-morph に TS として解析させる）。
 * 索引キーは元の `.vue` fileId。segments を保持して後段の行補正に供する。
 *
 * SFC パースエラー（`script=null` かつ collector に記録済み）/ スクリプト無しの `.vue` は
 * Project へ載せずスキップする（Req4.1）。
 */
function addVueFile(
  project: Project,
  absPath: string,
  fileId: string,
  sourceFiles: Map<string, SourceFile>,
  segmentsByFileId: Map<string, ScriptSegment[]>,
  vueSourceByFileId: Map<string, string>,
  collector: SfcWarningCollector,
): void {
  const source = readFileUtf8(absPath);
  const extracted = extractSfc(source, fileId, collector);
  if (extracted.script === null) {
    // SFC エラー（警告は extractSfc が記録済み）/ スクリプト無し → 解析対象なしでスキップ。
    return;
  }

  const virtualPath = `${fileId}.ts`;
  const sourceFile = project.createSourceFile(virtualPath, extracted.script.content, {
    overwrite: true,
  });
  sourceFiles.set(fileId, sourceFile);
  segmentsByFileId.set(fileId, extracted.script.segments);
  // 生ソースを保持し、Pass2 の template 参照抽出（extractTemplateRefs）に供する。
  // script を持つ（= Project に載った）.vue のみ保持し、skip 済みファイルとは整合する。
  vueSourceByFileId.set(fileId, source);
}

/**
 * `frontendRoot` 配下の対象 fileId（frontendRoot 相対 POSIX）を再帰列挙する。
 * 決定性のため昇順ソートして返す（Req: 決定的なファイル走査）。
 */
function listSourceFileIds(frontendRoot: string): string[] {
  const results: string[] = [];

  const walk = (dir: string): void => {
    const dirents = readdirSync(dir, { withFileTypes: true });
    const sorted = [...dirents].sort((a, b) => compareAscending(a.name, b.name));
    for (const dirent of sorted) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.isFile() && isRecognizedExtension(dirent.name)) {
        results.push(toFileId(frontendRoot, full));
      }
    }
  };

  walk(frontendRoot);
  return results.sort(compareAscending);
}

/** 認識拡張子（`.ts`/`.js`/`.vue`）か判定する（Req5.1）。 */
function isRecognizedExtension(name: string): boolean {
  return name.endsWith(VUE_EXTENSION) || TS_JS_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** 絶対パスを fileId（frontendRoot 相対 POSIX）へ変換する。 */
function toFileId(frontendRoot: string, absPath: string): string {
  const rel = relative(frontendRoot, absPath);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** 決定的な昇順比較（ロケール非依存）。 */
function compareAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * UTF-8 でファイルを同期読み込みする（静的解析のためのソース読み取りのみ）。
 * 同期 I/O は公開 API `analyzeFrontend` が非 async（ts-morph 同期）であることに整合。
 */
function readFileUtf8(absPath: string): string {
  return readFileSync(absPath, "utf8");
}
