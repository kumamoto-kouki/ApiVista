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
 * - Cytoscapeへ`style`配列を渡し、ノードラベル（`data(label)`）・種別（`kind`）別の色分け・
 *   未連携（`unmatched`）ノードの破線強調・連携(linkage)/構造(structural)エッジの区別を行う
 *   （実機目視確認で「データはあるが既定スタイルのため何も見えない/区別できない」という
 *   視認性の欠陥が見つかり追加した）。配色はVSCodeのテーマCSS変数（`--vscode-charts-*`等）を
 *   `getComputedStyle`で実行時に解決して用いる（design.mdの軽量スタイル指針に従い、固定パレットを
 *   持たずテーマ追従させる）。
 * - エッジの線色は`kind`に関わらず`foreground`系の中立色に統一し、太さ・実線/破線のみで
 *   linkage/structuralを区別する（当初はlinkageエッジに`route`ノードと同じ青を使っていたが、
 *   「同じ青がノード種別とエッジ種別という別の意味を同時に持つ」という視認性評価の指摘を受け、
 *   色相を意味の異なる2軸（ノード種別=色、エッジ種別=線幅/線種）に分離した）。
 * - レイアウトは`grid`→`cose`(力学モデル)を経て`breadthfirst`へ変更した。`cose`は連携の強い
 *   ノードを近接させる一方、対角線状の配置でラベル同士が重なりやすかったため
 *   （視認性評価の指摘）、依存関係の方向性も同時に見やすい`breadthfirst`(階層レイアウト)を採用。
 * - 警告一覧(`warningsPanel.renderWarnings`)に`onTargetHover`コールバックを渡し、警告項目への
 *   ホバー時に対応するグラフノードへ`.warning-highlight`クラスを付与してオーバーレイ強調表示する
 *   （`findMatchingNodeIds`が`warning.target`とノードの`label`の部分一致でマッチングする。
 *   視認性評価で「警告一覧とグラフの対応関係が見た目で分からない」という指摘を受けて追加）。
 */
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from "cytoscape";

import { createDepthSwitchControl } from "./depthSwitchControl.js";
import type { Depth, GraphEdge, GraphNode } from "./projectDepth.js";
import { findMatchingNodeIds, projectDepth } from "./projectDepth.js";
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
depthSwitchContainer.style.flexShrink = "0";

const legendContainer = document.createElement("div");
legendContainer.id = "legend";
legendContainer.style.flexShrink = "0";
legendContainer.style.padding = "2px 0";

const warningsContainer = document.createElement("div");
warningsContainer.id = "warnings";
warningsContainer.style.flexShrink = "0";
warningsContainer.style.maxHeight = "40%";
warningsContainer.style.overflowY = "auto";

// `#app`(webviewHtml.ts側で`display:flex; flex-direction:column; height:100%`を付与済み)の
// 残り領域をグラフ表示に充てる。Cytoscapeはコンテナの実際のサイズを読んで初期化するため、
// 明示的な高さ(`flex: 1 1 auto` + `minHeight`)が無いとコンテナの高さが0pxに崩れ、要素は
// 生成されても何も見えない状態になる(実機検証で発見)。`position: relative`もCytoscape自身が
// 警告するUI拡張機能の前提条件。
const graphContainer = document.createElement("div");
graphContainer.id = "graph";
graphContainer.style.flex = "1 1 auto";
graphContainer.style.minHeight = "300px";
graphContainer.style.position = "relative";

appRoot.appendChild(depthSwitchContainer);
appRoot.appendChild(legendContainer);
appRoot.appendChild(warningsContainer);
appRoot.appendChild(graphContainer);

let currentOutput: LinkageOutput | undefined;
let currentDepth: Depth = DEFAULT_DEPTH;
let cy: Core | undefined;

