import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { correctLine, line, normalizeUrlTemplate, toSourceLocation } from "../astUtils.js";
import type { ScriptSegment } from "../sfc.js";

const project = new Project({ useInMemoryFileSystem: true });

/** ソースを作って最初の変数初期化子（式ノード）を返すヘルパ。 */
function firstInitializer(code: string): Node {
  const sf = project.createSourceFile(`tmp-${Math.random()}.ts`, code, { overwrite: true });
  const init = sf.getVariableDeclarations()[0]?.getInitializer();
  if (init === undefined) {
    throw new Error("no initializer found");
  }
  return init;
}

describe("normalizeUrlTemplate", () => {
  it("returns a plain string literal unchanged", () => {
    const node = firstInitializer('const u = "/api/items";');
    expect(normalizeUrlTemplate(node)).toBe("/api/items");
  });

  it("returns a static no-substitution template literal unchanged", () => {
    const node = firstInitializer("const u = `/api/items`;");
    expect(normalizeUrlTemplate(node)).toBe("/api/items");
  });

  it("normalizes a single ${expr} to a {} placeholder", () => {
    const node = firstInitializer("const u = `/api/users/${id}`;");
    expect(normalizeUrlTemplate(node)).toBe("/api/users/{}");
  });

  it("normalizes multiple ${expr} placeholders while keeping the literal skeleton", () => {
    const node = firstInitializer("const u = `/api/users/${id}/posts/${pid}`;");
    expect(normalizeUrlTemplate(node)).toBe("/api/users/{}/posts/{}");
  });

  it("keeps a static suffix after the final placeholder", () => {
    const node = firstInitializer("const u = `/api/users/${id}/profile`;");
    expect(normalizeUrlTemplate(node)).toBe("/api/users/{}/profile");
  });

  it("normalizes a leading placeholder (dynamic prefix) to {}", () => {
    const node = firstInitializer("const u = `${base}/api/users`;");
    expect(normalizeUrlTemplate(node)).toBe("{}/api/users");
  });

  it("returns null for a non-literal URL (variable / function result)", () => {
    expect(normalizeUrlTemplate(firstInitializer("const u = buildUrl();"))).toBeNull();
    expect(normalizeUrlTemplate(firstInitializer("const u = path;"))).toBeNull();
  });

  it("is deterministic for the same input", () => {
    const a = normalizeUrlTemplate(firstInitializer("const u = `/api/users/${id}`;"));
    const b = normalizeUrlTemplate(firstInitializer("const u = `/api/users/${id}`;"));
    expect(a).toBe(b);
  });
});

describe("line", () => {
  it("returns the 1-based start line for a .ts node (empty segments = identity)", () => {
    const sf = project.createSourceFile("lines.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n", {
      overwrite: true,
    });
    const c = sf.getVariableDeclarations()[2]!;
    expect(line(c, [])).toBe(3);
  });

  it("corrects a .vue-derived node line via its segment", () => {
    // <script> at .vue line 2, content occupies combined lines 1..3
    // <script setup> at .vue line 8, content occupies combined lines 4..6
    const segments: ScriptSegment[] = [
      { fromLine: 1, toLine: 3, vueStartLine: 2 },
      { fromLine: 4, toLine: 6, vueStartLine: 8 },
    ];
    const sf = project.createSourceFile(
      "vue-derived.ts",
      ["a", "b", "c", "d", "e", "f"].join("\n"),
      { overwrite: true },
    );
    // combined line 5 (the "e" statement) lives in segment #2 (fromLine 4, vueStartLine 8)
    // expected .vue line = 8 - 1 + (5 - 4 + 1) = 9
    const e = sf.getStatements()[4]!;
    expect(line(e, segments)).toBe(9);
  });
});

describe("correctLine", () => {
  const segments: ScriptSegment[] = [
    { fromLine: 1, toLine: 3, vueStartLine: 2 },
    { fromLine: 4, toLine: 6, vueStartLine: 8 },
  ];

  it("returns the line unchanged when segments are empty (.ts/.js)", () => {
    expect(correctLine(5, [])).toBe(5);
  });

  it("corrects a line in the first segment", () => {
    // combined line 1 -> 2 - 1 + (1 - 1 + 1) = 2
    expect(correctLine(1, segments)).toBe(2);
    // combined line 3 -> 2 - 1 + (3 - 1 + 1) = 4
    expect(correctLine(3, segments)).toBe(4);
  });

  it("corrects a line in the second segment", () => {
    // combined line 4 -> 8 - 1 + (4 - 4 + 1) = 8
    expect(correctLine(4, segments)).toBe(8);
    // combined line 6 -> 8 - 1 + (6 - 4 + 1) = 10
    expect(correctLine(6, segments)).toBe(10);
  });

  it("falls back to the raw line when no segment contains it", () => {
    expect(correctLine(99, segments)).toBe(99);
  });
});

describe("toSourceLocation", () => {
  it("builds a SourceLocation with fileId and corrected line", () => {
    const sf = project.createSourceFile("loc.ts", "const a = 1;\n", { overwrite: true });
    const a = sf.getVariableDeclarations()[0]!;
    expect(toSourceLocation("composables/useUserApi.ts", a, [])).toEqual({
      file: "composables/useUserApi.ts",
      line: 1,
    });
  });

  it("applies segment correction for .vue-derived nodes", () => {
    const segments: ScriptSegment[] = [{ fromLine: 1, toLine: 3, vueStartLine: 5 }];
    const sf = project.createSourceFile("loc-vue.ts", "a\nb\nc\n", { overwrite: true });
    const b = sf.getStatements()[1]!;
    // combined line 2 -> 5 - 1 + (2 - 1 + 1) = 6
    expect(toSourceLocation("pages/users.vue", b, segments)).toEqual({
      file: "pages/users.vue",
      line: 6,
    });
  });
});

describe("Node import smoke", () => {
  it("exposes ts-morph Node type guard usage (no-op assertion)", () => {
    const node = firstInitializer('const u = "/x";');
    expect(Node.isStringLiteral(node)).toBe(true);
  });
});
