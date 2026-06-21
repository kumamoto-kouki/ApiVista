/**
 * `projectDepth`の単体テスト(design.md「webview/projectDepth」, tasks.md 4.1)。
 *
 * 純粋関数のため`LinkageOutput`を型付きインラインリテラルで構築し、DOM/vscode依存なしで検証する。
 * 3深度(route/file/function)それぞれのノード/エッジ導出・未連携の識別・連携エッジの重複除去・
 * 参照整合性・決定的出力をカバーする(Requirements 3.2, 3.3, 4.2, 7.3)。
 */
import { describe, expect, it } from "vitest";

import type {
  ApiCallRef,
  LinkageOutput,
  LinkedFileNode,
  LinkedFunctionNode,
  RouteRef,
} from "../../../route-linkage/models.js";
import {
  findMatchingNodeIds,
  projectDepth,
  type Depth,
  type GraphEdge,
  type GraphNode,
} from "../projectDepth.js";

/** 全フィールドを持つ最小`LinkageOutput`を組み立てるヘルパー(各テストで必要な部分のみ上書き)。 */
function buildOutput(overrides: Partial<LinkageOutput>): LinkageOutput {
  return {
    schemaVersion: 1,
    linkages: [],
    unmatchedRoutes: [],
    unmatchedApiCalls: [],
    functions: [],
    files: [],
    warnings: [],
    ...overrides,
  };
}

function route(overrides: Partial<RouteRef> = {}): RouteRef {
  return {
    method: "GET",
    path: "/api/users/{id}",
    handler: { file: "backend/routes/users.ts", line: 10 },
    entryFunctionId: "backend:fn-getUser",
    schemaRefs: [],
    ...overrides,
  };
}

function apiCall(overrides: Partial<ApiCallRef> = {}): ApiCallRef {
  return {
    method: "GET",
    urlPattern: "/api/users/{}",
    enclosingFunctionId: "frontend:fn-fetchUser",
    location: { file: "frontend/api/users.ts", line: 5 },
    ...overrides,
  };
}

function fn(overrides: Partial<LinkedFunctionNode> = {}): LinkedFunctionNode {
  return {
    id: "backend:fn-getUser",
    side: "backend",
    name: "getUser",
    file: "backend:file-users",
    location: { file: "backend/routes/users.ts", line: 10 },
    calls: [],
    ...overrides,
  };
}

function file(overrides: Partial<LinkedFileNode> = {}): LinkedFileNode {
  return {
    id: "backend:file-users",
    side: "backend",
    path: "backend/routes/users.ts",
    dependsOn: [],
    ...overrides,
  };
}

/** 各エッジのsource/targetが、同じ深度で返されたnodesに存在することを検証する。 */
function assertReferentialIntegrity(nodes: GraphNode[], edges: GraphEdge[]): void {
  const ids = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    expect(ids.has(edge.source), `edge ${edge.id} source ${edge.source} missing from nodes`).toBe(
      true,
    );
    expect(ids.has(edge.target), `edge ${edge.id} target ${edge.target} missing from nodes`).toBe(
      true,
    );
  }
}

