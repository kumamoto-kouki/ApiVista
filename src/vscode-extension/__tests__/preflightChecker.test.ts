/**
 * preflightChecker.ts の単体テスト。
 *
 * node:fs 関数をモックし、WASM ファイル有無・Python ファイル有無・
 * プロジェクト Python バージョン設定の各チェックを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn<[string], boolean>();
const readdirSyncMock = vi.fn();
const readFileSyncMock = vi.fn<[string, string], string>();

vi.mock("node:fs", () => ({
  existsSync: (p: string) => existsSyncMock(p),
  readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
  readFileSync: (p: string, enc: string) => readFileSyncMock(p, enc),
}));

/** ファイル用 Dirent モック。 */
function fileDirent(name: string) {
  return { name, isFile: () => true, isDirectory: () => false };
}

/** ディレクトリ用 Dirent モック。 */
function dirDirent(name: string) {
  return { name, isFile: () => false, isDirectory: () => true };
}

const BACKEND = "/workspace/backend";
const WASM_DIR = "/ext/media/wasm";

describe("preflightChecker.checkPreflight", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    readFileSyncMock.mockReset();

    // デフォルト: すべての条件を満たす
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith("tree-sitter.wasm") || p.endsWith("tree-sitter-python.wasm")) return true;
      if (p.endsWith(".python-version") || p.endsWith("pyproject.toml")) return false;
      return false;
    });
    // backend/ に main.py が存在する
    readdirSyncMock.mockReturnValue([fileDirent("main.py"), fileDirent("requirements.txt")]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  // --- WASM ファイルチェック ---

  it("tree-sitter.wasm が不在の場合 PreflightError をスローする", async () => {
    existsSyncMock.mockImplementation((p: string) => !p.endsWith("tree-sitter.wasm"));

    const { checkPreflight, PreflightError } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(PreflightError);
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow("tree-sitter.wasm");
  });

  it("tree-sitter-python.wasm が不在の場合 PreflightError をスローする", async () => {
    existsSyncMock.mockImplementation((p: string) => !p.endsWith("tree-sitter-python.wasm"));

    const { checkPreflight, PreflightError } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(PreflightError);
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow("tree-sitter-python.wasm");
  });

  it("WASM ファイルがすべて存在する場合はエラーをスローしない", async () => {
    const { checkPreflight } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).not.toThrow();
  });

  // --- Python ファイルチェック ---

  it("backend/ に .py ファイルがない場合 PreflightError をスローする", async () => {
    readdirSyncMock.mockReturnValue([fileDirent("requirements.txt"), fileDirent("README.md")]);

    const { checkPreflight, PreflightError } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(PreflightError);
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(".py");
  });

  it("backend/ の 1 段深いサブディレクトリに .py ファイルがある場合はエラーをスローしない", async () => {
    // hasPy(root) × 1 + for-loop listing(root) × 1 + hasPy(app/) × 1 = 計 3 回呼ばれる
    readdirSyncMock.mockImplementation((dir: string) => {
      if (dir === BACKEND) return [dirDirent("app"), fileDirent("requirements.txt")];
      if (dir.endsWith("/app")) return [fileDirent("main.py")];
      return [];
    });

    const { checkPreflight } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).not.toThrow();
  });

  // --- プロジェクト Python バージョンチェック ---

  it(".python-version が Python 3.8 未満の場合 PreflightError をスローする", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith("tree-sitter.wasm") || p.endsWith("tree-sitter-python.wasm")) return true;
      if (p.endsWith(".python-version")) return true;
      return false;
    });
    readFileSyncMock.mockReturnValue("3.7.18\n");

    const { checkPreflight, PreflightError } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(PreflightError);
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow("3.7");
  });

  it(".python-version が Python 2.x の場合 PreflightError をスローする", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith("tree-sitter.wasm") || p.endsWith("tree-sitter-python.wasm")) return true;
      if (p.endsWith(".python-version")) return true;
      return false;
    });
    readFileSyncMock.mockReturnValue("2.7.18\n");

    const { checkPreflight, PreflightError } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(PreflightError);
  });

  it(".python-version が Python 3.8 の場合はエラーをスローしない（境界値）", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith("tree-sitter.wasm") || p.endsWith("tree-sitter-python.wasm")) return true;
      if (p.endsWith(".python-version")) return true;
      return false;
    });
    readFileSyncMock.mockReturnValue("3.8.0\n");

    const { checkPreflight } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).not.toThrow();
  });

  it("pyproject.toml の requires-python が 3.7 の場合 PreflightError をスローする", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith("tree-sitter.wasm") || p.endsWith("tree-sitter-python.wasm")) return true;
      if (p.endsWith("pyproject.toml")) return true;
      return false;
    });
    readFileSyncMock.mockReturnValue(`[project]\nrequires-python = ">=3.7"\n`);

    const { checkPreflight, PreflightError } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).toThrow(PreflightError);
  });

  it("pyproject.toml の Poetry python が 3.11 の場合はエラーをスローしない", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith("tree-sitter.wasm") || p.endsWith("tree-sitter-python.wasm")) return true;
      if (p.endsWith("pyproject.toml")) return true;
      return false;
    });
    readFileSyncMock.mockReturnValue(`[tool.poetry.dependencies]\npython = "^3.11"\n`);

    const { checkPreflight } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).not.toThrow();
  });

  it("Python バージョン設定ファイルがない場合はバージョンチェックをスキップしエラーをスローしない", async () => {
    // existsSyncMock のデフォルト: .python-version / pyproject.toml は false
    const { checkPreflight } = await import("../preflightChecker.js");
    expect(() => checkPreflight(BACKEND, WASM_DIR)).not.toThrow();
  });
});
