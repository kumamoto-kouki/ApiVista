import { describe, expect, it } from "vitest";

import type { ApiCall } from "../../frontend-analysis/models.js";
import type { RouteDefinition } from "../../backend-analysis/models.js";
import { matchRoutes } from "../matcher.js";

function route(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    method: "GET",
    path: "/api/users/{id}",
    handler: { file: "routers/users.py", line: 1 },
    entryFunctionId: "routers.users:get_user",
    schemaRefs: [],
    ...overrides,
  };
}

function apiCall(overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    method: "GET",
    urlPattern: "/api/users/{}",
    enclosingFunctionId: "composables/useUser:fetchUser",
    location: { file: "composables/useUser.ts", line: 1 },
    ...overrides,
  };
}

describe("matchRoutes", () => {
  it("returns an empty result for empty inputs", () => {
    const result = matchRoutes([], []);
    expect(result).toEqual({
      linkages: [],
      unmatchedRoutes: [],
      unmatchedApiCalls: [],
      diagnostics: [],
    });
  });

  it("links a single exact match and namespaces the function ids", () => {
    const result = matchRoutes([route()], [apiCall()]);
    expect(result.linkages).toHaveLength(1);
    const [linkage] = result.linkages;
    expect(linkage.matchKind).toBe("exact");
    expect(linkage.route.entryFunctionId).toBe("backend:routers.users:get_user");
    expect(linkage.apiCall.enclosingFunctionId).toBe("frontend:composables/useUser:fetchUser");
    expect(result.unmatchedRoutes).toEqual([]);
    expect(result.unmatchedApiCalls).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not match when methods differ even if paths align", () => {
    const result = matchRoutes([route({ method: "GET" })], [apiCall({ method: "POST" })]);
    expect(result.linkages).toEqual([]);
    expect(result.unmatchedRoutes).toHaveLength(1);
    expect(result.unmatchedApiCalls).toHaveLength(1);
  });

  it("keeps all suffix matches when one api call matches multiple routes (Req3.1 multiplicity)", () => {
    const v1 = route({
      path: "/v1/orders/{id}",
      entryFunctionId: "routers.orders_v1:get_order",
    });
    const v2 = route({
      path: "/v2/orders/{id}",
      entryFunctionId: "routers.orders_v2:get_order",
    });
    const call = apiCall({ urlPattern: "/orders/{}" });
    const result = matchRoutes([v1, v2], [call]);
    expect(result.linkages).toHaveLength(2);
    expect(result.linkages.every((l) => l.matchKind === "suffix")).toBe(true);
    expect(result.diagnostics).toEqual([{ target: "/orders/{}", reason: "multiple-route-match" }]);
    expect(result.unmatchedRoutes).toEqual([]);
    expect(result.unmatchedApiCalls).toEqual([]);
  });

  it("keeps multiple exact matches and still records multiple-route-match", () => {
    const a = route({ entryFunctionId: "routers.users:get_user_a" });
    const b = route({ entryFunctionId: "routers.users:get_user_b" });
    const result = matchRoutes([a, b], [apiCall()]);
    expect(result.linkages).toHaveLength(2);
    expect(result.linkages.every((l) => l.matchKind === "exact")).toBe(true);
    expect(result.diagnostics).toEqual([
      { target: "/api/users/{}", reason: "multiple-route-match" },
    ]);
  });

  it("prefers exact and suppresses suffix for the same api call, leaving the suffix route unmatched", () => {
    const exactRoute = route({ entryFunctionId: "routers.users:get_user" });
    const suffixOnlyRoute = route({
      path: "/external/api/users/{id}",
      entryFunctionId: "routers.external:get_user",
    });
    const result = matchRoutes([exactRoute, suffixOnlyRoute], [apiCall()]);
    expect(result.linkages).toHaveLength(1);
    expect(result.linkages[0].matchKind).toBe("exact");
    expect(result.linkages[0].route.entryFunctionId).toBe("backend:routers.users:get_user");
    expect(result.unmatchedRoutes).toHaveLength(1);
    expect(result.unmatchedRoutes[0].path).toBe("/external/api/users/{id}");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { target: "/api/users/{}", reason: "suffix-suppressed" },
        { target: "/external/api/users/{id}", reason: "unmatched-route" },
      ]),
    );
  });

  it("records an unmatched api call with no matching route", () => {
    const call = apiCall({ method: "POST", urlPattern: "/api/comments" });
    const result = matchRoutes([route()], [call]);
    expect(result.linkages).toEqual([]);
    expect(result.unmatchedApiCalls).toHaveLength(1);
    expect(result.unmatchedApiCalls[0].urlPattern).toBe("/api/comments");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([{ target: "/api/comments", reason: "unmatched-api-call" }]),
    );
  });

  it("records an unmatched route with no matching api call", () => {
    const deleteRoute = route({ method: "DELETE", entryFunctionId: "routers.users:delete_user" });
    const result = matchRoutes([deleteRoute], [apiCall({ method: "GET" })]);
    expect(result.unmatchedRoutes).toHaveLength(1);
    expect(result.unmatchedRoutes[0].path).toBe("/api/users/{id}");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([{ target: "/api/users/{id}", reason: "unmatched-route" }]),
    );
  });

  it("excludes a pure-wildcard suffix candidate via the literal-required guard, leaving both sides unmatched", () => {
    const catchAll = route({ path: "/api/{id}", entryFunctionId: "routers.catchall:get_by_id" });
    const wildcardCall = apiCall({ urlPattern: "/{}" });
    const result = matchRoutes([catchAll], [wildcardCall]);
    expect(result.linkages).toEqual([]);
    expect(result.unmatchedRoutes).toHaveLength(1);
    expect(result.unmatchedApiCalls).toHaveLength(1);
  });

  it("attaches schemaRefs to the linked RouteRef for display without affecting matching (Req4.1/4.2)", () => {
    const schemaRefs = [
      {
        className: "UserOut",
        location: { file: "schemas/user.py", line: 5 },
        role: "response" as const,
      },
    ];
    const result = matchRoutes([route({ schemaRefs })], [apiCall()]);
    expect(result.linkages).toHaveLength(1);
    expect(result.linkages[0].route.schemaRefs).toEqual(schemaRefs);
  });
});