describe("projectDepth", () => {
  describe('depth="route"', () => {
    it("produces a node per linked route+apiCall and a linkage edge connecting them", () => {
      const output = buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      });

      const { nodes, edges } = projectDepth(output, "route");

      const routeNode = nodes.find((n) => n.kind === "route");
      const apiCallNode = nodes.find((n) => n.kind === "apiCall");
      expect(routeNode).toBeDefined();
      expect(apiCallNode).toBeDefined();
      expect(routeNode?.unmatched).toBe(false);
      expect(apiCallNode?.unmatched).toBe(false);
      expect(routeNode?.label).toContain("GET");
      expect(routeNode?.sourceLocation).toEqual({ file: "backend/routes/users.ts", line: 10 });
      expect(apiCallNode?.sourceLocation).toEqual({ file: "frontend/api/users.ts", line: 5 });

      expect(edges).toHaveLength(1);
      expect(edges[0].kind).toBe("linkage");
      expect(edges[0].source).toBe(routeNode?.id);
      expect(edges[0].target).toBe(apiCallNode?.id);

      assertReferentialIntegrity(nodes, edges);
    });

    it("includes unmatched routes as flagged nodes with no edge", () => {
      const output = buildOutput({
        unmatchedRoutes: [route({ method: "DELETE", path: "/api/users/{id}" })],
      });

      const { nodes, edges } = projectDepth(output, "route");

      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe("route");
      expect(nodes[0].unmatched).toBe(true);
      expect(edges).toHaveLength(0);
      assertReferentialIntegrity(nodes, edges);
    });

    it("includes unmatched apiCalls as flagged nodes with no edge", () => {
      const output = buildOutput({
        unmatchedApiCalls: [apiCall({ method: "POST", urlPattern: "/api/comments" })],
      });

      const { nodes, edges } = projectDepth(output, "route");

      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe("apiCall");
      expect(nodes[0].unmatched).toBe(true);
      expect(edges).toHaveLength(0);
      assertReferentialIntegrity(nodes, edges);
    });

    it("synthesizes deterministic ids for route/apiCall nodes across repeated calls", () => {
      const output = buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      });

      const first = projectDepth(output, "route");
      const second = projectDepth(output, "route");

      expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
    });
  });

  describe('depth="file"', () => {
    it("includes structural dependsOn edges", () => {
      const backendFile = file({
        id: "backend:file-a",
        path: "backend/a.ts",
        dependsOn: ["backend:file-b"],
      });
      const dependencyFile = file({ id: "backend:file-b", path: "backend/b.ts" });
      const output = buildOutput({ files: [backendFile, dependencyFile] });

      const { nodes, edges } = projectDepth(output, "file");

      expect(nodes).toHaveLength(2);
      expect(nodes.every((n) => n.kind === "file" && n.unmatched === false)).toBe(true);
      const structuralEdges = edges.filter((e) => e.kind === "structural");
      expect(structuralEdges).toHaveLength(1);
      expect(structuralEdges[0].source).toBe("backend:file-a");
      expect(structuralEdges[0].target).toBe("backend:file-b");
      assertReferentialIntegrity(nodes, edges);
    });

    it("projects a linkage between two functions in different files into one linkage edge", () => {
      const backendFn = fn({
        id: "backend:fn-getUser",
        file: "backend:file-users",
      });
      const frontendFn = fn({
        id: "frontend:fn-fetchUser",
        side: "frontend",
        file: "frontend:file-users-api",
      });
      const backendFile = file({ id: "backend:file-users", path: "backend/routes/users.ts" });
      const frontendFile = file({
        id: "frontend:file-users-api",
        side: "frontend",
        path: "frontend/api/users.ts",
      });

      const output = buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
        functions: [backendFn, frontendFn],
        files: [backendFile, frontendFile],
      });

      const { nodes, edges } = projectDepth(output, "file");

      const linkageEdges = edges.filter((e) => e.kind === "linkage");
      expect(linkageEdges).toHaveLength(1);
      expect([linkageEdges[0].source, linkageEdges[0].target].sort()).toEqual(
        ["backend:file-users", "frontend:file-users-api"].sort(),
      );
      assertReferentialIntegrity(nodes, edges);
    });

    it("omits a structural edge whose dependsOn target does not exist in files", () => {
      const backendFile = file({
        id: "backend:file-a",
        path: "backend/a.ts",
        dependsOn: ["backend:file-missing"],
      });
      const output = buildOutput({ files: [backendFile] });

      const { nodes, edges } = projectDepth(output, "file");

      expect(nodes).toHaveLength(1);
      expect(nodes.some((n) => n.id === "backend:file-missing")).toBe(false);
      const structuralEdges = edges.filter((e) => e.kind === "structural");
      expect(structuralEdges).toHaveLength(0);
      expect(edges.some((e) => e.target === "backend:file-missing")).toBe(false);
      assertReferentialIntegrity(nodes, edges);
    });

    it("dedupes two linkages that resolve to the same file pair into a single edge", () => {
      const backendFn = fn({ id: "backend:fn-getUser", file: "backend:file-users" });
      const backendFn2 = fn({
        id: "backend:fn-listUsers",
        file: "backend:file-users",
        name: "listUsers",
      });
      const frontendFn = fn({
        id: "frontend:fn-fetchUser",
        side: "frontend",
        file: "frontend:file-users-api",
      });
      const frontendFn2 = fn({
        id: "frontend:fn-fetchUsers",
        side: "frontend",
        name: "fetchUsers",
        file: "frontend:file-users-api",
      });
      const backendFile = file({ id: "backend:file-users", path: "backend/routes/users.ts" });
      const frontendFile = file({
        id: "frontend:file-users-api",
        side: "frontend",
        path: "frontend/api/users.ts",
      });

      const output = buildOutput({
        linkages: [
          {
            route: route({ entryFunctionId: "backend:fn-getUser" }),
            apiCall: apiCall({ enclosingFunctionId: "frontend:fn-fetchUser" }),
            matchKind: "exact",
          },
          {
            route: route({ entryFunctionId: "backend:fn-listUsers", path: "/api/users" }),
            apiCall: apiCall({
              enclosingFunctionId: "frontend:fn-fetchUsers",
              urlPattern: "/api/users",
            }),
            matchKind: "exact",
          },
        ],
        functions: [backendFn, backendFn2, frontendFn, frontendFn2],
        files: [backendFile, frontendFile],
      });

      const { nodes, edges } = projectDepth(output, "file");

      const linkageEdges = edges.filter((e) => e.kind === "linkage");
      expect(linkageEdges).toHaveLength(1);
      assertReferentialIntegrity(nodes, edges);
    });
  });

  describe('depth="function"', () => {
    it("includes structural calls edges", () => {
      const callerFn = fn({ id: "backend:fn-a", name: "a", calls: ["backend:fn-b"] });
      const calleeFn = fn({ id: "backend:fn-b", name: "b" });
      const output = buildOutput({ functions: [callerFn, calleeFn] });

      const { nodes, edges } = projectDepth(output, "function");

      expect(nodes).toHaveLength(2);
      expect(nodes.every((n) => n.kind === "function" && n.unmatched === false)).toBe(true);
      const structuralEdges = edges.filter((e) => e.kind === "structural");
      expect(structuralEdges).toHaveLength(1);
      expect(structuralEdges[0].source).toBe("backend:fn-a");
      expect(structuralEdges[0].target).toBe("backend:fn-b");
      assertReferentialIntegrity(nodes, edges);
    });

    it("omits a structural edge whose calls target does not exist in functions", () => {
      const callerFn = fn({ id: "backend:fn-a", name: "a", calls: ["backend:fn-missing"] });
      const output = buildOutput({ functions: [callerFn] });

      const { nodes, edges } = projectDepth(output, "function");

      expect(nodes).toHaveLength(1);
      expect(nodes.some((n) => n.id === "backend:fn-missing")).toBe(false);
      const structuralEdges = edges.filter((e) => e.kind === "structural");
      expect(structuralEdges).toHaveLength(0);
      expect(edges.some((e) => e.target === "backend:fn-missing")).toBe(false);
      assertReferentialIntegrity(nodes, edges);
    });

    it("connects entryFunctionId<->enclosingFunctionId directly via a linkage edge", () => {
      const backendFn = fn({ id: "backend:fn-getUser" });
      const frontendFn = fn({ id: "frontend:fn-fetchUser", side: "frontend", name: "fetchUser" });
      const output = buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
        functions: [backendFn, frontendFn],
      });

      const { nodes, edges } = projectDepth(output, "function");

      const linkageEdges = edges.filter((e) => e.kind === "linkage");
      expect(linkageEdges).toHaveLength(1);
      expect([linkageEdges[0].source, linkageEdges[0].target].sort()).toEqual(
        ["backend:fn-getUser", "frontend:fn-fetchUser"].sort(),
      );
      assertReferentialIntegrity(nodes, edges);
    });

    it("dedupes two linkages resolving to the same function pair into a single edge", () => {
      const backendFn = fn({ id: "backend:fn-getUser" });
      const frontendFn = fn({ id: "frontend:fn-fetchUser", side: "frontend", name: "fetchUser" });
      const output = buildOutput({
        linkages: [
          { route: route(), apiCall: apiCall(), matchKind: "exact" },
          {
            route: route({ path: "/api/users/{id}/profile" }),
            apiCall: apiCall(),
            matchKind: "exact",
          },
        ],
        functions: [backendFn, frontendFn],
      });

      const { edges } = projectDepth(output, "function");

      const linkageEdges = edges.filter((e) => e.kind === "linkage");
      expect(linkageEdges).toHaveLength(1);
    });
  });

  describe("determinism", () => {
    const depths: Depth[] = ["route", "file", "function"];

    it.each(depths)("produces identical output across repeated calls for depth=%s", (depth) => {
      const backendFn = fn({ id: "backend:fn-getUser", file: "backend:file-users" });
      const frontendFn = fn({
        id: "frontend:fn-fetchUser",
        side: "frontend",
        file: "frontend:file-users-api",
      });
      const backendFile = file({ id: "backend:file-users", path: "backend/routes/users.ts" });
      const frontendFile = file({
        id: "frontend:file-users-api",
        side: "frontend",
        path: "frontend/api/users.ts",
      });

      const output = buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
        unmatchedRoutes: [route({ method: "DELETE", path: "/api/users/{id}" })],
        unmatchedApiCalls: [apiCall({ method: "POST", urlPattern: "/api/comments" })],
        functions: [backendFn, frontendFn],
        files: [backendFile, frontendFile],
      });

      const first = projectDepth(output, depth);
      const second = projectDepth(output, depth);

      expect(first).toEqual(second);
    });
  });
});

