/**
 * Pass2 有向呼び出しグラフ構築 + API 注釈 + ファイルグラフ導出（design.md「resolver/callGraph(Pass2)」, Req 1.4/2.1/2.2/2.3）。
 *
 * Pass1 抽出器（apiCalls/defs/calls/templates）の結果を集約し、frontend/ 内の有向呼び出しグラフを構築する。
 *
 * 構成（4 ステップ）:
 * 1. `extractPerFile`: `fileMap.fileIds` を反復（構文/SFC エラー skip を尊重。Req4.1。`project.fileIds`
 *    ではない）し、各ファイルから apiCalls/defs/calls/templateRefs を抽出して `FileExtractionResult` へ集約。
 *    `.vue` の template は `project.getVueSource(fileId)` の生ソースを `extractTemplateRefs` に渡す。
 * 2. `buildCallGraph`: 全 defs を `FunctionNode` 化し、各 caller の callee を解決してエッジ（calls[]）を張る。
 *    callee 解決（System Flows 図）:
 *      (a) 明示 import: caller ファイル内に callee 識別子の import があれば `resolveSpecifierToFileId` で
 *          対象 fileId を得て、対象ファイルの該当ノードへ解決。
 *      (b) auto-import: 明示 import 無しなら `exportIndex` の名前一致で一意解決。
 *      (c) template エッジ: 3.4 の childComponentName を `componentIndex` で子コンポーネントノードへ解決。
 *      (d) intra-file: 同一ファイル内の定義済み関数呼び出しはエッジを張る。
 *    終端（エッジを張らない）: frontend/ 外（axios/vue 等）・未解決・非一意・属性アクセスで一意一致なし。
 *    同一ノードは1回だけ訪問（循環安全）、calls[] は重複排除。
 * 3. `deriveFileGraph`: 各 FunctionNode.file → 呼び出し先 FunctionNode.file 集合を dependsOn
 *    （自己依存除外・昇順ソート）。
 * 4. `annotateApiCalls`: 各 ApiCallCandidate の内包ノードを行範囲ベースの `resolveEnclosing`
 *    （location.line を内包する最近傍 def → 無ければコンポーネントノード。3.2 の AST ベース
 *    `findEnclosingDef` と同一結果）で解決し `enclosingFunctionId` を確定する
 *    （空プレースホルダを残さない。Req1.4。参照貫通）。
 *
 * ID 整合（不変条件）: `ApiCall.enclosingFunctionId == FunctionNode.id`、`FunctionNode.file == FileNode.id`、
 * `calls[]/dependsOn[] == 実在 id`（backend と同じ参照貫通）。
 *
 * 本モジュールは Pass1 抽出器・fileMap・project・ids・models を **import 利用のみ**（再実装しない）。
 */
import { Node, type SourceFile } from "ts-morph";

import {
  resolveSpecifierToFileId,
  stripExtension,
  type FileMap,
  type NameIndexEntry,
} from "../fileMap.js";
import { makeFunctionId } from "../ids.js";
import type { ApiCall, FileNode, FunctionNode } from "../models.js";
import type { FrontendProject } from "../project.js";
import type { WarningCollector } from "../warnings.js";

import { extractApiCalls, type ApiCallCandidate } from "../extractors/apiCalls.js";
import { extractGeneratedClientApiCalls } from "../extractors/generatedClient.js";
import { extractCalls, type CallSiteEntry } from "../extractors/calls.js";
import { extractDefs, type FunctionDef } from "../extractors/defs.js";
import { extractTemplateRefs, type TemplateRefEdge } from "../extractors/templates.js";

/** `.vue` fileId 判定（索引キーは `.vue` 拡張子のまま）。 */
const VUE_EXTENSION = ".vue";

/**
 * 1 ファイル分の Pass1 抽出結果（design「FileExtractionResult」）。
 *
 * 4.1 が caller→callee エッジ構築・API 注釈・ファイルグラフ導出の入力に用いる。`defs` は
 * `findEnclosingDef`（API 注釈の最近傍包含解決）に再利用するため宣言ノード参照ごと保持する。
 */
