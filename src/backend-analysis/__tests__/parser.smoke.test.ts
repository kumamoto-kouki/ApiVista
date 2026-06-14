import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getPythonParser, resetPythonParser } from "../parser.js";

const fixture = (rel: string): string =>
  readFileSync(resolve(process.cwd(), "tests/fixtures/sample_app", rel), "utf8");

describe("parser bootstrap (web-tree-sitter, Python grammar)", () => {
  it("loads the Python grammar and parses a valid fixture without a syntax error", async () => {
    const parser = await getPythonParser();
    const tree = parser.parse(fixture("main.py"));

    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("module");
    // main.py is valid Python -> the tree must not be flagged as containing errors.
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it("flags a syntactically broken fixture via hasError (no exception thrown)", async () => {
    const parser = await getPythonParser();
    // tree-sitter never throws on invalid input; it surfaces errors on the tree.
    const tree = parser.parse(fixture("routers/broken.py"));

    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(true);
  });

  it("reuses a single parser instance across calls (singleton)", async () => {
    const a = await getPythonParser();
    const b = await getPythonParser();
    expect(a).toBe(b);
  });

  it("can rebuild the parser after reset", async () => {
    const a = await getPythonParser();
    resetPythonParser();
    const b = await getPythonParser();
    expect(a).not.toBe(b);
    expect(b.parse("x = 1")!.rootNode.hasError).toBe(false);
  });
});
