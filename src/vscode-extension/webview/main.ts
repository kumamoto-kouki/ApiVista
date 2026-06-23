/**
 * Webviewエントリポイント（design.md「webview/main.ts」, tasks.md 7, Requirements 3.1, 4.2, 5.1）。
 *
 * Claude Design実装（handoff.md §8）に基づき、以下を全面改修した:
 * - レイアウト: breadthfirst → preset（フロントエンド=左列 / バックエンド=右列）
 * - ノード: Cytoscapeキャンバスでは不可視（opacity:0）にし、HTMLカードオーバーレイで表現。
 *   カード内に「バッジ + 種別名 + 接続数」ヘッダ、大きめのラベル、イタリックのソース位置を表示。
 * - エッジ: Cytoscapeが担当（矢印付き bezier/taxi）。ノードが不可視の矩形サイズを持つため正確に結線。
 * - エッジ方向: 呼び出し元(フロントエンド) → 呼び出し先(バックエンド) に統一。
 * - 背景ゾーン: 丸角ボーダー＋ノード数バッジ付きゾーンヘッダ。
 * - 警告: 対応ノード直下のHTMLオーバーレイ（kindに応じた色インジケータ）。孤立警告は底部に固定表示。
 * - インタラクション: hover減光（.dim＋カード不透明度）、空きエリアclick解除。
 */
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from "cytoscape";

import { createCardContextMenu } from "./cardContextMenu.js";
import { createDepthSwitchControl } from "./depthSwitchControl.js";
import { LEGEND_LANGUAGES } from "./languageStyle.js";
import { createNodeCard } from "./nodeCardRenderer.js";
import { createSearchBox } from "./searchBox.js";
import type { Depth, GraphEdge, GraphNode } from "./projectDepth.js";
import { matchWarningNodeIds, projectDepth } from "./projectDepth.js";
import {
  clearLinkageLines,
  clearTreeGuides,
  renderLinkageLines,
  renderTreeGuides,
  setHoverReachable,
} from "./svgRenderer.js";
import { buildTheme } from "./themeManager.js";
import {
  inferWarningKind,
  translateReason,
  WARNING_KIND_COLOR,
  type WarningKind,
} from "./warningFormatter.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../webviewProtocol.js";
import type { LinkageOutput, Warning } from "../../route-linkage/models.js";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
};

const DEFAULT_DEPTH: Depth = "route";

const vscodeApi = acquireVsCodeApi();

// 枠（ノードカード）右クリック用コンテキストメニュー。選択で連鎖関数コピーを要求する。
const cardContextMenu = createCardContextMenu((node) => {
  if (node.functionId) {
    vscodeApi.postMessage({
      type: "copyLinked",
      payload: { functionId: node.functionId },
    });
  }
});

const appRoot = document.getElementById("app") ?? document.body;
appRoot.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;";

// ツールバー
const depthSwitchContainer = document.createElement("div");
depthSwitchContainer.id = "depth-switch";
depthSwitchContainer.style.flexShrink = "0";

// 凡例
const legendContainer = document.createElement("div");
legendContainer.id = "legend";
legendContainer.style.cssText =
  "flex-shrink:0;padding:4px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--vscode-widget-border,#2b2b2b);";

// グラフコンテナ（flex: 1 で残り領域全体を占有）
const graphContainer = document.createElement("div");
graphContainer.id = "graph";
graphContainer.style.cssText = "flex:1 1 auto;min-height:300px;position:relative;overflow:hidden;";

// 孤立警告セクション（グラフ下部、警告がある場合のみ表示）
const orphanSection = document.createElement("div");
orphanSection.id = "orphan-section";
orphanSection.style.cssText =
  "flex-shrink:0;display:none;border-top:1px solid var(--vscode-widget-border,#2b2b2b);";

appRoot.appendChild(depthSwitchContainer);
appRoot.appendChild(legendContainer);
appRoot.appendChild(graphContainer);
appRoot.appendChild(orphanSection);

let currentOutput: LinkageOutput | undefined;
let currentDepth: Depth = DEFAULT_DEPTH;
let cy: Core | undefined;

// ─────────────────────────────────────────
// 右ドラッグによるパン（表示移動）
//   Cytoscape は右ボタンパンを標準サポートしないため、左パンを無効化（renderGraph 側）し
//   ここで右ドラッグを手動でパンに変換する。右クリック単独（ドラッグなし）はカードの
//   コンテキストメニュー（連携関数コピー）を維持する。
// ─────────────────────────────────────────

