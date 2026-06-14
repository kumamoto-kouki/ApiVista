import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import { getPythonParser } from "../parser.js";
import { buildSymbolTable, resolveName } from "../symbolTable.js";

let parse: (src: string) => Tree;

function fixture(relPath: string): string {
  const url = new URL(`../../../tests/fixtures/sample_app/${relPath}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

beforeAll(async () => {
  const parser = await getPythonParser();
  parse = (src: string): Tree => {
    const tree = parser.parse(src);
    if (tree === null) {
      throw new Error("parse returned null");
    }
    return tree;
  };
});

describe("buildSymbolTable", () => {
  it("resolves cross-file imports (relative + absolute) in routers/users.py", () => {
    const tree = parse(fixture("routers/users.py"));
    const table = buildSymbolTable(tree, "routers/users.py");

    const userRequest = table.get("UserRequest");
    expect(userRequest).toEqual({ kind: "import", qualifiedName: "..schemas.UserRequest" });

    const userResponse = table.get("UserResponse");
    expect(userResponse).toEqual({ kind: "import", qualifiedName: "..schemas.UserResponse" });

    const apiRouter = table.get("APIRouter");
    expect(apiRouter).toEqual({ kind: "import", qualifiedName: "fastapi.APIRouter" });
  });

  it("resolves local classes, imports, and helper imports in routers/items.py", () => {
    const src = fixture("routers/items.py");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "routers/items.py");

    // Local class definitions resolve to the line of their `class` keyword.
    const lines = src.split("\n");
    const itemCreateLine = lines.findIndex((l) => l.startsWith("class ItemCreate")) + 1;
    const itemResponseLine = lines.findIndex((l) => l.startsWith("class ItemResponse")) + 1;

    expect(table.get("ItemCreate")).toEqual({
      kind: "localClass",
      location: { file: "routers/items.py", line: itemCreateLine },
    });
    expect(table.get("ItemResponse")).toEqual({
      kind: "localClass",
      location: { file: "routers/items.py", line: itemResponseLine },
    });

    expect(table.get("format_item_label")).toEqual({
      kind: "import",
      qualifiedName: "..helpers.format_item_label",
    });
    expect(table.get("BaseModel")).toEqual({ kind: "import", qualifiedName: "pydantic.BaseModel" });
    expect(table.get("APIRouter")).toEqual({ kind: "import", qualifiedName: "fastapi.APIRouter" });
  });

  it("binds top-level def as `other` and supports aliased / dotted imports", () => {
    const tree = parse(
      [
        "from x import Name as Alias",
        "import a.b.c",
        "import pkg as p",
        "from m import *",
        "def helper():",
        "    pass",
      ].join("\n"),
    );
    const table = buildSymbolTable(tree, "f.py");

    expect(table.get("Alias")).toEqual({ kind: "import", qualifiedName: "x.Name" });
    expect(table.get("a")).toEqual({ kind: "import", qualifiedName: "a.b.c" });
    expect(table.get("p")).toEqual({ kind: "import", qualifiedName: "pkg" });
    // Wildcard import contributes no enumerable binding.
    expect(table.has("m")).toBe(false);
    // Top-level function is a local non-class binding.
    expect(table.get("helper")).toEqual({ kind: "other" });
  });
});

describe("resolveName", () => {
  it("falls back to builtin for unbound builtin names", () => {
    const tree = parse("class Foo:\n    pass\n");
    const table = buildSymbolTable(tree, "f.py");

    expect(resolveName(table, "int")).toEqual({ kind: "builtin" });
    expect(resolveName(table, "str")).toEqual({ kind: "builtin" });
    expect(resolveName(table, "Optional")).toEqual({ kind: "builtin" });
  });

  it("prefers a local/import binding over builtin (shadowing)", () => {
    const tree = parse("from typing import Optional\nclass list:\n    pass\n");
    const table = buildSymbolTable(tree, "f.py");

    // `Optional` is imported here -> import wins over builtin classification.
    expect(resolveName(table, "Optional")).toEqual({
      kind: "import",
      qualifiedName: "typing.Optional",
    });
    // `list` is locally defined as a class -> localClass wins over builtin.
    expect(resolveName(table, "list")).toMatchObject({ kind: "localClass" });
  });

  it("returns `other` for names that are neither bound nor builtin", () => {
    const tree = parse("x = 1\n");
    const table = buildSymbolTable(tree, "f.py");

    expect(resolveName(table, "SomethingUnknown")).toEqual({ kind: "other" });
  });
});