describe("findMatchingNodeIds", () => {
  function node(overrides: Partial<GraphNode> = {}): GraphNode {
    return {
      id: "n1",
      kind: "route",
      label: "GET /api/users/{id}",
      unmatched: false,
      ...overrides,
    };
  }

  it("matches a route/apiCall node whose label contains the bare path as a substring", () => {
    const nodes = [node({ id: "route:1", label: "GET /api/users/{id}" })];

    expect(findMatchingNodeIds("/api/users/{id}", nodes)).toEqual(["route:1"]);
  });

  it("matches a file node whose label equals the warning target exactly", () => {
    const nodes = [node({ id: "file:1", kind: "file", label: "routers/broken.py" })];

    expect(findMatchingNodeIds("routers/broken.py", nodes)).toEqual(["file:1"]);
  });

  it("returns all matching node ids when multiple nodes share the same path", () => {
    const nodes = [
      node({ id: "route:1", label: "GET /api/users" }),
      node({ id: "route:2", kind: "apiCall", label: "GET /api/users" }),
      node({ id: "route:3", label: "GET /api/orders" }),
    ];

    expect(findMatchingNodeIds("/api/users", nodes)).toEqual(["route:1", "route:2"]);
  });

  it("returns an empty array when no node label contains the target", () => {
    const nodes = [node({ id: "route:1", label: "GET /api/users" })];

    expect(findMatchingNodeIds("/api/unknown", nodes)).toEqual([]);
  });
});
