import { describe, expect, it } from "vitest";

import type {
  AnalysisOutput,
  ApiCall,
  FileNode,
  FunctionNode,
  SourceLocation,
  Warning,
} from "../models.js";
import { isAnalysisOutput, SCHEMA_VERSION } from "../models.js";

describe("models", () => {
  it("pins SCHEMA_VERSION to 1 (backend と対称)", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("type-checks a constructed AnalysisOutput literal", () => {
    const location: SourceLocation = { file: "pages/users.vue", line: 6 };
    const apiCall: ApiCall = {
      method: "GET",
      urlPattern: "/api/users/{}",
      enclosingFunctionId: "pages/users:Users",
      location,
    };
    const fn: FunctionNode = {
      id: "pages/users:Users",
      name: "Users",
      file: "pages/users.vue",
      location,
      calls: ["composables/useUserApi:fetchUsers"],
    };
    const file: FileNode = {
      id: "pages/users.vue",
      path: "pages/users.vue",
      dependsOn: ["composables/useUserApi.ts"],
    };
    const warning: Warning = {
      target: "pages/broken.vue",
      reason: "syntax error",
    };
    const output: AnalysisOutput = {
      schemaVersion: SCHEMA_VERSION,
      apiCalls: [apiCall],
      functions: [fn],
      files: [file],
      warnings: [warning],
    };

    expect(output.schemaVersion).toBe(1);
    expect(output.apiCalls[0]?.urlPattern).toBe("/api/users/{}");
    // ApiCall は backend RouteDefinition の対称物（schemaRefs を持たない）。
    expect("schemaRefs" in (output.apiCalls[0] as object)).toBe(false);
  });

  describe("isAnalysisOutput", () => {
    const valid: AnalysisOutput = {
      schemaVersion: 1,
      apiCalls: [],
      functions: [],
      files: [],
      warnings: [],
    };

    it("accepts a well-formed schemaVersion=1 output", () => {
      expect(isAnalysisOutput(valid)).toBe(true);
    });

    it("rejects a non-object", () => {
      expect(isAnalysisOutput(null)).toBe(false);
      expect(isAnalysisOutput(42)).toBe(false);
      expect(isAnalysisOutput("x")).toBe(false);
    });

    it("rejects a wrong schemaVersion", () => {
      expect(isAnalysisOutput({ ...valid, schemaVersion: 2 })).toBe(false);
    });

    it("rejects when required arrays are missing", () => {
      const rest: Record<string, unknown> = { ...valid };
      delete rest.apiCalls;
      expect(isAnalysisOutput(rest)).toBe(false);
    });
  });
});
