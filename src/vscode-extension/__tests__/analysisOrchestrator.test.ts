/**
 * analysisOrchestrator（design.md「analysisOrchestrator」, Requirements 2.1, 2.3, 6.2, 8.2）の単体テスト。
 *
 * `analyzeBackend`（真の非同期・WASM初期化を伴う）→`analyzeFrontend`（同期）→`linkRoutes`（同期）の
 * 順次呼び出しと、いずれかがthrow/rejectした場合の`AnalysisError`ラップ・伝播を検証する。
 * 実モジュール（`../backend-analysis/index.js` 等）は `vi.mock` で完全に差し替え、呼び出し順序・
 * 引数・エラー伝播のみをテストする（実WASM初期化やファイルI/Oは発生させない）。
 */
import { describe, expect, it, vi } from "vitest";

import type { AnalysisOutput as BackendAnalysisOutput } from "../../backend-analysis/index.js";
import type { AnalysisOutput as FrontendAnalysisOutput } from "../../frontend-analysis/index.js";
import type { LinkageOutput } from "../../route-linkage/index.js";

const analyzeBackendMock = vi.fn();
const analyzeFrontendMock = vi.fn();
const linkRoutesMock = vi.fn();

vi.mock("../../backend-analysis/index.js", () => ({
  analyzeBackend: analyzeBackendMock,
}));
vi.mock("../../frontend-analysis/index.js", () => ({
  analyzeFrontend: analyzeFrontendMock,
}));
vi.mock("../../route-linkage/index.js", () => ({
  linkRoutes: linkRoutesMock,
}));

const BACKEND_ROOT = "/workspace/backend";
const FRONTEND_ROOT = "/workspace/frontend";

function makeBackendOutput(): BackendAnalysisOutput {
  return {
    schemaVersion: 1,
    routes: [],
    functions: [],
    files: [],
    warnings: [],
  } as unknown as BackendAnalysisOutput;
}

function makeFrontendOutput(): FrontendAnalysisOutput {
  return {
    schemaVersion: 1,
    apiCalls: [],
    functions: [],
    files: [],
    warnings: [],
  } as unknown as FrontendAnalysisOutput;
}

function makeLinkageOutput(): LinkageOutput {
  return {
    schemaVersion: 1,
    linkages: [],
    unmatchedRoutes: [],
    unmatchedApiCalls: [],
    functions: [],
    files: [],
    warnings: [],
  };
}

describe("analysisOrchestrator.analyze", () => {
  it("analyzeBackend→analyzeFrontend→linkRoutesの順に正しい引数で呼び出し、linkRoutesの戻り値をそのまま返す", async () => {
    const backendOutput = makeBackendOutput();
    const frontendOutput = makeFrontendOutput();
    const linkageOutput = makeLinkageOutput();

    analyzeBackendMock.mockReset().mockResolvedValue(backendOutput);
    analyzeFrontendMock.mockReset().mockReturnValue(frontendOutput);
    linkRoutesMock.mockReset().mockReturnValue(linkageOutput);

    const { analyze } = await import("../analysisOrchestrator.js");

    const result = await analyze(BACKEND_ROOT, FRONTEND_ROOT);

    expect(result).toBe(linkageOutput);
    expect(analyzeBackendMock).toHaveBeenCalledWith(BACKEND_ROOT, { wasmDir: undefined });
    expect(analyzeFrontendMock).toHaveBeenCalledWith(FRONTEND_ROOT);
    expect(linkRoutesMock).toHaveBeenCalledWith(backendOutput, frontendOutput);

    // 呼び出し順序: analyzeBackend → analyzeFrontend → linkRoutes
    const backendOrder = analyzeBackendMock.mock.invocationCallOrder[0];
    const frontendOrder = analyzeFrontendMock.mock.invocationCallOrder[0];
    const linkOrder = linkRoutesMock.mock.invocationCallOrder[0];
    expect(backendOrder).toBeLessThan(frontendOrder);
    expect(frontendOrder).toBeLessThan(linkOrder);
  });

  it("analyzeBackendがrejectした場合、AnalysisErrorでラップしてthrowし、analyzeFrontend/linkRoutesは呼ばれない", async () => {
    const originalError = new Error("backend boom");
    analyzeBackendMock.mockReset().mockRejectedValue(originalError);
    analyzeFrontendMock.mockReset();
    linkRoutesMock.mockReset();

    const { analyze, AnalysisError } = await import("../analysisOrchestrator.js");

    await expect(analyze(BACKEND_ROOT, FRONTEND_ROOT)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as InstanceType<typeof AnalysisError>).cause).toBe(originalError);
      return true;
    });

    expect(analyzeFrontendMock).not.toHaveBeenCalled();
    expect(linkRoutesMock).not.toHaveBeenCalled();
  });

  it("analyzeFrontendがthrowした場合、AnalysisErrorでラップしてthrowし、linkRoutesは呼ばれない", async () => {
    const backendOutput = makeBackendOutput();
    const originalError = new Error("frontend boom");
    analyzeBackendMock.mockReset().mockResolvedValue(backendOutput);
    analyzeFrontendMock.mockReset().mockImplementation(() => {
      throw originalError;
    });
    linkRoutesMock.mockReset();

    const { analyze, AnalysisError } = await import("../analysisOrchestrator.js");

    await expect(analyze(BACKEND_ROOT, FRONTEND_ROOT)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as InstanceType<typeof AnalysisError>).cause).toBe(originalError);
      return true;
    });

    expect(linkRoutesMock).not.toHaveBeenCalled();
  });

  it("linkRoutesがthrowした場合、AnalysisErrorでラップしてthrowする", async () => {
    const backendOutput = makeBackendOutput();
    const frontendOutput = makeFrontendOutput();
    const originalError = new Error("link boom");
    analyzeBackendMock.mockReset().mockResolvedValue(backendOutput);
    analyzeFrontendMock.mockReset().mockReturnValue(frontendOutput);
    linkRoutesMock.mockReset().mockImplementation(() => {
      throw originalError;
    });

    const { analyze, AnalysisError } = await import("../analysisOrchestrator.js");

    await expect(analyze(BACKEND_ROOT, FRONTEND_ROOT)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as InstanceType<typeof AnalysisError>).cause).toBe(originalError);
      return true;
    });
  });
});
