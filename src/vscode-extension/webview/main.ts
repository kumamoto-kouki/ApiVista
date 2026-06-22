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

import { createDepthSwitchControl } from "./depthSwitchControl.js";
import type { Depth, GraphEdge, GraphNode } from "./projectDepth.js";
import { findMatchingNodeIds, projectDepth } from "./projectDepth.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../webviewProtocol.js";
import type { LinkageOutput, Warning } from "../../route-linkage/models.js";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
};

const DEFAULT_DEPTH: Depth = "route";

const vscodeApi = acquireVsCodeApi();

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
// テーマ変数の解決
// ─────────────────────────────────────────

function resolveCssVar(varName: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return value === "" ? fallback : value;
}

function buildTheme() {
  return {
    route: resolveCssVar("--vscode-charts-blue", "#3794ff"),
    apiCall: resolveCssVar("--vscode-charts-green", "#89d185"),
    file: resolveCssVar("--vscode-charts-purple", "#c586c0"),
    function: resolveCssVar("--vscode-charts-yellow", "#d7ba7d"),
    unmatched: resolveCssVar("--vscode-charts-red", "#f14c4c"),
    edge: resolveCssVar("--vscode-editorLineNumber-foreground", "#8a8a8a"),
    edgeHi: resolveCssVar("--vscode-foreground", "#e8e8e8"),
    cardBg: resolveCssVar("--vscode-editorWidget-background", "#252526"),
    border: resolveCssVar("--vscode-widget-border", "#2b2b2b"),
    selected: resolveCssVar("--vscode-focusBorder", "#0078d4"),
    text: resolveCssVar("--vscode-foreground", "#cccccc"),
    textSub: resolveCssVar("--vscode-descriptionForeground", "#9d9d9d"),
  };
}

// ─────────────────────────────────────────
// 凡例
// ─────────────────────────────────────────

type NodeKind = "route" | "apiCall" | "file" | "function";
const NODE_INITIALS: Record<NodeKind, string> = {
  route: "R",
  apiCall: "API",
  file: "F",
  function: "fn",
};
const NODE_LABELS: Record<NodeKind, string> = {
  route: "ルート",
  apiCall: "APIコール",
  file: "ファイル",
  function: "関数",
};

