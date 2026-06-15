import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProject, type FrontendProject } from "../project.js";
import type { SfcWarningCollector } from "../sfc.js";

/** テスト用の最小 WarningCollector スタブ（target/reason を挿入順に収集）。 */
class TestCollector implements SfcWarningCollector {
  readonly entries: { target: string; reason: string }[] = [];
  record(target: string, reason: string): void {
    this.entries.push({ target, reason });
  }
  recordParseError(target: string, detail?: string): void {
    const reason =
      detail === undefined || detail.length === 0 ? "syntax error" : `syntax error: ${detail}`;
    this.record(target, reason);
  }
}

/** 一時 frontendRoot を作り、相対 POSIX パス → 内容のマップでファイルを配置する。 */
function makeFrontendRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fce-project-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

describe("buildProject", () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });
  afterEach(() => {
    for (const r of roots) {
      rmSync(r, { recursive: true, force: true });
    }
  });

  function build(files: Record<string, string>): {
    project: FrontendProject;
    collector: TestCollector;
    root: string;
  } {
    const root = makeFrontendRoot(files);
    roots.push(root);
    const collector = new TestCollector();
    const project = buildProject(root, collector);
    return { project, collector, root };
  }

  it("loads a .ts file and retrieves its SourceFile by fileId", () => {
    const { project } = build({
      "composables/useUserApi.ts": "export function fetchUsers() { return 1; }\n",
    });
    const sf = project.getSourceFile("composables/useUserApi.ts");
    expect(sf).toBeDefined();
    expect(sf?.getFunction("fetchUsers")).toBeDefined();
  });

  it("loads a .js file and retrieves its SourceFile by fileId", () => {
    const { project } = build({
      "utils/helper.js": "export const helper = () => 1;\n",
    });
    const sf = project.getSourceFile("utils/helper.js");
    expect(sf).toBeDefined();
  });

  it("loads a .vue file as a virtual .ts and retrieves it by the .vue fileId", () => {
    const vue = [
      "<template>",
      "  <div />",
      "</template>",
      '<script setup lang="ts">',
      'const data = useFetch("/api/users");',
      "</script>",
      "",
    ].join("\n");
    const { project } = build({ "pages/users.vue": vue });
    // fileId は拡張子そのまま .vue
    const sf = project.getSourceFile("pages/users.vue");
    expect(sf).toBeDefined();
    // 抽出済み script 本文が ts-morph に載っている
    expect(sf?.getFullText()).toContain('useFetch("/api/users")');
  });

  it("preserves .vue segments keyed by fileId for line-offset correction", () => {
    const vue = [
      "<template>",
      "  <div />",
      "</template>",
      '<script setup lang="ts">',
      'const data = useFetch("/api/users");',
      "</script>",
      "",
    ].join("\n");
    const { project } = build({ "pages/users.vue": vue });
    const segments = project.getSegments("pages/users.vue");
    expect(segments.length).toBeGreaterThanOrEqual(1);
    // <script setup> タグは .vue の 4 行目。useFetch（結合本文の該当行）を
    // segment 経由で .vue 実行番号(5) へ補正できることを確認する。
    const sf = project.getSourceFile("pages/users.vue");
    const contentLines = (sf?.getFullText() ?? "").split("\n");
    const idx = contentLines.findIndex((l) => l.includes('useFetch("/api/users")'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const combinedLine = idx + 1;
    const seg = segments.find((s) => combinedLine >= s.fromLine && combinedLine <= s.toLine);
    expect(seg).toBeDefined();
    const vueLine =
      (seg as { vueStartLine: number }).vueStartLine -
      1 +
      (combinedLine - (seg as { fromLine: number }).fromLine + 1);
    expect(vueLine).toBe(5);
  });

  it("returns empty segments for .ts/.js files (identity offset)", () => {
    const { project } = build({
      "composables/useUserApi.ts": "export function fetchUsers() { return 1; }\n",
    });
    expect(project.getSegments("composables/useUserApi.ts")).toEqual([]);
  });

  it("loads both .ts and .vue into the same project and lists both fileIds", () => {
    const { project } = build({
      "composables/useUserApi.ts": "export function fetchUsers() { return 1; }\n",
      "pages/users.vue": [
        "<script setup>",
        'const x = useFetch("/api/users");',
        "</script>",
        "",
      ].join("\n"),
    });
    expect(project.getSourceFile("composables/useUserApi.ts")).toBeDefined();
    expect(project.getSourceFile("pages/users.vue")).toBeDefined();
    expect([...project.fileIds].sort()).toEqual(["composables/useUserApi.ts", "pages/users.vue"]);
  });

  it("uses POSIX-separated fileIds for nested directories on all platforms", () => {
    const { project } = build({
      "components/base/Button.vue": ["<script setup>", "const n = 1;", "</script>", ""].join("\n"),
    });
    expect(project.getSourceFile("components/base/Button.vue")).toBeDefined();
    expect([...project.fileIds]).toContain("components/base/Button.vue");
  });

  it("skips a .vue with an SFC parse error and records a warning (continues)", () => {
    const broken = "<script setup>\nconst x = 1;\n<template><div/></template>\n";
    const { project, collector } = build({
      "pages/broken.vue": broken,
      "composables/useUserApi.ts": "export function fetchUsers() { return 1; }\n",
    });
    // 壊れた .vue は Project に載らない（script=null）。健全な .ts は載る
    expect(project.getSourceFile("pages/broken.vue")).toBeUndefined();
    expect(project.getSourceFile("composables/useUserApi.ts")).toBeDefined();
    expect(collector.entries.some((e) => e.target === "pages/broken.vue")).toBe(true);
  });

  it("does not load a .vue that has no script block (nothing to analyze)", () => {
    const { project, collector } = build({
      "components/Static.vue": "<template><div /></template>\n",
    });
    expect(project.getSourceFile("components/Static.vue")).toBeUndefined();
    // script なしは警告にしない（SFC エラーではない）
    expect(collector.entries).toHaveLength(0);
  });

  it("ignores files outside the recognized extensions (.ts/.js/.vue)", () => {
    const { project } = build({
      "README.md": "# hello\n",
      "styles/main.css": ".a{}\n",
      "composables/useUserApi.ts": "export const f = 1;\n",
    });
    expect([...project.fileIds]).toEqual(["composables/useUserApi.ts"]);
  });

  it("returns undefined for an unknown fileId", () => {
    const { project } = build({ "a.ts": "const a = 1;\n" });
    expect(project.getSourceFile("does/not/exist.ts")).toBeUndefined();
  });

  it("throws when frontendRoot does not exist", () => {
    const collector = new TestCollector();
    expect(() => buildProject(join(tmpdir(), "fce-nonexistent-xyz-123"), collector)).toThrow();
  });

  it("scans files deterministically (sorted fileIds)", () => {
    const { project } = build({
      "z/last.ts": "const z = 1;\n",
      "a/first.ts": "const a = 1;\n",
      "m/mid.ts": "const m = 1;\n",
    });
    expect([...project.fileIds]).toEqual(["a/first.ts", "m/mid.ts", "z/last.ts"]);
  });
});