export interface FileExtractionResult {
  /** fileId（frontendRoot 相対 POSIX。`.vue` は `.vue` 拡張子のまま）。 */
  fileId: string;
  /** API 呼び出し候補（`enclosingFunctionId` は未解決プレースホルダ。4.1 で注釈）。 */
  apiCalls: ApiCallCandidate[];
  /** 定義ノード（関数/composable/`.vue` コンポーネントノード）。 */
  defs: FunctionDef[];
  /** 呼び出しサイト（callerQualname/calleeText/location）。エッジ構築の入力。 */
  calls: CallSiteEntry[];
  /** template 由来のコンポーネント間エッジ候補（`.vue` のみ。`.ts/.js` は空）。 */
  templateRefs: TemplateRefEdge[];
}

/**
 * `fileMap.fileIds`（構文/SFC エラー skip 済み）を反復し、各ファイルの Pass1 抽出結果を集約する。
 *
 * `project.fileIds` ではなく `fileMap.fileIds` を反復することで、構文エラーファイル（`useBroken.ts`）の
 * skip を尊重する（Req4.1）。`.vue` の template 参照は生ソース（`project.getVueSource`）から抽出する。
 *
 * @param project Pass0 の `FrontendProject`（fileId → SourceFile / segments / `.vue` 生ソース）
 * @param fileMap Pass0 の `FileMap`（skip 済み fileId 集合・名前索引）
 * @param collector 警告コレクター（動的 URL/method 除外等を記録）
 */
export function extractPerFile(
  project: FrontendProject,
  fileMap: FileMap,
  collector: WarningCollector,
): Map<string, FileExtractionResult> {
  const perFile = new Map<string, FileExtractionResult>();

  for (const fileId of fileMap.fileIds) {
    const sourceFile = project.getSourceFile(fileId);
    if (sourceFile === undefined) {
      continue; // 索引に在るが Project 未登録（理論上発生しない）。防御的に skip。
    }
    const segments = project.getSegments(fileId);

    const templateRefs = extractTemplateRefsForFile(project, fileId, collector);

    perFile.set(fileId, {
      fileId,
      apiCalls: [
        ...extractApiCalls(sourceFile, fileId, segments, collector),
        // 生成 OpenAPI クライアント（openapi-generator）のエンドポイントも併せて抽出する。
        ...extractGeneratedClientApiCalls(sourceFile, fileId, segments),
      ],
      defs: extractDefs(sourceFile, fileId, segments),
      calls: extractCalls(sourceFile, fileId, segments),
      templateRefs,
    });
  }

  return perFile;
}

/** `.vue` のみ生ソースから template 参照を抽出する（`.ts/.js` は空配列）。 */
function extractTemplateRefsForFile(
  project: FrontendProject,
  fileId: string,
  collector: WarningCollector,
): TemplateRefEdge[] {
  if (!fileId.endsWith(VUE_EXTENSION)) {
    return [];
  }
  const vueSource = project.getVueSource(fileId);
  if (vueSource === undefined) {
    return [];
  }
  return extractTemplateRefs(vueSource, fileId, collector);
}

/**
 * 有向呼び出しグラフを構築する（design「buildCallGraph」, Req2.1/2.3）。
 *
 * 全ファイルの defs を `FunctionNode` 化し、各 caller の callee を解決してエッジ（calls[]）を張る。
 * 同一ノードは1回だけ生成（id でユニーク）、calls[] は重複排除。
 *
 * @param perFile `extractPerFile` の結果
 * @param fileMap Pass0 の名前索引（exportIndex/componentIndex・指定子解決）
 * @param project Pass0 の `FrontendProject`（import 宣言の参照に使用）
 */
