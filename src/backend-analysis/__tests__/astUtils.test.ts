import type { Node, Tree } from "web-tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import {
  computeQualname,
  fieldChild,
  hasSyntaxError,
  line,
  stripStringLiteral,
  toSourceLocation,
} from "../astUtils.js";
import { getPythonParser } from "../parser.js";

function parse(src: string): Tree {
  return parserTree(src);
}

let parserTree: (src: string) => Tree;

beforeAll(async () => {
  const parser = await getPythonParser();
  parserTree = (src: string): Tree => {
    const tree = parser.parse(src);
    if (tree === null) {
      throw new Error("parse returned null");
    }
    return tree;
  };
});

/** Find the first function_definition node whose `name` field equals `name`. */
function findFunction(root: Node, name: string): Node {
  const matches = root.descendantsOfType("function_definition");
  for (const m of matches) {
    if (m === null) {
      continue;
    }
    const nameNode = m.childForFieldName("name");
    if (nameNode !== null && nameNode.text === name) {
      return m;
    }
  }
  throw new Error(`function ${name} not found`);
}

/** Find the first string node in the tree. */
function findString(root: Node): Node {
  const strings = root.descendantsOfType("string");
  const first = strings[0];
  if (first === undefined || first === null) {
    throw new Error("no string node found");
  }
  return first;
}

describe("computeQualname", () => {
  it("returns the bare name for a top-level function", () => {
    const tree = parse("def get_item():\n    return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(computeQualname(fn)).toBe("get_item");
  });

  it("returns Class.method for a method inside a class", () => {
    const tree = parse("class ItemRouter:\n    def get_item(self):\n        return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(computeQualname(fn)).toBe("ItemRouter.get_item");
  });

  it("returns outer.inner for a nested function", () => {
    const tree = parse("def outer():\n    def inner():\n        return 1\n    return inner\n");
    const inner = findFunction(tree.rootNode, "inner");
    expect(computeQualname(inner)).toBe("outer.inner");
  });

  it("does not include if-block ancestors as qualname segments", () => {
    const tree = parse("if True:\n    def get_item():\n        return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(computeQualname(fn)).toBe("get_item");
  });
});

describe("line", () => {
  it("is 1-based (first source line is 1)", () => {
    const tree = parse("def get_item():\n    return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(line(fn)).toBe(1);
  });

  it("reflects later lines correctly", () => {
    const tree = parse("x = 1\n\ndef get_item():\n    return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(line(fn)).toBe(3);
  });
});

describe("toSourceLocation", () => {
  it("builds a SourceLocation with fileId and 1-based line", () => {
    const tree = parse("def get_item():\n    return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(toSourceLocation("routers/items.py", fn)).toEqual({
      file: "routers/items.py",
      line: 1,
    });
  });
});

describe("stripStringLiteral", () => {
  it("strips double quotes", () => {
    const tree = parse('x = "/items"\n');
    expect(stripStringLiteral(findString(tree.rootNode).text)).toBe("/items");
  });

  it("strips single quotes", () => {
    const tree = parse("x = '/items'\n");
    expect(stripStringLiteral(findString(tree.rootNode).text)).toBe("/items");
  });

  it("strips triple double quotes", () => {
    const tree = parse('x = """/items"""\n');
    expect(stripStringLiteral(findString(tree.rootNode).text)).toBe("/items");
  });

  it("strips triple single quotes", () => {
    const tree = parse("x = '''/items'''\n");
    expect(stripStringLiteral(findString(tree.rootNode).text)).toBe("/items");
  });

  it("strips r/b/f/u prefixes", () => {
    expect(stripStringLiteral('r"/items"')).toBe("/items");
    expect(stripStringLiteral('b"/items"')).toBe("/items");
    expect(stripStringLiteral('f"/items"')).toBe("/items");
    expect(stripStringLiteral('u"/items"')).toBe("/items");
    expect(stripStringLiteral('R"/items"')).toBe("/items");
    expect(stripStringLiteral('rb"/items"')).toBe("/items");
    expect(stripStringLiteral('f"""/items"""')).toBe("/items");
  });

  it("returns empty string for an empty literal", () => {
    expect(stripStringLiteral('""')).toBe("");
  });
});

describe("hasSyntaxError", () => {
  it("is false for valid Python (tree input)", () => {
    const tree = parse("def get_item():\n    return 1\n");
    expect(hasSyntaxError(tree)).toBe(false);
  });

  it("is false for valid Python (rootNode input)", () => {
    const tree = parse("def get_item():\n    return 1\n");
    expect(hasSyntaxError(tree.rootNode)).toBe(false);
  });

  it("is true for broken Python", () => {
    const tree = parse("def get_item(:\n    return\n");
    expect(hasSyntaxError(tree)).toBe(true);
  });
});

describe("fieldChild", () => {
  it("returns the named field child", () => {
    const tree = parse("def get_item():\n    return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    const nameNode = fieldChild(fn, "name");
    expect(nameNode).not.toBeNull();
    expect(nameNode?.text).toBe("get_item");
  });

  it("returns null for a missing field", () => {
    const tree = parse("def get_item():\n    return 1\n");
    const fn = findFunction(tree.rootNode, "get_item");
    expect(fieldChild(fn, "nonexistent_field")).toBeNull();
  });
});
