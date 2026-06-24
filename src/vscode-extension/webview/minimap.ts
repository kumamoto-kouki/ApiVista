/**
 * グラフ全体を俯瞰するミニマップ（webview）。
 *
 * cytoscape のノードは不可視（`opacity:0`）で見える本体は HTML カード＋SVG 線のため、cytoscape 既定の
 * minimap 拡張は使えない。本モジュールは `graphContainer` 右下に小さな SVG オーバーレイを置き、
 * 各ノードの **モデル座標**を縮小描画し、現在の表示範囲（ビューポート）を矩形で示す。クリックでその位置へパン。
 *
 * svgRenderer と同じく、再描画のたびに `renderMinimap` で作り直し、`cy.on("render pan zoom resize")` で
 * ビューポート矩形をパン/ズームに追従させる（`renderGraph` 側が `clearMinimap` でクリーンアップする）。
 */
import type { Core } from "cytoscape";

import type { GraphNode } from "./projectDepth.js";
import { buildTheme } from "./themeManager.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** ズーム=1 時のカード寸法（svgRenderer と同値）。ミニマップ上の矩形サイズ算出に使う。 */
const NODE_CARD_W = 200;
const NODE_CARD_H = 80;

/** ミニマップの外形と内側余白（px）。 */
const MINI_W = 200;
const MINI_H = 130;
const MINI_PADDING = 8;

let minimapEl: HTMLElement | null = null;
let minimapUpdateFn: (() => void) | null = null;

/** ミニマップを除去し、登録した cy リスナーも解除する。 */
export function clearMinimap(cy?: Core): void {
  if (minimapUpdateFn) {
    cy?.off("render pan zoom resize", minimapUpdateFn);
    minimapUpdateFn = null;
  }
  minimapEl?.remove();
  minimapEl = null;
}

/**
 * `graphContainer` 右下にミニマップを描画する。
 *
 * @param cy Cytoscape インスタンス（モデル座標・パン/ズーム取得用）
 * @param graphContainer グラフ表示コンテナ（オーバーレイの親・ビューポート寸法）
 * @param nodes 表示中の全ノード（矩形描画用。side で色分け）
 */
export function renderMinimap(cy: Core, graphContainer: HTMLElement, nodes: GraphNode[]): void {
  clearMinimap(cy);
  if (nodes.length === 0) return;

  const theme = buildTheme();

  const container = document.createElement("div");
  container.setAttribute("data-minimap", "true");
  container.style.cssText = [
    "position:absolute",
    "right:10px",
    "bottom:10px",
    `width:${MINI_W}px`,
    `height:${MINI_H}px`,
    "z-index:6", // カード(5)より上・検索/メニューより下
    "pointer-events:auto",
    "cursor:pointer",
    "background:var(--vscode-editorWidget-background,#252526)",
    "border:1px solid var(--vscode-widget-border,#454545)",
    "border-radius:6px",
    "box-shadow:0 2px 8px rgba(0,0,0,0.36)",
    "overflow:hidden",
  ].join(";");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(MINI_W));
  svg.setAttribute("height", String(MINI_H));
  svg.style.display = "block";
  container.appendChild(svg);
  graphContainer.appendChild(container);
  minimapEl = container;

  // 全ノードのモデル bbox をミニマップ内側へフィットさせる縮小率。
  const bb = cy.elements().boundingBox();
  const bw = Math.max(bb.w, 1);
  const bh = Math.max(bb.h, 1);
  const innerW = MINI_W - MINI_PADDING * 2;
  const innerH = MINI_H - MINI_PADDING * 2;
  const scale = Math.min(innerW / bw, innerH / bh);

  /** モデル座標 → ミニマップ座標。 */
  const toMini = (mx: number, my: number): { x: number; y: number } => ({
    x: MINI_PADDING + (mx - bb.x1) * scale,
    y: MINI_PADDING + (my - bb.y1) * scale,
  });

  // ノード矩形（静的: パン/ズームで動かさない）。side で色分け。
  for (const node of nodes) {
    const cyNode = cy.getElementById(node.id);
    if (!cyNode.length) continue;
    const pos = cyNode.position();
    const p = toMini(pos.x - NODE_CARD_W / 2, pos.y - NODE_CARD_H / 2);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(p.x));
    rect.setAttribute("y", String(p.y));
    rect.setAttribute("width", String(Math.max(NODE_CARD_W * scale, 1)));
    rect.setAttribute("height", String(Math.max(NODE_CARD_H * scale, 1)));
    rect.setAttribute("fill", node.side === "backend" ? theme.route : theme.apiCall);
    rect.setAttribute("opacity", "0.7");
    rect.setAttribute("rx", "1");
    svg.appendChild(rect);
  }

  // ビューポート矩形（動的: パン/ズームに追従）。
  const viewport = document.createElementNS(SVG_NS, "rect");
  viewport.setAttribute("fill", "none");
  viewport.setAttribute("stroke", theme.edgeHi);
  viewport.setAttribute("stroke-width", "1.5");
  svg.appendChild(viewport);

  const updateViewport = (): void => {
    const zoom = cy.zoom();
    const pan = cy.pan();
    const w = graphContainer.clientWidth;
    const h = graphContainer.clientHeight;
    const a = toMini((0 - pan.x) / zoom, (0 - pan.y) / zoom);
    const b = toMini((w - pan.x) / zoom, (h - pan.y) / zoom);
    viewport.setAttribute("x", String(a.x));
    viewport.setAttribute("y", String(a.y));
    viewport.setAttribute("width", String(Math.max(b.x - a.x, 0)));
    viewport.setAttribute("height", String(Math.max(b.y - a.y, 0)));
  };
  updateViewport();
  minimapUpdateFn = updateViewport;
  cy.on("render pan zoom resize", updateViewport);

  // クリック: クリック点（ミニマップ座標）をモデル座標へ逆変換し、その点が画面中央に来るようパン。
  container.addEventListener("click", (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = bb.x1 + (e.clientX - rect.left - MINI_PADDING) / scale;
    const my = bb.y1 + (e.clientY - rect.top - MINI_PADDING) / scale;
    const zoom = cy.zoom();
    cy.pan({
      x: graphContainer.clientWidth / 2 - mx * zoom,
      y: graphContainer.clientHeight / 2 - my * zoom,
    });
  });
}
