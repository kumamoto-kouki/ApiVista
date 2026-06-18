import { resolve } from "node:path";

import { Project, type SourceFile } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { extractApiCalls, type ApiCallCandidate } from "../extractors/apiCalls.js";
import { buildProject, type FrontendProject } from "../project.js";
import type { ScriptSegment } from "../sfc.js";
import { WarningCollector } from "../warnings.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

/** 単発の in-memory ts-morph SourceFile を作るヘルパ（.ts/.js 経路 = segments 恒等）。 */
const scratch = new Project({ useInMemoryFileSystem: true });
function makeSource(fileId: string, code: string): SourceFile {
  return scratch.createSourceFile(`scratch/${fileId}`, code, { overwrite: true });
}

/** fileId に一致する候補を取り出す（順不同の比較用）。 */
function byUrl(calls: ApiCallCandidate[], url: string): ApiCallCandidate | undefined {
  return calls.find((c) => c.urlPattern === url);
}

describe("extractApiCalls — recognized call shapes (Req 1.1, 1.2)", () => {
  it("recognizes axios.get / axios.post attribute calls and derives method from the call name", () => {
    const collector = new WarningCollector();
    const sf = makeSource(
      "client.ts",
      [
        'import axios from "axios";',
        'axios.get("/api/users");',
        'axios.post("/api/users");',
        'axios.put("/api/users/1");',
        'axios.delete("/api/users/1");',
        'axios.patch("/api/users/1");',
      ].join("\n"),
    );

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    const get = calls.find((c) => c.method === "GET" && c.urlPattern === "/api/users");
    const post = calls.find((c) => c.method === "POST" && c.urlPattern === "/api/users");
    expect(get).toBeDefined();
    expect(post).toBeDefined();
    const methods = calls.map((c) => c.method).sort();
    expect(methods).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
  });

  it("recognizes `useFetch` identifier calls with default GET (no method option) (Req 1.2)", () => {
    const collector = new WarningCollector();
    const sf = makeSource("page.ts", 'const { data } = useFetch("/api/users");');

    const calls = extractApiCalls(sf, "page.ts", [], collector);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.urlPattern).toBe("/api/users");
  });

  it("recognizes `$fetch` identifier calls with default GET", () => {
    const collector = new WarningCollector();
    const sf = makeSource("page.ts", 'await $fetch("/api/items");');

    const calls = extractApiCalls(sf, "page.ts", [], collector);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.urlPattern).toBe("/api/items");
  });

  it("reads the method from an options object literal (`{ method: 'POST' }`) (Req 1.2)", () => {
    const collector = new WarningCollector();
    const sf = makeSource(
      "page.ts",
      [
        '$fetch("/api/items", { method: "POST" });',
        'useFetch("/api/items", { method: "delete" });',
        'axios("/api/items", { method: "put" });',
      ].join("\n"),
    );

    const calls = extractApiCalls(sf, "page.ts", [], collector);

    expect(calls.find((c) => c.urlPattern === "/api/items" && c.method === "POST")).toBeDefined();
    // options method is uppercased regardless of source casing.
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("prefers the attribute method name over an options method for axios.<verb>", () => {
    const collector = new WarningCollector();
    // axios.get with an options object: attribute name (.get) wins -> GET.
    const sf = makeSource("client.ts", 'axios.get("/api/users", { params: { q: 1 } });');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });
});

describe("extractApiCalls — URL normalization (Req 1.3)", () => {
  it("normalizes a template-literal dynamic segment to a placeholder", () => {
    const collector = new WarningCollector();
    const sf = makeSource("page.ts", "const u = $fetch(`/api/users/${id}`);");

    const calls = extractApiCalls(sf, "page.ts", [], collector);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.urlPattern).toBe("/api/users/{}");
  });

  it("keeps a plain string literal URL unchanged", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", 'axios.get("/api/users");');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls[0]!.urlPattern).toBe("/api/users");
  });
});

describe("extractApiCalls — dynamic exclusion + warnings (Req 4.2)", () => {
  it("excludes a call whose URL skeleton is fully dynamic (function result) and records a warning", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", "axios.get(buildUrl());");

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    expect(collector.warnings).toHaveLength(1);
    expect(collector.warnings[0]!.target).toBe("client.ts");
    expect(collector.warnings[0]!.reason.toLowerCase()).toContain("url");
  });

  it("excludes a call whose URL is a bare variable reference and records a warning", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", "$fetch(path);");

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    expect(collector.warnings).toHaveLength(1);
  });

  it("excludes a call whose method is statically undeterminable (non-literal) and records a warning", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", '$fetch("/api/items", { method: verb });');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    expect(collector.warnings).toHaveLength(1);
    expect(collector.warnings[0]!.reason.toLowerCase()).toContain("method");
  });

  it("excludes a call with no arguments (no URL) and records a warning", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", "$fetch();");

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    expect(collector.warnings).toHaveLength(1);
  });
});

