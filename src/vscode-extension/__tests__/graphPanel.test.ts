/**
 * graphPanel（design.md「graphPanel」, Requirements 3.1, 5.1, 5.2）の単体テスト。
 *
 * `graphPanel.ts` は `vscode.window.createWebviewPanel`/`vscode.window.showErrorMessage`/
 * `vscode.Uri.joinPath`等を実行時に参照するため、実VSCodeホスト外で動くvitestではこのモジュールは
 * 解決できない。`vi.mock("vscode", ...)`でこれらをテストごとに差し替え可能なフェイクに置き換える。
 * `webviewHtml.ts`・`sourceJump.ts`も実モジュールをモックし、呼び出し引数・委譲・エラー処理のみを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkageOutput } from "../../route-linkage/models.js";

/** `Webview`の最小フェイク。 */
interface FakeWebview {
  html: string;
  options: Record<string, unknown>;
  asWebviewUri: ReturnType<typeof vi.fn>;
  onDidReceiveMessage: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  cspSource: string;
}

/** `WebviewPanel`の最小フェイク。 */
interface FakeWebviewPanel {
  webview: FakeWebview;
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeUri {
  fsPath: string;
}

const createWebviewPanelMock = vi.fn();
const showErrorMessageMock = vi.fn();
const joinPathMock = vi.fn();
const buildWebviewHtmlMock = vi.fn();
const sourceJumpRevealMock = vi.fn();

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: createWebviewPanelMock,
    showErrorMessage: showErrorMessageMock,
  },
  Uri: {
    joinPath: joinPathMock,
  },
  ViewColumn: { One: 1 },
}));

vi.mock("../webviewHtml.js", () => ({
  buildWebviewHtml: buildWebviewHtmlMock,
}));

vi.mock("../sourceJump.js", () => ({
  reveal: sourceJumpRevealMock,
}));

function makeFakeWebview(): FakeWebview {
  return {
    html: "",
    options: {},
    asWebviewUri: vi.fn(),
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn(),
    cspSource: "vscode-webview://fake",
  };
}