export function buildCallGraph(
  perFile: Map<string, FileExtractionResult>,
  fileMap: FileMap,
  project: FrontendProject,
): FunctionNode[] {
  // 1. 全 defs を FunctionNode 化（id でユニーク＝循環安全・重複ノードなし）。
  const nodesById = new Map<string, FunctionNode>();
  for (const result of perFile.values()) {
    for (const def of result.defs) {
      if (!nodesById.has(def.id)) {
        nodesById.set(def.id, toFunctionNode(def));
      }
    }
  }

  // 2. caller ファイルごとに caller→callee エッジを張る。
  for (const result of perFile.values()) {
    addCallEdges(result, perFile, fileMap, project, nodesById);
    addTemplateEdges(result, fileMap, nodesById);
  }

  // 3. 各ノードの calls[] を重複排除（挿入順を保持）。
  for (const node of nodesById.values()) {
    node.calls = dedupe(node.calls);
  }

  return [...nodesById.values()];
}

/** `FunctionDef` を空 calls の `FunctionNode` へ変換する。 */
function toFunctionNode(def: FunctionDef): FunctionNode {
  return {
    id: def.id,
    name: def.name,
    file: def.file,
    location: def.location,
    calls: [],
  };
}

/**
 * 呼び出しサイト（calls.ts 由来）を解決して caller→callee エッジを張る。
 *
 * caller の `FunctionNode.id` は `makeFunctionId(stripExtension(fileId), callerQualname)`（3.2 と同体系）。
 * 各 calleeText を「明示 import → auto-import（exportIndex）→ intra-file」の順に解決し、解決できた
 * 内部ノード id を caller の calls[] に加える。未解決/非一意/外部は終端（エッジを張らない）。
 */
function addCallEdges(
  result: FileExtractionResult,
  perFile: Map<string, FileExtractionResult>,
  fileMap: FileMap,
  project: FrontendProject,
  nodesById: Map<string, FunctionNode>,
): void {
  const modulePath = stripExtension(result.fileId);
  const sourceFile = project.getSourceFile(result.fileId);
  const importsByLocal = sourceFile === undefined ? new Map() : collectImports(sourceFile);

  for (const call of result.calls) {
    const callerId = makeFunctionId(modulePath, call.callerQualname);
    const caller = nodesById.get(callerId);
    if (caller === undefined) {
      continue; // caller がノード化されていない（理論上発生しない）。
    }

    const calleeId = resolveCallee(call.calleeText, result, perFile, fileMap, importsByLocal);
    if (calleeId !== null && nodesById.has(calleeId)) {
      caller.calls.push(calleeId);
    }
  }
}

/**
 * callee 式テキストを内部ノード id へ解決する（System Flows 図, Req2.3）。
 *
 * - 属性アクセス（`obj.method`）: axios 等の外部・カスタムクライアントは終端。本実装では識別子呼び出し
 *   のみ解決対象とし、属性アクセスは一意一致が取れないため終端（null）。
 * - 識別子呼び出し（`foo`）:
 *   (a) 明示 import: caller ファイル内に同名 import があれば指定子を `resolveSpecifierToFileId` で
 *       fileId へ解決し、対象ファイルの該当ノード（exportIndex 内 fileId 一致 / 同名 def）を返す。
 *   (b) intra-file: 同一ファイル内に同名 def があればそのノード id。
 *   (c) auto-import: `exportIndex` の名前一致で一意解決（非一意は終端）。
 */
function resolveCallee(
  calleeText: string,
  result: FileExtractionResult,
  perFile: Map<string, FileExtractionResult>,
  fileMap: FileMap,
  importsByLocal: Map<string, string>,
): string | null {
  // 属性アクセス（`axios.get` / `customClient.fetchData` 等）は一意解決できず終端。
  if (calleeText.includes(".")) {
    return null;
  }

  // (a) 明示 import: 指定子を fileId へ解決し、対象ファイルの該当ノードを返す。
  const specifier = importsByLocal.get(calleeText);
  if (specifier !== undefined) {
    const targetFileId = resolveSpecifierToFileId(specifier, result.fileId, fileMap);
    if (targetFileId === null) {
      return null; // frontend 外 → 終端。
    }
    return resolveNameInFile(calleeText, targetFileId, perFile, fileMap);
  }

  // (b) intra-file: 同一ファイル内の定義済み関数。
  const intra = result.defs.find((d) => !d.isComponentNode && d.qualname === calleeText);
  if (intra !== undefined) {
    return intra.id;
  }

  // (c) auto-import: exportIndex の名前一致で一意解決。
  return resolveUnique(fileMap.exportIndex.get(calleeText));
}

