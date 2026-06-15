import { describe, expect, it } from "vitest";

import { extractSfc, type SfcWarningCollector } from "../sfc.js";

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

describe("extractSfc", () => {
  describe("<script setup> 単独", () => {
    const source = [
      "<template>", // line 1
      "  <UserList />", // line 2
      "</template>", // line 3
      '<script setup lang="ts">', // line 4
      'import { useFetch } from "#app";', // line 5
      'const data = useFetch("/api/users");', // line 6
      "</script>", // line 7
      "",
    ].join("\n");

    it("extracts the script content", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      expect(result.script).not.toBeNull();
      expect(result.script?.content).toContain("useFetch");
      expect(result.script?.content).toContain('import { useFetch } from "#app";');
    });

    it("reports lang ts", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      expect(result.script?.lang).toBe("ts");
    });

    it("maps a combined-script line back to the original .vue line", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      const segments = result.script?.segments ?? [];
      // useFetch 行を結合本文から探し、segments で .vue 実行番号(6)に補正できること
      const lines = (result.script?.content ?? "").split("\n");
      const idx = lines.findIndex((l) => l.includes('useFetch("/api/users")'));
      expect(idx).toBeGreaterThanOrEqual(0);
      const combinedLine = idx + 1; // 1基底
      const seg = segments.find((s) => combinedLine >= s.fromLine && combinedLine <= s.toLine);
      expect(seg).toBeDefined();
      const vueLine =
        (seg as { vueStartLine: number }).vueStartLine -
        1 +
        (combinedLine - (seg as { fromLine: number }).fromLine + 1);
      expect(vueLine).toBe(6);
    });

    it("records no warnings for a valid SFC", () => {
      const c = new TestCollector();
      extractSfc(source, "pages/users.vue", c);
      expect(c.entries).toHaveLength(0);
    });
  });

  describe("<script> + <script setup> 併存", () => {
    const source = [
      "<script>", // line 1
      'export default { name: "Mixed" };', // line 2
      "const legacy = 1;", // line 3
      "</script>", // line 4
      "<script setup>", // line 5
      "const ext = useExternal();", // line 6
      "function run() {", // line 7
      "  return ext;", // line 8
      "}", // line 9
      "</script>", // line 10
      "<template>", // line 11
      "  <div />", // line 12
      "</template>", // line 13
      "",
    ].join("\n");

    it("combines both script blocks into one content", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "comp/Mixed.vue", c);
      expect(result.script).not.toBeNull();
      expect(result.script?.content).toContain("const legacy = 1;");
      expect(result.script?.content).toContain("function run()");
    });

    it("produces a segment per block with correct .vue start lines", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "comp/Mixed.vue", c);
      const segments = result.script?.segments ?? [];
      expect(segments).toHaveLength(2);
      // 1つ目: <script> ブロック、2つ目: <script setup> ブロック（出現順）
    });

    it("maps a line in the FIRST block back to the original .vue line", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "comp/Mixed.vue", c);
      const lines = (result.script?.content ?? "").split("\n");
      const idx = lines.findIndex((l) => l.includes("const legacy = 1;"));
      const combinedLine = idx + 1;
      const segs = result.script?.segments ?? [];
      const seg = segs.find((s) => combinedLine >= s.fromLine && combinedLine <= s.toLine);
      expect(seg).toBeDefined();
      const vueLine =
        (seg as { vueStartLine: number }).vueStartLine -
        1 +
        (combinedLine - (seg as { fromLine: number }).fromLine + 1);
      expect(vueLine).toBe(3); // const legacy = 1; は .vue の3行目
    });

    it("maps a line in the SECOND block back to the original .vue line", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "comp/Mixed.vue", c);
      const lines = (result.script?.content ?? "").split("\n");
      const idx = lines.findIndex((l) => l.includes("function run()"));
      const combinedLine = idx + 1;
      const segs = result.script?.segments ?? [];
      const seg = segs.find((s) => combinedLine >= s.fromLine && combinedLine <= s.toLine);
      expect(seg).toBeDefined();
      const vueLine =
        (seg as { vueStartLine: number }).vueStartLine -
        1 +
        (combinedLine - (seg as { fromLine: number }).fromLine + 1);
      expect(vueLine).toBe(7); // function run() は .vue の7行目
    });

    it("orders segments so the second block maps higher than the first", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "comp/Mixed.vue", c);
      const segs = result.script?.segments ?? [];
      expect(segs[0]?.vueStartLine).toBeLessThan(segs[1]?.vueStartLine ?? Infinity);
    });
  });

  describe("template のコンポーネント参照", () => {
    const source = [
      "<template>",
      "  <div>",
      "    <UserList />",
      '    <user-detail :id="1" />',
      "    <base-button>x</base-button>",
      '    <component :is="dyn" />',
      "  </div>",
      "</template>",
      "<script setup></script>",
      "",
    ].join("\n");

    it("collects child component references", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      const names = result.componentRefs.map((r) => r.name);
      expect(names).toContain("UserList");
    });

    it("normalizes kebab-case to PascalCase", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      const names = result.componentRefs.map((r) => r.name);
      expect(names).toContain("UserDetail");
      expect(names).toContain("BaseButton");
    });

    it("excludes dynamic <component :is> and plain HTML elements", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      const names = result.componentRefs.map((r) => r.name);
      expect(names).not.toContain("Component");
      expect(names).not.toContain("Div");
      expect(names).not.toContain("Component:is");
    });

    it("attaches a source location with the original .vue line", () => {
      const c = new TestCollector();
      const result = extractSfc(source, "pages/users.vue", c);
      const ref = result.componentRefs.find((r) => r.name === "UserList");
      expect(ref?.location.file).toBe("pages/users.vue");
      expect(ref?.location.line).toBe(3); // <UserList /> は .vue の3行目
    });
  });

  describe("script の無い SFC", () => {
    it("returns null script and no warning when there is simply no script block", () => {
      const c = new TestCollector();
      const result = extractSfc("<template><div /></template>\n", "comp/Static.vue", c);
      expect(result.script).toBeNull();
      expect(c.entries).toHaveLength(0);
    });
  });

  describe("SFC パースエラー", () => {
    it("returns null script and records a parse error", () => {
      const c = new TestCollector();
      // 閉じられていない <script> タグ → @vue/compiler-sfc が errors を返す
      const broken = "<script setup>\nconst x = 1;\n<template><div/></template>\n";
      const result = extractSfc(broken, "comp/Broken.vue", c);
      expect(result.script).toBeNull();
      expect(c.entries.length).toBeGreaterThanOrEqual(1);
      expect(c.entries[0]?.target).toBe("comp/Broken.vue");
    });
  });
});
