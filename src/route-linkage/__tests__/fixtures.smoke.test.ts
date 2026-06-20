import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isAnalysisOutput as isFrontendAnalysisOutput } from "../../frontend-analysis/models.js";

const fixturesDir = fileURLToPath(
  new URL("../../../tests/fixtures/route-linkage/", import.meta.url),
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf-8"));
}

/**
 * backend-analysis/models.ts は型ガードを公開していない(frontend のみ)ため、
 * 同等の構造検証(schemaVersion=1 と必須配列)をこのテスト内に再現する。
 * backend-analysis を改変しない(boundary: fixtures のみ)。
 */
function isBackendAnalysisOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.routes) &&
    Array.isArray(candidate.functions) &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.warnings)
  );
}

describe("route-linkage fixtures", () => {
  const backend = readFixture("backend.analysis.json");
  const frontend = readFixture("frontend.analysis.json");

  it("backend.analysis.json is a valid backend AnalysisOutput", () => {
    expect(isBackendAnalysisOutput(backend)).toBe(true);
  });

  it("frontend.analysis.json is a valid frontend AnalysisOutput", () => {
    expect(isFrontendAnalysisOutput(frontend)).toBe(true);
  });

  it("contains an exact-match pair (GET /api/users/{id} vs GET /api/users/{})", () => {
    const be = backend as { routes: Array<{ method: string; path: string }> };
    const fe = frontend as { apiCalls: Array<{ method: string; urlPattern: string }> };
    expect(be.routes.some((r) => r.method === "GET" && r.path === "/api/users/{id}")).toBe(true);
    expect(fe.apiCalls.some((c) => c.method === "GET" && c.urlPattern === "/api/users/{}")).toBe(
      true,
    );
  });

  it("contains a baseURL-diff suffix-match pair (GET /api/products vs GET /products)", () => {
    const be = backend as { routes: Array<{ method: string; path: string }> };
    const fe = frontend as { apiCalls: Array<{ method: string; urlPattern: string }> };
    expect(be.routes.some((r) => r.method === "GET" && r.path === "/api/products")).toBe(true);
    expect(fe.apiCalls.some((c) => c.method === "GET" && c.urlPattern === "/products")).toBe(true);
  });

  it("contains a pure-wildcard apiCall that the literal-required guard must exclude", () => {
    const fe = frontend as { apiCalls: Array<{ method: string; urlPattern: string }> };
    expect(fe.apiCalls.some((c) => c.urlPattern === "/{}")).toBe(true);
  });

  it("contains two backend routes that both suffix-match the same /orders/{} apiCall", () => {
    const be = backend as { routes: Array<{ method: string; path: string }> };
    const fe = frontend as { apiCalls: Array<{ method: string; urlPattern: string }> };
    expect(
      be.routes.filter((r) => r.method === "GET" && /\/orders\/\{id\}$/.test(r.path)).length,
    ).toBe(2);
    expect(fe.apiCalls.some((c) => c.method === "GET" && c.urlPattern === "/orders/{}")).toBe(true);
  });

  it("contains an unmatched backend route and an unmatched frontend apiCall", () => {
    const be = backend as { routes: Array<{ method: string; path: string }> };
    const fe = frontend as { apiCalls: Array<{ method: string; urlPattern: string }> };
    expect(be.routes.some((r) => r.method === "DELETE" && r.path === "/api/users/{id}")).toBe(true);
    expect(fe.apiCalls.some((c) => c.method === "POST" && c.urlPattern === "/api/comments")).toBe(
      true,
    );
  });

  it("attaches schemaRefs to at least one backend route", () => {
    const be = backend as { routes: Array<{ schemaRefs: unknown[] }> };
    expect(be.routes.some((r) => r.schemaRefs.length > 0)).toBe(true);
  });

  it("has a colliding function id shared verbatim between backend and frontend", () => {
    const be = backend as { functions: Array<{ id: string }> };
    const fe = frontend as { functions: Array<{ id: string }> };
    const beIds = new Set(be.functions.map((f) => f.id));
    const feIds = new Set(fe.functions.map((f) => f.id));
    const shared = [...beIds].filter((id) => feIds.has(id));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("carries at least one warning on each side", () => {
    const be = backend as { warnings: unknown[] };
    const fe = frontend as { warnings: unknown[] };
    expect(be.warnings.length).toBeGreaterThan(0);
    expect(fe.warnings.length).toBeGreaterThan(0);
  });
});
