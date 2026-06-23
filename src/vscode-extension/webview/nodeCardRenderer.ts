import type { Warning } from "../../route-linkage/models.js";
import type { GraphNode } from "./projectDepth.js";
import type { Theme } from "./themeManager.js";
import { inferWarningKind, translateReason, WARNING_KIND_COLOR } from "./warningFormatter.js";

export type NodeKind = "route" | "apiCall" | "file" | "function";

export const NODE_INITIALS: Record<NodeKind, string> = {
  route: "R",
  apiCall: "API",
  file: "F",
  function: "fn",
};

export const NODE_LABELS: Record<NodeKind, string> = {
  route: "ルート",
  apiCall: "APIコール",
  file: "ファイル",
  function: "関数",
};

const NODE_CARD_W = 200;
const NODE_CARD_H = 80;

export function createNodeCard(
  node: GraphNode,
  connCount: number,
  warnings: Warning[],
  theme: Theme,
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

  // メインラベル（sourceLocation があればコードジャンプリンクとして機能する）
  const labelEl = document.createElement("div");
  labelEl.textContent = node.label;
  const isJumpable = !!node.sourceLocation;
  labelEl.style.cssText = [
    "font-size:12px",
    "font-weight:600",
    `color:${theme.text}`,
    "font-family:ui-monospace,Menlo,monospace",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "line-height:1.4",
    ...(isJumpable ? ["cursor:pointer"] : []),
  ].join(";");
  if (isJumpable) {
    labelEl.dataset.codeLink = "true";
  }

  card.appendChild(header);
  card.appendChild(labelEl);

  // ソース位置（コードジャンプリンク）
  if (node.sourceLocation) {
    const source = document.createElement("div");
    source.textContent = `↗ ${node.sourceLocation.file}:${node.sourceLocation.line}`;
    source.dataset.codeLink = "true";
    source.style.cssText = [
      "font-size:10px",
      `color:${theme.textSub}`,
      "font-style:italic",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      "line-height:1.4",
      "margin-top:2px",
      "cursor:pointer",
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
