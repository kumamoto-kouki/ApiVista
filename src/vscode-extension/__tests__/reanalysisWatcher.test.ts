/**
 * reanalysisWatcher（design.md「reanalysisWatcher」, Requirements 6.1, 6.3）の単体テスト。
 *
 * `reanalysisWatcher.ts` は `vscode.workspace.createFileSystemWatcher`/`vscode.RelativePattern`を
 * 実行時に参照するため、実VSCodeホスト外で動くvitestではこのモジュールは解決できない。
 * `vi.mock("vscode", ...)`でフェイクの`FileSystemWatcher`を返すよう差し替える。
 * また`analysisOrchestrator.analyze`の呼び出し回数・タイミングを検証するため
 * `vi.mock("../analysisOrchestrator.js", ...)`でモックし、debounceの挙動は
 * `vi.useFakeTimers()`で制御する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkageOutput } from "../../route-linkage/index.js";

/** イベントハンドラを記録できるフェイク`FileSystemWatcher`。 */
interface FakeFileSystemWatcher {
  dispose: ReturnType<typeof vi.fn>;
  onDidChange: ReturnType<typeof vi.fn>;
  onDidCreate: ReturnType<typeof vi.fn>;
  onDidDelete: ReturnType<typeof vi.fn>;
}

const createdWatchers: FakeFileSystemWatcher[] = [];
/** 各監視対象（backend/frontend）ごとに登録されたイベントハンドラの集合。 */
let registeredHandlers: Array<() => void> = [];

function makeFakeWatcher(): FakeFileSystemWatcher {
  const watcher: FakeFileSystemWatcher = {
    dispose: vi.fn(),
    onDidChange: vi.fn((handler: () => void) => {
      registeredHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    onDidCreate: vi.fn((handler: () => void) => {
      registeredHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    onDidDelete: vi.fn((handler: () => void) => {
      registeredHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
  };
  createdWatchers.push(watcher);
  return watcher;
}

vi.mock("vscode", () => ({
  workspace: {
    createFileSystemWatcher: vi.fn(() => makeFakeWatcher()),
  },
  RelativePattern: vi.fn(function RelativePattern(this: unknown, base: string, pattern: string) {
    return { base, pattern };
  }),
}));

const analyzeMock = vi.fn<(backendRoot: string, frontendRoot: string) => Promise<LinkageOutput>>();

vi.mock("../analysisOrchestrator.js", () => ({
  analyze: (...args: [string, string]) => analyzeMock(...args),
}));

/** すべての登録済みハンドラ（=ファイル変更イベント）を一度ずつ発火させる。 */
function fireFileChangeEvent(): void {
  for (const handler of registeredHandlers) {
    handler();
  }
}

const sampleOutput: LinkageOutput = {
  schemaVersion: 1,
  routes: [],
  apiCalls: [],
  files: [],
  functions: [],
  linkages: [],
  warnings: [],
} as unknown as LinkageOutput;

describe("reanalysisWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createdWatchers.length = 0;
    registeredHandlers = [];
    analyzeMock.mockReset();
    analyzeMock.mockResolvedValue(sampleOutput);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startはvscode.workspace.createFileSystemWatcherでファイル監視を開始する", async () => {
    const { createReanalysisWatcher } = await import("../reanalysisWatcher.js");
    const vscode = await import("vscode");

    const watcher = createReanalysisWatcher();
    watcher.start("/repo/backend", "/repo/frontend", vi.fn());

    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled();
    expect(createdWatchers.length).toBeGreaterThan(0);
  });

  it("単一のファイル変更イベント後、debounce遅延が経過するとanalyzeが1回呼ばれonReanalyzedへ結果が渡る", async () => {
    const { createReanalysisWatcher } = await import("../reanalysisWatcher.js");

    const watcher = createReanalysisWatcher();
    const onReanalyzed = vi.fn();
    watcher.start("/repo/backend", "/repo/frontend", onReanalyzed);

    fireFileChangeEvent();
    expect(analyzeMock).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(analyzeMock).toHaveBeenCalledTimes(1);
    expect(analyzeMock).toHaveBeenCalledWith("/repo/backend", "/repo/frontend");
    expect(onReanalyzed).toHaveBeenCalledTimes(1);
    expect(onReanalyzed).toHaveBeenCalledWith(sampleOutput);
  });

  it("debounce window内の複数回のファイル変更イベントは1回のanalyze呼び出しに集約される", async () => {
    const { createReanalysisWatcher } = await import("../reanalysisWatcher.js");

    const watcher = createReanalysisWatcher();
    const onReanalyzed = vi.fn();
    watcher.start("/repo/backend", "/repo/frontend", onReanalyzed);

    fireFileChangeEvent();
    vi.advanceTimersByTime(100);
    fireFileChangeEvent();
    vi.advanceTimersByTime(100);
    fireFileChangeEvent();

    await vi.runAllTimersAsync();

    expect(analyzeMock).toHaveBeenCalledTimes(1);
    expect(onReanalyzed).toHaveBeenCalledTimes(1);
  });

  it("disposeをdebounceタイマー発火前に呼ぶと、その後タイマーを進めてもanalyzeは呼ばれない", async () => {
    const { createReanalysisWatcher } = await import("../reanalysisWatcher.js");

    const watcher = createReanalysisWatcher();
    const onReanalyzed = vi.fn();
    watcher.start("/repo/backend", "/repo/frontend", onReanalyzed);

    fireFileChangeEvent();
    watcher.dispose();

    await vi.runAllTimersAsync();

    expect(analyzeMock).not.toHaveBeenCalled();
    expect(onReanalyzed).not.toHaveBeenCalled();
  });

  it("再解析が進行中（analyze呼び出し済み・未解決）の状態でdisposeされた場合、analyzeが後で解決してもonReanalyzedは呼ばれない", async () => {
    const { createReanalysisWatcher } = await import("../reanalysisWatcher.js");

    let resolveAnalyze: ((value: LinkageOutput) => void) | undefined;
    analyzeMock.mockReset();
    analyzeMock.mockImplementation(
      () =>
        new Promise<LinkageOutput>((resolve) => {
          resolveAnalyze = resolve;
        }),
    );

    const watcher = createReanalysisWatcher();
    const onReanalyzed = vi.fn();
    watcher.start("/repo/backend", "/repo/frontend", onReanalyzed);

    fireFileChangeEvent();
    await vi.runAllTimersAsync();

    expect(analyzeMock).toHaveBeenCalledTimes(1);

    watcher.dispose();

    expect(resolveAnalyze).toBeDefined();
    resolveAnalyze?.(sampleOutput);
    await vi.waitFor(() => {
      // analyzeのpromiseチェーンがflushされるのを待つ（フェイクタイマー不使用のmicrotask待ち）。
    });

    expect(onReanalyzed).not.toHaveBeenCalled();
  });

  it("disposeは生成したファイル監視のdisposeを呼ぶ", async () => {
    const { createReanalysisWatcher } = await import("../reanalysisWatcher.js");

    const watcher = createReanalysisWatcher();
    watcher.start("/repo/backend", "/repo/frontend", vi.fn());

    expect(createdWatchers.length).toBeGreaterThan(0);

    watcher.dispose();

    for (const fakeWatcher of createdWatchers) {
      expect(fakeWatcher.dispose).toHaveBeenCalledTimes(1);
    }
  });
});