function renderLegend(container: HTMLElement): void {
  const theme = buildTheme();
  container.replaceChildren();

  const kinds: NodeKind[] = ["route", "apiCall", "file", "function"];
  for (const kind of kinds) {
    const entry = document.createElement("span");
    entry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:11px;";

    const badge = document.createElement("span");
    badge.textContent = NODE_INITIALS[kind];
    badge.style.cssText = [
      `background:${theme[kind]}`,
      "color:#1f1f1f",
      "font-size:9px",
      "font-weight:700",
      "padding:1px 5px",
      "border-radius:3px",
      "font-family:ui-monospace,Menlo,monospace",
    ].join(";");

    const label = document.createElement("span");
    label.textContent = NODE_LABELS[kind];
    label.style.color = theme.textSub;

    entry.appendChild(badge);
    entry.appendChild(label);
    container.appendChild(entry);
  }

  // 未連携
  const unmatchedEntry = document.createElement("span");
  unmatchedEntry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:11px;";
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
  linkageEntry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:11px;";
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
  structEntry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:11px;";
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

  frontendZone = document.createElement("div");
  frontendZone.style.cssText = [
    "position:absolute",
    "top:8px",
    "left:8px",
    "width:calc(50% - 16px)",
    "height:calc(100% - 16px)",
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
    "top:8px",
    "right:8px",
    "width:calc(50% - 16px)",
    "height:calc(100% - 16px)",
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
  const theme = buildTheme();

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
// HTMLノードカード
// ─────────────────────────────────────────

type NodeCardEntry = { el: HTMLElement; nodeId: string };
let nodeCardEls: NodeCardEntry[] = [];
let nodeCardUpdateFn: (() => void) | null = null;

function clearNodeCards(): void {
  if (nodeCardUpdateFn) {
    cy?.off("render pan zoom resize", nodeCardUpdateFn);
    nodeCardUpdateFn = null;
  }
  for (const { el } of nodeCardEls) el.remove();
  nodeCardEls = [];
  clearTreeGuides();
  clearLinkageLines();
}

// ─────────────────────────────────────────
// ツリーガイド SVG（structural ネスト表現）
// ─────────────────────────────────────────

let treeGuideSvg: SVGSVGElement | null = null;
let treeGuideUpdateFn: (() => void) | null = null;

function clearTreeGuides(): void {
  if (treeGuideUpdateFn) {
    cy?.off("render pan zoom resize", treeGuideUpdateFn);
    treeGuideUpdateFn = null;
  }
  treeGuideSvg?.remove();
  treeGuideSvg = null;
}

// ─────────────────────────────────────────
// linkage SVG（フロントエンド↔バックエンド接続線）
// ─────────────────────────────────────────

let linkageSvg: SVGSVGElement | null = null;
let linkageLineEls: { el: SVGPathElement; sourceId: string; targetId: string }[] = [];

function clearLinkageLines(): void {
  linkageSvg?.remove();
  linkageSvg = null;
  linkageLineEls = [];
}

function renderTreeGuides(
  nodes: GraphNode[],
  edges: GraphEdge[],
  depths: Map<string, number>,
  primaryParentOf: Map<string, string>,
  warningsByNode: Map<string, Warning[]>,
): void {
  clearTreeGuides();
  if (!cy) return;

  const theme = buildTheme();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 同一 side 内 structural エッジのうち主親エッジのみ対象
  const childrenMap = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "structural") continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s.side !== t.side) continue;
    if (primaryParentOf.get(e.target) !== e.source) continue;
    if (!childrenMap.has(e.source)) childrenMap.set(e.source, []);
    childrenMap.get(e.source)!.push(e.target);
  }
  if (childrenMap.size === 0) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible;";
  graphContainer.appendChild(svg);
  treeGuideSvg = svg;

  const updateFn = (): void => {
    if (!cy) return;
    const zoom = cy.zoom();
    const pan = cy.pan();

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    for (const [parentId, childIds] of childrenMap) {
      const pCyNode = cy.getElementById(parentId);
      if (!pCyNode.length) continue;

      const pp = pCyNode.position();
      const pDepth = depths.get(parentId) ?? 0;
      const pVisualCenterX = pp.x * zoom + pan.x + pDepth * INDENT_X * zoom;
      const pWarnCount = (warningsByNode.get(parentId) ?? []).length;
      const pBottomY = pp.y * zoom + pan.y + (NODE_CARD_H / 2 + pWarnCount * WARNING_ITEM_H) * zoom;
      // ガイド線は親カードの視覚的左端から 14px 内側
      const guideX = pVisualCenterX - (NODE_CARD_W / 2) * zoom + 14 * zoom;

      const childData: { y: number; x: number; color: string }[] = [];
      for (const cid of childIds) {
        const cCyNode = cy.getElementById(cid);
        if (!cCyNode.length) continue;
        const cp = cCyNode.position();
        const cCenterY = cp.y * zoom + pan.y;
        const cDepth = depths.get(cid) ?? 0;
        const cVisualCenterX = cp.x * zoom + pan.x + cDepth * INDENT_X * zoom;
        const childNode = byId.get(cid);
        const color = childNode
          ? ((theme[childNode.kind as NodeKind] as string | undefined) ?? theme.edge)
          : theme.edge;
        childData.push({ y: cCenterY, x: cVisualCenterX, color });
      }
      if (childData.length === 0) continue;

      // 親→子ペアごとにベジェカーブ（縦トランク廃止）
      for (const { y: childCenterY, x: cVisualCenterX, color } of childData) {
        const childCardLeft = cVisualCenterX - (NODE_CARD_W / 2) * zoom;
        const arrowTip = childCardLeft;

        // L字ベジェ: 親カード底面(guideX, pBottomY) → 子カード左端
        // 制御点を (guideX, childCenterY) x2 にすることで開始接線=真下、終了接線=右向きになる
        const curvePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        curvePath.setAttribute(
          "d",
          `M${guideX},${pBottomY} C${guideX},${childCenterY} ${guideX},${childCenterY} ${arrowTip - 8},${childCenterY}`,
        );
        curvePath.setAttribute("stroke", color);
        curvePath.setAttribute("stroke-width", "1.5");
        curvePath.setAttribute("fill", "none");
        svg.appendChild(curvePath);

        // 矢印ヘッド（右向き）
        const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
        arrow.setAttribute(
          "d",
          `M${arrowTip - 8},${childCenterY - 4.5} L${arrowTip},${childCenterY} L${arrowTip - 8},${childCenterY + 4.5} Z`,
        );
        arrow.setAttribute("fill", color);
        svg.appendChild(arrow);
      }
    }
  };

  treeGuideUpdateFn = updateFn;
  cy.on("render pan zoom resize", updateFn);
  updateFn();
}

