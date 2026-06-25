/**
 * functionCopier.ts `copyLinkedChain` の単体テスト。
 *
 * `vscode` の openTextDocument / executeDocumentSymbolProvider / clipboard をモックし、
 * calls[] とルート連携を無向に辿った連結成分が収集されること、起点が双方向（呼ぶ側/呼ばれる側）
 * いずれでも全関数を取得できること、抽出失敗をスキップすることを検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkageOutput } from "../../route-linkage/models.js";
import type { LinkedFunctionNode } from "../../route-linkage/models.js";

const openTextDocumentMock = vi.fn();
const executeCommandMock = vi.fn();
const clipboardWriteMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: { openTextDocument: (p: string) => openTextDocumentMock(p) },
  commands: { executeCommand: (...a: unknown[]) => executeCommandMock(...a) },
  env: { clipboard: { writeText: (t: string) => clipboardWriteMock(t) } },
  SymbolKind: { Function: 11, Method: 5 },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
}));

const BE = "/be";
const FE = "/fe";

/** path(fsPath) → DocumentSymbol[] のレジストリ。 */
let symbolsByPath: Map<string, { name: string; kind: number; children: []; range: unknown }[]>;
/** openTextDocument が失敗するパス集合。 */
let missingPaths: Set<string>;

function fn(
  over: Partial<LinkedFunctionNode> & Pick<LinkedFunctionNode, "id" | "side">,
): LinkedFunctionNode {
  return {
    name: over.id.split(":")[1] ?? over.id,
    file: `${over.side}:file`,
    location: { file: "a.ts", line: 1 },
    calls: [],
    ...over,
  } as LinkedFunctionNode;
}

function buildOutput(
  functions: LinkedFunctionNode[],
  linkages: LinkageOutput["linkages"],
): LinkageOutput {
  return {
    schemaVersion: 1,
    linkages,
    unmatchedRoutes: [],
    unmatchedApiCalls: [],
    functions,
    files: [],
    warnings: [],
  };
}

/** functions からシンボルレジストリを構築する（path = root/location.file）。range は定義行(0始まり)を持つ。 */
function registerSymbols(functions: LinkedFunctionNode[]): void {
  symbolsByPath = new Map();
  for (const f of functions) {
    const root = f.side === "backend" ? BE : FE;
    const path = `${root}/${f.location.file}`;
    const list = symbolsByPath.get(path) ?? [];
    const startLine = f.location.line - 1;
    list.push({
      name: f.name,
      kind: 11,
      children: [],
      range: {
        start: { line: startLine, character: 0 },
        end: { line: startLine + 4, character: 0 },
        code: `code:${f.name}@${f.location.line}`,
      },
    });
    symbolsByPath.set(path, list);
  }
}

