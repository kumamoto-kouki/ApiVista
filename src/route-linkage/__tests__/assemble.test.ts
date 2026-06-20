import { describe, expect, it } from "vitest";

import { assembleLinkage } from "../assemble.js";
import type { MatchResult } from "../matcher.js";
import { SCHEMA_VERSION } from "../models.js";
import type {
  ApiCallRef,
  LinkedFileNode,
  LinkedFunctionNode,
  RouteRef,
  Warning,
} from "../models.js";

function routeRef(overrides: Partial<RouteRef> = {}): RouteRef {
  return {
    method: "GET",
    path: "/api/users/{id}",
    handler: { file: "routers/users.py", line: 1 },
    entryFunctionId: "backend:routers.users:get_user",
    schemaRefs: [],
    ...overrides,
  };
}

function apiCallRef(overrides: Partial<ApiCallRef> = {}): ApiCallRef {
  return {
    method: "GET",
    urlPattern: "/api/users/{}",
    enclosingFunctionId: "frontend:composables/useUser:fetchUser",
    location: { file: "composables/useUser.ts", line: 1 },
    ...overrides,
  };
}

const emptyMatch: MatchResult = {
  linkages: [],
  unmatchedRoutes: [],
  unmatchedApiCalls: [],
  diagnostics: [],
};