const PAN_MOVE_THRESHOLD = 4;
let isRightPanning = false;
let rightPanMoved = false;
let panStart = { clientX: 0, clientY: 0, panX: 0, panY: 0 };

graphContainer.addEventListener("mousedown", (e) => {
  if (e.button !== 2 || !cy) return;
  isRightPanning = true;
  rightPanMoved = false;
  const pan = cy.pan();
  panStart = { clientX: e.clientX, clientY: e.clientY, panX: pan.x, panY: pan.y };
});

window.addEventListener("mousemove", (e) => {
  if (!isRightPanning || !cy) return;
  const dx = e.clientX - panStart.clientX;
  const dy = e.clientY - panStart.clientY;
  if (Math.abs(dx) > PAN_MOVE_THRESHOLD || Math.abs(dy) > PAN_MOVE_THRESHOLD) {
    rightPanMoved = true;
  }
  cy.pan({ x: panStart.panX + dx, y: panStart.panY + dy });
});

window.addEventListener("mouseup", (e) => {
  if (e.button === 2) isRightPanning = false;
});

// 右ドラッグ後の contextmenu はカードのコピーメニューを開かない。常にブラウザ既定メニューは抑止。
graphContainer.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
    if (rightPanMoved) {
      e.stopPropagation();
      rightPanMoved = false;
    }
  },
  true,
);

// 手動ホイールズーム（カーソル位置中心）。Cytoscape 既定ズームは userPanningEnabled に依存し
// 無効化済みのため、ここで cy.zoom({level, renderedPosition}) を直接呼ぶ（プログラム的パンは有効）。
graphContainer.addEventListener(
  "wheel",
  (e) => {
    if (!cy) return;
    e.preventDefault();
    const rect = graphContainer.getBoundingClientRect();
    const renderedPosition = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 33; // 行単位デルタを px 相当へ近似（Cytoscape 準拠）
    const newZoom = cy.zoom() * Math.pow(10, delta / -2200);
    cy.zoom({ level: newZoom, renderedPosition });
  },
  { passive: false },
);

// ─────────────────────────────────────────
// 文字列検索（右上の検索ボックス + Ctrl+F）
// ─────────────────────────────────────────

const SEARCH_MATCH_SHADOW = "0 0 0 2px var(--vscode-editorWarning-foreground,#cca700)";
const SEARCH_CURRENT_SHADOW = "0 0 0 3px var(--vscode-focusBorder,#0078d4)";

let searchQuery = "";
let searchMatchIds: string[] = [];
let searchIndex = 0;

/** 検索のハイライト/減光を全解除する。 */
function clearSearchHighlight(): void {
  for (const { el } of nodeCardEls) {
    el.style.opacity = "";
    el.style.boxShadow = "";
  }
  setHoverReachable(null);
}

/** 現在のクエリで一致を再計算し、ハイライト/減光・件数・中央寄せを反映する。 */
function applySearch(query: string): void {
  searchQuery = query;
  const q = query.trim().toLowerCase();
  if (q === "") {
    searchMatchIds = [];
    searchIndex = 0;
    clearSearchHighlight();
    searchBox.setCount(0, 0);
    return;
  }

  const matchSet = new Set<string>();
  for (const { nodeId, searchText } of nodeCardEls) {
    if (searchText.includes(q)) matchSet.add(nodeId);
  }
  searchMatchIds = nodeCardEls.filter((c) => matchSet.has(c.nodeId)).map((c) => c.nodeId);
  searchIndex = 0;

  for (const { el, nodeId } of nodeCardEls) {
    if (matchSet.has(nodeId)) {
      el.style.opacity = "";
      el.style.boxShadow = SEARCH_MATCH_SHADOW;
    } else {
      el.style.opacity = "0.24";
      el.style.boxShadow = "";
    }
  }
  setHoverReachable(null);

  if (searchMatchIds.length > 0) {
    focusMatch(0);
  } else {
    searchBox.setCount(0, 0);
  }
}

