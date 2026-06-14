/**
 * Pass2b: 呼び出しグラフ構築（design.md「resolver/callGraph(Pass2b)」, Requirements 3.1, 3.2, 3.3）。
 *
 * ルートハンドラを起点に、各関数本体の呼び出し式（`callExpressions`）を
 * 「関数定義レジストリ（`functionDefinitions`）」「symbolTable の import 束縛」「ModuleMap」を
 * 用いて呼び出し先 FunctionNode id へ解決しながら、関数単位グラフを DFS で再帰構築する。
 *
 * - `backend/` 外（外部ライブラリ・stdlib）への呼び出し、および解決不能な callee は **終端**
 *   として `calls` に含めない（Requirement 3.3）。
 * - 同一関数 id は 1 回のみ訪問する（循環呼び出しでも無限再帰しない）。複数ハンドラから
 *   到達可能な関数は 1 度だけノード化される。
 * - `deriveFileGraph` は関数単位グラフから、各関数の `file` → 呼び出し先関数の `file` 集合を
 *   集約してファイル単位依存グラフを導出する（自己依存は除外, Requirement 3.2）。
 *
 * symbolTable 入手についての設計判断（routePaths(Pass2a) と同様）: `FileExtractionResult` は
 * tree も symbolTable も保持しないため、import 経由 callee の解決には symbolTable が必要。
 * 呼び出し側（Pass オーケストレーション=4.2）がファイルごとに 1 回構築して
 * `symbolTables: Map<fileId, Map<name, Binding>>` を注入する。本 resolver は純関数として動作する。
 *
 * entryHandlers パラメータについて: 起点ハンドラは `perFile` の各ファイルの `routes` から
 * 直接導出する（RouteCandidate は自身の fileId を持たないため、perFile の走査で fileId を確定
 * できる）。API 対称性・明示的な起点集合のため `entryHandlers` は受け取るが、起点 fileId の確定は
 * perFile 側で行い、`entryHandlers` に含まれる qualname のみを起点としてフィルタする。
 */
import type { FileExtractionResult, RouteCandidate } from "../extractFile.js";
import type { FunctionDefinitionEntry } from "../extractFile.js";
import { makeFunctionId } from "../ids.js";
import type { ModuleMap } from "../moduleMap.js";
import { isInternalModule } from "../moduleMap.js";
import type { FileNode, FunctionNode } from "../models.js";
import type { Binding } from "../symbolTable.js";
import { resolveName } from "../symbolTable.js";

import { resolveImportQualifiedName } from "./imports.js";

/** 関数定義レジストリの索引エントリ（id → 所属ファイルと定義エントリ）。 */
interface IndexedFunction {
  fileId: string;
  entry: FunctionDefinitionEntry;
}

/**
 * 全ファイルの `functionDefinitions` を関数 id でキー化した検索索引を構築する。
 * id = `makeFunctionId(map.pathToModule.get(fileId), entry.qualname)`。
 * モジュール解決できないファイル（pathToModule 未登録）の定義は索引化しない。
 */
function buildFunctionIndex(
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
): Map<string, IndexedFunction> {
  const index = new Map<string, IndexedFunction>();
  for (const [fileId, file] of perFile) {
    const moduleDotted = map.pathToModule.get(fileId);
    if (moduleDotted === undefined) {
      continue;
    }
    for (const entry of file.functionDefinitions) {
      const id = makeFunctionId(moduleDotted, entry.qualname);
      if (!index.has(id)) {
        index.set(id, { fileId, entry });
      }
    }
  }
  return index;
}

/** `calleeName` の先頭セグメント（ドット式なら head 識別子）を返す。 */
function headSegment(calleeName: string): string {
  const dot = calleeName.indexOf(".");
  return dot < 0 ? calleeName : calleeName.slice(0, dot);
}

/**
 * 呼び出し元ファイル内の同一ファイルローカル定義に `simpleName` が一致するなら、
 * その関数 id を返す（同名関数の id 化）。一致しなければ null。
 */
