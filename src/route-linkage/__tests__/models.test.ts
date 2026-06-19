import { describe, expect, it } from "vitest";

import type {
  ApiCallRef,
  LinkageOutput,
  LinkedFileNode,
  LinkedFunctionNode,
  MatchKind,
  RouteLinkage,
  RouteRef,
  SchemaReference,
  Side,
  SourceLocation,
  Warning,
} from "../models.js";
import { SCHEMA_VERSION, isLinkageOutput } from "../models.js";

/** 完全な型チェックを通る最小限の有効な LinkageOutput リテラルを構築する。 */
function makeValidLinkageOutput(): LinkageOutput {
  const location: SourceLocation = { file: "src/api.ts", line: 10 };
  const schemaRef: SchemaReference = {
    className: "UserDto",
    location: { file: "src/dto.ts", line: 3 },
    role: "request",
  };
  const route: RouteRef = {
    method: "GET",
    path: "/api/users/{id}",
    handler: { file: "src/routes.ts", line: 5 },
    entryFunctionId: "backend:routes:getUser",
    schemaRefs: [schemaRef],
  };
  const apiCall: ApiCallRef = {
    method: "GET",
    urlPattern: "/users/{}",
    enclosingFunctionId: "frontend:api:fetchUser",
    location,
  };
  const matchKind: MatchKind = "suffix";
  const linkage: RouteLinkage = { route, apiCall, matchKind };
  const side: Side = "backend";
  const fn: LinkedFunctionNode = {
    id: "backend:routes:getUser",
    side,
    name: "getUser",
    file: "backend:src/routes.ts",
    location: { file: "src/routes.ts", line: 5 },
    calls: ["backend:routes:helper"],
  };
  const file: LinkedFileNode = {
    id: "backend:src/routes.ts",
    side,
    path: "src/routes.ts",
    dependsOn: ["backend:src/dto.ts"],
  };
  const warning: Warning = { target: "/users/{}", reason: "multiple-route-match" };
  return {
    schemaVersion: SCHEMA_VERSION,
    linkages: [linkage],
    unmatchedRoutes: [route],
    unmatchedApiCalls: [apiCall],
    functions: [fn],
    files: [file],
    warnings: [warning],
  };
}

describe("SCHEMA_VERSION", () => {
  it("is the literal 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("LinkageOutput type", () => {
  it("a fully-populated literal type-checks and round-trips its values", () => {
    const output = makeValidLinkageOutput();
    expect(output.schemaVersion).toBe(1);
    expect(output.linkages[0].matchKind).toBe("suffix");
    expect(output.linkages[0].route.schemaRefs[0].role).toBe("request");
    expect(output.functions[0].side).toBe("backend");
    expect(output.files[0].dependsOn).toContain("backend:src/dto.ts");
  });
});

describe("isLinkageOutput", () => {
  it("returns true for a valid LinkageOutput", () => {
    expect(isLinkageOutput(makeValidLinkageOutput())).toBe(true);
  });

  it("returns true for an output with empty (but present) required arrays", () => {
    const empty: LinkageOutput = {
      schemaVersion: SCHEMA_VERSION,
      linkages: [],
      unmatchedRoutes: [],
      unmatchedApiCalls: [],
      functions: [],
      files: [],
      warnings: [],
    };
    expect(isLinkageOutput(empty)).toBe(true);
  });

  it("returns false when schemaVersion is not 1", () => {
    const output = { ...makeValidLinkageOutput(), schemaVersion: 2 };
    expect(isLinkageOutput(output)).toBe(false);
  });

  it.each([
    "linkages",
    "unmatchedRoutes",
    "unmatchedApiCalls",
    "functions",
    "files",
    "warnings",
  ] as const)("returns false when required array %s is missing", (key) => {
    const output: Record<string, unknown> = { ...makeValidLinkageOutput() };
    delete output[key];
    expect(isLinkageOutput(output)).toBe(false);
  });

  it.each([
    "linkages",
    "unmatchedRoutes",
    "unmatchedApiCalls",
    "functions",
    "files",
    "warnings",
  ] as const)("returns false when required field %s is not an array", (key) => {
    const output: Record<string, unknown> = { ...makeValidLinkageOutput() };
    output[key] = "not-an-array";
    expect(isLinkageOutput(output)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isLinkageOutput(null)).toBe(false);
  });

  it("returns false for non-object primitives", () => {
    expect(isLinkageOutput(42)).toBe(false);
    expect(isLinkageOutput("output")).toBe(false);
    expect(isLinkageOutput(undefined)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isLinkageOutput({})).toBe(false);
  });
});
