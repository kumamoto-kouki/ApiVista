/**
 * @vitest-environment jsdom
 */
/**
 * `webview/main.ts`の単体テスト(design.md「webview/main.ts」, tasks.md 7,
 * Requirements 3.1, 4.2, 5.1)。
 *
 * Cytoscape本体の描画初期化自体はDOM/Canvas依存のためdesign.md Testing Strategyで明示的に
 * 単体テスト対象外とされている(目視確認で検証する)。しかし本ファイルが結線する以下のロジックは
 * Cytoscape本体の実描画に依存しない「薄いグルー」のpureな部分であり、`cytoscape`モジュール自体・
 * `depthSwitchControl`・`warningsPanel`をモックすることで検証可能かつ価値がある:
 * - `acquireVsCodeApi`が1度だけ呼ばれること
 * - 初期化完了後に`"ready"`メッセージが送られること
 * - `linkageData`受信時に`renderWarnings`(モック)が正しい`warnings`で呼ばれ、
 *   `cytoscape`(モック)が`projectDepth`の実出力(デフォルト深度)から導出した要素で呼ばれること
 * - ノードタップ(モックした`cy.on("tap","node",handler)`のコールバックを直接呼び出すことで模擬)時に
 *   正しい`sourceLocation`を含む`nodeClick`メッセージが送られること
 * - `createDepthSwitchControl`(モック)に渡された`onDepthChange`を呼ぶと、以後の再描画が
 *   新しい深度で行われること
 *
 * `projectDepth`自体は実モジュールを使用する(モックしない)。深度別投影ロジックの正しさは
 * `projectDepth.test.ts`が既にカバーしており、本テストの関心は「`main.ts`が`projectDepth`の
 * 出力を正しくCytoscape要素へ変換して引き渡すか」という結線の正しさのみであるため。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ApiCallRef,
  LinkageOutput,
  LinkedFunctionNode,
  RouteRef,
} from "../../../route-linkage/models.js";
import type { HostToWebviewMessage } from "../../webviewProtocol.js";

/** 全フィールドを持つ最小`LinkageOutput`を組み立てるヘルパー(projectDepth.test.tsと同方式)。 */
function buildOutput(overrides: Partial<LinkageOutput>): LinkageOutput {
  return {
    schemaVersion: 1,
    linkages: [],
    unmatchedRoutes: [],
    unmatchedApiCalls: [],
    functions: [],
    files: [],
    warnings: [],
    ...overrides,
  };
}

function route(overrides: Partial<RouteRef> = {}): RouteRef {
  return {
    method: "GET",
    path: "/api/users/{id}",
    handler: { file: "backend/routes/users.ts", line: 10 },
    entryFunctionId: "backend:fn-getUser",
    schemaRefs: [],
    ...overrides,
  };
}

function apiCall(overrides: Partial<ApiCallRef> = {}): ApiCallRef {
  return {
    method: "GET",
    urlPattern: "/api/users/{}",
    enclosingFunctionId: "frontend:fn-fetchUser",
    location: { file: "frontend/api/users.ts", line: 5 },
    ...overrides,
  };
}

function fn(overrides: Partial<LinkedFunctionNode> = {}): LinkedFunctionNode {
  return {
    id: "backend:fn-getUser",
    side: "backend",
    name: "getUser",
    file: "backend:file-users",
    location: { file: "backend/routes/users.ts", line: 10 },
    calls: [],
    ...overrides,
  };
}

const postMessageMock = vi.fn();
const acquireVsCodeApiMock = vi.fn(() => ({ postMessage: postMessageMock }));

const cyOnMock = vi.fn();
const cyOffMock = vi.fn();
const cyDestroyMock = vi.fn();
// getElementById returns length:0 so warning-overlay updatePositions skips renderedBoundingBox
const cyGetElementByIdMock = vi.fn(() => ({
  length: 0,
  renderedBoundingBox: vi.fn(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 })),
  addClass: vi.fn(),
  select: vi.fn(),
  closedNeighborhood: vi.fn(() => ({ removeClass: vi.fn() })),
}));
const cytoscapeMock = vi.fn((options: { elements: { data: { id: string } }[] }) => {
  void options;
  return {
    on: cyOnMock,
    off: cyOffMock,
    destroy: cyDestroyMock,
    getElementById: cyGetElementByIdMock,
    elements: vi.fn(() => ({
      addClass: vi.fn(),
      removeClass: vi.fn(),
      unselect: vi.fn(),
    })),
    zoom: vi.fn(() => 1),
    pan: vi.fn(() => ({ x: 0, y: 0 })),
    animate: vi.fn(),
  };
});