/**
 * 対象 fileId 内の名前 `name` のノード id を返す。
 * 当該 fileId の exportIndex エントリ優先、無ければ defs から同名定義を引く。一致なしは null。
 */
function resolveNameInFile(
  name: string,
  targetFileId: string,
  perFile: Map<string, FileExtractionResult>,
  fileMap: FileMap,
): string | null {
  const entries = fileMap.exportIndex.get(name)?.filter((e) => e.fileId === targetFileId) ?? [];
  if (entries.length === 1) {
    return entries[0]!.functionId;
  }

  const targetFile = perFile.get(targetFileId);
  const def = targetFile?.defs.find((d) => !d.isComponentNode && d.qualname === name);
  return def?.id ?? null;
}

/**
 * template の子コンポーネント参照を `componentIndex` で解決し、親→子のコンポーネント間エッジを張る。
 * 非一意/未解決は終端（誤エッジを作らない）。
 */
function addTemplateEdges(
  result: FileExtractionResult,
  fileMap: FileMap,
  nodesById: Map<string, FunctionNode>,
): void {
  for (const ref of result.templateRefs) {
    const parent = nodesById.get(ref.parentNodeId);
    if (parent === undefined) {
      continue;
    }
    const childId = resolveUnique(fileMap.componentIndex.get(ref.childComponentName));
    if (childId !== null && nodesById.has(childId)) {
      parent.calls.push(childId);
    }
  }
}

/** 名前索引の多値エントリを一意解決する（一意=その id、非一意/不在=null=終端）。 */
function resolveUnique(entries: NameIndexEntry[] | undefined): string | null {
  if (entries === undefined || entries.length !== 1) {
    return null;
  }
  return entries[0]!.functionId;
}

/**
 * caller SourceFile の import 宣言から「ローカル名 → モジュール指定子」を集める。
 * 名前付き import（`import { fetchUsers } from "~/..."`）・デフォルト import・名前空間 import を対象。
 */
function collectImports(sourceFile: SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();

    const defaultImport = decl.getDefaultImport();
    if (defaultImport !== undefined && Node.isIdentifier(defaultImport)) {
      map.set(defaultImport.getText(), specifier);
    }

    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport !== undefined) {
      map.set(namespaceImport.getText(), specifier);
    }

    for (const named of decl.getNamedImports()) {
      // エイリアス（`{ a as b }`）があればローカル名 `b`、無ければ `a`。
      const local = named.getAliasNode()?.getText() ?? named.getName();
      map.set(local, specifier);
    }
  }
  return map;
}

/**
 * 関数単位グラフからファイル単位グラフを導出する（design「deriveFileGraph」, Req2.2）。
 *
 * 各 FunctionNode.file → 呼び出し先 FunctionNode.file 集合を `dependsOn` とする。
 * 自己依存は除外、`dependsOn` は昇順ソート。`id === path`（fileId）。
 */
export function deriveFileGraph(functions: FunctionNode[]): FileNode[] {
  const nodeFileById = new Map<string, string>();
  for (const fn of functions) {
    nodeFileById.set(fn.id, fn.file);
  }

  // ファイルごとの dependsOn 集合を構築（挿入順は問わない＝最後に昇順ソート）。
  const depsByFile = new Map<string, Set<string>>();
  const ensure = (fileId: string): Set<string> => {
    let set = depsByFile.get(fileId);
    if (set === undefined) {
      set = new Set<string>();
      depsByFile.set(fileId, set);
    }
    return set;
  };

  for (const fn of functions) {
    const deps = ensure(fn.file);
    for (const calleeId of fn.calls) {
      const calleeFile = nodeFileById.get(calleeId);
      if (calleeFile !== undefined && calleeFile !== fn.file) {
        deps.add(calleeFile); // 自己依存は除外。
      }
    }
  }

  return [...depsByFile.keys()].map((fileId) => ({
    id: fileId,
    path: fileId,
    dependsOn: [...(depsByFile.get(fileId) ?? new Set<string>())].sort(compareAscending),
  }));
}

