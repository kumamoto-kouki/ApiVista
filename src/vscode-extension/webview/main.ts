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

appRoot.appendChild(depthSwitchContainer);
appRoot.appendChild(legendContainer);
appRoot.appendChild(graphContainer);

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
    "z-index:0",
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
    "z-index:0",
    "box-sizing:border-box",
  ].join(";");

  const beHeader = document.createElement("div");
  beHeader.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px 0;";
  beHeader.innerHTML = `<span style="font-size:12px;font-weight:600;color:${theme.route}">バックエンド <span style="font-weight:400;font-size:11px;color:${theme.textSub}">呼び出し先</span></span><span style="background:${theme.route};color:#1f1f1f;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${backendCount}</span>`;
  backendZone.appendChild(beHeader);

  graphContainer.insertBefore(frontendZone, graphContainer.firstChild);
  graphContainer.insertBefore(backendZone, graphContainer.firstChild);
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
      selector: ".dim",
      style: {
        opacity: 0.24,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.6,
        "line-color": theme.edge,
        "target-arrow-color": theme.edge,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "line-style": "solid",
      },
    },
    {
      selector: 'edge[kind = "linkage"]',
      style: {
        width: 2,
        "curve-style": "bezier",
      },
    },
    {
      selector: 'edge[kind = "structural"]',
      style: {
        "curve-style": "taxi",
        "taxi-direction": "horizontal",
      },
    },
    {
      selector: "edge.hi",
      style: {
        width: 2.4,
        "line-color": theme.edgeHi,
        "target-arrow-color": theme.edgeHi,
      },
    },
  ];
}

// ─────────────────────────────────────────
// プリセットレイアウト計算
// ─────────────────────────────────────────

function buildPresetPositions(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Record<string, { x: number; y: number }> {
  const LEFT_X = 200;
  const RIGHT_X = 700;
  const ROW_H = 110;
  const TOP_Y = 90;

  const frontendNodes = nodes.filter((n) => n.side === "frontend");
  const backendNodes = nodes.filter((n) => n.side === "backend");

  function treeOrder(group: GraphNode[]): GraphNode[] {
    const ids = new Set(group.map((n) => n.id));
    const structuralEdges = edges.filter(
      (e) => e.kind === "structural" && ids.has(e.source) && ids.has(e.target),
    );
    const children = new Set(structuralEdges.map((e) => e.target));
    const roots = group.filter((n) => !children.has(n.id));
    const result: GraphNode[] = [];
    const visited = new Set<string>();

    function visit(nodeId: string): void {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = group.find((n) => n.id === nodeId);
      if (node) result.push(node);
      for (const e of structuralEdges) {
        if (e.source === nodeId) visit(e.target);
      }
    }

    for (const root of roots) visit(root.id);
    for (const node of group) {
      if (!visited.has(node.id)) result.push(node);
    }
    return result;
  }

  const pos: Record<string, { x: number; y: number }> = {};
  treeOrder(frontendNodes).forEach((n, i) => {
    pos[n.id] = { x: LEFT_X, y: TOP_Y + i * ROW_H };
  });
  treeOrder(backendNodes).forEach((n, i) => {
    pos[n.id] = { x: RIGHT_X, y: TOP_Y + i * ROW_H };
  });
  return pos;
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
}

function createNodeCard(
  node: GraphNode,
  connCount: number,
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
    el.style.transform = `translate(${screenX - hw * zoom}px, ${screenY - hh * zoom}px) scale(${zoom})`;
  }
}