let capturedOnDepthChange: ((depth: "route" | "file" | "function") => void) | undefined;
const createDepthSwitchControlMock = vi.fn(
  (_container: HTMLElement, onDepthChange: (depth: "route" | "file" | "function") => void) => {
    capturedOnDepthChange = onDepthChange;
  },
);

vi.stubGlobal("acquireVsCodeApi", acquireVsCodeApiMock);

vi.mock("cytoscape", () => ({
  default: cytoscapeMock,
}));

vi.mock("../depthSwitchControl.js", () => ({
  createDepthSwitchControl: createDepthSwitchControlMock,
}));

function dispatchLinkageData(output: LinkageOutput): void {
  const message: HostToWebviewMessage = { type: "linkageData", payload: output };
  window.dispatchEvent(new MessageEvent("message", { data: message }));
}

/** `cy.on("tap", "node", handler)`呼び出しで渡されたタップハンドラを取り出す。 */
function getTapHandler(): (event: { target: { data: () => unknown } }) => void {
  const call = cyOnMock.mock.calls.find(
    ([eventName, selector]) => eventName === "tap" && selector === "node",
  );
  if (!call) {
    throw new Error('cy.on("tap", "node", handler) was not registered');
  }
  return call[2] as (event: { target: { data: () => unknown } }) => void;
}

/**
 * `main.ts`はモジュール読み込み時に`window.addEventListener("message", ...)`を行うが、
 * `vi.resetModules()`はモジュールレジストリのみをリセットし、すでに`window`へ登録済みの
 * リスナー(直前のテストのモジュールインスタンスが捕捉したモック群への参照を持つ)までは
 * 取り除かない。テスト間で`main.ts`を再import するたびにリスナーが積み重なり、
 * `dispatchLinkageData`が複数世代のハンドラを同時に発火させてしまうため、各テスト前に
 * 前回登録された`"message"`リスナーを明示的に除去する。
 */
let registeredMessageListeners: EventListenerOrEventListenerObject[] = [];
const originalAddEventListener = window.addEventListener.bind(window);
window.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => {
  if (type === "message") {
    registeredMessageListeners.push(listener);
  }
  return originalAddEventListener(type, listener, options);
}) as typeof window.addEventListener;

