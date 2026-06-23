/**
 * extension.ts（design.md「extension.ts」, Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 2.5, 6.2, 7.2）の単体テスト。
 *
 * `extension.ts` は `vscode.commands.registerCommand`/`vscode.window.showErrorMessage`/
 * `vscode.window.withProgress`等を実行時に参照するため、実VSCodeホスト外で動くvitestではこの
 * モジュールは解決できない。`vi.mock("vscode", ...)`でこれらをテストごとに差し替え可能なフェイクに
 * 置き換える。`workspaceScanner`/`analysisOrchestrator`/`graphPanel`/`reanalysisWatcher`も実モジュール
 * をモックし、結線（呼び出し順序・引数・エラー時の停止・watcherライフサイクル）のみを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkageOutput } from "../../route-linkage/index.js";

/** `vscode.ExtensionContext`の最小フェイク。 */
interface FakeExtensionContext {
  subscriptions: Array<{ dispose: () => void }>;
  extensionUri: { fsPath: string };
  storageUri?: { fsPath: string };
}

const registerCommandMock = vi.fn();
const showErrorMessageMock = vi.fn();
const withProgressMock = vi.fn();

const validateMock = vi.fn();
const analyzeMock = vi.fn();
const showOrRevealMock = vi.fn();
const postLinkageUpdateMock = vi.fn();
const createReanalysisWatcherMock = vi.fn();

class FakeScopeError extends Error {
  constructor(
    public readonly reason: "missing-backend" | "missing-frontend" | "multi-root",
    message: string,
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

class FakeAnalysisError extends Error {
  constructor(
    public readonly cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

const createOutputChannelMock = vi.fn(() => ({
  appendLine: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
}));

class FakeCancellationError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancellationError";
  }
}

vi.mock("vscode", () => ({
  Uri: {
    joinPath: vi.fn((_base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: parts.join("/"),
    })),
  },
  commands: {
    registerCommand: registerCommandMock,
  },
  window: {
    showErrorMessage: showErrorMessageMock,
    withProgress: withProgressMock,
    createOutputChannel: createOutputChannelMock,
  },
  ProgressLocation: { Notification: 15 },
  CancellationError: FakeCancellationError,
}));

vi.mock("../workspaceScanner.js", () => ({
  validate: (...args: []) => validateMock(...args),
  ScopeError: FakeScopeError,
}));

vi.mock("../analysisOrchestrator.js", () => ({
  analyze: (...args: [string, string]) => analyzeMock(...args),
  AnalysisError: FakeAnalysisError,
}));

vi.mock("../graphPanel.js", () => ({
  showOrReveal: (...args: unknown[]) => showOrRevealMock(...args),
  postLinkageUpdate: (...args: unknown[]) => postLinkageUpdateMock(...args),
}));

vi.mock("../reanalysisWatcher.js", () => ({
  createReanalysisWatcher: (...args: []) => createReanalysisWatcherMock(...args),
}));

const loadCachedResultMock = vi.fn();
const saveCachedResultMock = vi.fn();

vi.mock("../resultCache.js", () => ({
  loadCachedResult: (...args: unknown[]) => loadCachedResultMock(...args),
  saveCachedResult: (...args: unknown[]) => saveCachedResultMock(...args),
}));

const BACKEND_ROOT = "/workspace/backend";
const FRONTEND_ROOT = "/workspace/frontend";

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

function makeFakeContext(): FakeExtensionContext {
  return {
    subscriptions: [],
    extensionUri: { fsPath: "/ext" },
    storageUri: { fsPath: "/ext-storage" },
  };
}

function makeFakeWatcher(): { start: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(),
    dispose: vi.fn(),
  };
}