/** i 番目の一致を強調し、表示を中央へ寄せる。 */
function focusMatch(i: number): void {
  if (searchMatchIds.length === 0) return;
  searchIndex = ((i % searchMatchIds.length) + searchMatchIds.length) % searchMatchIds.length;
  const targetId = searchMatchIds[searchIndex];
  for (const { el, nodeId } of nodeCardEls) {
    if (nodeId === targetId) el.style.boxShadow = SEARCH_CURRENT_SHADOW;
    else if (searchMatchIds.includes(nodeId)) el.style.boxShadow = SEARCH_MATCH_SHADOW;
  }
  if (cy) {
    const ele = cy.getElementById(targetId);
    if (ele.length) cy.animate({ center: { eles: ele }, duration: 200 });
  }
  searchBox.setCount(searchIndex + 1, searchMatchIds.length);
}

const searchBox = createSearchBox(graphContainer, {
  onInput: (q) => applySearch(q),
  onNext: () => focusMatch(searchIndex + 1),
  onPrev: () => focusMatch(searchIndex - 1),
  onClose: () => {
    clearSearchHighlight();
    searchMatchIds = [];
    searchQuery = "";
    searchBox.close();
  },
});

window.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchBox.open();
    } else if (e.key === "Escape" && searchBox.isOpen()) {
      e.preventDefault();
      clearSearchHighlight();
      searchMatchIds = [];
      searchQuery = "";
      searchBox.close();
    }
  },
  true,
);

// ─────────────────────────────────────────
// HTMLノードカード定数
// ─────────────────────────────────────────

/** ズーム=1 時のカード幅（px）。Cytoscapeノードの width と一致させる。 */
const NODE_CARD_W = 200;
/** ズーム=1 時のカード高さ（px）。Cytoscapeノードの height と一致させる。 */
const NODE_CARD_H = 80;
/** 警告1件あたりのカード内高さ（2行＋パディング）（px）。 */
const WARNING_ITEM_H = 34;
/** カード間の最小ギャップ（px）。 */
const ROW_GAP = 16;
/** structural ネスト1階層ごとの X インデント（px）。 */
const INDENT_X = 60;

// ─────────────────────────────────────────
// 凡例
// ─────────────────────────────────────────

function renderLegend(container: HTMLElement): void {
  const theme = buildTheme();
  container.replaceChildren();

  // 言語（拡張子）別の凡例。枠の配色・左上アイコンに対応する。
  for (const lang of LEGEND_LANGUAGES) {
    const entry = document.createElement("span");
    entry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:13px;";

    const icon = document.createElement("span");
    icon.innerHTML = lang.iconSvg;
    icon.style.cssText = "width:14px;height:14px;display:inline-flex;line-height:0;flex-shrink:0;";

    const label = document.createElement("span");
    label.textContent = lang.label;
    label.style.color = theme.textSub;

    entry.appendChild(icon);
    entry.appendChild(label);
    container.appendChild(entry);
  }

  // 未連携
  const unmatchedEntry = document.createElement("span");
  unmatchedEntry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:13px;";
  const unmatchedBox = document.createElement("span");
  unmatchedBox.style.cssText = `display:inline-block;width:12px;height:12px;border:2px dashed ${theme.unmatched};border-radius:2px;`;
  const unmatchedLabel = document.createElement("span");
  unmatchedLabel.textContent = "未連携";
  unmatchedLabel.style.color = theme.textSub;
  unmatchedEntry.appendChild(unmatchedBox);
  unmatchedEntry.appendChild(unmatchedLabel);
  container.appendChild(unmatchedEntry);

  // セパレータ
  const sep = document.createElement("span");
  sep.style.cssText =
    "width:1px;height:14px;background:var(--vscode-widget-border,#2b2b2b);margin:0 4px;";
  container.appendChild(sep);

  // エッジ凡例
  const linkageEntry = document.createElement("span");
  linkageEntry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:13px;";
  const linkageLine = document.createElement("span");
  linkageLine.textContent = "→";
  linkageLine.style.cssText = `color:${theme.edge};font-weight:700;`;
  const linkageLabel = document.createElement("span");
  linkageLabel.textContent = "連携";
  linkageLabel.style.color = theme.textSub;
  linkageEntry.appendChild(linkageLine);
  linkageEntry.appendChild(linkageLabel);
  container.appendChild(linkageEntry);

  const structEntry = document.createElement("span");
  structEntry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:13px;";
  const structLine = document.createElement("span");
  structLine.textContent = "⌐→";
  structLine.style.cssText = `color:${theme.edge};font-weight:700;`;
  const structLabel = document.createElement("span");
  structLabel.textContent = "構造(import/呼出・ネスト表示)";
  structLabel.style.color = theme.textSub;
  structEntry.appendChild(structLine);
  structEntry.appendChild(structLabel);
  container.appendChild(structEntry);
}

