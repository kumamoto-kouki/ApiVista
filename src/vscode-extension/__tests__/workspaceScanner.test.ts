/**
 * workspaceScanner（design.md「workspaceScanner」, Requirements 2.1, 2.2, 2.5）の単体テスト。
 *
 * `workspaceScanner.ts` は `vscode.workspace.workspaceFolders` を実行時に参照するため、
 * 実VSCodeホスト外で動くvitestではこのモジュールは解決できない。`vi.mock("vscode", ...)`で
 * `workspaceFolders` をテストごとに差し替え可能なフェイクに置き換える。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `WorkspaceFolder`の最小フェイク（`@types/vscode`の`uri.fsPath`/`name`/`index`のみ使用）。 */
interface FakeWorkspaceFolder {
  uri: { fsPath: string };
  name: string;
  index: number;
}

let workspaceFolders: FakeWorkspaceFolder[] | undefined;

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceFolders;
    },
  },
}));

function makeFolder(fsPath: string, index = 0): FakeWorkspaceFolder {
  return { uri: { fsPath }, name: fsPath, index };
}

describe("workspaceScanner.validate", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "workspace-scanner-"));
    workspaceFolders = undefined;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ワークスペースが開かれていない場合（0件）はScopeError(multi-root)をthrowする", async () => {
    workspaceFolders = undefined;

    const { validate, ScopeError } = await import("../workspaceScanner.js");

    expect(() => validate()).toThrow(ScopeError);
    try {
      validate();
      expect.fail("ScopeErrorがthrowされるべき");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as InstanceType<typeof ScopeError>).reason).toBe("multi-root");
    }
  });

  it("複数のワークスペースフォルダ（マルチルート）の場合はScopeError(multi-root)をthrowする", async () => {
    const second = mkdtempSync(join(tmpdir(), "workspace-scanner-second-"));
    try {
      workspaceFolders = [makeFolder(tempRoot, 0), makeFolder(second, 1)];

      const { validate, ScopeError } = await import("../workspaceScanner.js");

      try {
        validate();
        expect.fail("ScopeErrorがthrowされるべき");
      } catch (error) {
        expect(error).toBeInstanceOf(ScopeError);
        expect((error as InstanceType<typeof ScopeError>).reason).toBe("multi-root");
      }
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("単一フォルダでbackend/が不在の場合はScopeError(missing-backend)をthrowする", async () => {
    mkdirSync(join(tempRoot, "frontend"));
    workspaceFolders = [makeFolder(tempRoot)];

    const { validate, ScopeError } = await import("../workspaceScanner.js");

    try {
      validate();
      expect.fail("ScopeErrorがthrowされるべき");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as InstanceType<typeof ScopeError>).reason).toBe("missing-backend");
    }
  });

  it("単一フォルダでfrontend/が不在の場合はScopeError(missing-frontend)をthrowする", async () => {
    mkdirSync(join(tempRoot, "backend"));
    workspaceFolders = [makeFolder(tempRoot)];

    const { validate, ScopeError } = await import("../workspaceScanner.js");

    try {
      validate();
      expect.fail("ScopeErrorがthrowされるべき");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as InstanceType<typeof ScopeError>).reason).toBe("missing-frontend");
    }
  });

  it("単一フォルダでbackend/・frontend/が両方存在する場合は絶対パスを返す", async () => {
    mkdirSync(join(tempRoot, "backend"));
    mkdirSync(join(tempRoot, "frontend"));
    workspaceFolders = [makeFolder(tempRoot)];

    const { validate } = await import("../workspaceScanner.js");

    const result = validate();

    expect(result).toEqual({
      backendRoot: join(tempRoot, "backend"),
      frontendRoot: join(tempRoot, "frontend"),
    });
  });

  it("backendという名前のファイル（ディレクトリでない）はbackend/存在の代わりにならない", async () => {
    writeFileSync(join(tempRoot, "backend"), "not a directory");
    mkdirSync(join(tempRoot, "frontend"));
    workspaceFolders = [makeFolder(tempRoot)];

    const { validate, ScopeError } = await import("../workspaceScanner.js");

    try {
      validate();
      expect.fail("ScopeErrorがthrowされるべき");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as InstanceType<typeof ScopeError>).reason).toBe("missing-backend");
    }
  });
});
