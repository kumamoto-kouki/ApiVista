/**
 * 開発 / E2E 用 CLI ラッパ `cli.ts`（design.md「cli.ts」, Req 3.1, 4.3, 5.1）の単体テスト。
 *
 * 契約:
 * - stdout には単一 JSON（AnalysisOutput）のみ。JSON.parse 可能で他文字列を混ぜない（Req3.1）。
 * - ログ / 診断は stderr（Req4.3）。
 * - frontendRoot 引数が無い → usage を stderr に出し非0（2）終了。
 * - 解析が成立すれば warnings を含んでも 0 終了（部分実行成功, Req5.1）。
 * - frontendRoot が不在 / 非ディレクトリ（analyzeFrontend が throw）→ stderr にエラー・非0（1）終了。
 */
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../cli.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

interface Captured {
  stdout: string[];
  stderr: string[];
}

function captureStreams(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: [], stderr: [] };
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  return {
    captured,
    restore: (): void => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("cli main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sample_nuxt 解析: exit 0・stdout は単一 JSON・stderr に JSON を混ぜない（Req 3.1, 5.1）", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([SAMPLE_NUXT]);
    } finally {
      restore();
    }

    expect(code).toBe(0);

    // stdout は単一の JSON ペイロード（AnalysisOutput）でなければならない。
    const stdout = captured.stdout.join("");
    const parsed: unknown = JSON.parse(stdout);
    expect(typeof parsed).toBe("object");
    const output = parsed as {
      schemaVersion: number;
      apiCalls: unknown[];
      functions: unknown[];
      files: unknown[];
      warnings: unknown[];
    };
    expect(output.schemaVersion).toBe(1);
    expect(Array.isArray(output.apiCalls)).toBe(true);
    expect(Array.isArray(output.functions)).toBe(true);
    expect(Array.isArray(output.files)).toBe(true);

    // フィクスチャは構文/SFC エラー・動的 URL を含むため warnings があるが、exit は 0（Req5.1）。
    expect(output.warnings.length).toBeGreaterThan(0);

    // stderr に JSON ペイロードを混ぜない（stdout は JSON 専用）。
    const stderr = captured.stderr.join("");
    expect(stderr.includes('"schemaVersion"')).toBe(false);
  });

  it("frontendRoot 引数が無いと usage を stderr に出し 2 を返す", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([]);
    } finally {
      restore();
    }

    expect(code).toBe(2);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });

  it("不在ディレクトリでは非0（1）でエラーを stderr に出す", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main(["/nonexistent/path/xyz"]);
    } finally {
      restore();
    }

    expect(code).toBe(1);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });

  it("ディレクトリでないパス（ファイル）でも非0（1）終了", () => {
    const filePath = resolve(SAMPLE_NUXT, "pages/users.vue");
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([filePath]);
    } finally {
      restore();
    }

    expect(code).toBe(1);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });
});
