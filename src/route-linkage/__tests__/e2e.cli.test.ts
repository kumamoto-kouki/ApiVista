/**
 * E2E テスト(design.md「Testing Strategy / E2E(cli)」、タスク5.2, Req6.1/7.2)。
 *
 * 他のテスト(cli.test.ts はインプロセスで `main` を呼ぶ、index.test.ts / integration.test.ts
 * は公開API `linkRoutes` を直接呼ぶ)と異なり、本テストは**ビルド済みの成果物**
 * (`out/route-linkage/cli.js`)を `node` の**サブプロセス**として起動し、stdout / stderr /
 * 終了コードを観測する。これにより、配布される成果物が外部ランタイム無しに Node だけで
 * 完走することを証明する(design.md「対象コードを実行しない」「外部ランタイム不要」)。
 *
 * ビルド前提: `beforeAll` で `npx tsc -p tsconfig.json` を実行し、
 * `out/route-linkage/cli.js` を最新化する(テストを自己完結させる)。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// src/route-linkage/__tests__ -> repo root
const REPO_ROOT = resolve(here, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "out", "route-linkage", "cli.js");
// CLI にはフィクスチャパスを相対パスで渡す(cwd = repo root)。
const BACKEND_JSON = "tests/fixtures/route-linkage/backend.analysis.json";
const FRONTEND_JSON = "tests/fixtures/route-linkage/frontend.analysis.json";

interface LinkageOutputShape {
  schemaVersion: number;
  linkages: unknown[];
  unmatchedRoutes: unknown[];
  unmatchedApiCalls: unknown[];
}

/** ビルド済み CLI を node サブプロセスとして起動し、観測結果を返す。 */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // 外部ランタイム不要であることを示すため、特別な env は与えない。
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("route-linkage CLI (E2E, compiled artifact via subprocess)", () => {
  beforeAll(() => {
    // テストを自己完結させるためビルドを最新化する。
    const build = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(build.status, `tsc build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(CLI), `compiled CLI not found at ${CLI}`).toBe(true);
  }, 120_000);

  it("success: exit 0, single JSON on stdout, no JSON leak on stderr, completes without an external runtime (Req6.1/7.2)", () => {
    const { status, stdout, stderr } = runCli([BACKEND_JSON, FRONTEND_JSON]);

    expect(status).toBe(0);

    // stdout は単一の有効な JSON のみ。
    const output = JSON.parse(stdout) as LinkageOutputShape;
    expect(output.schemaVersion).toBe(1);
    expect(output.linkages.length).toBeGreaterThan(0);

    // stdout/stderr 分離: stderr に JSON ペイロードが混入していないこと。
    expect(stderr.includes('"schemaVersion"')).toBe(false);
    expect(stderr.includes('"linkages"')).toBe(false);
  }, 60_000);

  it("invalid arg: missing frontend path -> exit 2, usage on stderr, no JSON on stdout", () => {
    const { status, stdout, stderr } = runCli([BACKEND_JSON]);

    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);

  it("invalid arg: no arguments -> exit 2, usage on stderr, no JSON on stdout", () => {
    const { status, stdout, stderr } = runCli([]);

    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);

  it("invalid file: nonexistent backend path -> non-zero exit, error on stderr, no JSON on stdout", () => {
    const { status, stdout, stderr } = runCli([
      "tests/fixtures/route-linkage/nonexistent.json",
      FRONTEND_JSON,
    ]);

    expect(status).not.toBe(0);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);
});