describe("extractApiCalls — unrecognized patterns are not extracted (Req 1.5)", () => {
  it("does not extract an unrecognized client method call and does not warn for it", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", 'customClient.fetchData("/api/custom");');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    // Out of scope: no warning for unrecognized clients.
    expect(collector.warnings).toHaveLength(0);
  });

  it("does not extract an unrecognized axios verb (e.g. axios.head)", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", 'axios.head("/api/users");');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    expect(collector.warnings).toHaveLength(0);
  });

  it("does not extract an unrelated plain function call", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", 'doSomething("/api/users");');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(0);
    expect(collector.warnings).toHaveLength(0);
  });
});

describe("extractApiCalls — enclosingFunctionId is left unresolved at Pass1 (3.1 boundary)", () => {
  it("emits candidates with an empty enclosingFunctionId placeholder (filled by callGraph in 4.1)", () => {
    const collector = new WarningCollector();
    const sf = makeSource("client.ts", 'axios.get("/api/users");');

    const calls = extractApiCalls(sf, "client.ts", [], collector);

    expect(calls).toHaveLength(1);
    // 3.1 does not own Req 1.4; enclosing node attribution is done in Pass2 (4.1).
    expect(calls[0]!.enclosingFunctionId).toBe("");
  });
});

describe("extractApiCalls — real sample_nuxt fixture", () => {
  let project: FrontendProject;

  beforeAll(() => {
    const collector = new WarningCollector();
    project = buildProject(SAMPLE_NUXT, collector);
  });

  function extractFor(fileId: string): { calls: ApiCallCandidate[]; collector: WarningCollector } {
    const collector = new WarningCollector();
    const sf = project.getSourceFile(fileId);
    if (sf === undefined) {
      throw new Error(`source file not loaded: ${fileId}`);
    }
    const segments: ScriptSegment[] = project.getSegments(fileId);
    const calls = extractApiCalls(sf, fileId, segments, collector);
    return { calls, collector };
  }

  it("extracts axios.get / axios.post / template-literal calls from useUserApi.ts (Req 1.1-1.3)", () => {
    const { calls, collector } = extractFor("composables/useUserApi.ts");

    // axios.get('/api/users') -> GET /api/users (appears once as a literal-URL GET).
    expect(calls.some((c) => c.method === "GET" && c.urlPattern === "/api/users")).toBe(true);
    // axios.post('/api/users') -> POST /api/users.
    expect(calls.some((c) => c.method === "POST" && c.urlPattern === "/api/users")).toBe(true);
    // axios.get(`/api/users/${userId}`) -> GET /api/users/{}.
    expect(calls.some((c) => c.method === "GET" && c.urlPattern === "/api/users/{}")).toBe(true);

    // fetchDynamic: axios.get(buildUrl()) -> excluded + warning (Req 4.2).
    expect(byUrl(calls, "/api/")).toBeUndefined();
    expect(collector.warnings.some((w) => w.reason.toLowerCase().includes("url"))).toBe(true);

    // fetchViaCustom: customClient.fetchData(...) -> NOT extracted, NOT warned (Req 1.5).
    expect(calls.some((c) => c.urlPattern === "/api/custom")).toBe(false);

    // Recognized literal calls: GET /api/users, POST /api/users, GET /api/users/{}.
    // (fetchDynamic excluded, customClient not recognized.)
    expect(calls).toHaveLength(3);
  });

  it("extracts the top-level useFetch from pages/users.vue with default GET (Req 1.2)", () => {
    const { calls } = extractFor("pages/users.vue");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.urlPattern).toBe("/api/users");
  });

  it("normalizes the $fetch template literal in pages/userDetail.vue to /api/users/{}", () => {
    const { calls } = extractFor("pages/userDetail.vue");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.urlPattern).toBe("/api/users/{}");
  });

  it("corrects the .vue line of a useFetch in the second (setup) script block (Req 3.3)", () => {
    // LegacyWidget.vue: <script> classic block first, <script setup> second.
    // The `useFetch('/api/widgets')` sits at real .vue line 25.
    const { calls } = extractFor("components/LegacyWidget.vue");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.urlPattern).toBe("/api/widgets");
    expect(calls[0]!.location.file).toBe("components/LegacyWidget.vue");
    expect(calls[0]!.location.line).toBe(25);
  });

  it("uses fileId and 1-based line for a .ts source location", () => {
    const { calls } = extractFor("composables/useUserApi.ts");

    const get = calls.find((c) => c.urlPattern === "/api/users" && c.method === "GET");
    expect(get?.location.file).toBe("composables/useUserApi.ts");
    // axios.get("/api/users") sits at line 31 in the fixture.
    expect(get?.location.line).toBe(31);
  });
});