// ─────────────────────────────────────────
// 背景ゾーン（フロントエンド左 / バックエンド右）
// ─────────────────────────────────────────

let frontendZone: HTMLElement | null = null;
let backendZone: HTMLElement | null = null;

function renderBackgroundZones(frontendCount: number, backendCount: number): void {
  if (frontendZone) frontendZone.remove();
  if (backendZone) backendZone.remove();

  const theme = buildTheme();

  // 矩形（left/top/width/height）は updateZonePositions が実カード位置から算出する。
  // 固定 50% をやめることで、縮尺・解像度に依らずカードが必ずゾーン内に収まる。
  frontendZone = document.createElement("div");
  frontendZone.style.cssText = [
    "position:absolute",
    "display:none",
    `background:${theme.apiCall}0d`,
    `border:1px solid ${theme.apiCall}35`,
    "border-radius:8px",
    "pointer-events:none",
    "z-index:2",
    "box-sizing:border-box",
  ].join(";");

  const feHeader = document.createElement("div");
  feHeader.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px 0;";
  feHeader.innerHTML = `<span style="font-size:12px;font-weight:600;color:${theme.apiCall}">フロントエンド <span style="font-weight:400;font-size:11px;color:${theme.textSub}">呼び出し元</span></span><span style="background:${theme.apiCall};color:#1f1f1f;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${frontendCount}</span>`;
  frontendZone.appendChild(feHeader);

  backendZone = document.createElement("div");
  backendZone.style.cssText = [
    "position:absolute",
    "display:none",
    `background:${theme.route}0d`,
    `border:1px solid ${theme.route}35`,
    "border-radius:8px",
    "pointer-events:none",
    "z-index:2",
    "box-sizing:border-box",
  ].join(";");

  const beHeader = document.createElement("div");
  beHeader.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px 0;";
  beHeader.innerHTML = `<span style="font-size:12px;font-weight:600;color:${theme.route}">バックエンド <span style="font-weight:400;font-size:11px;color:${theme.textSub}">呼び出し先</span></span><span style="background:${theme.route};color:#1f1f1f;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${backendCount}</span>`;
  backendZone.appendChild(beHeader);

  // Cytoscape canvas 生成後に追加することでキャンバス上に重なる (z-index:2 > canvas:auto)
  graphContainer.appendChild(frontendZone);
  graphContainer.appendChild(backendZone);
}

// ─────────────────────────────────────────
// Cytoscape スタイル
// ─────────────────────────────────────────

function buildCytoscapeStyle(): StylesheetJson {
  return [
    {
      // ノードは不可視（HTMLカードがビジュアルを担当）。エッジ結線のためサイズは維持する。
      selector: "node",
      style: {
        opacity: 0,
        width: NODE_CARD_W,
        height: NODE_CARD_H,
        shape: "rectangle",
        label: "",
      },
    },
    {
      // エッジはトポロジー保持のみ（ホバー隣接検出用）。描画は linkage SVG が担当。
      selector: "edge",
      style: { opacity: 0, width: 0 },
    },
  ];
}

// ─────────────────────────────────────────
// レイアウト計算（位置 + structural 深度）
// ─────────────────────────────────────────

type LayoutResult = {
  positions: Record<string, { x: number; y: number }>;
  depths: Map<string, number>;
  primaryParentOf: Map<string, string>;
};

