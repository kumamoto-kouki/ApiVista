import type { Core } from "cytoscape";

import type { Warning } from "../../route-linkage/models.js";
import type { GraphEdge, GraphNode } from "./projectDepth.js";
import { buildTheme } from "./themeManager.js";

const NODE_CARD_W = 200;
const NODE_CARD_H = 80;
const WARNING_ITEM_H = 34;
const INDENT_X = 60;

let treeGuideSvg: SVGSVGElement | null = null;
let treeGuideUpdateFn: (() => void) | null = null;
let linkageSvg: SVGSVGElement | null = null;
let linkageUpdateFn: (() => void) | null = null;

/**
 * ホバー連鎖の到達ノード集合。`null` のときは減光なし（全線不透明）。
 * ツリーガイド/連携線の updateFn が参照し、両端が集合内の線のみを不透明に保つ。
 */
let hoverReachable: Set<string> | null = null;

/** 両端 ID が到達集合に含まれる線の不透明度を返す（`hoverReachable===null` は常に不透明）。 */
function lineOpacity(aId: string, bId: string): string {
  if (hoverReachable === null) return "1";
  return hoverReachable.has(aId) && hoverReachable.has(bId) ? "1" : "0.24";
}

/**
 * ホバー連鎖の到達集合を設定し、ツリーガイド・連携線を即時再描画して減光を反映する。
 * `null` を渡すと減光を解除する。
 */
export function setHoverReachable(set: Set<string> | null): void {
  hoverReachable = set;
  treeGuideUpdateFn?.();
  linkageUpdateFn?.();
}

export function clearTreeGuides(cy?: Core): void {
  if (treeGuideUpdateFn) {
    cy?.off("render pan zoom resize", treeGuideUpdateFn);
    treeGuideUpdateFn = null;
  }
  treeGuideSvg?.remove();
  treeGuideSvg = null;
  hoverReachable = null;
}

export function clearLinkageLines(): void {
  linkageSvg?.remove();
  linkageSvg = null;
  linkageUpdateFn = null;
  hoverReachable = null;
}

export function renderTreeGuides(
  cy: Core,
  graphContainer: HTMLElement,
  nodes: GraphNode[],
  edges: GraphEdge[],
  depths: Map<string, number>,
  primaryParentOf: Map<string, string>,
  warningsByNode: Map<string, Warning[]>,
): void {
  clearTreeGuides(cy);

  const theme = buildTheme();
  const byId = new Map(nodes.map((n) => [n.id, n]));

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
      const guideX = pVisualCenterX - (NODE_CARD_W / 2) * zoom + 14 * zoom;

      const childData: { id: string; y: number; x: number; color: string }[] = [];
      for (const cid of childIds) {
        const cCyNode = cy.getElementById(cid);
        if (!cCyNode.length) continue;
        const cp = cCyNode.position();
        const cCenterY = cp.y * zoom + pan.y;
        const cDepth = depths.get(cid) ?? 0;
        const cVisualCenterX = cp.x * zoom + pan.x + cDepth * INDENT_X * zoom;
        const childNode = byId.get(cid);
        type NodeKind = "route" | "apiCall" | "file" | "function";
        const color = childNode
          ? ((theme[childNode.kind as NodeKind] as string | undefined) ?? theme.edge)
          : theme.edge;
        childData.push({ id: cid, y: cCenterY, x: cVisualCenterX, color });
      }
      if (childData.length === 0) continue;

      for (const { id: childId, y: childCenterY, x: cVisualCenterX, color } of childData) {
        const childCardLeft = cVisualCenterX - (NODE_CARD_W / 2) * zoom;
        const arrowTip = childCardLeft;
        const opacity = lineOpacity(parentId, childId);

        const curvePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        curvePath.setAttribute(
          "d",
          `M${guideX},${pBottomY} C${guideX},${childCenterY} ${guideX},${childCenterY} ${arrowTip - 8},${childCenterY}`,
        );
        curvePath.setAttribute("stroke", color);
        curvePath.setAttribute("stroke-width", "1.5");
        curvePath.setAttribute("fill", "none");
        curvePath.setAttribute("opacity", opacity);
        svg.appendChild(curvePath);

        const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
        arrow.setAttribute(
          "d",
          `M${arrowTip - 8},${childCenterY - 4.5} L${arrowTip},${childCenterY} L${arrowTip - 8},${childCenterY + 4.5} Z`,
        );
        arrow.setAttribute("fill", color);
        arrow.setAttribute("opacity", opacity);
        svg.appendChild(arrow);
      }
    }
  };

  treeGuideUpdateFn = updateFn;
  cy.on("render pan zoom resize", updateFn);
  updateFn();
}

export function renderLinkageLines(
  cy: Core,
  graphContainer: HTMLElement,
  nodes: GraphNode[],
  edges: GraphEdge[],
  depths: Map<string, number>,
): void {
  clearLinkageLines();

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

  const pathEls: SVGPathElement[] = edgeDataList.map(() => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", theme.edge);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("marker-end", "url(#linkage-arrow)");
    svg.appendChild(path);
    return path;
  });

  const updateFn = (): void => {
    const zoom = cy.zoom();
    const pan = cy.pan();

    edgeDataList.forEach(({ sourceId, targetId, srcDepth, tgtDepth }, i) => {
      const srcCyNode = cy.getElementById(sourceId);
      const tgtCyNode = cy.getElementById(targetId);
      if (!srcCyNode.length || !tgtCyNode.length) return;

      const srcPos = srcCyNode.position();
      const tgtPos = tgtCyNode.position();

      const srcRightX = (srcPos.x + NODE_CARD_W / 2 + srcDepth * INDENT_X) * zoom + pan.x;
      const srcY = srcPos.y * zoom + pan.y;
      const tgtLeftX = (tgtPos.x - NODE_CARD_W / 2 + tgtDepth * INDENT_X) * zoom + pan.x;
      const tgtY = tgtPos.y * zoom + pan.y;

      const midX = (srcRightX + tgtLeftX) / 2;
      pathEls[i].setAttribute(
        "d",
        `M${srcRightX},${srcY} C${midX},${srcY} ${midX},${tgtY} ${tgtLeftX},${tgtY}`,
      );
      pathEls[i].setAttribute("opacity", lineOpacity(sourceId, targetId));
    });
  };

  linkageUpdateFn = updateFn;
  cy.on("render pan zoom resize", updateFn);
  updateFn();
}