function resolveSameFile(
  simpleName: string,
  callerFileId: string,
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
): string | null {
  const file = perFile.get(callerFileId);
  const moduleDotted = map.pathToModule.get(callerFileId);
  if (file === undefined || moduleDotted === undefined) {
    return null;
  }
  const match = file.functionDefinitions.find((d) => d.name === simpleName);
  if (match === undefined) {
    return null;
  }
  return makeFunctionId(moduleDotted, match.qualname);
}

/**
 * import 束縛経由で callee を解決する。
 *
 * 1. 呼び出し元ファイルの symbolTable で head 名を引く。`import` 束縛でなければ解決不能。
 * 2. `resolveImportQualifiedName` で `{moduleDotted, name, targetFileId}` を得る。
 * 3. モジュールが内部でない（`isInternalModule` が false）／対象ファイルが無い場合は終端（null）。
 * 4. 対象ファイルの `functionDefinitions` から `name === importedName` を満たす定義を探し id 化。
 */
function resolveImported(
  calleeName: string,
  callerFileId: string,
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
  symbolTables: Map<string, Map<string, Binding>>,
): string | null {
  const table = symbolTables.get(callerFileId);
  if (table === undefined) {
    return null;
  }
  const head = headSegment(calleeName);
  const binding = resolveName(table, head);
  if (binding.kind !== "import") {
    return null;
  }

  const resolved = resolveImportQualifiedName(binding.qualifiedName, callerFileId, map);
  if (resolved.moduleDotted === null || !isInternalModule(map, resolved.moduleDotted)) {
    return null; // backend 外 → 終端（Requirement 3.3）。
  }
  if (resolved.targetFileId === null) {
    return null;
  }
  const targetFile = perFile.get(resolved.targetFileId);
  const targetModule = map.pathToModule.get(resolved.targetFileId);
  if (targetFile === undefined || targetModule === undefined) {
    return null;
  }
  // import される名前（例 `format_item_label`）に一致する定義を探す。
  const match = targetFile.functionDefinitions.find((d) => d.name === resolved.name);
  if (match === undefined) {
    return null;
  }
  return makeFunctionId(targetModule, match.qualname);
}

/**
 * 1 つの `calleeName` を呼び出し先 FunctionNode id へ解決する。解決できなければ null（終端）。
 *
 * - 単純名: 同一ファイルローカル定義を優先し、無ければ import 束縛経由で解決。
 * - ドット式（`obj.method` 等）: head が import 束縛なら import 解決を試みる。レシーバ型が
 *   静的に特定できないものは `functionDefinitions` に一意一致しなければ終端。
 */
function resolveCallee(
  calleeName: string,
  callerFileId: string,
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
  symbolTables: Map<string, Map<string, Binding>>,
): string | null {
  const isDotted = calleeName.includes(".");

  if (!isDotted) {
    const sameFile = resolveSameFile(calleeName, callerFileId, perFile, map);
    if (sameFile !== null) {
      return sameFile;
    }
  }
  return resolveImported(calleeName, callerFileId, perFile, map, symbolTables);
}

/**
 * ハンドラ起点の関数単位呼び出しグラフを構築する（Pass2b）。
 *
 * @param entryHandlers 起点ルートハンドラ候補（明示的な起点集合 / API 対称性のため受け取る）
 * @param perFile fileId → Pass1 抽出結果
 * @param map ModuleMap（モジュール↔fileId・内部判定）
 * @param symbolTables fileId → symbolTable（import 束縛経由 callee 解決に使用）
 */