function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  warningsByNode: Map<string, Warning[]>,
): LayoutResult {
  const LEFT_X = 200;
  const RIGHT_X = 700;
  const TOP_Y = 50;

  const frontendNodes = nodes.filter((n) => n.side === "frontend");
  const backendNodes = nodes.filter((n) => n.side === "backend");

  /** グループ内 structural エッジ（同一 side）のみ取得 */
  function groupStructEdges(group: GraphNode[]): GraphEdge[] {
    const ids = new Set(group.map((n) => n.id));
    return edges.filter((e) => e.kind === "structural" && ids.has(e.source) && ids.has(e.target));
  }

  /** structural エッジを優先した深さ優先訪問順（primaryParentOf が渡された場合は主親のみ辿る） */
  function treeOrder(
    group: GraphNode[],
    structEdges: GraphEdge[],
    primaryParentOf?: Map<string, string>,
  ): GraphNode[] {
    const children = new Set(structEdges.map((e) => e.target));
    const roots = group.filter((n) => !children.has(n.id));
    const result: GraphNode[] = [];
    const visited = new Set<string>();
    const nodeMap = new Map(group.map((n) => [n.id, n]));

    function visit(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      const n = nodeMap.get(id);
      if (n) result.push(n);
      for (const e of structEdges) {
        if (e.source === id) {
          if (!primaryParentOf || primaryParentOf.get(e.target) === id) {
            visit(e.target);
          }
        }
      }
    }

    for (const r of roots) visit(r.id);
    for (const n of group) {
      if (!visited.has(n.id)) result.push(n);
    }
    return result;
  }

  /** structural 親子関係から各ノードの深さと主親マップを算出 */
  function calcDepths(
    group: GraphNode[],
    structEdges: GraphEdge[],
  ): { depthMap: Map<string, number>; parentOf: Map<string, string> } {
    const parentOf = new Map<string, string>();
    for (const e of structEdges) parentOf.set(e.target, e.source);

    const depths = new Map<string, number>();
    function getDepth(id: string): number {
      if (depths.has(id)) return depths.get(id)!;
      const parent = parentOf.get(id);
      if (!parent) {
        depths.set(id, 0);
        return 0;
      }
      const d = getDepth(parent) + 1;
      depths.set(id, d);
      return d;
    }
    for (const n of group) getDepth(n.id);
    return { depthMap: depths, parentOf };
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const depths = new Map<string, number>();
  const primaryParentOf = new Map<string, string>();

  function layoutColumn(group: GraphNode[], x: number): void {
    const se = groupStructEdges(group);
    const { depthMap: colDepths, parentOf: colParentOf } = calcDepths(group, se);
    for (const [k, v] of colParentOf) primaryParentOf.set(k, v);
    const ordered = treeOrder(group, se, colParentOf);

    let y = TOP_Y + NODE_CARD_H / 2;
    for (const node of ordered) {
      const depth = colDepths.get(node.id) ?? 0;
      depths.set(node.id, depth);
      positions[node.id] = { x, y };
      const wCount = (warningsByNode.get(node.id) ?? []).length;
      y += NODE_CARD_H + wCount * WARNING_ITEM_H + ROW_GAP;
    }
  }

  layoutColumn(frontendNodes, LEFT_X);
  layoutColumn(backendNodes, RIGHT_X);
  return { positions, depths, primaryParentOf };
}

// ─────────────────────────────────────────
// HTMLノードカード（オーケストレーション）
// ─────────────────────────────────────────

type NodeCardEntry = {
  el: HTMLElement;
  nodeId: string;
  side: "backend" | "frontend";
  /** 検索一致判定用の小文字テキスト（label + sourceLocation.file）。 */
  searchText: string;
};
let nodeCardEls: NodeCardEntry[] = [];
let nodeCardUpdateFn: (() => void) | null = null;

/**
 * 表示中エッジ（structural+linkage）から構築する**有向**隣接（source→target）。連鎖ホバーに使う。
 *
 * 無向にすると、ファイル/関数依存グラフのように密に連結したグラフでは到達集合が全ノードになり
 * 減光が起きない。エッジの向き（呼び出し元→呼び出し先、フロント→バック）に沿って下流のみを
 * 辿ることで、連鎖を保ちつつ無関係な枝を減光する。
 */
let hoverAdj = new Map<string, Set<string>>();

/** `hoverAdj` を `edges` から有向（source→target）で再構築する。 */
function buildHoverAdjacency(edges: GraphEdge[]): void {
  hoverAdj = new Map();
  for (const e of edges) {
    (hoverAdj.get(e.source) ?? hoverAdj.set(e.source, new Set()).get(e.source)!).add(e.target);
  }
}

/** `startId` から有向 BFS で下流到達するノード ID 集合（起点含む）を返す。 */
function reachableNodeIds(startId: string): Set<string> {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of hoverAdj.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

function clearNodeCards(): void {
  if (nodeCardUpdateFn) {
    cy?.off("render pan zoom resize", nodeCardUpdateFn);
    nodeCardUpdateFn = null;
  }
  for (const { el } of nodeCardEls) el.remove();
  nodeCardEls = [];
  cardContextMenu.close();
  clearTreeGuides(cy);
  clearLinkageLines();
}

function updateNodeCardPositions(): void {
  if (!cy) return;
  const zoom = cy.zoom();
  const pan = cy.pan();

  for (const { el, nodeId } of nodeCardEls) {
    const cyNode = cy.getElementById(nodeId);
    if (!cyNode.length) continue;
    const pos = cyNode.position();
    const screenX = pos.x * zoom + pan.x;
    const screenY = pos.y * zoom + pan.y;
    const hw = NODE_CARD_W / 2;
    const hh = NODE_CARD_H / 2;
    const depth = Number(el.dataset.depth ?? "0");
    const extraX = depth * INDENT_X * zoom;
    el.style.transform = `translate(${screenX - hw * zoom + extraX}px, ${screenY - hh * zoom}px) scale(${zoom})`;
  }

  updateZonePositions();
}

/** ゾーンパディング（カード bbox の外側余白, px）。 */
const ZONE_PADDING = 14;
/** ゾーン上部のヘッダ（見出し+件数）用に確保する追加の高さ（px）。 */
const ZONE_HEADER_SPACE = 30;

/**
 * フロント/バック背景ゾーンを、実際のカード画面位置から算出した矩形に合わせる。
 * 固定 50% ではなく実コンテンツ基準にすることで、カードが必ずゾーン内に収まる。
 */
function updateZonePositions(): void {
  const containerRect = graphContainer.getBoundingClientRect();

  const fit = (side: "backend" | "frontend", zone: HTMLElement | null): void => {
    if (!zone) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const { el, side: cardSide } of nodeCardEls) {
      if (cardSide !== side) continue;
      const r = el.getBoundingClientRect();
      minX = Math.min(minX, r.left - containerRect.left);
      minY = Math.min(minY, r.top - containerRect.top);
      maxX = Math.max(maxX, r.right - containerRect.left);
      maxY = Math.max(maxY, r.bottom - containerRect.top);
      count++;
    }
    if (count === 0) {
      zone.style.display = "none";
      return;
    }
    zone.style.display = "block";
    zone.style.left = `${minX - ZONE_PADDING}px`;
    zone.style.top = `${minY - ZONE_HEADER_SPACE}px`;
    zone.style.width = `${maxX - minX + ZONE_PADDING * 2}px`;
    zone.style.height = `${maxY - minY + ZONE_HEADER_SPACE + ZONE_PADDING}px`;
  };

  fit("frontend", frontendZone);
  fit("backend", backendZone);
}

function renderNodeCards(
  nodes: GraphNode[],
  edges: GraphEdge[],
  warningsByNode: Map<string, Warning[]>,
  depths: Map<string, number>,
): void {
  clearNodeCards();
  if (!cy) return;

  const theme = buildTheme();

  // 連鎖ホバー用の無向隣接を構築
  buildHoverAdjacency(edges);

  // ノードごとの接続数を集計
  const connCount = new Map<string, number>();
  for (const e of edges) {
    connCount.set(e.source, (connCount.get(e.source) ?? 0) + 1);
    connCount.set(e.target, (connCount.get(e.target) ?? 0) + 1);
  }

  for (const node of nodes) {
    const warnings = warningsByNode.get(node.id) ?? [];
    const card = createNodeCard(node, connCount.get(node.id) ?? 0, warnings, theme);
    card.dataset.depth = String(depths.get(node.id) ?? 0);

    // クリック: カードをハイライト（コードジャンプは [data-code-link] 要素のみ）
    card.addEventListener("click", () => {
      for (const { el } of nodeCardEls) {
        el.style.boxShadow = "";
      }
      card.style.boxShadow = `0 0 0 2px ${theme.selected}`;
    });

    // 右クリック: 連鎖関数コピー用の日本語コンテキストメニューを開く（functionId を持つ枠のみ）
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (node.functionId) {
        cardContextMenu.open(e.clientX, e.clientY, node);
      }
    });

    // コードジャンプリンク: ホバーで下線、クリックでコードジャンプ
    for (const link of card.querySelectorAll<HTMLElement>("[data-code-link]")) {
      link.addEventListener("mouseenter", () => {
        link.style.textDecoration = "underline";
      });
      link.addEventListener("mouseleave", () => {
        link.style.textDecoration = "";
      });
      link.addEventListener("click", () => {
        if (node.sourceLocation) {
          vscodeApi.postMessage({ type: "nodeClick", payload: node.sourceLocation });
        }
      });
    }

    // ホバー: 連鎖（無向で到達可能な全ノード）以外を減光。線（連携線・ツリーガイド）は
    // svgRenderer 側へ到達集合を渡して減光させる（毎tick再描画されるため）。
    card.addEventListener("mouseenter", () => {
      const reachable = reachableNodeIds(node.id);
      for (const { el, nodeId: nid } of nodeCardEls) {
        el.style.opacity = reachable.has(nid) ? "" : "0.24";
      }
      setHoverReachable(reachable);
    });

    card.addEventListener("mouseleave", () => {
      for (const { el } of nodeCardEls) {
        el.style.opacity = "";
      }
      setHoverReachable(null);
    });

    graphContainer.appendChild(card);
    nodeCardEls.push({
      el: card,
      nodeId: node.id,
      side: node.side,
      searchText: `${node.label} ${node.sourceLocation?.file ?? ""}`.toLowerCase(),
    });
  }

  const updateFn = () => updateNodeCardPositions();
  nodeCardUpdateFn = updateFn;
  cy.on("render pan zoom resize", updateFn);
  updateNodeCardPositions();
}

