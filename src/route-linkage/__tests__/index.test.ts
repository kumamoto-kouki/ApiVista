import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AnalysisOutput as BackendAnalysisOutput } from "../../backend-analysis/models.js";
import type { AnalysisOutput as FrontendAnalysisOutput } from "../../frontend-analysis/models.js";
import { linkRoutes, SCHEMA_VERSION } from "../index.js";
import { isLinkageOutput } from "../models.js";

const fixturesDir = fileURLToPath(
  new URL("../../../tests/fixtures/route-linkage/", import.meta.url),
);

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf-8")) as T;
}

const backendFixture = readFixture<BackendAnalysisOutput>("backend.analysis.json");
const frontendFixture = readFixture<FrontendAnalysisOutput>("frontend.analysis.json");

describe("linkRoutes", () => {
  it("returns a single, valid LinkageOutput synchronously for fixture inputs", () => {
    const result = linkRoutes(backendFixture, frontendFixture);
    expect(isLinkageOutput(result)).toBe(true);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("does not return a Promise (synchronous, no external runtime)", () => {
    const result = linkRoutes(backendFixture, frontendFixture);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).not.toBe("function");
  });

  it("contains the exact-match linkage present in the fixtures", () => {
    const result = linkRoutes(backendFixture, frontendFixture);
    expect(
      result.linkages.some(
        (l) =>
          l.matchKind === "exact" &&
          l.route.path === "/api/users/{id}" &&
          l.apiCall.urlPattern === "/api/users/{}",
      ),
    ).toBe(true);
  });

  it("aggregates both input warnings into the output", () => {
    const result = linkRoutes(backendFixture, frontendFixture);
    expect(result.warnings).toEqual(
      expect.arrayContaining([...backendFixture.warnings, ...frontendFixture.warnings]),
    );
  });

  it("throws when backendOutput.schemaVersion is not 1", () => {
    const invalidBackend = {
      ...backendFixture,
      schemaVersion: 2,
    } as unknown as BackendAnalysisOutput;
    expect(() => linkRoutes(invalidBackend, frontendFixture)).toThrow();
  });

  it("throws when frontendOutput.schemaVersion is not 1", () => {
    const invalidFrontend = {
      ...frontendFixture,
      schemaVersion: 2,
    } as unknown as FrontendAnalysisOutput;
    expect(() => linkRoutes(backendFixture, invalidFrontend)).toThrow();
  });

  it("throws when backendOutput is missing a required array (routes)", () => {
    const invalidBackend = { ...backendFixture } as Record<string, unknown>;
    delete invalidBackend.routes;
    expect(() =>
      linkRoutes(invalidBackend as unknown as BackendAnalysisOutput, frontendFixture),
    ).toThrow();
  });

  it("throws when frontendOutput is missing a required array (apiCalls)", () => {
    const invalidFrontend = { ...frontendFixture } as Record<string, unknown>;
    delete invalidFrontend.apiCalls;
    expect(() =>
      linkRoutes(backendFixture, invalidFrontend as unknown as FrontendAnalysisOutput),
    ).toThrow();
  });

  it("throws when backendOutput is not an object", () => {
    expect(() => linkRoutes(null as unknown as BackendAnalysisOutput, frontendFixture)).toThrow();
  });
});