export function buildCallGraph(
  entryHandlers: RouteCandidate[],
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
  symbolTables: Map<string, Map<string, Binding>>,
): FunctionNode[] {
  const index = buildFunctionIndex(perFile, map);

  // 起点ハンドラの qualname 集合（fileId は perFile 走査で確定する）。
  const entryQualnames = new Set(entryHandlers.map((h) => h.qualname));

  // 起点関数 id を確定する。基本は perFile の各ファイルの routes に含まれ、かつ
  // entryHandlers が指定した qualname に一致するものを起点とする。
  const entryIds: string[] = [];
  const seenEntries = new Set<string>();
  const addEntry = (id: string): void => {
    if (!seenEntries.has(id)) {
      seenEntries.add(id);
      entryIds.push(id);
    }
  };
  const matchedQualnames = new Set<string>();
  for (const [fileId, file] of perFile) {
    const moduleDotted = map.pathToModule.get(fileId);
    if (moduleDotted === undefined) {
      continue;
    }
    for (const route of file.routes) {
      if (entryQualnames.has(route.qualname)) {
        addEntry(makeFunctionId(moduleDotted, route.qualname));
        matchedQualnames.add(route.qualname);
      }
    }
  }

  // フォールバック: routes に現れない起点ハンドラ qualname は、関数定義レジストリ索引から
  // 一意一致する関数 id を起点とする（デコレータ以外の明示的な起点指定に対応）。
  for (const handler of entryHandlers) {
    if (matchedQualnames.has(handler.qualname)) {
      continue;
    }
    for (const [id, indexed] of index) {
      if (indexed.entry.qualname === handler.qualname) {
        addEntry(id);
      }
    }
  }

  const visited = new Set<string>();
  const nodes: FunctionNode[] = [];

  const visit = (functionId: string): void => {
    if (visited.has(functionId)) {
      return;
    }
    visited.add(functionId);

    const indexed = index.get(functionId);
    if (indexed === undefined) {
      return; // 定義が見つからない（理論上、起点が索引外）。
    }
    const { fileId, entry } = indexed;

    const calls: string[] = [];
    const seenCalls = new Set<string>();

    const file = perFile.get(fileId);
    const callExpressions = file?.callExpressions ?? [];
    for (const call of callExpressions) {
      if (call.callerQualname !== entry.qualname) {
        continue;
      }
      const targetId = resolveCallee(call.calleeName, fileId, perFile, map, symbolTables);
      if (targetId === null) {
        continue; // 終端（外部 / 未解決）。
      }
      if (!seenCalls.has(targetId)) {
        seenCalls.add(targetId);
        calls.push(targetId);
      }
    }

    nodes.push({
      id: functionId,
      name: entry.name,
      file: fileId,
      location: entry.location,
      calls,
    });

    for (const targetId of calls) {
      visit(targetId);
    }
  };

  for (const entryId of entryIds) {
    visit(entryId);
  }

  return nodes;
}

/**
 * 関数単位グラフからファイル単位依存グラフを導出する（Requirement 3.2）。
 *
 * 各関数の `file` から、その関数の呼び出し先関数の `file` を `dependsOn` に集約する。
 * 自己依存は除外し、重複は排除する。ファイル/依存先は決定性のため昇順ソートする。
 * 結果に含めるファイルは「関数ノードの `file`」に現れるもの全て（依存が空でもノード化する）。
 */
export function deriveFileGraph(functions: FunctionNode[]): FileNode[] {
  const idToFile = new Map<string, string>();
  for (const fn of functions) {
    idToFile.set(fn.id, fn.file);
  }

  const dependsByFile = new Map<string, Set<string>>();
  const ensure = (fileId: string): Set<string> => {
    let set = dependsByFile.get(fileId);
    if (set === undefined) {
      set = new Set<string>();
      dependsByFile.set(fileId, set);
    }
    return set;
  };

  for (const fn of functions) {
    const deps = ensure(fn.file);
    for (const calleeId of fn.calls) {
      const calleeFile = idToFile.get(calleeId);
      if (calleeFile === undefined || calleeFile === fn.file) {
        continue; // 解決先がノード化されていない / 自己依存は除外。
      }
      deps.add(calleeFile);
    }
  }

  const files: FileNode[] = [];
  for (const fileId of [...dependsByFile.keys()].sort()) {
    const deps = dependsByFile.get(fileId) ?? new Set<string>();
    files.push({
      id: fileId,
      path: fileId,
      dependsOn: [...deps].sort(),
    });
  }
  return files;
}