// ─────────────────────────────────────────
// 警告オーバーレイ
// ─────────────────────────────────────────

const WARNING_OVERLAY_CLASS = "warning-overlay";

function clearWarningOverlays(): void {
  for (const el of Array.from(graphContainer.querySelectorAll("." + WARNING_OVERLAY_CLASS))) {
    el.remove();
  }
}

/** 孤立警告（対応ノードが見つからない警告）をグラフ下部のセクションに表示する。 */
function renderOrphanWarnings(orphans: Warning[]): void {
  clearWarningOverlays();
  orphanSection.replaceChildren();

  if (orphans.length === 0) {
    orphanSection.style.display = "none";
    return;
  }

  orphanSection.style.display = "block";
  const theme = buildTheme();

  // ヘッダ
  const header = document.createElement("div");
  header.style.cssText = `padding:6px 12px 4px;font-size:13px;font-weight:600;color:${theme.textSub};letter-spacing:.3px;`;
  header.textContent = "該当ノードのない警告";
  orphanSection.appendChild(header);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px;";

  for (const w of orphans) {
    const kind = inferWarningKind(w);
    const icon = kind === "excluded" ? "■" : kind === "parse" ? "◆" : "○";
    const color = WARNING_KIND_COLOR[kind];

    // 警告チップは視認性のため従来比 1.5 倍のサイズで表示する。
    const chip = document.createElement("div");
    chip.className = WARNING_OVERLAY_CLASS;
    chip.style.cssText = [
      `background:${theme.cardBg}`,
      `border:1px solid ${color}40`,
      "border-radius:6px",
      "padding:5px 12px 5px 9px",
      `border-left:5px solid ${color}`,
      "font-size:18px",
      "font-family:ui-monospace,Menlo,monospace",
      "max-width:480px",
    ].join(";");

    const l1 = document.createElement("div");
    l1.style.cssText = `color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;`;
    l1.textContent = `${icon} ${w.target}`;

    const l2 = document.createElement("div");
    l2.style.cssText = `font-size:16px;color:${theme.textSub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    l2.textContent = translateReason(w.reason);

    chip.appendChild(l1);
    chip.appendChild(l2);
    list.appendChild(chip);
  }

  orphanSection.appendChild(list);
}

// ─────────────────────────────────────────
// グラフ描画
// ─────────────────────────────────────────

function toElementDefinitions(
  nodes: GraphNode[],
  edges: GraphEdge[],
  positions: Record<string, { x: number; y: number }>,
): ElementDefinition[] {
  const nodeElements: ElementDefinition[] = nodes.map((node) => ({
    data: { ...node, label: "" },
    position: positions[node.id],
  }));

  // structural エッジはツリーガイド SVG で描画するため Cytoscape から除外
  const edgeElements: ElementDefinition[] = edges
    .filter((e) => e.kind === "linkage")
    .map((edge) => ({ data: { ...edge } }));

  return [...nodeElements, ...edgeElements];
}

function handleNodeTap(_node: GraphNode): void {
  // Cytoscape fallback tap: カード上のクリックは [data-code-link] 要素が処理するため何もしない
}

function renderGraph(): void {
  if (!currentOutput) return;

  clearWarningOverlays();
  clearNodeCards();

  const { nodes, edges } = projectDepth(currentOutput, currentDepth);
  const frontendCount = nodes.filter((n) => n.side === "frontend").length;
  const backendCount = nodes.filter((n) => n.side === "backend").length;

  // 警告マップをレイアウト前に構築（動的行間隔の計算に必要）
  const warningsByNode = new Map<string, Warning[]>();
  const orphanWarnings: Warning[] = [];
  for (const w of currentOutput.warnings) {
    const matchedIds = matchWarningNodeIds(w, nodes);
    if (matchedIds.length > 0) {
      for (const nodeId of matchedIds) {
        if (!warningsByNode.has(nodeId)) warningsByNode.set(nodeId, []);
        warningsByNode.get(nodeId)!.push(w);
      }
    } else {
      orphanWarnings.push(w);
    }
  }

  const { positions, depths, primaryParentOf } = computeLayout(nodes, edges, warningsByNode);
  const elements = toElementDefinitions(nodes, edges, positions);

  cy?.destroy();
  cy = cytoscape({
    container: graphContainer,
    elements,
    style: buildCytoscapeStyle(),
    layout: {
      name: "preset",
      fit: true,
      padding: 50,
    },
    // ホイールズーム/パンは下の手動ハンドラで実装する。Cytoscape のホイールズームは
    // userPanningEnabled が真であることを要求するため（パン無効化でズームも死ぬ）、両方 false にし
    // 右ドラッグパン + 手動ホイールズームで代替する。
    userZoomingEnabled: false,
    userPanningEnabled: false,
    autoungrabify: true,
    boxSelectionEnabled: false,
  });

  // ゾーンは cy 生成後に追加してキャンバス上に表示（z-index:2 > canvas:auto）
  renderBackgroundZones(frontendCount, backendCount);

  // cy.destroy() が graphContainer の全子要素を除去するため、検索ボックスを再マウントして復帰させる
  // （これが無いと再描画後に Ctrl+F で開いてもボックスが DOM から消えていて表示されない）。
  searchBox.mount();

  // pan/zoom でカードが移動するため、開いているコンテキストメニューは閉じる。
  cy.on("pan zoom", () => {
    cardContextMenu.close();
  });

  // ノードタップ（不可視ノード上のクリックも Cytoscape が受け取る場合の fallback）
  cy.on("tap", "node", (event) => {
    const node = event.target.data() as GraphNode;
    handleNodeTap(node);
  });

  // 空きエリアクリック → 選択解除・カード選択リセット
  cy.on("tap", (event) => {
    if (event.target === cy) {
      cy?.elements().removeClass("dim").unselect();
      for (const { el } of nodeCardEls) {
        el.style.boxShadow = "";
        el.style.opacity = "";
      }
      setHoverReachable(null);
    }
  });

  // hover: Cytoscape invisible nodes のホバーはカード側ハンドラーが処理
  cy.on("mouseover", "node", (event) => {
    const nbr = event.target.closedNeighborhood();
    cy!.elements().addClass("dim");
    nbr.removeClass("dim");
  });
  cy.on("mouseout", "node", () => {
    cy!.elements().removeClass("dim");
  });

  renderNodeCards(nodes, edges, warningsByNode, depths);
  renderTreeGuides(cy, graphContainer, nodes, edges, depths, primaryParentOf, warningsByNode);
  renderLinkageLines(cy, graphContainer, nodes, edges, depths);
  renderOrphanWarnings(orphanWarnings);

  // 再描画（再解析・深度切替）後も検索中なら一致表示を維持する。
  if (searchBox.isOpen() && searchQuery.trim() !== "") {
    applySearch(searchQuery);
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "linkageData") {
    currentOutput = message.payload;
    renderGraph();
  }
});

createDepthSwitchControl(depthSwitchContainer, (depth) => {
  currentDepth = depth;
  renderGraph();
});

renderLegend(legendContainer);

vscodeApi.postMessage({ type: "ready" });