// グラフの配色を定義する凡例（design.mdの軽量スタイル指針に従い、固定の16進カラーではなく
// VSCodeテーマのCSS変数名を保持し、実際の色は`resolveCssVar`が実行時に解決する）。
// `--vscode-charts-orange`は使わない: 既定のDark Modernテーマでは`rgba(238,238,238,0.27)`
// という低彩度の半透明値が定義されており(空文字列ではないためフォールバックも効かない)、
// 実機検証でほぼ視認できない薄灰色になることが判明したため`--vscode-charts-yellow`を使う。
const LEGEND_ITEMS: { label: string; varName: string; fallback: string }[] = [
  { label: "ルート", varName: "--vscode-charts-blue", fallback: "#3794ff" },
  { label: "APIコール", varName: "--vscode-charts-green", fallback: "#89d185" },
  { label: "ファイル", varName: "--vscode-charts-purple", fallback: "#b180d7" },
  { label: "関数", varName: "--vscode-charts-yellow", fallback: "#cca700" },
  { label: "未連携", varName: "--vscode-charts-red", fallback: "#f14c4c" },
];

function resolveCssVar(varName: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return value === "" ? fallback : value;
}

function renderLegend(container: HTMLElement): void {
  container.replaceChildren();
  for (const item of LEGEND_ITEMS) {
    const entry = document.createElement("span");
    entry.style.display = "inline-flex";
    entry.style.alignItems = "center";
    entry.style.marginRight = "12px";
    entry.style.fontSize = "11px";

    const swatch = document.createElement("span");
    swatch.style.display = "inline-block";
    swatch.style.width = "10px";
    swatch.style.height = "10px";
    swatch.style.borderRadius = "50%";
    swatch.style.marginRight = "4px";
    swatch.style.backgroundColor = resolveCssVar(item.varName, item.fallback);

    const text = document.createElement("span");
    text.textContent = item.label;

    entry.appendChild(swatch);
    entry.appendChild(text);
    container.appendChild(entry);
  }
}

function buildCytoscapeStyle(): StylesheetJson {
  const foreground = resolveCssVar("--vscode-foreground", "#cccccc");
  const routeColor = resolveCssVar("--vscode-charts-blue", "#3794ff");
  const apiCallColor = resolveCssVar("--vscode-charts-green", "#89d185");
  const fileColor = resolveCssVar("--vscode-charts-purple", "#b180d7");
  const functionColor = resolveCssVar("--vscode-charts-yellow", "#cca700");
  const unmatchedColor = resolveCssVar("--vscode-charts-red", "#f14c4c");
  const highlightColor = resolveCssVar("--vscode-focusBorder", "#007acc");

  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        color: foreground,
        "font-size": 10,
        "text-valign": "bottom",
        "text-margin-y": 6,
        "background-color": foreground,
        width: 24,
        height: 24,
      },
    },
    { selector: 'node[kind = "route"]', style: { "background-color": routeColor } },
    { selector: 'node[kind = "apiCall"]', style: { "background-color": apiCallColor } },
    { selector: 'node[kind = "file"]', style: { "background-color": fileColor } },
    { selector: 'node[kind = "function"]', style: { "background-color": functionColor } },
    {
      selector: "node[?unmatched]",
      style: {
        "border-width": 3,
        "border-style": "dashed",
        "border-color": unmatchedColor,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": foreground,
        "line-style": "dashed",
        "curve-style": "bezier",
        "target-arrow-shape": "none",
      },
    },
    {
      selector: 'edge[kind = "linkage"]',
      style: {
        width: 2.5,
        "line-color": foreground,
        "line-style": "solid",
      },
    },
    {
      selector: "node.warning-highlight",
      style: {
        "overlay-color": highlightColor,
        "overlay-opacity": 0.5,
        "overlay-padding": 6,
      },
    },
  ];
}

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

function handleWarningHover(target: string | null): void {
  if (!cy) {
    return;
  }
  cy.nodes().removeClass("warning-highlight");
  if (target === null || !currentOutput) {
    return;
  }
  const { nodes } = projectDepth(currentOutput, currentDepth);
  for (const id of findMatchingNodeIds(target, nodes)) {
    cy.getElementById(id).addClass("warning-highlight");
  }
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
    style: buildCytoscapeStyle(),
    layout: {
      name: "breadthfirst",
      directed: true,
      fit: true,
      padding: 30,
      nodeDimensionsIncludeLabels: true,
      spacingFactor: 1.5,
    },
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
    renderWarnings(warningsContainer, currentOutput.warnings, handleWarningHover);
    renderGraph();
  }
});

createDepthSwitchControl(depthSwitchContainer, (depth) => {
  currentDepth = depth;
  renderGraph();
});

renderLegend(legendContainer);

vscodeApi.postMessage({ type: "ready" });
