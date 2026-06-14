/**
 * E2E テスト（task 5.2 / design.md「Testing Strategy / E2E Tests」,
 * Requirements 4.1, 4.3, 5.1, 5.3, 6.1, 6.4）。
 *
 * 他のテスト（cli.test.ts はインプロセスで `main` を呼ぶ、index.test.ts / integration は
 * 公開 API を直接呼ぶ）と異なり、本テストは **ビルド済みの成果物**
 * (`out/backend-analysis/cli.js`) を `node` の **サブプロセス**として起動し、
 * stdout / stderr / 終了コードを観測する。これにより、配布される成果物が
 * 外部ランタイム（Python / uv）無しに Node + 同梱 WASM だけで完走することを証明する
 * （Requirement 6.4）。
 *
 * ビルド前提: `beforeAll` で `npx tsc -p tsconfig.json` を実行し、
 * `out/backend-analysis/cli.js` を最新化する（テストを自己完結させる）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root
const REPO_ROOT = resolve(here, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "out", "backend-analysis", "cli.js");
// CLI には backendRoot を相対パスで渡す（cwd = repo root）。
const SAMPLE_APP = "tests/fixtures/sample_app";

interface AnalysisOutputShape {
  schemaVersion: number;
  routes: { method: string; path: string; entryFunctionId: string }[];
  functions: { id: string; file: string }[];
  files: { id: string }[];
  warnings: { target: string; reason: string }[];
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

describe("backend-analysis CLI (E2E, compiled artifact via subprocess)", () => {
  beforeAll(() => {
    // テストを自己完結させるためビルドを最新化する（tsc + 後続の WASM ロードに
    // 時間がかかるためタイムアウトは広めに取る）。
    const build = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(build.status, `tsc build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(CLI), `compiled CLI not found at ${CLI}`).toBe(true);
  }, 120_000);

  it("success: exit 0, single JSON on stdout, route->function->file integrity, warnings (Req 4.1, 4.3, 5.1, 5.3, 6.1, 6.4)", () => {
    const { status, stdout, stderr } = runCli([SAMPLE_APP]);

    // 部分的失敗（broken.py / dynamic route）があっても解析は成立し exit 0（Req 5.1）。
    expect(status).toBe(0);

    // stdout は単一の有効な JSON（Req 4.3: stdout は JSON 専用）。
    const output = JSON.parse(stdout) as AnalysisOutputShape;
    expect(output.schemaVersion).toBe(1);
    expect(output.routes.length).toBe(4);

    // stderr に JSON ペイロードが混入していないこと（stdout/stderr 分離, Req 4.3）。
    expect(stderr.includes('"schemaVersion"')).toBe(false);
    expect(stderr.includes('"routes"')).toBe(false);

    // 参照貫通: route.entryFunctionId ∈ functions[].id かつ その関数の file ∈ files[].id（Req 4.1）。
    const functionById = new Map(output.functions.map((f) => [f.id, f]));
    const fileIds = new Set(output.files.map((f) => f.id));
    expect(output.routes.length).toBeGreaterThan(0);
    for (const route of output.routes) {
      const fn = functionById.get(route.entryFunctionId);
      expect(fn, `route ${route.method} ${route.path} entryFunctionId missing`).toBeDefined();
      expect(fileIds.has(fn?.file ?? "")).toBe(true);
    }

    // warnings: 構文エラー（broken.py）と未解決の動的ルート（get_dynamic_item）の双方を含む（Req 5.3 / 5.1）。
    expect(output.warnings.some((w) => w.target === "routers/broken.py")).toBe(true);
    expect(output.warnings.some((w) => w.target.endsWith(":get_dynamic_item"))).toBe(true);
  }, 60_000);

  it("invalid arg: nonexistent directory -> non-zero exit, error on stderr, no JSON on stdout", () => {
    const { status, stdout, stderr } = runCli(["/nonexistent/dir/xyz"]);

    expect(status).not.toBe(0);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);

  it("invalid arg: no backendRoot -> exit 2, usage on stderr, no JSON on stdout", () => {
    const { status, stdout, stderr } = runCli([]);

    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);
});