/**
 * 各 ApiCallCandidate を内包ノードへ注釈し、`enclosingFunctionId` を確定した `ApiCall[]` を返す
 * （design「各 ApiCall を内包ノードへ注釈」, Req1.4）。
 *
 * 内包解決の規則は defs の `findEnclosingDef`（最近傍の名前付き関数 → 無ければ `.vue` コンポーネント
 * ノード）と同一だが、`ApiCallCandidate` は location（補正済み行）のみを保持し元の ts-morph ノードを
 * 持たないため、ここでは **行番号ベース**で同規則を再現する: candidate.location.line を行範囲に内包する
 * 最近傍の名前付き関数 def を優先し、無ければ当該 `.vue` のコンポーネントノードへ帰属させる
 * （`<script setup>` 直下の帰属）。candidate と def の行はいずれも同じ segments 補正系で揃うため整合する。
 */
export function annotateApiCalls(perFile: Map<string, FileExtractionResult>): ApiCall[] {
  const apiCalls: ApiCall[] = [];

  for (const result of perFile.values()) {
    for (const candidate of result.apiCalls) {
      const enclosingFunctionId = resolveEnclosing(candidate, result);
      apiCalls.push({
        method: candidate.method,
        urlPattern: candidate.urlPattern,
        enclosingFunctionId,
        location: candidate.location,
      });
    }
  }

  return apiCalls;
}

/**
 * API 呼び出し候補の内包ノード id を解決する（Req1.4）。
 *
 * candidate.location.line を内包する最近傍の名前付き関数 def（location.line 範囲）を優先し、
 * 無ければ当該ファイルの `.vue` コンポーネントノードへ帰属させる（`<script setup>` 直下の帰属）。
 * これは defs の `findEnclosingDef` と同じ規則（最近傍 → コンポーネントノード）を行番号ベースで再現する。
 */
function resolveEnclosing(candidate: ApiCallCandidate, result: FileExtractionResult): string {
  const line = candidate.location.line;

  // 名前付き関数のうち、宣言ノードの行範囲が候補行を内包する最近傍（最大開始行）を選ぶ。
  let best: FunctionDef | undefined;
  for (const def of result.defs) {
    if (def.isComponentNode) {
      continue;
    }
    if (enclosesLine(def, line)) {
      if (best === undefined || def.location.line > best.location.line) {
        best = def;
      }
    }
  }
  if (best !== undefined) {
    return best.id;
  }

  // 名前付き関数に内包されない → `.vue` コンポーネントノードへ帰属。
  const componentNode = result.defs.find((d) => d.isComponentNode);
  return componentNode?.id ?? "";
}

/** def の宣言ノードの行範囲（開始〜終了、`.vue` は segments 補正済み）が `line` を内包するか。 */
function enclosesLine(def: FunctionDef, line: number): boolean {
  const startLine = def.location.line;
  const endLine = nodeEndLine(def);
  return line >= startLine && line <= endLine;
}

/**
 * def の宣言ノードの終了行を求める。`.vue` の行は segments 補正された値だが、ノードの相対的な
 * 行スパン（終了 - 開始）は補正で不変なため、ts-morph の生の行スパンを def.location.line に加算する。
 */
function nodeEndLine(def: FunctionDef): number {
  const node = def.node;
  const rawStart = node.getStartLineNumber();
  const rawEnd = node.getEndLineNumber();
  return def.location.line + (rawEnd - rawStart);
}

/** 配列の重複を除去する（挿入順保持）。 */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** 決定的な昇順比較（ロケール非依存。fileMap/project と同流儀）。 */
function compareAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