function renderLinkageLines(
  nodes: GraphNode[],
  edges: GraphEdge[],
  depths: Map<string, number>,
): void {
  clearLinkageLines();
  if (!cy) return;

  const linkageEdges = edges.filter((e) => e.kind === "linkage");
  if (linkageEdges.length === 0) return;

  const theme = buildTheme();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  type EdgeMeta = { sourceId: string; targetId: string; srcDepth: number; tgtDepth: number };
  const edgeDataList: EdgeMeta[] = [];
  for (const e of linkageEdges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    edgeDataList.push({
      sourceId: e.source,
      targetId: e.target,
      srcDepth: depths.get(e.source) ?? 0,
      tgtDepth: depths.get(e.target) ?? 0,
    });
  }
  if (edgeDataList.length === 0) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:3;overflow:visible;";
  graphContainer.appendChild(svg);
  linkageSvg = svg;

  // arrowhead marker
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "linkage-arrow");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const arrowPoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  arrowPoly.setAttribute("points", "0 0, 8 3, 0 6");
  arrowPoly.setAttribute("fill", theme.edge);
  marker.appendChild(arrowPoly);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const pathEls: SVGPathElement[] = edgeDataList.map(({ sourceId, targetId }) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", theme.edge);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("marker-end", "url(#linkage-arrow)");
    svg.appendChild(path);
    linkageLineEls.push({ el: path, sourceId, targetId });
    return path;
  });

  const updateFn = (): void => {
    if (!cy) return;
    const zoom = cy.zoom();
    const pan = cy.pan();

    edgeDataList.forEach(({ sourceId, targetId, srcDepth, tgtDepth }, i) => {
      const srcCyNode = cy!.getElementById(sourceId);
      const tgtCyNode = cy!.getElementById(targetId);
      if (!srcCyNode.length || !tgtCyNode.length) return;

      const srcPos = srcCyNode.position();
      const tgtPos = tgtCyNode.position();

      // 視覚的カード端（CSS depth インデント込み）
      const srcRightX = (srcPos.x + NODE_CARD_W / 2 + srcDepth * INDENT_X) * zoom + pan.x;
      const srcY = srcPos.y * zoom + pan.y;
      const tgtLeftX = (tgtPos.x - NODE_CARD_W / 2 + tgtDepth * INDENT_X) * zoom + pan.x;
      const tgtY = tgtPos.y * zoom + pan.y;

      // 水平中点を制御点にしたベジェ曲線
      const midX = (srcRightX + tgtLeftX) / 2;
      pathEls[i].setAttribute(
        "d",
        `M${srcRightX},${srcY} C${midX},${srcY} ${midX},${tgtY} ${tgtLeftX},${tgtY}`,
      );
    });
  };

  cy.on("render pan zoom resize", updateFn);
  updateFn();
}

