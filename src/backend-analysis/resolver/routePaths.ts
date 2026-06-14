/**
 * Pass2a: ルートパス解決（design.md「resolver/routePaths(Pass2a)」, Requirements 1.2, 1.3, 5.2, 5.3）。
 *
 * 全ファイルの `fastapiInstances` を集約し、`FastAPI()` 起点が一意か判定する（0/複数件は
 * 警告 + 全ルート除外 = 5.2/5.3）。一意な起点ファイルから `include_router` を BFS で辿り、
 * 各 `routerExpr`（例 `items.router`）を対象ファイルの `RouterDefinition` へ解決しつつ
 * prefix を連結する。循環は訪問済み集合で打ち切り、無限ループしない。
 *
 * 確定ルートには連結 prefix + 候補 path を完全パスとして与え、`makeFunctionId` で
 * `entryFunctionId` を採番した `RouteDefinition` を生成する。`schemaRefs` は空配列で、
 * Pass2c/Assembler が後段でマージする。
 *
 * symbolTable 入手についての設計判断（CONCERNS にも記載）: `FileExtractionResult` は tree も
 * symbolTable も保持しないため、`routerExpr` の head 識別子（import 束縛）を解決するには
 * symbolTable が必要。これを呼び出し側（Pass オーケストレーション=4.2）がファイルごとに 1 回
 * 構築して `symbolTables: Map<fileId, Map<name, Binding>>` として注入する。本 resolver は
 * これを受け取り純関数として動作する。
 */
import type { FileExtractionResult, RouteCandidate } from "../extractFile.js";
import { makeFunctionId } from "../ids.js";
import type { ModuleMap } from "../moduleMap.js";
import type { RouteDefinition } from "../models.js";
import type { Binding } from "../symbolTable.js";
import type { WarningCollector } from "../warnings.js";

import { resolveImportQualifiedName } from "./imports.js";

/**
 * 連結済み prefix を正規化する。空セグメントは無視し、`/` の重複を畳む。
 *
 * - `["/api", "/items", "/{item_id}"]` → `/api/items/{item_id}`
 * - `["/api", "/items", ""]` → `/api/items`
 * - `["", "/users", "/{user_id}"]` → `/users/{user_id}`
 */
function joinPath(segments: string[]): string {
  const joined = segments.filter((s) => s.length > 0).join("");
  if (joined.length === 0) {
    return "/";
  }
  return joined;
}

/**
 * `routerExpr`（例 `items.router`）を head 識別子 + attribute（例 `items` / `router`）に分割する。
 * ドットを含まない単純名は attribute を `null` とする。
 */
function splitRouterExpr(routerExpr: string): { head: string; attribute: string | null } {
  const dot = routerExpr.indexOf(".");
  if (dot < 0) {
    return { head: routerExpr, attribute: null };
  }
  const head = routerExpr.slice(0, dot);
  const attribute = routerExpr.slice(dot + 1);
  return { head, attribute };
}

/**
 * ある起点ファイル上の `routerExpr` を、対象ファイルの `RouterDefinition` へ解決する。
 *
 * head 識別子を起点ファイルの symbolTable で引き、`import` 束縛（モジュール import）なら
 * `resolveImportQualifiedName` で対象 fileId を得る。対象ファイルの `RouterDefinition` のうち
 * `variableName === attribute`（例 `router`）を見つけ、その fileId と自身の prefix を返す。
 */
function resolveRouterExpr(
  routerExpr: string,
  originFileId: string,
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
  symbolTables: Map<string, Map<string, Binding>>,
): { fileId: string; routerPrefix: string } | null {
  const { head, attribute } = splitRouterExpr(routerExpr);
  if (attribute === null) {
    return null;
  }

  const table = symbolTables.get(originFileId);
  if (table === undefined) {
    return null;
  }
  const binding = table.get(head);
  if (binding === undefined || binding.kind !== "import") {
    return null;
  }

  const resolved = resolveImportQualifiedName(binding.qualifiedName, originFileId, map);
  if (resolved.targetFileId === null) {
    return null;
  }

  const targetFile = perFile.get(resolved.targetFileId);
  if (targetFile === undefined) {
    return null;
  }
  const routerDef = targetFile.routers.find((r) => r.variableName === attribute);
  if (routerDef === undefined) {
    return null;
  }
  return { fileId: resolved.targetFileId, routerPrefix: routerDef.prefix };
}

/**
 * 起点 FastAPI 変数から `include_router` チェーンを BFS し、到達した各ルーターファイルへ
 * 連結 prefix を割り当てる。循環は訪問済みファイル集合で打ち切る。
 *
 * @returns fileId → 起点からの連結 prefix。
 */