describe("copyLinkedChain", () => {
  beforeEach(() => {
    openTextDocumentMock.mockReset();
    executeCommandMock.mockReset();
    clipboardWriteMock.mockReset();
    missingPaths = new Set();

    openTextDocumentMock.mockImplementation((path: string) => {
      if (missingPaths.has(path)) return Promise.reject(new Error("not found"));
      return Promise.resolve({
        uri: { fsPath: path },
        getText: (range: { code: string }) => range.code,
      });
    });
    executeCommandMock.mockImplementation((_cmd: string, uri: { fsPath: string }) =>
      Promise.resolve(symbolsByPath.get(uri.fsPath) ?? []),
    );
  });

  it("calls[] とルート連携を無向に辿り連結成分の全関数を収集する（起点=呼ぶ側）", async () => {
    const functions = [
      fn({
        id: "frontend:index",
        side: "frontend",
        location: { file: "pages/index.vue", line: 1 },
        calls: ["frontend:fetchPosts", "frontend:fetchUser"],
      }),
      fn({
        id: "frontend:fetchPosts",
        side: "frontend",
        location: { file: "composables/usePosts.ts", line: 5 },
      }),
      fn({
        id: "frontend:fetchUser",
        side: "frontend",
        location: { file: "composables/useUser.ts", line: 3 },
      }),
      fn({
        id: "backend:getPosts",
        side: "backend",
        location: { file: "routers/posts.py", line: 10 },
        calls: ["backend:queryPosts"],
      }),
      fn({ id: "backend:queryPosts", side: "backend", location: { file: "db.py", line: 20 } }),
    ];
    const linkages = [
      {
        route: {
          method: "GET",
          path: "/api/posts",
          handler: { file: "routers/posts.py", line: 10 },
          entryFunctionId: "backend:getPosts",
          schemaRefs: [],
        },
        apiCall: {
          method: "GET",
          urlPattern: "/api/posts",
          enclosingFunctionId: "frontend:fetchPosts",
          location: { file: "composables/usePosts.ts", line: 6 },
        },
        matchKind: "exact" as const,
      },
    ];
    const output = buildOutput(functions, linkages);
    registerSymbols(functions);

    const count = await copyLinkedChainImport(output, "frontend:index");

    expect(count).toBe(5);
    const md = clipboardWriteMock.mock.calls[0][0] as string;
    for (const name of ["index", "fetchPosts", "fetchUser", "getPosts", "queryPosts"]) {
      expect(md).toContain(`\`${name}\``);
    }
    // 見出しは起点関数名
    expect(md).toContain("連携関数コピー — `index`");
  });

  it("呼ばれる側（バック末端）を起点にしても連結成分の全関数を取得する", async () => {
    const functions = [
      fn({
        id: "frontend:index",
        side: "frontend",
        location: { file: "pages/index.vue", line: 1 },
        calls: ["frontend:fetchPosts"],
      }),
      fn({
        id: "frontend:fetchPosts",
        side: "frontend",
        location: { file: "composables/usePosts.ts", line: 5 },
      }),
      fn({
        id: "backend:getPosts",
        side: "backend",
        location: { file: "routers/posts.py", line: 10 },
        calls: ["backend:queryPosts"],
      }),
      fn({ id: "backend:queryPosts", side: "backend", location: { file: "db.py", line: 20 } }),
    ];
    const linkages = [
      {
        route: {
          method: "GET",
          path: "/api/posts",
          handler: { file: "routers/posts.py", line: 10 },
          entryFunctionId: "backend:getPosts",
          schemaRefs: [],
        },
        apiCall: {
          method: "GET",
          urlPattern: "/api/posts",
          enclosingFunctionId: "frontend:fetchPosts",
          location: { file: "composables/usePosts.ts", line: 6 },
        },
        matchKind: "exact" as const,
      },
    ];
    const output = buildOutput(functions, linkages);
    registerSymbols(functions);

    const count = await copyLinkedChainImport(output, "backend:queryPosts");
    expect(count).toBe(4);
  });

  it("起点関数が存在しない場合は 0 を返しクリップボードに書き込まない", async () => {
    const output = buildOutput([], []);
    registerSymbols([]);
    const count = await copyLinkedChainImport(output, "frontend:missing");
    expect(count).toBe(0);
    expect(clipboardWriteMock).not.toHaveBeenCalled();
  });

  it("コードを抽出できない関数はスキップする（開けないファイル）", async () => {
    const functions = [
      fn({
        id: "frontend:a",
        side: "frontend",
        location: { file: "a.ts", line: 1 },
        calls: ["frontend:b"],
      }),
      fn({ id: "frontend:b", side: "frontend", location: { file: "b.ts", line: 1 } }),
    ];
    const output = buildOutput(functions, []);
    registerSymbols(functions);
    missingPaths.add(`${FE}/b.ts`); // b は開けない

    const count = await copyLinkedChainImport(output, "frontend:a");
    expect(count).toBe(1); // a のみ
  });
});

/** 動的 import（vi.mock 適用後に解決する）。 */
async function copyLinkedChainImport(output: LinkageOutput, focalId: string): Promise<number> {
  const { copyLinkedChain } = await import("../functionCopier.js");
  return copyLinkedChain(output, focalId, BE, FE);
}

async function copySelectedImport(output: LinkageOutput, ids: string[]): Promise<number> {
  const { copySelectedFunctions } = await import("../functionCopier.js");
  return copySelectedFunctions(output, ids, BE, FE);
}

