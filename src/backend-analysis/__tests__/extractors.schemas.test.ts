import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractSchemaInfo } from "../extractors/schemas.js";
import type { SchemaRefCandidate } from "../extractors/schemas.js";
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

function pick(
  candidates: SchemaRefCandidate[],
  handlerQualname: string,
  role: "request" | "response",
): SchemaRefCandidate[] {
  return candidates.filter((c) => c.handlerQualname === handlerQualname && c.role === role);
}

describe("extractSchemaInfo", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("resolves local-defined model refs and class registry from routers/items.py (Req 2.1)", async () => {
    const tree = await parseFixture("routers/items.py");
    const result = extractSchemaInfo(tree, "routers/items.py");

    // get_item -> response ItemResponse (local, line 32), no request candidate.
    const getItemResp = pick(result.refCandidates, "get_item", "response");
    expect(getItemResp).toHaveLength(1);
    expect(getItemResp[0]).toMatchObject({
      role: "response",
      className: "ItemResponse",
      handlerQualname: "get_item",
      localLocation: { file: "routers/items.py", line: 32 },
      importedQualifiedName: null,
    });
    expect(pick(result.refCandidates, "get_item", "request")).toHaveLength(0);

    // create_item -> request ItemCreate (local, line 25) AND response ItemResponse (local, line 32).
    const createReq = pick(result.refCandidates, "create_item", "request");
    expect(createReq).toHaveLength(1);
    expect(createReq[0]).toMatchObject({
      role: "request",
      className: "ItemCreate",
      handlerQualname: "create_item",
      localLocation: { file: "routers/items.py", line: 25 },
      importedQualifiedName: null,
    });
    const createResp = pick(result.refCandidates, "create_item", "response");
    expect(createResp).toHaveLength(1);
    expect(createResp[0]).toMatchObject({
      className: "ItemResponse",
      localLocation: { file: "routers/items.py", line: 32 },
      importedQualifiedName: null,
    });

    // get_dynamic_item returns `dict` (builtin) -> no candidate.
    expect(pick(result.refCandidates, "get_dynamic_item", "response")).toHaveLength(0);

    // format_item_label is a helper (no route decorator) -> no candidates at all.
    expect(
      result.refCandidates.filter((c) => c.handlerQualname.includes("format_item_label")),
    ).toHaveLength(0);

    // Class registry: ItemCreate (line 25), ItemResponse (line 32), each base ["BaseModel"].
    const itemCreate = result.classDefinitions.find((d) => d.className === "ItemCreate");
    expect(itemCreate).toMatchObject({
      className: "ItemCreate",
      baseClassNames: ["BaseModel"],
      location: { file: "routers/items.py", line: 25 },
    });
    const itemResponse = result.classDefinitions.find((d) => d.className === "ItemResponse");
    expect(itemResponse).toMatchObject({
      className: "ItemResponse",
      baseClassNames: ["BaseModel"],
      location: { file: "routers/items.py", line: 32 },
    });
  });

  it("resolves import-derived model refs from routers/users.py (Req 2.1)", async () => {
    const tree = await parseFixture("routers/users.py");
    const result = extractSchemaInfo(tree, "routers/users.py");

    // get_user -> response UserResponse (import-derived).
    const getUserResp = pick(result.refCandidates, "get_user", "response");
    expect(getUserResp).toHaveLength(1);
    expect(getUserResp[0]?.role).toBe("response");
    expect(getUserResp[0]?.className).toBe("UserResponse");
    expect(getUserResp[0]?.localLocation).toBeNull();
    expect(getUserResp[0]?.importedQualifiedName).toContain("schemas.UserResponse");

    // create_user -> request UserRequest (import) AND response UserResponse (import).
    const createReq = pick(result.refCandidates, "create_user", "request");
    expect(createReq).toHaveLength(1);
    expect(createReq[0]?.className).toBe("UserRequest");
    expect(createReq[0]?.localLocation).toBeNull();
    expect(createReq[0]?.importedQualifiedName).toContain("schemas.UserRequest");

    const createResp = pick(result.refCandidates, "create_user", "response");
    expect(createResp).toHaveLength(1);
    expect(createResp[0]?.importedQualifiedName).toContain("schemas.UserResponse");
    expect(createResp[0]?.localLocation).toBeNull();

    // No top-level classes in users.py.
    expect(result.classDefinitions).toHaveLength(0);
  });

  it("collects class registry and no ref candidates from schemas.py (Req 2.1)", async () => {
    const tree = await parseFixture("schemas.py");
    const result = extractSchemaInfo(tree, "schemas.py");

    expect(result.refCandidates).toHaveLength(0);

    const userRequest = result.classDefinitions.find((d) => d.className === "UserRequest");
    expect(userRequest).toMatchObject({
      className: "UserRequest",
      baseClassNames: ["BaseModel"],
      location: { file: "schemas.py", line: 11 },
    });
    const userResponse = result.classDefinitions.find((d) => d.className === "UserResponse");
    expect(userResponse).toMatchObject({
      className: "UserResponse",
      baseClassNames: ["BaseModel"],
      location: { file: "schemas.py", line: 18 },
    });
  });
});