describe("assembleLinkage", () => {
  it("sets schemaVersion to SCHEMA_VERSION", () => {
    const output = assembleLinkage(emptyMatch, [], [], []);
    expect(output.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("aggregates inputWarnings followed by match diagnostics into warnings", () => {
    const inputWarnings: Warning[] = [{ target: "a.py", reason: "unsupported-decorator" }];
    const diagnostics: Warning[] = [{ target: "/orders/{}", reason: "multiple-route-match" }];
    const match: MatchResult = { ...emptyMatch, diagnostics };
    const output = assembleLinkage(match, [], [], inputWarnings);
    expect(output.warnings).toEqual([...inputWarnings, ...diagnostics]);
  });

  it("passes functions/files through sorted by id ascending", () => {
    const functions: LinkedFunctionNode[] = [
      {
        id: "frontend:b",
        side: "frontend",
        name: "b",
        file: "frontend:f.ts",
        location: { file: "f.ts", line: 1 },
        calls: [],
      },
      {
        id: "backend:a",
        side: "backend",
        name: "a",
        file: "backend:f.py",
        location: { file: "f.py", line: 1 },
        calls: [],
      },
    ];
    const files: LinkedFileNode[] = [
      { id: "frontend:f.ts", side: "frontend", path: "f.ts", dependsOn: [] },
      { id: "backend:f.py", side: "backend", path: "f.py", dependsOn: [] },
    ];
    const output = assembleLinkage(emptyMatch, functions, files, []);
    expect(output.functions.map((f) => f.id)).toEqual(["backend:a", "frontend:b"]);
    expect(output.files.map((f) => f.id)).toEqual(["backend:f.py", "frontend:f.ts"]);
  });

  it("sorts unmatchedRoutes by (method, path)", () => {
    const match: MatchResult = {
      ...emptyMatch,
      unmatchedRoutes: [
        routeRef({ method: "GET", path: "/zeta" }),
        routeRef({ method: "DELETE", path: "/alpha" }),
        routeRef({ method: "GET", path: "/alpha" }),
      ],
    };
    const output = assembleLinkage(match, [], [], []);
    expect(output.unmatchedRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /alpha",
      "GET /alpha",
      "GET /zeta",
    ]);
  });

  it("sorts unmatchedApiCalls by (location.file, location.line, urlPattern)", () => {
    const match: MatchResult = {
      ...emptyMatch,
      unmatchedApiCalls: [
        apiCallRef({ location: { file: "b.ts", line: 1 }, urlPattern: "/b" }),
        apiCallRef({ location: { file: "a.ts", line: 5 }, urlPattern: "/a5" }),
        apiCallRef({ location: { file: "a.ts", line: 2 }, urlPattern: "/a2" }),
      ],
    };
    const output = assembleLinkage(match, [], [], []);
    expect(output.unmatchedApiCalls.map((c) => c.urlPattern)).toEqual(["/a2", "/a5", "/b"]);
  });

  it("sorts linkages by (apiCall.location.file, line) then (route.method, route.path)", () => {
    const linkages = [
      {
        route: routeRef({ method: "GET", path: "/z" }),
        apiCall: apiCallRef({ location: { file: "b.ts", line: 1 } }),
        matchKind: "exact" as const,
      },
      {
        route: routeRef({ method: "POST", path: "/a" }),
        apiCall: apiCallRef({ location: { file: "a.ts", line: 9 } }),
        matchKind: "exact" as const,
      },
      {
        route: routeRef({ method: "GET", path: "/a" }),
        apiCall: apiCallRef({ location: { file: "a.ts", line: 9 } }),
        matchKind: "exact" as const,
      },
    ];
    const match: MatchResult = { ...emptyMatch, linkages };
    const output = assembleLinkage(match, [], [], []);
    expect(
      output.linkages.map(
        (l) =>
          `${l.apiCall.location.file}:${l.apiCall.location.line} ${l.route.method} ${l.route.path}`,
      ),
    ).toEqual(["a.ts:9 GET /a", "a.ts:9 POST /a", "b.ts:1 GET /z"]);
  });

  it("is deterministic: shuffling all input arrays yields an identical output", () => {
    const functionA: LinkedFunctionNode = {
      id: "backend:a",
      side: "backend",
      name: "a",
      file: "backend:f.py",
      location: { file: "f.py", line: 1 },
      calls: [],
    };
    const functionB: LinkedFunctionNode = {
      id: "frontend:b",
      side: "frontend",
      name: "b",
      file: "frontend:f.ts",
      location: { file: "f.ts", line: 1 },
      calls: [],
    };
    const fileA: LinkedFileNode = {
      id: "backend:f.py",
      side: "backend",
      path: "f.py",
      dependsOn: [],
    };
    const fileB: LinkedFileNode = {
      id: "frontend:f.ts",
      side: "frontend",
      path: "f.ts",
      dependsOn: [],
    };
    const linkage1 = {
      route: routeRef({ path: "/a" }),
      apiCall: apiCallRef({ location: { file: "a.ts", line: 1 } }),
      matchKind: "exact" as const,
    };
    const linkage2 = {
      route: routeRef({ path: "/b" }),
      apiCall: apiCallRef({ location: { file: "b.ts", line: 1 } }),
      matchKind: "exact" as const,
    };
    const unmatchedRouteA = routeRef({ method: "DELETE", path: "/x" });
    const unmatchedRouteB = routeRef({ method: "GET", path: "/y" });
    const unmatchedCallA = apiCallRef({ location: { file: "c.ts", line: 1 }, urlPattern: "/c" });
    const unmatchedCallB = apiCallRef({ location: { file: "d.ts", line: 1 }, urlPattern: "/d" });
    const warningA: Warning = { target: "x", reason: "unmatched-route" };
    const warningB: Warning = { target: "y", reason: "unmatched-api-call" };

    // diagnostics は design.md の正準ソート対象(linkages/unmatched*/functions/files)に
    // 含まれないため、shuffle 対象から外し両者で同順に保つ(warnings の順序保証は対象外)。
    const diagnostics = [warningA, warningB];

    const matchInOrder: MatchResult = {
      linkages: [linkage1, linkage2],
      unmatchedRoutes: [unmatchedRouteA, unmatchedRouteB],
      unmatchedApiCalls: [unmatchedCallA, unmatchedCallB],
      diagnostics,
    };
    const matchShuffled: MatchResult = {
      linkages: [linkage2, linkage1],
      unmatchedRoutes: [unmatchedRouteB, unmatchedRouteA],
      unmatchedApiCalls: [unmatchedCallB, unmatchedCallA],
      diagnostics,
    };

    const outputInOrder = assembleLinkage(matchInOrder, [functionA, functionB], [fileA, fileB], []);
    const outputShuffled = assembleLinkage(
      matchShuffled,
      [functionB, functionA],
      [fileB, fileA],
      [],
    );

    expect(outputShuffled).toEqual(outputInOrder);
  });

  it("threads references from linkage to route/apiCall to function to file", () => {
    const fn: LinkedFunctionNode = {
      id: "backend:routers.users:get_user",
      side: "backend",
      name: "get_user",
      file: "backend:routers/users.py",
      location: { file: "routers/users.py", line: 1 },
      calls: [],
    };
    const file: LinkedFileNode = {
      id: "backend:routers/users.py",
      side: "backend",
      path: "routers/users.py",
      dependsOn: [],
    };
    const match: MatchResult = {
      ...emptyMatch,
      linkages: [
        {
          route: routeRef({ entryFunctionId: "backend:routers.users:get_user" }),
          apiCall: apiCallRef(),
          matchKind: "exact",
        },
      ],
    };
    const output = assembleLinkage(match, [fn], [file], []);
    const [linkage] = output.linkages;
    const linkedFunction = output.functions.find((f) => f.id === linkage.route.entryFunctionId);
    expect(linkedFunction).toBeDefined();
    const linkedFile = output.files.find((f) => f.id === linkedFunction?.file);
    expect(linkedFile).toBeDefined();
  });
});
