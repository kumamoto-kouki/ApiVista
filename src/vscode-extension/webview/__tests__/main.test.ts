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
      boundingBox: vi.fn(() => ({ x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 })),
    })),
    zoom: vi.fn(() => 1),
    pan: vi.fn(() => ({ x: 0, y: 0 })),
    animate: vi.fn(),
  };
});

let capturedOnDepthChange: ((depth: "route" | "file" | "function") => void) | undefined;
let capturedOnReanalyze: (() => void) | undefined;
let capturedConnectedFilter:
  | { initial: boolean; onToggle: (connectedOnly: boolean) => void }
  | undefined;
const createDepthSwitchControlMock = vi.fn(
  (
    _container: HTMLElement,
    onDepthChange: (depth: "route" | "file" | "function") => void,
    onReanalyze?: () => void,
    connectedFilter?: { initial: boolean; onToggle: (connectedOnly: boolean) => void },
  ) => {
    capturedOnDepthChange = onDepthChange;
    capturedOnReanalyze = onReanalyze;
    capturedConnectedFilter = connectedFilter;
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
    capturedOnReanalyze = undefined;
    capturedConnectedFilter = undefined;
    document.body.innerHTML = '<div id="app"></div>';
  });

  it("calls acquireVsCodeApi exactly once and posts the initial ready message", async () => {
    await import("../main.js");

    expect(acquireVsCodeApiMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({ type: "ready" });
  });

  it("posts a reanalyze message when the reanalyze control is triggered", async () => {
    await import("../main.js");
    expect(capturedOnReanalyze).toBeDefined();

    postMessageMock.mockClear();
    capturedOnReanalyze?.();

    expect(postMessageMock).toHaveBeenCalledWith({ type: "reanalyze" });
  });

  it("provides a connected-only filter (default on) and re-renders the graph on toggle", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    expect(capturedConnectedFilter?.initial).toBe(true);

    const callsBefore = cytoscapeMock.mock.calls.length;
    capturedConnectedFilter?.onToggle(false);
    // トグルで再描画 → cytoscape が再生成される。
    expect(cytoscapeMock.mock.calls.length).toBeGreaterThan(callsBefore);
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

  it("disables left-drag panning (userPanningEnabled:false) so panning is right-drag only", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const options = cytoscapeMock.mock.calls[0][0] as { userPanningEnabled?: boolean };
    expect(options.userPanningEnabled).toBe(false);
  });

  it("clamps zoom with minZoom/maxZoom so few/many nodes don't over-zoom (#3)", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const options = cytoscapeMock.mock.calls[0][0] as { minZoom?: number; maxZoom?: number };
    // 原寸の 130% まで拡大を許容する（#1）。
    expect(options.maxZoom).toBe(1.3);
    expect(options.minZoom).toBeGreaterThan(0);
    expect(options.minZoom).toBeLessThan(1);
  });

  it("renders a separate frontend sub-zone per source directory (#2)", async () => {
    await import("../main.js");

    // 連携あり（= connected-only でも表示される）の apiCall を異なるディレクトリに 2 件作る。
    dispatchLinkageData(
      buildOutput({
        linkages: [
          {
            route: route({ entryFunctionId: "backend:fn-a" }),
            apiCall: apiCall({
              enclosingFunctionId: "frontend:fn-a",
              location: { file: "components/UserCard.vue", line: 3 },
            }),
            matchKind: "exact",
          },
          {
            route: route({ path: "/api/items", entryFunctionId: "backend:fn-b" }),
            apiCall: apiCall({
              urlPattern: "/api/items",
              enclosingFunctionId: "frontend:fn-b",
              location: { file: "composables/useItems.ts", line: 7 },
            }),
            matchKind: "exact",
          },
        ],
      }),
    );

    // ディレクトリごとにサブゾーン枠（data-zone-dir）が生成される。
    expect(document.querySelector('[data-zone-dir="components"]')).not.toBeNull();
    expect(document.querySelector('[data-zone-dir="composables"]')).not.toBeNull();
    // 未知ディレクトリ（other）のサブゾーンは生成されない。
    expect(document.querySelector('[data-zone-dir="other"]')).toBeNull();
  });

  it("focusNode メッセージで対象枠を選択リングで目立たせる（コード→グラフ逆遷移, #1）", async () => {
    await import("../main.js");
    dispatchLinkageData(
      buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      }),
    );

    // 初期描画時はどのカードにも選択リング（boxShadow）が付いていない。
    const cardsBefore = [...document.querySelectorAll<HTMLElement>(".node-card")];
    expect(cardsBefore.length).toBeGreaterThan(0);
    expect(cardsBefore.every((c) => c.style.boxShadow === "")).toBe(true);

    // apiCall ノードのソース位置（frontend/api/users.ts:5）を内包する行で逆遷移。
    const focus: HostToWebviewMessage = {
      type: "focusNode",
      payload: { file: "frontend/api/users.ts", line: 5 },
    };
    window.dispatchEvent(new MessageEvent("message", { data: focus }));

    // 対象枠に選択リング（boxShadow）が 1 枚だけ付く。
    const ringed = [...document.querySelectorAll<HTMLElement>(".node-card")].filter(
      (c) => c.style.boxShadow !== "",
    );
    expect(ringed.length).toBe(1);
  });

  it("付与する: 省略され得るラベル/パスにツールチップ(title)で全文を持たせる (#2)", async () => {
    await import("../main.js");
    dispatchLinkageData(
      buildOutput({
        linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }],
      }),
    );

    const titles = [...document.querySelectorAll<HTMLElement>(".node-card [title]")].map(
      (el) => el.title,
    );
    // ラベル全文（route ラベル）とソースパス全文がツールチップとして付く。
    expect(titles).toContain("GET /api/users/{id}");
    expect(titles.some((t) => t.includes("frontend/api/users.ts:5"))).toBe(true);
  });

  it("caps the orphan-warning list height with scroll so it doesn't take over the screen (#4)", async () => {
    await import("../main.js");
    // どのノードにも紐付かない警告 → 孤立警告セクションに表示される
    dispatchLinkageData(buildOutput({ warnings: [{ target: "x", reason: "y" }] }));

    const section = document.getElementById("orphan-section")!;
    expect(section.style.display).not.toBe("none");
    // ヘッダ直下のリスト（チップ群コンテナ）に高さ上限と縦スクロールが付いていること
    const list = section.querySelector<HTMLElement>('div[style*="overflow-y"]')!;
    expect(list).not.toBeNull();
    expect(list.style.maxHeight).not.toBe("");
    expect(list.style.overflowY).toBe("auto");
  });

  it("toggles the orphan-warning area collapsed/expanded on header click and keeps state across re-render", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({ warnings: [{ target: "x", reason: "y" }] }));

    const section = document.getElementById("orphan-section")!;
    const header = section.querySelector<HTMLElement>("div")!;
    const list = section.querySelector<HTMLElement>('div[style*="overflow-y"]')!;

    // 既定は展開
    expect(list.style.display).toBe("flex");

    // ヘッダクリックで折りたたみ
    header.click();
    expect(list.style.display).toBe("none");

    // 再描画後も折りたたみ状態を維持する
    dispatchLinkageData(buildOutput({ warnings: [{ target: "z", reason: "w" }] }));
    const sectionAfter = document.getElementById("orphan-section")!;
    const listAfter = sectionAfter.querySelector<HTMLElement>('div[style*="overflow-y"]')!;
    expect(listAfter.style.display).toBe("none");
  });

  it("pans the graph on right-button drag (mousedown button=2 + mousemove → cy.pan)", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const graph = document.getElementById("graph")!;
    const cyInstance = cytoscapeMock.mock.results[0].value as { pan: ReturnType<typeof vi.fn> };
    cyInstance.pan.mockClear();

    graph.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 140, clientY: 130 }));

    // pan({x,y}) がオフセット付きで呼ばれる（初期 pan {0,0} + dx/dy）
    expect(cyInstance.pan).toHaveBeenCalledWith({ x: 40, y: 30 });

    window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
  });

  it("does not pan on left-button drag (button=0)", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const graph = document.getElementById("graph")!;
    const cyInstance = cytoscapeMock.mock.results[0].value as { pan: ReturnType<typeof vi.fn> };
    cyInstance.pan.mockClear();

    graph.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 140, clientY: 130 }));

    expect(cyInstance.pan).not.toHaveBeenCalled();
  });

  it("zooms on wheel via manual handler (cy.zoom called with level + renderedPosition)", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const graph = document.getElementById("graph")!;
    const cyInstance = cytoscapeMock.mock.results[0].value as { zoom: ReturnType<typeof vi.fn> };
    cyInstance.zoom.mockClear();
    cyInstance.zoom.mockReturnValue(1); // 現在ズーム

    graph.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 50, clientY: 60 }));

    expect(cyInstance.zoom).toHaveBeenCalledWith(
      expect.objectContaining({
        level: expect.any(Number) as number,
        renderedPosition: expect.any(Object) as object,
      }),
    );
  });

  it("opens the search box on Ctrl+F", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    expect(document.querySelector('[role="search"]')).not.toBeNull();
    const box = document.querySelector<HTMLElement>('[role="search"]')!;
    expect(box.style.display).toBe("none");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));

    expect(box.style.display).not.toBe("none");
  });

  it("highlights matching cards and dims non-matching on search input", async () => {
    await import("../main.js");
    dispatchLinkageData(
      buildOutput({ linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }] }),
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const searchInput = document
      .querySelector('[role="search"]')!
      .querySelector<HTMLInputElement>('input[type="text"]')!;

    // route ラベルは "GET /api/users/{id}"、apiCall は "GET /api/users/{}"。"users" は両方一致。
    searchInput.value = "users";
    searchInput.dispatchEvent(new Event("input"));

    // 件数表示が更新される（2件一致）
    expect(document.querySelector('[role="search"]')!.textContent).toContain("/ 2");

    // 非一致クエリで全カードが減光される
    searchInput.value = "zzzznomatch";
    searchInput.dispatchEvent(new Event("input"));
    const dimmed = Array.from(document.querySelectorAll<HTMLElement>(".node-card")).every(
      (el) => el.style.opacity === "0.24",
    );
    expect(dimmed).toBe(true);
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
    // 当たり判定は文字だけ: data-code-link はインライン span（行全体の div ではない）。
    expect(codeLink!.tagName).toBe("SPAN");
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
      payload: { functionId: "backend:fn-getUser" },
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

  it("hover brightens the reachable cards and leaves others unchanged (no dimming)", async () => {
    await import("../main.js");
    // 独立した2つの連携。片方をホバーしても、もう片方（連携はあるが到達しない）は無変化であること。
    const output = buildOutput({
      linkages: [
        { route: route(), apiCall: apiCall(), matchKind: "exact" },
        {
          route: route({ path: "/api/posts/{id}" }),
          apiCall: apiCall({ urlPattern: "/api/posts/{}" }),
          matchKind: "exact",
        },
      ],
    });
    dispatchLinkageData(output);

    const cards = Array.from(document.querySelectorAll<HTMLElement>(".node-card"));
    const hovered = cards.find((c) => c.textContent?.includes("GET /api/users/{}"))!; // apiCall1
    const linkedRoute = cards.find((c) => c.textContent?.includes("GET /api/users/{id}"))!; // route1
    const other = cards.find((c) => c.textContent?.includes("GET /api/posts/{}"))!; // apiCall2(別連携)
    expect(hovered).toBeTruthy();
    expect(linkedRoute).toBeTruthy();
    expect(other).toBeTruthy();

    hovered.dispatchEvent(new MouseEvent("mouseenter"));
    // 到達集合(ホバーした apiCall + 連携先 route)は明るく強調、別連携の apiCall は無変化。
    expect(hovered.style.filter).toContain("brightness");
    expect(linkedRoute.style.filter).toContain("brightness");
    expect(other.style.filter).toBe("");
    // 減光しない: どのカードも opacity は変更しない。
    expect(cards.every((c) => c.style.opacity === "")).toBe(true);

    hovered.dispatchEvent(new MouseEvent("mouseleave"));
    expect(cards.every((c) => c.style.filter === "")).toBe(true);
  });

  it("renders a minimap overlay and pans on click", async () => {
    await import("../main.js");
    dispatchLinkageData(
      buildOutput({ linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }] }),
    );

    const minimap = document.querySelector<HTMLElement>('[data-minimap="true"]');
    expect(minimap).not.toBeNull();

    const cyInstance = cytoscapeMock.mock.results.at(-1)!.value as {
      pan: ReturnType<typeof vi.fn>;
    };
    cyInstance.pan.mockClear();
    minimap!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cyInstance.pan).toHaveBeenCalled();
  });

  it("supports Ctrl+Click multi-select and copies selected frames via the context menu", async () => {
    await import("../main.js");
    dispatchLinkageData(
      buildOutput({
        linkages: [
          { route: route(), apiCall: apiCall(), matchKind: "exact" },
          {
            route: route({ path: "/api/posts/{id}" }),
            apiCall: apiCall({ urlPattern: "/api/posts/{}" }),
            matchKind: "exact",
          },
        ],
      }),
    );

    const cards = Array.from(document.querySelectorAll<HTMLElement>(".node-card"));
    const routeCard = cards.find((c) => c.textContent?.includes("GET /api/users/{id}"))!;
    const apiCard = cards.find((c) => c.textContent?.includes("GET /api/users/{}"))!;

    // 通常クリック = 単一選択（リングのみ。背景色は付けない＝未選択カードと同じ背景）
    routeCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(routeCard.style.boxShadow).not.toBe("");
    const plainBg = routeCard.style.background;
    expect(apiCard.style.background).toBe(plainBg); // 単一選択は背景色で目立たせない

    // Ctrl+クリック = 複数選択（背景色も付く）。先に選択した routeCard も背景色になる。
    apiCard.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(apiCard.style.boxShadow).not.toBe("");
    expect(routeCard.style.boxShadow).not.toBe("");
    const multiBg = apiCard.style.background;
    expect(multiBg).not.toBe(plainBg); // 複数選択は背景色が変わる
    expect(routeCard.style.background).toBe(multiBg);

    // 右クリック → メニューの「選択した枠をコピー」→ copySelected を post
    postMessageMock.mockClear();
    routeCard.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const selectedItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("選択した枠をコピー"))!;
    expect(selectedItem.style.display).toBe("block");
    selectedItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "copySelected" }));
  });

  it("type-to-navigate: typing a prefix selects the matching frame and pans to it (#5)", async () => {
    await import("../main.js");
    dispatchLinkageData(
      buildOutput({ linkages: [{ route: route(), apiCall: apiCall(), matchKind: "exact" }] }),
    );

    const routeCard = Array.from(document.querySelectorAll<HTMLElement>(".node-card")).find((c) =>
      c.textContent?.includes("GET /api/users/{id}"),
    )!;
    const cyInstance = cytoscapeMock.mock.results.at(-1)!.value as {
      pan: ReturnType<typeof vi.fn>;
    };
    cyInstance.pan.mockClear();
    // panToNode は getElementById().position() を使うので、位置付きノードを返すようにする。
    cyGetElementByIdMock.mockReturnValue({
      length: 1,
      position: () => ({ x: 0, y: 0 }),
    } as never);

    // route ラベル "GET /api/users/{id}" → "get" 打鍵で前方一致・選択＋パン。
    for (const ch of "get") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ch }));
    }
    expect(routeCard.style.boxShadow).not.toBe(""); // 選択された
    expect(cyInstance.pan).toHaveBeenCalled(); // 中央へパン
  });

  it("PageDown/PageUp pan the graph vertically (#7)", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const cyInstance = cytoscapeMock.mock.results.at(-1)!.value as {
      pan: ReturnType<typeof vi.fn>;
    };
    cyInstance.pan.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    expect(cyInstance.pan).toHaveBeenCalled();
    cyInstance.pan.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    expect(cyInstance.pan).toHaveBeenCalled();
  });

  it("renders a fixed help overlay at bottom-left with rounded border (#8)", async () => {
    await import("../main.js");
    dispatchLinkageData(buildOutput({}));

    const help = document.querySelector<HTMLElement>('[data-help="true"]');
    expect(help).not.toBeNull();
    expect(help!.style.left).toBe("10px");
    expect(help!.style.bottom).toBe("10px");
    expect(help!.style.borderRadius).not.toBe("");
    expect(help!.textContent).toContain("クリック");
  });
});
