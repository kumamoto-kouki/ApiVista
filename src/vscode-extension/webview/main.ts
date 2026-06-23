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
import { createNodeCard, NODE_INITIALS, NODE_LABELS, type NodeKind } from "./nodeCardRenderer.js";
import type { Depth, GraphEdge, GraphNode } from "./projectDepth.js";
import { findMatchingNodeIds, projectDepth } from "./projectDepth.js";
import {
  clearLinkageLines,
  clearTreeGuides,
  getLinkageLineEls,
  renderLinkageLines,
  renderTreeGuides,
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

// 枠（ノードカード）右クリック用コンテキストメニュー。選択で連携関数コピーを要求する。
const cardContextMenu = createCardContextMenu((node) => {
  if (node.sourceLocation) {
    vscodeApi.postMessage({
      type: "copyLinked",
      payload: { ...node.sourceLocation, side: node.side },
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

  const kinds: NodeKind[] = ["route", "apiCall", "file", "function"];
  for (const kind of kinds) {
    const entry = document.createElement("span");
    entry.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:13px;";

    const badge = document.createElement("span");
    badge.textContent = NODE_INITIALS[kind];
    badge.style.cssText = [
      `background:${theme[kind]}`,
      "color:#1f1f1f",
      "font-size:11px",
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

    // クリック: カードをハイライト（コードジャンプは [data-code-link] 要素のみ）
    card.addEventListener("click", () => {
      for (const { el } of nodeCardEls) {
        el.style.boxShadow = "";
      }
      card.style.boxShadow = `0 0 0 2px ${theme.selected}`;
    });

    // 右クリック: 連携関数コピー用の日本語コンテキストメニューを開く（sourceLocation を持つ枠のみ）
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (node.sourceLocation) {
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
      for (const { el, sourceId, targetId } of getLinkageLineEls()) {
        el.style.opacity = neighborIds.has(sourceId) || neighborIds.has(targetId) ? "" : "0.24";
      }
    });

    card.addEventListener("mouseleave", () => {
      if (cy) cy.elements().removeClass("dim");
      for (const { el } of nodeCardEls) {
        el.style.opacity = "";
      }
      for (const { el } of getLinkageLineEls()) {
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
      "font-size:12px",
      "font-family:ui-monospace,Menlo,monospace",
      "max-width:320px",
    ].join(";");

    const l1 = document.createElement("div");
    l1.style.cssText = `color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;`;
    l1.textContent = `${icon} ${w.target}`;

    const l2 = document.createElement("div");
    l2.style.cssText = `font-size:11px;color:${theme.textSub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
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
    autoungrabify: true,
    boxSelectionEnabled: false,
  });

  // ゾーンは cy 生成後に追加してキャンバス上に表示（z-index:2 > canvas:auto）
  renderBackgroundZones(frontendCount, backendCount);

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
      for (const { el } of getLinkageLineEls()) {
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
  renderTreeGuides(cy, graphContainer, nodes, edges, depths, primaryParentOf, warningsByNode);
  renderLinkageLines(cy, graphContainer, nodes, edges, depths);
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
