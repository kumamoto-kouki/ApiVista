/**
 * 解析前の実行環境チェック。条件を満たさない場合は `PreflightError` をスローする。
 *
 * 設計原則: エンドユーザーへの外部ランタイム要求なし（tech.md / Requirement 8.1）。
 * Python インタープリタは実行しない。バージョン確認はプロジェクトの設定ファイルから読む。
 *
 * 検証項目:
 * 1. WASM ファイル（tree-sitter.wasm / tree-sitter-python.wasm）が wasmDir に存在する
 * 2. backend/ ディレクトリに Python ファイル (.py) が存在する
 * 3. プロジェクト設定が FastAPI 最低要件 (Python 3.8) を満たす（設定ファイルがある場合のみ）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

const PYTHON_MIN_MAJOR = 3;
const PYTHON_MIN_MINOR = 8;
const FASTAPI_MIN_LABEL = `Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}`;

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

/** WASM ファイルが wasmDir に存在するか確認する。 */
function assertWasmFiles(wasmDir: string): void {
  const required = ["tree-sitter.wasm", "tree-sitter-python.wasm"];
  const missing = required.filter((f) => !existsSync(join(wasmDir, f)));
  if (missing.length > 0) {
    throw new PreflightError(
      `解析エンジン (WASM) ファイルが見つかりません: ${missing.join(", ")}\n` +
        `拡張機能を再インストールするか、ApiVista 開発者にご連絡ください。\n` +
        `確認先: ${wasmDir}`,
    );
  }
}

/** backendRoot に .py ファイルが存在するか確認する（ルート + 1段深いサブディレクトリ）。 */
function assertPythonFiles(backendRoot: string): void {
  // ルートの listing は1回だけ取得し、直下の .py 判定とサブディレクトリ列挙の両方に再利用する。
  let rootEntries: Dirent[];
  try {
    rootEntries = readdirSync(backendRoot, { withFileTypes: true });
  } catch {
    // ルートを読めない（アクセス権限等）場合は .py 不在と同様に扱う。
    rootEntries = [];
  }

  if (rootEntries.some((e) => e.isFile() && e.name.endsWith(".py"))) return;

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    try {
      const hasPy = readdirSync(join(backendRoot, entry.name), { withFileTypes: true }).some(
        (e) => e.isFile() && e.name.endsWith(".py"),
      );
      if (hasPy) return;
    } catch {
      // サブディレクトリ読み取り失敗は無視して次へ。
    }
  }

  throw new PreflightError(
    `backend/ ディレクトリに Python ファイル (.py) が見つかりません。\n` +
      `FastAPI プロジェクトの backend/ ディレクトリが正しく設定されているか確認してください。\n` +
      `確認先: ${backendRoot}`,
  );
}

/**
 * プロジェクトの設定ファイルから Python バージョンを読み取る。
 * 読み取れない場合は null を返す（チェックをスキップするため）。
 *
 * 対応ファイル:
 * - `.python-version`（pyenv）: `3.8.18`
 * - `pyproject.toml` の `requires-python`（PEP 518）または `python =`（Poetry）
 */
function readProjectPythonVersion(backendRoot: string): { major: number; minor: number } | null {
  // .python-version (pyenv)
  const pvFile = join(backendRoot, ".python-version");
  if (existsSync(pvFile)) {
    try {
      const m = readFileSync(pvFile, "utf8")
        .trim()
        .match(/^(\d+)\.(\d+)/);
      if (m) return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
    } catch {
      /* ignore read errors */
    }
  }

  // pyproject.toml
  const pyproject = join(backendRoot, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const content = readFileSync(pyproject, "utf8");
      // PEP 518: requires-python = ">=3.8"
      let m = content.match(/requires-python\s*=\s*["'][><=~^!]*(\d+)\.(\d+)/);
      // Poetry: python = "^3.8"
      if (!m) m = content.match(/^\s*python\s*=\s*["'][><=~^!]*(\d+)\.(\d+)/m);
      if (m) return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
    } catch {
      /* ignore read errors */
    }
  }

  return null;
}

/** プロジェクトの Python バージョン設定が FastAPI 最低要件を満たすか確認する。 */
function assertProjectPythonVersion(backendRoot: string): void {
  const v = readProjectPythonVersion(backendRoot);
  if (v === null) return; // 設定ファイルなし → チェックをスキップ

  if (v.major < PYTHON_MIN_MAJOR || (v.major === PYTHON_MIN_MAJOR && v.minor < PYTHON_MIN_MINOR)) {
    throw new PreflightError(
      `プロジェクトの Python バージョン (${v.major}.${v.minor}) が ` +
        `FastAPI の最低要件 (${FASTAPI_MIN_LABEL}) を下回っています。\n` +
        `pyproject.toml / .python-version を更新し、${FASTAPI_MIN_LABEL} 以上を指定してください。`,
    );
  }
}

/**
 * 解析前提条件を検証する。条件を満たさない場合は `PreflightError` をスローする。
 *
 * @param backendRoot 解析対象 backend ディレクトリの絶対パス
 * @param wasmDir 解析エンジン WASM ファイルのディレクトリ（拡張機能バンドル内）
 */
export function checkPreflight(backendRoot: string, wasmDir: string): void {
  assertWasmFiles(wasmDir);
  assertPythonFiles(backendRoot);
  assertProjectPythonVersion(backendRoot);
}