describe("copySelectedFunctions", () => {
  beforeEach(() => {
    openTextDocumentMock.mockReset();
    executeCommandMock.mockReset();
    clipboardWriteMock.mockReset();
    missingPaths = new Set();
    openTextDocumentMock.mockImplementation((path: string) => {
      if (missingPaths.has(path)) return Promise.reject(new Error("not found"));
      return Promise.resolve({
        uri: { fsPath: path },
        getText: (range: { code: string }) => range.code,
      });
    });
    executeCommandMock.mockImplementation((_cmd: string, uri: { fsPath: string }) =>
      Promise.resolve(symbolsByPath.get(uri.fsPath) ?? []),
    );
  });

  it("指定 id の関数のみを Markdown でコピーする（連鎖しない）", async () => {
    const functions = [
      fn({
        id: "frontend:a",
        side: "frontend",
        location: { file: "a.ts", line: 1 },
        calls: ["frontend:b"],
      }),
      fn({ id: "frontend:b", side: "frontend", location: { file: "b.ts", line: 1 } }),
      fn({ id: "backend:c", side: "backend", location: { file: "c.py", line: 1 } }),
    ];
    const output = buildOutput(functions, []);
    registerSymbols(functions);

    // a と c だけ選択（b は a の callee だが連鎖しないので含めない）。
    const count = await copySelectedImport(output, ["frontend:a", "backend:c"]);
    expect(count).toBe(2);

    const md = clipboardWriteMock.mock.calls[0][0] as string;
    expect(md).toContain("# ApiVista: 選択枠コピー");
    expect(md).toContain("code:a");
    expect(md).toContain("code:c");
    expect(md).not.toContain("code:b"); // 連鎖で b を含めない
  });

  it("重複・非実在 id は無視し、抽出不能なら skip する", async () => {
    const functions = [
      fn({ id: "frontend:a", side: "frontend", location: { file: "a.ts", line: 1 } }),
      fn({ id: "frontend:b", side: "frontend", location: { file: "b.ts", line: 1 } }),
    ];
    const output = buildOutput(functions, []);
    registerSymbols(functions);
    missingPaths.add(`${FE}/b.ts`); // b は開けない

    const count = await copySelectedImport(output, [
      "frontend:a",
      "frontend:a",
      "frontend:b",
      "missing",
    ]);
    expect(count).toBe(1); // a のみ（重複・非実在・抽出不能を除外）
  });

  it("コピー対象が無ければ 0 を返し clipboard を呼ばない", async () => {
    const output = buildOutput([], []);
    registerSymbols([]);
    const count = await copySelectedImport(output, ["nope"]);
    expect(count).toBe(0);
    expect(clipboardWriteMock).not.toHaveBeenCalled();
  });

  it("同名・異 line の関数を line で正しく区別して抽出する（#3 誤キャプチャ防止）", async () => {
    // 同一ファイルに同名 'deviceSearch' が複数（ParamCreator/Fp/Factory 相当）。line で区別する。
    const functions = [
      fn({
        id: "frontend:pc",
        side: "frontend",
        name: "deviceSearch",
        location: { file: "client.ts", line: 10 },
      }),
      fn({
        id: "frontend:fp",
        side: "frontend",
        name: "deviceSearch",
        location: { file: "client.ts", line: 50 },
      }),
      fn({
        id: "frontend:factory",
        side: "frontend",
        name: "deviceSearch",
        location: { file: "client.ts", line: 90 },
      }),
    ];
    const output = buildOutput(functions, []);
    registerSymbols(functions);

    // line 50 の Fp 版だけを選択 → その行の関数が入る（先頭の line 10 ではない）。
    await copySelectedImport(output, ["frontend:fp"]);
    const md = clipboardWriteMock.mock.calls[0][0] as string;
    expect(md).toContain("code:deviceSearch@50");
    expect(md).not.toContain("code:deviceSearch@10");
    expect(md).not.toContain("code:deviceSearch@90");
  });
});
