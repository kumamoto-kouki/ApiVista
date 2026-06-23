/**
 * 連携構築(design.md「matcher.ts(連携構築)」、Req2.1/2.4, 3.1-3.4, 4.1/4.2)。
 *
 * 各 frontend `ApiCall` を全 backend `RouteDefinition` と照合し、`methodEquals` かつ
 * `pathMatch.matchKind` が non-null の組を候補とする。
 *
 * - **exact 優先**: ある apiCall に exact 一致が1つ以上あれば、その apiCall の suffix 一致は
 *   全て抑制(出力せず diagnostics に `suffix-suppressed` を記録)し、exact 一致のみを連携として
 *   採用する(複数あれば全保持)。exact が無ければ suffix 一致を採用する(多重一致は全保持=Req3.1)。
 * - 採用一致が複数件ある場合は `multiple-route-match` を診断記録する(Req3.4)。
 * - 一致0件の apiCall/route はそれぞれ `unmatchedApiCalls`/`unmatchedRoutes` に保持し、
 *   `unmatched-api-call`/`unmatched-route` を診断記録する(Req3.2/3.3)。
 * - `RouteRef.schemaRefs` は表示用付帯として素通しするのみで、絞り込みには使用しない(Req4.1/4.2)。
 * - `entryFunctionId`/`enclosingFunctionId` は `ids.namespaceId` で名前空間化して格納する。
 *
 * 診断 `Warning` の規約: `target` = 対象 apiCall の `urlPattern` または対象 route の `path`、
 * `reason` = 機械可読な分類タグ。
 */
import type { RouteDefinition } from "../backend-analysis/models.js";
import type { ApiCall } from "../frontend-analysis/models.js";
import { namespaceId } from "./ids.js";
import type { ApiCallRef, MatchKind, RouteLinkage, RouteRef, Warning } from "./models.js";
import { canonicalize, matchKindSegs } from "./pathMatch.js";

export interface MatchResult {
  linkages: RouteLinkage[];
  unmatchedRoutes: RouteRef[];
  unmatchedApiCalls: ApiCallRef[];
  diagnostics: Warning[];
}

function toRouteRef(route: RouteDefinition): RouteRef {
  return {
    method: route.method,
    path: route.path,
    handler: route.handler,
    entryFunctionId: namespaceId("backend", route.entryFunctionId),
    schemaRefs: route.schemaRefs,
  };
}

function toApiCallRef(apiCall: ApiCall): ApiCallRef {
  return {
    method: apiCall.method,
    urlPattern: apiCall.urlPattern,
    enclosingFunctionId: namespaceId("frontend", apiCall.enclosingFunctionId),
    location: apiCall.location,
  };
}

/**
 * backend のルート定義一覧と frontend の API 呼び出し一覧を照合し、連携・未連携・診断を構築する。
 */
export function matchRoutes(
  routes: readonly RouteDefinition[],
  apiCalls: readonly ApiCall[],
): MatchResult {
  const linkages: RouteLinkage[] = [];
  const diagnostics: Warning[] = [];
  const unmatchedApiCalls: ApiCallRef[] = [];
  const matchedRouteIndices = new Set<number>();

  // route/apiCall を1回だけ正準化・メソッド正規化しておき、N×M ループでの
  // 再計算（canonicalize / toUpperCase の重複）を回避する。出力は不変。
  const routeSegs = routes.map((r) => canonicalize(r.path));
  const routeMethodUpper = routes.map((r) => r.method.toUpperCase());
  const apiSegs = apiCalls.map((c) => canonicalize(c.urlPattern));
  const apiMethodUpper = apiCalls.map((c) => c.method.toUpperCase());

  apiCalls.forEach((apiCall, apiIndex) => {
    const exactIndices: number[] = [];
    const suffixIndices: number[] = [];
    routes.forEach((_route, index) => {
      if (routeMethodUpper[index] !== apiMethodUpper[apiIndex]) {
        return;
      }
      const kind = matchKindSegs(routeSegs[index], apiSegs[apiIndex]);
      if (kind === "exact") {
        exactIndices.push(index);
      } else if (kind === "suffix") {
        suffixIndices.push(index);
      }
    });

    if (exactIndices.length > 0 && suffixIndices.length > 0) {
      diagnostics.push({ target: apiCall.urlPattern, reason: "suffix-suppressed" });
    }

    const chosenIndices = exactIndices.length > 0 ? exactIndices : suffixIndices;
    const chosenKind: MatchKind = exactIndices.length > 0 ? "exact" : "suffix";

    if (chosenIndices.length === 0) {
      unmatchedApiCalls.push(toApiCallRef(apiCall));
      diagnostics.push({ target: apiCall.urlPattern, reason: "unmatched-api-call" });
      return;
    }

    if (chosenIndices.length > 1) {
      diagnostics.push({ target: apiCall.urlPattern, reason: "multiple-route-match" });
    }

    for (const index of chosenIndices) {
      matchedRouteIndices.add(index);
      linkages.push({
        route: toRouteRef(routes[index]),
        apiCall: toApiCallRef(apiCall),
        matchKind: chosenKind,
      });
    }
  });

  const unmatchedRoutes: RouteRef[] = [];
  routes.forEach((route, index) => {
    if (!matchedRouteIndices.has(index)) {
      unmatchedRoutes.push(toRouteRef(route));
      diagnostics.push({ target: route.path, reason: "unmatched-route" });
    }
  });

  return { linkages, unmatchedRoutes, unmatchedApiCalls, diagnostics };
}