function createNodeCard(
  node: GraphNode,
  connCount: number,
  warnings: Warning[],
  theme: ReturnType<typeof buildTheme>,
): HTMLElement {
  const kindColor = theme[node.kind as NodeKind] as string;
  const borderColor = node.unmatched ? theme.unmatched : kindColor;

  const card = document.createElement("div");
  card.className = "node-card";
  card.style.cssText = [
    "position:absolute",
    `width:${NODE_CARD_W}px`,
    "left:0",
    "top:0",
    `background:${theme.cardBg}`,
    `border:1.5px solid ${borderColor}`,
    node.unmatched ? "border-style:dashed" : "border-style:solid",
    "border-radius:6px",
    "padding:7px 10px 8px",
    "cursor:pointer",
    "box-sizing:border-box",
    `min-height:${NODE_CARD_H}px`,
    "z-index:5",
    "pointer-events:auto",
    "transform-origin:0 0",
    "user-select:none",
    "transition:box-shadow 0.1s",
  ].join(";");

  // ヘッダ行: バッジ + 種別名 + 接続数
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:5px;margin-bottom:4px;";

  const badge = document.createElement("span");
  badge.textContent = NODE_INITIALS[node.kind as NodeKind] ?? "?";
  badge.style.cssText = [
    `background:${kindColor}`,
    "color:#1f1f1f",
    "font-size:9px",
    "font-weight:700",
    "padding:1px 5px",
    "border-radius:3px",
    "font-family:ui-monospace,Menlo,monospace",
    "flex-shrink:0",
    "line-height:1.5",
  ].join(";");

  const typeName = document.createElement("span");
  typeName.textContent = NODE_LABELS[node.kind as NodeKind] ?? node.kind;
  typeName.style.cssText = `font-size:10px;color:${theme.textSub};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;

  const connBadge = document.createElement("span");
  connBadge.textContent = `${connCount} 接続`;
  connBadge.style.cssText = `font-size:10px;color:${theme.textSub};white-space:nowrap;flex-shrink:0;`;

  header.appendChild(badge);
  header.appendChild(typeName);
  header.appendChild(connBadge);

  // メインラベル
  const labelEl = document.createElement("div");
  labelEl.textContent = node.label;
  labelEl.style.cssText = [
    "font-size:12px",
    "font-weight:600",
    `color:${theme.text}`,
    "font-family:ui-monospace,Menlo,monospace",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "line-height:1.4",
  ].join(";");

  card.appendChild(header);
  card.appendChild(labelEl);

  // ソース位置
  if (node.sourceLocation) {
    const source = document.createElement("div");
    source.textContent = `↗ ${node.sourceLocation.file}:${node.sourceLocation.line}`;
    source.style.cssText = [
      "font-size:10px",
      `color:${theme.textSub}`,
      "font-style:italic",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      "line-height:1.4",
      "margin-top:2px",
    ].join(";");
    card.appendChild(source);
  }

  // 警告セクション（カード内に埋め込み）
  if (warnings.length > 0) {
    const warningsDiv = document.createElement("div");
    warningsDiv.style.cssText = `margin-top:6px;border-top:1px solid ${theme.border};padding-top:4px;`;

    for (const w of warnings) {
      const kind = inferWarningKind(w);
      const icon = kind === "excluded" ? "■" : kind === "parse" ? "◆" : "○";
      const color = WARNING_KIND_COLOR[kind];

      const item = document.createElement("div");
      item.style.cssText = `padding:3px 0 3px 8px;border-left:2px solid ${color};margin-bottom:3px;`;

      const line1 = document.createElement("div");
      line1.style.cssText = `font-size:10px;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;`;
      line1.textContent = `${icon} ${w.target}`;

      const line2 = document.createElement("div");
      line2.style.cssText = `font-size:9px;color:${theme.textSub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;`;
      line2.textContent = translateReason(w.reason);

      item.appendChild(line1);
      item.appendChild(line2);
      warningsDiv.appendChild(item);
    }

    card.appendChild(warningsDiv);
  }

  return card;
}

function updateNodeCardPositions(): void {
  if (!cy) return;
  const zoom = cy.zoom();
  const pan = cy.pan();

  for (const { el, nodeId } of nodeCardEls) {
    const cyNode = cy.getElementById(nodeId);
    if (!cyNode.length) continue;
    const pos = cyNode.position();
    // グラフ座標 → スクリーン座標（ノード中心）
    const screenX = pos.x * zoom + pan.x;
    const screenY = pos.y * zoom + pan.y;
    // translate(中心へ移動) scale(ズーム) translate(-50%,-50%でカード中心を原点に)
    const hw = NODE_CARD_W / 2;
    const hh = NODE_CARD_H / 2;
    const depth = Number(el.dataset.depth ?? "0");
    const extraX = depth * INDENT_X * zoom;
    el.style.transform = `translate(${screenX - hw * zoom + extraX}px, ${screenY - hh * zoom}px) scale(${zoom})`;
  }
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

    // クリック: ソースへジャンプ
    card.addEventListener("click", () => {
      // 他カードの選択表示をリセット
      for (const { el } of nodeCardEls) {
        el.style.boxShadow = "";
      }
      card.style.boxShadow = `0 0 0 2px ${theme.selected}`;
      if (node.sourceLocation) {
        vscodeApi.postMessage({ type: "nodeClick", payload: node.sourceLocation });
      }
    });

    // ホバー: 非隣接ノードを減光
    card.addEventListener("mouseenter", () => {
      if (!cy) return;
      const cyNode = cy.getElementById(node.id);
      if (cyNode.length) {
        cy.elements().addClass("dim");
        cyNode.closedNeighborhood().removeClass("dim");
      }
      const neighborIds = cyNode.length
        ? new Set(
            cyNode
              .closedNeighborhood()
              .nodes()
              .map((n: { id(): string }) => n.id()),
          )
        : new Set<string>();
      for (const { el, nodeId: nid } of nodeCardEls) {
        el.style.opacity = neighborIds.has(nid) ? "" : "0.24";
      }
      for (const { el, sourceId, targetId } of linkageLineEls) {
        el.style.opacity = neighborIds.has(sourceId) || neighborIds.has(targetId) ? "" : "0.24";
      }
    });

    card.addEventListener("mouseleave", () => {
      if (cy) cy.elements().removeClass("dim");
      for (const { el } of nodeCardEls) {
        el.style.opacity = "";
      }
      for (const { el } of linkageLineEls) {
        el.style.opacity = "";
      }
    });

    graphContainer.appendChild(card);
    nodeCardEls.push({ el: card, nodeId: node.id });
  }

  const updateFn = () => updateNodeCardPositions();
  nodeCardUpdateFn = updateFn;
  cy.on("render pan zoom resize", updateFn);
  updateNodeCardPositions();
}

// ─────────────────────────────────────────
// 警告 kind 推定 / 日本語変換
// ─────────────────────────────────────────

type WarningKind = "unmatched" | "excluded" | "parse";

const REASON_JA: Record<string, string> = {
  "unmatched-api-call": "未連携のAPIコール",
  "unmatched-route": "未連携のルート",
  "dynamic-url-unsupported": "URLを静的に解決できません",
  "multiple-route-match": "複数のルートに一致するAPIコール",
  "unsupported-decorator": "未対応のデコレーター",
};

function translateReason(reason: string): string {
  if (REASON_JA[reason]) return REASON_JA[reason];
  // パターンマッチ（フィクスチャ固有の長い英語文字列）
  const r = reason.toLowerCase();
  if (r.startsWith("syntax error")) {
    const detail = reason.replace(/^syntax error:?\s*/i, "").trim();
    if (!detail) return "構文エラー";
    if (detail.toLowerCase().includes("missing end tag")) return "構文エラー：終了タグがありません";
    return `構文エラー：${detail}`;
  }
  // "excluded api call" を先に判定（"statically" を含む場合に誤マッチしないよう順序に注意）
  if (r.includes("excluded api call") || (r.includes("excluded") && r.includes("url"))) {
    return "除外：URLを静的に決定できません";
  }
  if (
    r.includes("statically resolved") ||
    r.includes("statically determined") ||
    r.includes("statically determinable") ||
    r.includes("not statically")
  ) {
    return "ルートパスを静的に解決できません";
  }
  return reason;
}

function inferWarningKind(warning: Warning): WarningKind {
  const r = warning.reason;
  // 英語の reason コード（route-linkage-engine 出力）
  if (r === "dynamic-url-unsupported" || r === "multiple-route-match") return "excluded";
  if (r === "unsupported-decorator") return "parse";
  // 日本語フォールバック
  if (r.includes("除外") || r.includes("静的") || r.includes("URL")) return "excluded";
  if (r.includes("構文") || r.includes("解析") || r.includes("エラー") || r.includes("error"))
    return "parse";
  return "unmatched";
}

const WARNING_KIND_COLOR: Record<WarningKind, string> = {
  unmatched: "#f14c4c",
  excluded: "#d7ba7d",
  parse: "#e0944a",
};

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
  header.style.cssText = `padding:6px 12px 4px;font-size:11px;font-weight:600;color:${theme.textSub};letter-spacing:.3px;`;
  header.textContent = "該当ノードのない警告";
  orphanSection.appendChild(header);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 8px;";

  for (const w of orphans) {
    const kind = inferWarningKind(w);
    const icon = kind === "excluded" ? "■" : kind === "parse" ? "◆" : "○";
    const color = WARNING_KIND_COLOR[kind];

    const chip = document.createElement("div");
    chip.className = WARNING_OVERLAY_CLASS;
    chip.style.cssText = [
      `background:${theme.cardBg}`,
      `border:1px solid ${color}40`,
      "border-radius:4px",
      "padding:3px 8px 3px 6px",
      `border-left:3px solid ${color}`,
      "font-size:10px",
      "font-family:ui-monospace,Menlo,monospace",
      "max-width:320px",
    ].join(";");

    const l1 = document.createElement("div");
    l1.style.cssText = `color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;`;
    l1.textContent = `${icon} ${w.target}`;

    const l2 = document.createElement("div");
    l2.style.cssText = `font-size:9px;color:${theme.textSub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
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

function handleNodeTap(node: GraphNode): void {
  if (!node.sourceLocation) return;
  vscodeApi.postMessage({ type: "nodeClick", payload: node.sourceLocation });
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
    const matchedIds = findMatchingNodeIds(w.target, nodes);
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
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  });

  // ゾーンは cy 生成後に追加してキャンバス上に表示（z-index:2 > canvas:auto）
  renderBackgroundZones(frontendCount, backendCount);

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
      for (const { el } of linkageLineEls) {
        el.style.opacity = "";
      }
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
  renderTreeGuides(nodes, edges, depths, primaryParentOf, warningsByNode);
  renderLinkageLines(nodes, edges, depths);
  renderOrphanWarnings(orphanWarnings);
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
