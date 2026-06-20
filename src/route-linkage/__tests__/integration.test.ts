/**
 * 統合テスト(design.md「Testing Strategy」, タスク5.1)。
 *
 * `linkRoutes`(公開API)の出力を end-to-end で検証する。tests/fixtures/route-linkage/
 * の AnalysisOutput JSON ペア(タスク1.3)で表現できる観点はフィクスチャを使い、
 * フィクスチャでは表現していない観点(exact優先抑制・3階層参照貫通・決定的順序)は
 * 型付きインライン入力で補う(tasks.md 5.1: 「フィクスチャ(または型付きインライン入力)」)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AnalysisOutput as BackendAnalysisOutput } from "../../backend-analysis/models.js";
import type { AnalysisOutput as FrontendAnalysisOutput } from "../../frontend-analysis/models.js";
import { linkRoutes } from "../index.js";

const fixturesDir = fileURLToPath(
  new URL("../../../tests/fixtures/route-linkage/", import.meta.url),
);

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf-8")) as T;
}

describe("integration: linkRoutes over the route-linkage fixtures", () => {
  const backendFixture = readFixture<BackendAnalysisOutput>("backend.analysis.json");
  const frontendFixture = readFixture<FrontendAnalysisOutput>("frontend.analysis.json");
  const output = linkRoutes(backendFixture, frontendFixture);

  it("links an exact match (Req2.1/2.2)", () => {
    expect(
      output.linkages.some(
        (l) =>
          l.matchKind === "exact" &&
          l.route.path === "/api/users/{id}" &&
          l.apiCall.urlPattern === "/api/users/{}",
      ),
    ).toBe(true);
  });

  it("links a baseURL-diff suffix match (Req2.3)", () => {
    expect(
      output.linkages.some(
        (l) =>
          l.matchKind === "suffix" &&
          l.route.path === "/api/products" &&
          l.apiCall.urlPattern === "/products",
      ),
    ).toBe(true);
  });

  it("excludes the pure-wildcard apiCall and route via the literal-required guard (Req2.3)", () => {
    expect(output.unmatchedApiCalls.some((c) => c.urlPattern === "/{}")).toBe(true);
    expect(output.unmatchedRoutes.some((r) => r.path === "/api/{id}")).toBe(true);
    expect(output.linkages.some((l) => l.apiCall.urlPattern === "/{}")).toBe(false);
    expect(output.linkages.some((l) => l.route.path === "/api/{id}")).toBe(false);
  });

  it("keeps multiple suffix matches for one apiCall (Req3.1) and records the diagnostic (Req3.4)", () => {
    const orderLinkages = output.linkages.filter((l) => l.apiCall.urlPattern === "/orders/{}");
    expect(orderLinkages).toHaveLength(2);
    expect(orderLinkages.every((l) => l.matchKind === "suffix")).toBe(true);
    expect(orderLinkages.map((l) => l.route.path).sort()).toEqual([
      "/v1/orders/{id}",
      "/v2/orders/{id}",
    ]);
    expect(
      output.warnings.some((w) => w.target === "/orders/{}" && w.reason === "multiple-route-match"),
    ).toBe(true);
  });

  it("keeps unmatched routes and apiCalls on both sides (Req3.2/3.3)", () => {
    expect(
      output.unmatchedRoutes.some((r) => r.method === "DELETE" && r.path === "/api/users/{id}"),
    ).toBe(true);
    expect(
      output.unmatchedApiCalls.some((c) => c.method === "POST" && c.urlPattern === "/api/comments"),
    ).toBe(true);
  });

  it("attaches schemaRefs for display without using them to filter matches (Req4.1/4.2)", () => {
    const linkage = output.linkages.find((l) => l.route.path === "/api/users/{id}");
    expect(linkage?.route.schemaRefs.length).toBeGreaterThan(0);
    expect(linkage?.route.schemaRefs[0].className).toBe("UserOut");
  });

  it("aggregates both input warnings into the output (Req6.3)", () => {
    expect(output.warnings).toEqual(
      expect.arrayContaining([...backendFixture.warnings, ...frontendFixture.warnings]),
    );
  });

  it("returns linkages/unmatched* in canonical sort order regardless of fixture order (Req7.3)", () => {
    const linkageKeys = output.linkages.map(
      (l) =>
        `${l.apiCall.location.file}:${l.apiCall.location.line} ${l.route.method} ${l.route.path}`,
    );
    expect(linkageKeys).toEqual([...linkageKeys].sort());
    const unmatchedRouteKeys = output.unmatchedRoutes.map((r) => `${r.method} ${r.path}`);
    expect(unmatchedRouteKeys).toEqual([...unmatchedRouteKeys].sort());
  });
});

describe("integration: linkRoutes with inline input (scenarios not covered by the fixtures)", () => {
  it("prefers exact and suppresses suffix for the same apiCall, leaving the suffix-only route unmatched (Req2.4/3.4)", () => {
    const backend: BackendAnalysisOutput = {
      schemaVersion: 1,
      routes: [
        {
          method: "GET",
          path: "/api/users/{id}",
          handler: { file: "routers/users.py", line: 1 },
          entryFunctionId: "routers.users:get_user",
          schemaRefs: [],
        },
        {
          method: "GET",
          path: "/external/api/users/{id}",
          handler: { file: "routers/external.py", line: 1 },
          entryFunctionId: "routers.external:get_user",
          schemaRefs: [],
        },
      ],
      functions: [],
      files: [],
      warnings: [],
    };
    const frontend: FrontendAnalysisOutput = {
      schemaVersion: 1,
      apiCalls: [
        {
          method: "GET",
          urlPattern: "/api/users/{}",
          enclosingFunctionId: "composables/useUser:fetchUser",
          location: { file: "composables/useUser.ts", line: 1 },
        },
      ],
      functions: [],
      files: [],
      warnings: [],
    };

    const output = linkRoutes(backend, frontend);
    expect(output.linkages).toHaveLength(1);
    expect(output.linkages[0].matchKind).toBe("exact");
    expect(output.linkages[0].route.path).toBe("/api/users/{id}");
    expect(output.unmatchedRoutes.some((r) => r.path === "/external/api/users/{id}")).toBe(true);
    expect(
      output.warnings.some((w) => w.target === "/api/users/{}" && w.reason === "suffix-suppressed"),
    ).toBe(true);
  });

  it("threads references from linkage to route/apiCall to function to file through the public API (Req5.1/5.4/5.5)", () => {
    const backend: BackendAnalysisOutput = {
      schemaVersion: 1,
      routes: [
        {
          method: "GET",
          path: "/api/users/{id}",
          handler: { file: "routers/users.py", line: 10 },
          entryFunctionId: "routers.users:get_user",
          schemaRefs: [],
        },
      ],
      functions: [
        {
          id: "routers.users:get_user",
          name: "get_user",
          file: "routers/users.py",
          location: { file: "routers/users.py", line: 10 },
          calls: [],
        },
      ],
      files: [{ id: "routers/users.py", path: "routers/users.py", dependsOn: [] }],
      warnings: [],
    };
    const frontend: FrontendAnalysisOutput = {
      schemaVersion: 1,
      apiCalls: [
        {
          method: "GET",
          urlPattern: "/api/users/{}",
          enclosingFunctionId: "composables/useUser:fetchUser",
          location: { file: "composables/useUser.ts", line: 6 },
        },
      ],
      functions: [
        {
          id: "composables/useUser:fetchUser",
          name: "fetchUser",
          file: "composables/useUser.ts",
          location: { file: "composables/useUser.ts", line: 6 },
          calls: [],
        },
      ],
      files: [{ id: "composables/useUser.ts", path: "composables/useUser.ts", dependsOn: [] }],
      warnings: [],
    };

    const output = linkRoutes(backend, frontend);
    expect(output.linkages).toHaveLength(1);
    const [linkage] = output.linkages;

    const routeFn = output.functions.find((f) => f.id === linkage.route.entryFunctionId);
    expect(routeFn).toBeDefined();
    const routeFile = output.files.find((f) => f.id === routeFn?.file);
    expect(routeFile).toBeDefined();
    expect(routeFile?.path).toBe("routers/users.py");

    const apiCallFn = output.functions.find((f) => f.id === linkage.apiCall.enclosingFunctionId);
    expect(apiCallFn).toBeDefined();
    const apiCallFile = output.files.find((f) => f.id === apiCallFn?.file);
    expect(apiCallFile).toBeDefined();
    expect(apiCallFile?.path).toBe("composables/useUser.ts");
  });

  it("is deterministic: shuffling backend/frontend array order yields an identical LinkageOutput (Req7.3)", () => {
    function buildBackend(order: number[]): BackendAnalysisOutput {
      const routes = [
        {
          method: "GET",
          path: "/a",
          handler: { file: "a.py", line: 1 },
          entryFunctionId: "a:handler",
          schemaRefs: [],
        },
        {
          method: "GET",
          path: "/b",
          handler: { file: "b.py", line: 1 },
          entryFunctionId: "b:handler",
          schemaRefs: [],
        },
        {
          method: "GET",
          path: "/c",
          handler: { file: "c.py", line: 1 },
          entryFunctionId: "c:handler",
          schemaRefs: [],
        },
      ];
      return {
        schemaVersion: 1,
        routes: order.map((i) => routes[i]),
        functions: order
          .map((i) => routes[i])
          .map((r) => ({
            id: r.entryFunctionId,
            name: r.entryFunctionId,
            file: r.handler.file,
            location: r.handler,
            calls: [],
          })),
        files: order
          .map((i) => routes[i])
          .map((r) => ({
            id: r.handler.file,
            path: r.handler.file,
            dependsOn: [],
          })),
        warnings: [],
      };
    }
    function buildFrontend(order: number[]): FrontendAnalysisOutput {
      const calls = [
        {
          method: "GET",
          urlPattern: "/a",
          enclosingFunctionId: "fa:call",
          location: { file: "fa.ts", line: 1 },
        },
        {
          method: "GET",
          urlPattern: "/b",
          enclosingFunctionId: "fb:call",
          location: { file: "fb.ts", line: 1 },
        },
        {
          method: "GET",
          urlPattern: "/c",
          enclosingFunctionId: "fc:call",
          location: { file: "fc.ts", line: 1 },
        },
      ];
      return {
        schemaVersion: 1,
        apiCalls: order.map((i) => calls[i]),
        functions: order
          .map((i) => calls[i])
          .map((c) => ({
            id: c.enclosingFunctionId,
            name: c.enclosingFunctionId,
            file: c.location.file,
            location: c.location,
            calls: [],
          })),
        files: order
          .map((i) => calls[i])
          .map((c) => ({
            id: c.location.file,
            path: c.location.file,
            dependsOn: [],
          })),
        warnings: [],
      };
    }

    const outputInOrder = linkRoutes(buildBackend([0, 1, 2]), buildFrontend([0, 1, 2]));
    const outputShuffled = linkRoutes(buildBackend([2, 0, 1]), buildFrontend([1, 2, 0]));

    expect(outputShuffled).toEqual(outputInOrder);
    expect(outputInOrder.linkages).toHaveLength(3);
  });
});
