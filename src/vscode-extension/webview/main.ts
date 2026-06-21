/**
 * Webviewエントリポイント（design.md「webview/main.ts」, tasks.md 7, Requirements 3.1, 4.2, 5.1）。
 *
 * `acquireVsCodeApi`・メッセージ受信・Cytoscape初期化・各Webviewモジュール（`projectDepth`/
 * `depthSwitchControl`/`warningsPanel`）の結線を行う薄いグルー。`vscode`モジュールへの直接importは
 * 持たない（VSCode Webviewのプラットフォーム制約により実行時にも不可能）。
 *
 * - `acquireVsCodeApi()`は本モジュールのトップレベルで1度だけ呼び出す（design.md「Integration」）。
 * - 呼び出し後、グラフ/深度切替/警告のマウント先DOMを構築し（`webviewHtml.ts`が提供する`#app`の
 *   子要素として組み立てる。`webviewHtml.ts`は`#app`のみを提供し内部構造を持たないため、本モジュールが
 *   プログラム的に構築する。`webviewHtml.ts`自体の変更は不要）、続けて`"ready"`メッセージを送る
 *   （ホスト側`graphPanel.ts`が`"ready"`受信後に初回`linkageData`を送るため、マウント先が
 *   先に存在している必要がある）。
 * - `message`イベントで`HostToWebviewMessage`を受信し、`type === "linkageData"`の場合に
 *   `currentOutput`を更新して`renderWarnings`→`renderGraph`を実行する。`currentDepth`はこの
 *   ハンドラでは変更しないため、再解析後の再送時も「現在の深度で再描画する」を自然に満たす。
 * - `renderGraph`は`projectDepth(currentOutput, currentDepth)`の結果をCytoscape
 *   `ElementDefinition[]`へ変換し、既存のCytoscapeインスタンスを破棄してから再生成する
 *   （Cytoscapeは要素全体の差し替えを直接サポートしないため、本タスクの範囲では
 *   destroy+recreateが最も単純で正しい方式。インクリメンタルな差分更新は過剰実装として避ける）。
 * - ノードタップ（`cy.on("tap", "node", ...)`）時、ノードの`sourceLocation`が存在する場合のみ
 *   `nodeClick`メッセージをホストへ送信する（`sourceLocation`を持たない`file`/`function`ノードも
 *   将来的にあり得るため、存在チェックで安全側に倒す）。
 */
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";

import { createDepthSwitchControl } from "./depthSwitchControl.js";
import type { Depth, GraphEdge, GraphNode } from "./projectDepth.js";
import { projectDepth } from "./projectDepth.js";
import { renderWarnings } from "./warningsPanel.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../webviewProtocol.js";
import type { LinkageOutput } from "../../route-linkage/models.js";

/**
 * VSCodeがWebview実行時にグローバルへ注入する関数の最小限のアンビエント宣言。
 * `vscode`モジュールへの直接importを避けるため、本モジュールが必要とする`postMessage`の
 * シグネチャのみを宣言する。
 */
declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
};

const DEFAULT_DEPTH: Depth = "route";

const vscodeApi = acquireVsCodeApi();

const appRoot = document.getElementById("app") ?? document.body;

const depthSwitchContainer = document.createElement("div");
depthSwitchContainer.id = "depth-switch";

const warningsContainer = document.createElement("div");
warningsContainer.id = "warnings";

const graphContainer = document.createElement("div");
graphContainer.id = "graph";

appRoot.appendChild(depthSwitchContainer);
appRoot.appendChild(warningsContainer);
appRoot.appendChild(graphContainer);

let currentOutput: LinkageOutput | undefined;
let currentDepth: Depth = DEFAULT_DEPTH;
let cy: Core | undefined;

function toElementDefinitions(nodes: GraphNode[], edges: GraphEdge[]): ElementDefinition[] {
  const nodeElements: ElementDefinition[] = nodes.map((node) => ({
    data: { ...node },
  }));
  const edgeElements: ElementDefinition[] = edges.map((edge) => ({
    data: { ...edge },
  }));
  return [...nodeElements, ...edgeElements];
}

function handleNodeTap(node: GraphNode): void {
  if (!node.sourceLocation) {
    return;
  }
  vscodeApi.postMessage({ type: "nodeClick", payload: node.sourceLocation });
}

function renderGraph(): void {
  if (!currentOutput) {
    return;
  }

  const { nodes, edges } = projectDepth(currentOutput, currentDepth);
  const elements = toElementDefinitions(nodes, edges);

  cy?.destroy();
  cy = cytoscape({
    container: graphContainer,
    elements,
    layout: { name: "grid" },
  });

  cy.on("tap", "node", (event) => {
    const node = event.target.data() as GraphNode;
    handleNodeTap(node);
  });
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "linkageData") {
    currentOutput = message.payload;
    renderWarnings(warningsContainer, currentOutput.warnings);
    renderGraph();
  }
});

createDepthSwitchControl(depthSwitchContainer, (depth) => {
  currentDepth = depth;
  renderGraph();
});

vscodeApi.postMessage({ type: "ready" });