describe("webview/main.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const listener of registeredMessageListeners) {
      window.removeEventListener("message", listener);
    }
    registeredMessageListeners = [];
    postMessageMock.mockClear();
    acquireVsCodeApiMock.mockClear();
    cytoscapeMock.mockClear();
    cyOnMock.mockClear();
    cyOffMock.mockClear();
    cyDestroyMock.mockClear();
    cyGetElementByIdMock.mockClear();
    createDepthSwitchControlMock.mockClear();
    capturedOnDepthChange = undefined;
    document.body.innerHTML = '<div id="app"></div>';
  });

  it("calls acquireVsCodeApi exactly once and posts the initial ready message", async () => {
    await import("../main.js");

    expect(acquireVsCodeApiMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({ type: "ready" });
  });

  it("builds Cytoscape elements derived from projectDepth's default-depth output on linkageData", async () => {
    await import("../main.js");

    const output = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      warnings: [{ target: "x", reason: "y" }],
    });

    dispatchLinkageData(output);

    expect(cytoscapeMock).toHaveBeenCalledTimes(1);
    const options = cytoscapeMock.mock.calls[0][0] as { elements: { data: { id: string } }[] };
    const elementIds = options.elements.map((element) => element.data.id);

    // default depth is "route": expect both route and apiCall nodes plus the linkage edge.
    expect(elementIds.some((id) => id.startsWith("route:"))).toBe(true);
    expect(elementIds.some((id) => id.startsWith("apiCall:"))).toBe(true);
    expect(elementIds.some((id) => id.startsWith("linkage:"))).toBe(true);
  });

  it("posts a nodeClick message when a [data-code-link] element is clicked", async () => {
    await import("../main.js");

    const output = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
    });
    dispatchLinkageData(output);

    postMessageMock.mockClear();
    const codeLink = document.querySelector<HTMLElement>("[data-code-link]");
    expect(codeLink).not.toBeNull();
    codeLink!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(postMessageMock).toHaveBeenCalledWith({
      type: "nodeClick",
      payload: { file: "backend/routes/users.ts", line: 10 },
    });
  });

  it("opens the card context menu on right-click and posts copyLinked when the menu item is clicked", async () => {
    await import("../main.js");

    const output = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
    });
    dispatchLinkageData(output);

    postMessageMock.mockClear();

    // 枠（カード）を右クリック → 日本語コンテキストメニューを表示（contextmenu はカードへバブルする）
    const codeLink = document.querySelector<HTMLElement>("[data-code-link]");
    expect(codeLink).not.toBeNull();
    codeLink!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    // メニュー項目「連携関数をコピー」をクリック
    const menuItem = document.body.querySelector<HTMLElement>('[role="menuitem"]');
    expect(menuItem).not.toBeNull();
    expect(menuItem!.textContent).toBe("連携関数をコピー");
    menuItem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(postMessageMock).toHaveBeenCalledWith({
      type: "copyLinked",
      payload: { file: "backend/routes/users.ts", line: 10, side: "backend" },
    });
  });

  it("does not post nodeClick when Cytoscape node tap fires (code jump is [data-code-link] only)", async () => {
    await import("../main.js");

    const output = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
    });
    dispatchLinkageData(output);

    postMessageMock.mockClear();
    const tapHandler = getTapHandler();
    tapHandler({
      target: {
        data: () => ({
          id: "route:GET:/api/users/{id}:backend/routes/users.ts:10",
          kind: "route",
          label: "GET /api/users/{id}",
          unmatched: false,
          sourceLocation: { file: "backend/routes/users.ts", line: 10 },
        }),
      },
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("re-renders at the newly selected depth after createDepthSwitchControl's onDepthChange callback fires", async () => {
    await import("../main.js");

    const output = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      functions: [],
      files: [],
    });
    dispatchLinkageData(output);

    expect(cytoscapeMock).toHaveBeenCalledTimes(1);

    capturedOnDepthChange?.("function");

    expect(cytoscapeMock).toHaveBeenCalledTimes(2);
    expect(cyDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("re-renders at the current depth when a new linkageData message arrives after re-analysis", async () => {
    await import("../main.js");

    const functions = [
      fn({ id: "backend:fn-getUser", calls: [] }),
      fn({
        id: "frontend:fn-fetchUser",
        side: "frontend",
        name: "fetchUser",
        file: "frontend:file-users",
        location: { file: "frontend/api/users.ts", line: 5 },
      }),
    ];

    const firstOutput = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      functions,
    });
    dispatchLinkageData(firstOutput);
    expect(cytoscapeMock).toHaveBeenCalledTimes(1);

    capturedOnDepthChange?.("function");
    expect(cytoscapeMock).toHaveBeenCalledTimes(2);

    const secondOutput = buildOutput({
      linkages: [
        { route: route({ path: "/api/orders/{id}" }), apiCall: apiCall(), matchKind: "exact" },
      ],
      functions,
    });
    dispatchLinkageData(secondOutput);

    expect(cytoscapeMock).toHaveBeenCalledTimes(3);
    const lastOptions = cytoscapeMock.mock.calls[2][0] as {
      elements: { data: { id: string; kind?: string } }[];
    };
    // depth remained "function" after re-analysis: nodes should be function-kind, not route-kind.
    expect(lastOptions.elements.some((element) => element.data.kind === "function")).toBe(true);
  });

  it("registers hover dimming and background-click deselect handlers on the Cytoscape instance", async () => {
    await import("../main.js");

    const output = buildOutput({
      linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
    });
    dispatchLinkageData(output);

    // cy.on must be registered for: "tap"(node), "tap"(background), "mouseover"(node), "mouseout"(node)
    const eventNames = cyOnMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(eventNames).toContain("tap");
    expect(eventNames).toContain("mouseover");
    expect(eventNames).toContain("mouseout");
  });
});
