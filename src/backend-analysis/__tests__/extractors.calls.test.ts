import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractCalls } from "../extractors/calls.js";
import { getPythonParser, resetPythonParser } from "../parser.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

async function parse(source: string): Promise<Tree> {
  const parser = await getPythonParser();
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error("parse returned null");
  }
  return tree;
}

function parseFixture(relPath: string): Promise<Tree> {
  const source = readFileSync(join(SAMPLE_APP, relPath), "utf8");
  return parse(source);
}

describe("extractCalls", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("collects function definitions and handler call expressions from routers/items.py (Req 3.1)", async () => {
    const tree = await parseFixture("routers/items.py");
    const result = extractCalls(tree, "routers/items.py");

    // All module-level handlers are in the definition registry (qualname === name).
    const defQualnames = result.functionDefinitions.map((d) => d.qualname);
    expect(defQualnames).toContain("get_item");
    expect(defQualnames).toContain("create_item");
    expect(defQualnames).toContain("get_dynamic_item");

    // Registry entry carries name + location (def line).
    const getItemDef = result.functionDefinitions.find((d) => d.qualname === "get_item");
    expect(getItemDef).toMatchObject({
      name: "get_item",
      qualname: "get_item",
      location: { file: "routers/items.py" },
    });
    expect(getItemDef!.location.line).toBeGreaterThan(0);

    // get_item's body calls the helper format_item_label -> a call expression keyed
    // by its enclosing function's qualname.
    const helperCalls = result.callExpressions.filter((c) => c.calleeName === "format_item_label");
    expect(helperCalls.length).toBeGreaterThanOrEqual(1);
    const fromGetItem = helperCalls.find((c) => c.callerQualname === "get_item");
    expect(fromGetItem).toBeDefined();
    expect(fromGetItem!.location).toMatchObject({ file: "routers/items.py" });
    expect(fromGetItem!.location.line).toBeGreaterThan(0);

    // Every call expression must be attributed to an enclosing function (no empty caller).
    for (const call of result.callExpressions) {
      expect(call.callerQualname).not.toBe("");
    }
  });

  it("registers the helper function definition from helpers.py (Req 3.1)", async () => {
    const tree = await parseFixture("helpers.py");
    const result = extractCalls(tree, "helpers.py");

    const def = result.functionDefinitions.find((d) => d.qualname === "format_item_label");
    expect(def).toBeDefined();
    expect(def).toMatchObject({
      name: "format_item_label",
      qualname: "format_item_label",
      location: { file: "helpers.py" },
    });
  });

  it("keys call expressions by enclosing method/nested qualname", async () => {
    const source = ["class A:", "    def m(self):", "        helper()", ""].join("\n");
    const tree = await parse(source);
    const result = extractCalls(tree, "inline.py");

    // Method definition is registered with its dotted qualname.
    const method = result.functionDefinitions.find((d) => d.qualname === "A.m");
    expect(method).toMatchObject({ name: "m", qualname: "A.m" });

    // The call inside the method is attributed to A.m.
    const call = result.callExpressions.find((c) => c.calleeName === "helper");
    expect(call).toBeDefined();
    expect(call!.callerQualname).toBe("A.m");
  });

  it("collects nested-function definitions and dotted callee text", async () => {
    const source = [
      "def outer():",
      "    def inner():",
      "        self.repo.get(1)",
      "    return inner",
      "",
    ].join("\n");
    const tree = await parse(source);
    const result = extractCalls(tree, "nested.py");

    const innerDef = result.functionDefinitions.find((d) => d.qualname === "outer.inner");
    expect(innerDef).toMatchObject({ name: "inner", qualname: "outer.inner" });

    // Dotted callee text is preserved verbatim, keyed by the nested function qualname.
    const dotted = result.callExpressions.find((c) => c.calleeName === "self.repo.get");
    expect(dotted).toBeDefined();
    expect(dotted!.callerQualname).toBe("outer.inner");
  });

  it("skips module-level calls that have no enclosing function", async () => {
    const source = ["configure()", "def f():", "    g()", ""].join("\n");
    const tree = await parse(source);
    const result = extractCalls(tree, "modlevel.py");

    // The top-level configure() call is not attributed to any function -> skipped.
    expect(result.callExpressions.some((c) => c.calleeName === "configure")).toBe(false);
    // The call inside f() is retained.
    const inF = result.callExpressions.find((c) => c.calleeName === "g");
    expect(inF).toBeDefined();
    expect(inF!.callerQualname).toBe("f");
  });
});