function bfsRouterPrefixes(
  originFileId: string,
  originVarName: string,
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
  symbolTables: Map<string, Map<string, Binding>>,
  collector: WarningCollector,
): Map<string, string> {
  const prefixByFile = new Map<string, string>();
  const visited = new Set<string>();

  // キュー要素: 「include_router を持つファイル」と「そのファイルへ至るまでの連結 prefix」と
  // 「そのファイル内で対象とする変数名（起点ファイルでは FastAPI 変数、ルーターファイルでは router 変数）」。
  interface Frame {
    fileId: string;
    accumulatedPrefix: string;
    targetVarName: string;
  }
  const queue: Frame[] = [
    { fileId: originFileId, accumulatedPrefix: "", targetVarName: originVarName },
  ];

  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined) {
      break;
    }
    const file = perFile.get(frame.fileId);
    if (file === undefined) {
      continue;
    }

    for (const call of file.includeRouterCalls) {
      if (call.targetName !== frame.targetVarName) {
        continue;
      }
      const resolved = resolveRouterExpr(call.routerExpr, frame.fileId, perFile, map, symbolTables);
      if (resolved === null) {
        collector.record(
          `${frame.fileId}:include_router(${call.routerExpr})`,
          "router expression could not be resolved to a router definition",
        );
        continue;
      }

      const fullPrefix = `${frame.accumulatedPrefix}${call.prefix}${resolved.routerPrefix}`;
      // 循環打ち切り: 既に訪問済みのルーターファイルは再展開しない。
      if (visited.has(resolved.fileId)) {
        continue;
      }
      visited.add(resolved.fileId);
      prefixByFile.set(resolved.fileId, fullPrefix);

      // 対象ファイルがさらに sub-router を include する場合に備えて BFS を継続する。
      // ルーターファイル内では対象変数名はその router 変数（attribute）。
      const attribute = splitRouterExpr(call.routerExpr).attribute;
      if (attribute !== null) {
        queue.push({
          fileId: resolved.fileId,
          accumulatedPrefix: fullPrefix,
          targetVarName: attribute,
        });
      }
    }
  }

  return prefixByFile;
}

/**
 * FastAPI 起点のルートパスを解決する（Pass2a）。
 *
 * @param perFile fileId → Pass1 抽出結果
 * @param map ModuleMap（モジュール↔fileId・内部判定）
 * @param collector 警告コレクター（起点不定・未解決ルートを記録）
 * @param symbolTables fileId → symbolTable（`routerExpr` head の import 束縛解決に使用）
 */
export function resolveRoutePaths(
  perFile: Map<string, FileExtractionResult>,
  map: ModuleMap,
  collector: WarningCollector,
  symbolTables: Map<string, Map<string, Binding>>,
): RouteDefinition[] {
  // 1. FastAPI() 起点を集約し一意性を判定する。
  const instances: { fileId: string; variableName: string }[] = [];
  for (const [fileId, file] of perFile) {
    for (const inst of file.fastapiInstances) {
      instances.push({ fileId, variableName: inst.variableName });
    }
  }

  if (instances.length !== 1) {
    collector.record(
      "FastAPI()",
      instances.length === 0
        ? "no FastAPI() instance found; all routes unresolved"
        : `multiple FastAPI() instances found (${String(instances.length)}); all routes unresolved`,
    );
    return [];
  }

  const origin = instances[0];
  if (origin === undefined) {
    return [];
  }

  // 2. 起点から include_router を BFS し、各ルーターファイルの連結 prefix を求める。
  const prefixByFile = bfsRouterPrefixes(
    origin.fileId,
    origin.variableName,
    perFile,
    map,
    symbolTables,
    collector,
  );

  // 3. 各ルーターファイル + 起点ファイル自身の直接ルートから RouteDefinition を生成する。
  const routes: RouteDefinition[] = [];

  const emitRoutes = (fileId: string, prefix: string): void => {
    const file = perFile.get(fileId);
    if (file === undefined) {
      return;
    }
    const moduleDotted = map.pathToModule.get(fileId);
    if (moduleDotted === undefined) {
      // モジュール解決できないファイルのルートは確定不能 → 除外 + 警告。
      for (const candidate of file.routes) {
        collector.record(
          `${fileId}:${candidate.handlerName}`,
          "route file has no module mapping; route excluded",
        );
      }
      return;
    }
    for (const candidate of file.routes) {
      routes.push(toRouteDefinition(candidate, prefix, moduleDotted));
    }
  };

  // 起点ファイル自身の直接ルート（app.get(...) 等）は prefix なし。
  emitRoutes(origin.fileId, "");

  for (const [fileId, prefix] of prefixByFile) {
    emitRoutes(fileId, prefix);
  }

  return routes;
}

/** 1 つの RouteCandidate を完全パス付き RouteDefinition へ変換する。 */
function toRouteDefinition(
  candidate: RouteCandidate,
  prefix: string,
  moduleDotted: string,
): RouteDefinition {
  return {
    method: candidate.method,
    path: joinPath([prefix, candidate.path]),
    handler: candidate.location,
    entryFunctionId: makeFunctionId(moduleDotted, candidate.qualname),
    schemaRefs: [],
  };
}