/** `withProgress`を即時に`task`を実行してその結果を返すフェイク実装に設定する。 */
function makeWithProgressRunTask(): void {
  withProgressMock.mockImplementation(
    async (
      _options: unknown,
      task: (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<unknown>,
    ): Promise<unknown> => task({}, { isCancellationRequested: false }),
  );
}

/** `registerCommandMock`の呼び出しからコマンドIDに対応するハンドラを取り出す。 */
function getRegisteredHandler(commandId: string): (...args: unknown[]) => unknown {
  const call = registerCommandMock.mock.calls.find((c) => c[0] === commandId);
  if (!call) {
    throw new Error(`コマンド ${commandId} が登録されていません`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

describe("extension.activate", () => {
  beforeEach(() => {
    registerCommandMock.mockReset();
    showErrorMessageMock.mockReset();
    withProgressMock.mockReset();
    validateMock.mockReset();
    analyzeMock.mockReset();
    showOrRevealMock.mockReset();
    // デフォルトは新規パネル生成(true)。既存パネルのreveal(false)を検証するテストは
    // 個別にmockReturnValueOnceで上書きする。
    showOrRevealMock.mockReturnValue(true);
    postLinkageUpdateMock.mockReset();
    createReanalysisWatcherMock.mockReset();
    createOutputChannelMock.mockReset();
    createOutputChannelMock.mockReturnValue({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    });
    loadCachedResultMock.mockReset();
    loadCachedResultMock.mockResolvedValue(undefined); // デフォルトはキャッシュなし
    saveCachedResultMock.mockReset();
    saveCachedResultMock.mockResolvedValue(undefined);
    makeWithProgressRunTask();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("4コマンド（showGraph/reanalyze/analyzeActiveFile/copyFunctionWithLinked）を登録し、すべてのdisposableをcontext.subscriptionsへpushする", async () => {
    const disposableShowGraph = { dispose: vi.fn() };
    const disposableReanalyze = { dispose: vi.fn() };
    const disposableAnalyzeActiveFile = { dispose: vi.fn() };
    const disposableCopyFunction = { dispose: vi.fn() };
    registerCommandMock
      .mockReturnValueOnce(disposableShowGraph)
      .mockReturnValueOnce(disposableReanalyze)
      .mockReturnValueOnce(disposableAnalyzeActiveFile)
      .mockReturnValueOnce(disposableCopyFunction);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();

    activate(context as never);

    expect(registerCommandMock).toHaveBeenCalledTimes(4);
    expect(registerCommandMock.mock.calls[0][0]).toBe("apivista.showGraph");
    expect(registerCommandMock.mock.calls[1][0]).toBe("apivista.reanalyze");
    expect(registerCommandMock.mock.calls[2][0]).toBe("apivista.analyzeActiveFile");
    expect(registerCommandMock.mock.calls[3][0]).toBe("apivista.copyFunctionWithLinked");
    expect(context.subscriptions).toContain(disposableShowGraph);
    expect(context.subscriptions).toContain(disposableReanalyze);
    expect(context.subscriptions).toContain(disposableAnalyzeActiveFile);
    expect(context.subscriptions).toContain(disposableCopyFunction);
  });

  it("showGraph実行時、validate→analyze→showOrRevealの順に呼び出し、validateが返したrootsをanalyzeに渡す", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    const output = makeLinkageOutput();
    validateMock.mockReturnValue(scanned);
    analyzeMock.mockResolvedValue(output);
    createReanalysisWatcherMock.mockReturnValue(makeFakeWatcher());

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();

    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(analyzeMock).toHaveBeenCalledWith(
      BACKEND_ROOT,
      FRONTEND_ROOT,
      expect.any(String),
      expect.any(Object),
    );
    expect(showOrRevealMock).toHaveBeenCalledTimes(1);

    const validateOrder = validateMock.mock.invocationCallOrder[0];
    const analyzeOrder = analyzeMock.mock.invocationCallOrder[0];
    const showOrRevealOrder = showOrRevealMock.mock.invocationCallOrder[0];
    expect(validateOrder).toBeLessThan(analyzeOrder);
    expect(analyzeOrder).toBeLessThan(showOrRevealOrder);
  });

  it("showGraph実行時、analyzeの呼び出しはwithProgressでラップされる", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    validateMock.mockReturnValue(scanned);
    analyzeMock.mockResolvedValue(makeLinkageOutput());
    createReanalysisWatcherMock.mockReturnValue(makeFakeWatcher());

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();

    expect(withProgressMock).toHaveBeenCalledTimes(1);
    const options = withProgressMock.mock.calls[0][0] as { location: number };
    expect(options.location).toBe(15);
  });

  it("showGraph実行時、validateがScopeErrorをthrowした場合はshowErrorMessageを呼び、analyze/showOrRevealは呼ばれない", async () => {
    const { ScopeError } = await import("../workspaceScanner.js");
    const scopeError = new ScopeError("missing-backend", "backend/ が見つかりません");
    validateMock.mockImplementation(() => {
      throw scopeError;
    });

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();

    expect(showErrorMessageMock).toHaveBeenCalledWith(scopeError.message);
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(showOrRevealMock).not.toHaveBeenCalled();
  });

  it("showGraph実行時、analyzeがAnalysisErrorをrejectした場合はshowErrorMessageを呼び、showOrRevealは呼ばれない", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    validateMock.mockReturnValue(scanned);
    const { AnalysisError } = await import("../analysisOrchestrator.js");
    const analysisError = new AnalysisError(new Error("boom"), "解析に失敗しました");
    analyzeMock.mockRejectedValue(analysisError);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();

    expect(showErrorMessageMock).toHaveBeenCalledWith(analysisError.message);
    expect(showOrRevealMock).not.toHaveBeenCalled();
  });

  it("reanalyze実行時、validate→analyzeの後、showOrRevealではなくpostLinkageUpdateが呼ばれる", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    const output = makeLinkageOutput();
    validateMock.mockReturnValue(scanned);
    analyzeMock.mockResolvedValue(output);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.reanalyze");
    await handler();

    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(analyzeMock).toHaveBeenCalledWith(
      BACKEND_ROOT,
      FRONTEND_ROOT,
      expect.any(String),
      expect.any(Object),
    );
    expect(postLinkageUpdateMock).toHaveBeenCalledWith(output);
    expect(showOrRevealMock).not.toHaveBeenCalled();
  });

  it("reanalyze実行時、validateがScopeErrorをthrowした場合はshowErrorMessageを呼び、analyze/postLinkageUpdateは呼ばれない", async () => {
    const { ScopeError } = await import("../workspaceScanner.js");
    const scopeError = new ScopeError("multi-root", "複数ワークスペースフォルダ");
    validateMock.mockImplementation(() => {
      throw scopeError;
    });

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.reanalyze");
    await handler();

    expect(showErrorMessageMock).toHaveBeenCalledWith(scopeError.message);
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(postLinkageUpdateMock).not.toHaveBeenCalled();
  });

  it("reanalyze実行時、analyzeがAnalysisErrorをrejectした場合はshowErrorMessageを呼び、postLinkageUpdateは呼ばれない", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    validateMock.mockReturnValue(scanned);
    const { AnalysisError } = await import("../analysisOrchestrator.js");
    const analysisError = new AnalysisError(new Error("boom"), "解析に失敗しました");
    analyzeMock.mockRejectedValue(analysisError);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.reanalyze");
    await handler();

    expect(showErrorMessageMock).toHaveBeenCalledWith(analysisError.message);
    expect(postLinkageUpdateMock).not.toHaveBeenCalled();
  });

  it("showGraph成功時、showOrRevealに渡されたonDidDisposeコールバックが発火すると、起動されたwatcherのdisposeが呼ばれる", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    validateMock.mockReturnValue(scanned);
    analyzeMock.mockResolvedValue(makeLinkageOutput());
    const watcher = makeFakeWatcher();
    createReanalysisWatcherMock.mockReturnValue(watcher);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();

    expect(createReanalysisWatcherMock).toHaveBeenCalledTimes(1);
    expect(watcher.start).toHaveBeenCalledWith(
      BACKEND_ROOT,
      FRONTEND_ROOT,
      expect.any(Function) as unknown as () => void,
    );
    expect(watcher.dispose).not.toHaveBeenCalled();

    // showOrReveal(context, output, onDidDispose) の第3引数を捕捉して発火させる
    const onDidDispose = showOrRevealMock.mock.calls[0][2] as () => void;
    onDidDispose();

    expect(watcher.dispose).toHaveBeenCalledTimes(1);
  });

  it("showGraphを2回連続で実行し、2回目でshowOrRevealがfalse(既存パネルのreveal)を返した場合、createReanalysisWatcherは1回しか呼ばれない", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    validateMock.mockReturnValue(scanned);
    analyzeMock.mockResolvedValue(makeLinkageOutput());
    const firstWatcher = makeFakeWatcher();
    const secondWatcher = makeFakeWatcher();
    createReanalysisWatcherMock
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(secondWatcher);
    showOrRevealMock.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();
    await handler();

    expect(createReanalysisWatcherMock).toHaveBeenCalledTimes(1);
    expect(showOrRevealMock).toHaveBeenCalledTimes(2);
    expect(firstWatcher.start).toHaveBeenCalledTimes(1);
    expect(secondWatcher.start).not.toHaveBeenCalled();
  });

  it("showGraph成功時、watcher.startのonReanalyzedコールバックはgraphPanel.postLinkageUpdateを呼ぶ", async () => {
    const scanned = { backendRoot: BACKEND_ROOT, frontendRoot: FRONTEND_ROOT };
    validateMock.mockReturnValue(scanned);
    analyzeMock.mockResolvedValue(makeLinkageOutput());
    const watcher = makeFakeWatcher();
    createReanalysisWatcherMock.mockReturnValue(watcher);

    const { activate } = await import("../extension.js");
    const context = makeFakeContext();
    activate(context as never);

    const handler = getRegisteredHandler("apivista.showGraph");
    await handler();

    const onReanalyzed = watcher.start.mock.calls[0][2] as (output: LinkageOutput) => void;
    const newOutput = makeLinkageOutput();
    postLinkageUpdateMock.mockClear();
    onReanalyzed(newOutput);

    expect(postLinkageUpdateMock).toHaveBeenCalledWith(newOutput);
  });
});