function makeFakePanel(): FakeWebviewPanel {
  return {
    webview: makeFakeWebview(),
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    dispose: vi.fn(),
  };
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

const EXTENSION_URI: FakeUri = { fsPath: "/ext" };

describe("graphPanel.showOrReveal", () => {
  beforeEach(() => {
    createWebviewPanelMock.mockReset();
    showErrorMessageMock.mockReset();
    joinPathMock.mockReset().mockImplementation((base: FakeUri, ...segments: string[]) => ({
      fsPath: `${base.fsPath}/${segments.join("/")}`,
    }));
    buildWebviewHtmlMock.mockReset().mockReturnValue("<html></html>");
    sourceJumpRevealMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("パネルが存在しない場合、createWebviewPanelで新規生成し、webview.htmlをbuildWebviewHtmlの戻り値で設定する", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());

    expect(createWebviewPanelMock).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toBe("<html></html>");
    expect(panel.reveal).not.toHaveBeenCalled();
  });

  it("createWebviewPanel呼び出しのoptionsはlocalResourceRootsにmedia/webviewを指すURIを含む", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());

    const callArgs = createWebviewPanelMock.mock.calls[0];
    // createWebviewPanel(viewType, title, showOptions, options)
    const options = callArgs[3] as { localResourceRoots: FakeUri[] };
    expect(options.localResourceRoots).toBeDefined();
    expect(options.localResourceRoots[0].fsPath).toBe("/ext/media/webview");
  });

  it("2回目の呼び出し(パネルが既に存在する場合)はrevealを呼び、createWebviewPanelは再度呼ばれない", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());
    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());

    expect(createWebviewPanelMock).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });

  it("新規パネル生成時はtrueを返し、パネルが開いたままの2回目の呼び出し(reveal分岐)はfalseを返す", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);

    const { showOrReveal } = await import("../graphPanel.js");

    const firstResult = showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());
    const secondResult = showOrReveal(
      { extensionUri: EXTENSION_URI } as never,
      makeLinkageOutput(),
    );

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(false);
  });

  it("Webviewから'ready'メッセージを受信すると、postMessageでlinkageDataを初期出力とともに送信する", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);
    const initialOutput = makeLinkageOutput();

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, initialOutput);

    const onMessageHandler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
      message: unknown,
    ) => void;
    onMessageHandler({ type: "ready" });

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "linkageData",
      payload: initialOutput,
    });
  });

  it("Webviewから'nodeClick'メッセージを受信すると、sourceJump.revealを正しい引数で呼び出す", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);
    sourceJumpRevealMock.mockResolvedValue(undefined);

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());

    const onMessageHandler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
      message: unknown,
    ) => void;
    onMessageHandler({ type: "nodeClick", payload: { file: "backend/app/main.py", line: 42 } });

    expect(sourceJumpRevealMock).toHaveBeenCalledWith({ file: "backend/app/main.py", line: 42 });
  });

  it("sourceJump.revealが失敗(reject)した場合、showErrorMessageを呼び出し、パネルのpostMessageは追加で呼ばれない", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);
    const jumpError = new Error("file not found");
    sourceJumpRevealMock.mockRejectedValue(jumpError);

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());
    panel.webview.postMessage.mockClear();

    const onMessageHandler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
      message: unknown,
    ) => void;
    onMessageHandler({ type: "nodeClick", payload: { file: "backend/missing.py", line: 1 } });

    // sourceJump.reveal は非同期で reject されるため、マイクロタスクの完了を待つ
    await vi.waitFor(() => {
      expect(showErrorMessageMock).toHaveBeenCalledTimes(1);
    });

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it("パネルが破棄(onDidDispose発火)された後、再度showOrRevealを呼ぶと新規にcreateWebviewPanelが呼ばれる(シングルトンのクリア)", async () => {
    const firstPanel = makeFakePanel();
    const secondPanel = makeFakePanel();
    createWebviewPanelMock.mockReturnValueOnce(firstPanel).mockReturnValueOnce(secondPanel);

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());
    expect(createWebviewPanelMock).toHaveBeenCalledTimes(1);

    const onDisposeHandler = firstPanel.onDidDispose.mock.calls[0][0] as () => void;
    onDisposeHandler();

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());

    expect(createWebviewPanelMock).toHaveBeenCalledTimes(2);
    expect(secondPanel.reveal).not.toHaveBeenCalled();
  });

  it("新規パネル生成時に渡したonDidDisposeコールバックは、パネルのonDidDispose発火時に呼ばれる", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);
    const onDidDispose = vi.fn();

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput(), onDidDispose);

    expect(onDidDispose).not.toHaveBeenCalled();

    const onDisposeHandler = panel.onDidDispose.mock.calls[0][0] as () => void;
    onDisposeHandler();

    expect(onDidDispose).toHaveBeenCalledTimes(1);
  });

  it("既存パネルをreveal()する分岐では、渡されたonDidDisposeコールバックは呼ばれない(新規生成時のみ結線される)", async () => {
    const firstPanel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(firstPanel);
    const firstOnDidDispose = vi.fn();
    const secondOnDidDispose = vi.fn();

    const { showOrReveal } = await import("../graphPanel.js");

    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput(), firstOnDidDispose);
    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput(), secondOnDidDispose);

    expect(firstPanel.onDidDispose).toHaveBeenCalledTimes(1);

    const onDisposeHandler = firstPanel.onDidDispose.mock.calls[0][0] as () => void;
    onDisposeHandler();

    expect(firstOnDidDispose).toHaveBeenCalledTimes(1);
    expect(secondOnDidDispose).not.toHaveBeenCalled();
  });
});

describe("graphPanel.postLinkageUpdate", () => {
  beforeEach(() => {
    createWebviewPanelMock.mockReset();
    showErrorMessageMock.mockReset();
    joinPathMock.mockReset().mockImplementation((base: FakeUri, ...segments: string[]) => ({
      fsPath: `${base.fsPath}/${segments.join("/")}`,
    }));
    buildWebviewHtmlMock.mockReset().mockReturnValue("<html></html>");
    sourceJumpRevealMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("パネルが開いていない場合、postLinkageUpdateはno-op(エラーを起こさない)", async () => {
    const { postLinkageUpdate } = await import("../graphPanel.js");

    expect(() => postLinkageUpdate(makeLinkageOutput())).not.toThrow();
  });

  it("パネルが開いている場合、postLinkageUpdateはpostMessageでlinkageDataを送信する", async () => {
    const panel = makeFakePanel();
    createWebviewPanelMock.mockReturnValue(panel);

    const { showOrReveal, postLinkageUpdate } = await import("../graphPanel.js");
    showOrReveal({ extensionUri: EXTENSION_URI } as never, makeLinkageOutput());
    panel.webview.postMessage.mockClear();

    const updatedOutput = makeLinkageOutput();
    postLinkageUpdate(updatedOutput);

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "linkageData",
      payload: updatedOutput,
    });
  });
});