function renderNodeCards(nodes: GraphNode[], edges: GraphEdge[]): void {
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
    const card = createNodeCard(node, connCount.get(node.id) ?? 0, theme);

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
        cyNode.closedNeighborhood().edges().addClass("hi");
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
    });

    card.addEventListener("mouseleave", () => {
      if (cy) cy.elements().removeClass("dim hi");
      for (const { el } of nodeCardEls) {
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
// 警告 kind 推定
// ─────────────────────────────────────────

type WarningKind = "unmatched" | "excluded" | "parse";

function inferWarningKind(warning: Warning): WarningKind {
  const r = warning.reason;
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
let warningOverlayCleanup: (() => void) | null = null;

function clearWarningOverlays(): void {
  if (warningOverlayCleanup) {
    warningOverlayCleanup();
    warningOverlayCleanup = null;
  }
  for (const el of Array.from(graphContainer.querySelectorAll("." + WARNING_OVERLAY_CLASS))) {
    el.remove();
  }
}

function renderWarningOverlays(warnings: readonly Warning[], nodes: GraphNode[]): void {
  if (!cy) return;
  clearWarningOverlays();

  const theme = buildTheme();

  type OverlayEntry = {
    nodeId: string;
    items: { text: string; kind: WarningKind }[];
  };
  const overlayMap = new Map<string, OverlayEntry>();

  for (const warning of warnings) {
    const kind = inferWarningKind(warning);
    const matchedIds = findMatchingNodeIds(warning.target, nodes);
    if (matchedIds.length > 0) {
      for (const nodeId of matchedIds) {
        if (!overlayMap.has(nodeId)) {
          overlayMap.set(nodeId, { nodeId, items: [] });
        }
        overlayMap.get(nodeId)!.items.push({
          text: `${warning.target}: ${warning.reason}`,
          kind,
        });
      }
    } else {
      const key = "__orphan__";
      if (!overlayMap.has(key)) overlayMap.set(key, { nodeId: key, items: [] });
      overlayMap.get(key)!.items.push({ text: `${warning.target}: ${warning.reason}`, kind });
    }
  }

  const overlayEls: { el: HTMLElement; nodeId: string }[] = [];

  const baseOverlayStyle = (theme: ReturnType<typeof buildTheme>) =>
    [
      "position:absolute",
      "z-index:10",
      "pointer-events:auto",
      `background:${theme.cardBg}`,
      `border:1px solid ${theme.border}`,
      "border-radius:3px",
      "padding:3px 6px",
      "font-size:10px",
      "font-family:ui-monospace,Menlo,monospace",
      `color:${theme.textSub}`,
      "white-space:nowrap",
      "cursor:pointer",
      "max-width:220px",
      "overflow:hidden",
      "text-overflow:ellipsis",
    ].join(";");

  for (const [key, entry] of overlayMap) {
    const div = document.createElement("div");
    div.className = WARNING_OVERLAY_CLASS;
    div.style.cssText = baseOverlayStyle(theme);

    for (const item of entry.items) {
      const line = document.createElement("div");
      line.style.cssText = `border-left:3px solid ${WARNING_KIND_COLOR[item.kind]};padding-left:4px;margin:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      line.textContent = item.text;
      div.appendChild(line);
    }

    if (key === "__orphan__") {
      // 孤立警告: グラフコンテナ底部左に固定表示
      div.style.bottom = "8px";
      div.style.left = "8px";
      div.style.top = "";
    } else {
      div.addEventListener("mouseenter", () => {
        const node = cy!.getElementById(entry.nodeId);
        if (node.length) {
          cy!.elements().addClass("dim");
          node.closedNeighborhood().removeClass("dim");
          // 対応カードを強調
          for (const { el, nodeId: nid } of nodeCardEls) {
            el.style.opacity = nid === entry.nodeId ? "" : "0.24";
          }
        }
      });
      div.addEventListener("mouseleave", () => {
        cy!.elements().removeClass("dim");
        for (const { el } of nodeCardEls) el.style.opacity = "";
      });
      div.addEventListener("click", () => {
        const node = cy!.getElementById(entry.nodeId);
        if (node.length) {
          cy!.elements().removeClass("dim").unselect();
          node.select();
          cy!.animate({ center: { eles: node }, duration: 200 });
        }
      });
      overlayEls.push({ el: div, nodeId: entry.nodeId });
    }

    graphContainer.appendChild(div);
  }

  // ノード直下へ位置更新
  const updatePositions = () => {
    for (const { el, nodeId } of overlayEls) {
      const node = cy!.getElementById(nodeId);
      if (!node.length) continue;
      const bb = node.renderedBoundingBox({ includeLabels: false });
      el.style.left = `${bb.x1}px`;
      el.style.top = `${bb.y2 + 4}px`;
      el.style.width = `${Math.max(bb.x2 - bb.x1, 100)}px`;
    }
  };

  cy.on("render pan zoom resize", updatePositions);
  updatePositions();

  warningOverlayCleanup = () => {
    cy?.off("render pan zoom resize", updatePositions);
  };
}

// ─────────────────────────────────────────
// グラフ描画
// ─────────────────────────────────────────

function toElementDefinitions(nodes: GraphNode[], edges: GraphEdge[]): ElementDefinition[] {
  const positions = buildPresetPositions(nodes, edges);

  const nodeElements: ElementDefinition[] = nodes.map((node) => ({
    data: { ...node, label: "" },
    position: positions[node.id],
  }));

  const edgeElements: ElementDefinition[] = edges.map((edge) => ({
    data: { ...edge },
  }));

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

  renderBackgroundZones(frontendCount, backendCount);

  const elements = toElementDefinitions(nodes, edges);

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
    }
  });

  // hover: 隣接エッジ強調（ノードへのホバーはカード側で処理）
  cy.on("mouseover", "node", (event) => {
    const nbr = event.target.closedNeighborhood();
    cy!.elements().addClass("dim");
    nbr.removeClass("dim");
    nbr.edges().addClass("hi");
  });
  cy.on("mouseout", "node", () => {
    cy!.elements().removeClass("dim hi");
  });

  renderNodeCards(nodes, edges);
  renderWarningOverlays(currentOutput.warnings, nodes);
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
