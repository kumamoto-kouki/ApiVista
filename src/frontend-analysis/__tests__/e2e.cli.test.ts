/**
 * E2E テスト（task 6.2 / design.md「Testing Strategy / E2E Tests」,
 * Requirements 3.1, 4.3, 5.1, 5.4）。backend `src/backend-analysis/__tests__/e2e.cli.test.ts`
 * の対称実装。
 *
 * 他のテスト（cli.test.ts はインプロセスで `main` を呼ぶ、index.test.ts / integration は
 * 公開 API を直接呼ぶ）と異なり、本テストは **ビルド済みの成果物**
 * (`out/frontend-analysis/cli.js`) を `node` の **サブプロセス**として起動し、
 * stdout / stderr / 終了コードを観測する。これにより、配布される成果物が
 * 外部ランタイム（Python / uv 等）無しに Node + 純JS依存だけで完走することを
 * 実証する（Requirement 5.4 / design「拡張を導入するだけで動作する」）。
 *
 * ビルド前提: `beforeAll` で `npx tsc -p tsconfig.json` を実行し、
 * `out/frontend-analysis/cli.js` を最新化する（テストを自己完結させる）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// src/frontend-analysis/__tests__ -> repo root
const REPO_ROOT = resolve(here, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "out", "frontend-analysis", "cli.js");
// CLI には frontendRoot を相対パスで渡す（cwd = repo root）。
const SAMPLE_NUXT = "tests/fixtures/sample_nuxt";

interface AnalysisOutputShape {
  schemaVersion: number;
  apiCalls: { method: string; urlPattern: string; enclosingFunctionId: string }[];
  functions: { id: string; file: string }[];
  files: { id: string }[];
  warnings: { target: string; reason: string }[];
}

/** ビルド済み CLI を node サブプロセスとして起動し、観測結果を返す。 */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // 外部ランタイム不要であることを示すため、特別な env は与えない（Req 5.4）。
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("frontend-analysis CLI (E2E, compiled artifact via subprocess)", () => {
  beforeAll(() => {
    // テストを自己完結させるためビルドを最新化する（tsc に時間がかかるため
    // タイムアウトは広めに取る。backend e2e と同じ手順）。
    const build = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(build.status, `tsc build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(CLI), `compiled CLI not found at ${CLI}`).toBe(true);
  }, 120_000);

  it("success: exit 0, single JSON on stdout, schemaVersion=1, dynamic-URL & syntax warnings, Node-only (Req 3.1, 4.3, 5.1, 5.4)", () => {
    const { status, stdout, stderr } = runCli([SAMPLE_NUXT]);

    // 部分的失敗（構文/SFC エラー・動的 URL）があっても解析は成立し exit 0（Req 5.1）。
    expect(status, `expected exit 0, got ${status}. stderr:\n${stderr}`).toBe(0);

    // stdout は単一の有効な JSON（Req 3.1 / 4.3: stdout は JSON 専用）。
    const output = JSON.parse(stdout) as AnalysisOutputShape;
    expect(output.schemaVersion).toBe(1);
    expect(Array.isArray(output.apiCalls)).toBe(true);
    expect(Array.isArray(output.functions)).toBe(true);
    expect(Array.isArray(output.files)).toBe(true);
    expect(output.apiCalls.length).toBeGreaterThan(0);

    // stderr に JSON ペイロードが混入していないこと（stdout/stderr 分離, Req 4.3）。
    expect(stderr.includes('"schemaVersion"')).toBe(false);
    expect(stderr.includes('"apiCalls"')).toBe(false);

    // 参照貫通: apiCall.enclosingFunctionId ∈ functions[].id かつ その関数の file ∈ files[].id（Req 3.1）。
    const functionById = new Map(output.functions.map((f) => [f.id, f]));
    const fileIds = new Set(output.files.map((f) => f.id));
    for (const call of output.apiCalls) {
      const fn = functionById.get(call.enclosingFunctionId);
      expect(
        fn,
        `apiCall ${call.method} ${call.urlPattern} enclosingFunctionId missing`,
      ).toBeDefined();
      expect(fileIds.has(fn?.file ?? "")).toBe(true);
    }

    // warnings: 完全動的 URL（composables/useUserApi.ts の axios.get(buildUrl())）と
    // 構文/SFC エラー（useBroken.ts / BrokenWidget.vue）の双方を含む（Req 4.3 / 5.1）。
    expect(output.warnings.length).toBeGreaterThan(0);
    expect(
      output.warnings.some(
        (w) =>
          w.target === "composables/useUserApi.ts" && /not statically determinable/i.test(w.reason),
      ),
      "expected a dynamic-URL warning on composables/useUserApi.ts",
    ).toBe(true);
    expect(
      output.warnings.some(
        (w) => w.target === "composables/useBroken.ts" && /syntax error/i.test(w.reason),
      ),
      "expected a syntax-error warning on composables/useBroken.ts",
    ).toBe(true);
    expect(
      output.warnings.some(
        (w) => w.target === "components/BrokenWidget.vue" && /syntax error|end tag/i.test(w.reason),
      ),
      "expected an SFC parse-error warning on components/BrokenWidget.vue",
    ).toBe(true);
  }, 60_000);

  it("invalid arg: nonexistent directory -> non-zero exit, error on stderr, no JSON on stdout (Req 5.1)", () => {
    const { status, stdout, stderr } = runCli(["/nonexistent/dir/xyz"]);

    expect(status).not.toBe(0);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);

  it("invalid arg: no frontendRoot -> exit 2, usage on stderr, no JSON on stdout", () => {
    const { status, stdout, stderr } = runCli([]);

    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);
});
