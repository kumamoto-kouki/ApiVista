/**
 * 公開API `analyzeFrontend`（design.md「index — analyzeFrontend」, Req 3.1, 5.1, 5.2, 5.3, 5.4）の単体/統合テスト。
 *
 * - `sample_nuxt`（実フィクスチャ）に対し単一 `AnalysisOutput`（schemaVersion=1）を返し、
 *   apiCalls/functions/files/warnings が埋まり、参照貫通（ApiCall→FunctionNode→FileNode）する（Req3.1/3.2）。
 * - 構文/SFC エラーファイルがあっても throw せず値を返し、警告に記録する（部分実行, Req4.x）。
 * - 不在パス / ファイルパス（非ディレクトリ）では throw する（入力検証, Req5.1）。
 * - ts-morph / @vue/compiler-sfc は純JS のため、外部ランタイムの別途インストール無しに同期完了する（Req5.2/5.4）。
 */
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeFrontend } from "../index.js";
import { isAnalysisOutput, SCHEMA_VERSION } from "../models.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

describe("analyzeFrontend — input validation (Req 5.1)", () => {
  it("不在パスでは throw する", () => {
    const missing = resolve(SAMPLE_NUXT, "__does_not_exist__");
    expect(() => analyzeFrontend(missing)).toThrow();
  });

  it("ディレクトリでないパス（ファイル）では throw する", () => {
    const filePath = resolve(SAMPLE_NUXT, "pages/users.vue");
    expect(() => analyzeFrontend(filePath)).toThrow();
  });
});

describe("analyzeFrontend — single AnalysisOutput over sample_nuxt (Req 3.1, 3.2, 5.x)", () => {
  it("schemaVersion=1 の単一 AnalysisOutput を同期で返す", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);

    expect(isAnalysisOutput(output)).toBe(true);
    expect(output.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Array.isArray(output.apiCalls)).toBe(true);
    expect(Array.isArray(output.functions)).toBe(true);
    expect(Array.isArray(output.files)).toBe(true);
    expect(Array.isArray(output.warnings)).toBe(true);
  });

  it("apiCalls / functions / files が抽出される（空でない）", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);

    expect(output.apiCalls.length).toBeGreaterThan(0);
    expect(output.functions.length).toBeGreaterThan(0);
    expect(output.files.length).toBeGreaterThan(0);
  });

  it("参照貫通: 各 ApiCall.enclosingFunctionId が実在 FunctionNode.id を指す", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);
    const functionIds = new Set(output.functions.map((f) => f.id));

    for (const call of output.apiCalls) {
      expect(call.enclosingFunctionId).not.toBe("");
      expect(functionIds.has(call.enclosingFunctionId)).toBe(true);
    }
  });

  it("参照貫通: 各 FunctionNode.file が実在 FileNode.id を指す", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);
    const fileIds = new Set(output.files.map((f) => f.id));

    for (const fn of output.functions) {
      expect(fileIds.has(fn.file)).toBe(true);
    }
  });

  it("参照貫通: calls[] / dependsOn[] が実在 id を指す", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);
    const functionIds = new Set(output.functions.map((f) => f.id));
    const fileIds = new Set(output.files.map((f) => f.id));

    for (const fn of output.functions) {
      for (const calleeId of fn.calls) {
        expect(functionIds.has(calleeId)).toBe(true);
      }
    }
    for (const file of output.files) {
      for (const depId of file.dependsOn) {
        expect(fileIds.has(depId)).toBe(true);
      }
    }
  });

  it("到達経路: ページ→子コンポーネント→composable→API が calls で連結する", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);

    // useUserApi の API 呼び出しを内包する composable ノードが存在する。
    const apiNodeIds = new Set(output.apiCalls.map((c) => c.enclosingFunctionId));
    expect(apiNodeIds.size).toBeGreaterThan(0);

    // API を内包するいずれかのノードへ、他ノードから到達するエッジが存在する
    // （= 呼び出しグラフが孤立点だけではなく連結している）。
    const hasIncomingEdgeToApiNode = output.functions.some((fn) =>
      fn.calls.some((calleeId) => apiNodeIds.has(calleeId)),
    );
    expect(hasIncomingEdgeToApiNode).toBe(true);
  });
});

describe("analyzeFrontend — partial execution & warnings (Req 4.x, 5.2)", () => {
  it("構文/SFCエラーや動的URLがあっても throw せず警告に記録して値を返す", () => {
    const output = analyzeFrontend(SAMPLE_NUXT);

    // フィクスチャには構文エラー(useBroken.ts)・SFCエラー(BrokenWidget.vue)・完全動的URLが含まれる。
    expect(output.warnings.length).toBeGreaterThan(0);
    for (const warning of output.warnings) {
      expect(typeof warning.target).toBe("string");
      expect(typeof warning.reason).toBe("string");
    }
  });

  it("決定的: 同一入力に対し同一出力を返す", () => {
    const a = analyzeFrontend(SAMPLE_NUXT);
    const b = analyzeFrontend(SAMPLE_NUXT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
