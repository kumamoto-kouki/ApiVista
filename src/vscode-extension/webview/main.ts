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
import cytoscape, {
  type Core,
  type ElementDefinition,
  type NodeSingular,
  type StylesheetJson,
} from "cytoscape";

import { createCardContextMenu } from "./cardContextMenu.js";
import { createDepthSwitchControl } from "./depthSwitchControl.js";
import { LEGEND_LANGUAGES } from "./languageStyle.js";
import { createNodeCard } from "./nodeCardRenderer.js";
import { createSearchBox } from "./searchBox.js";
import type { Depth, GraphEdge, GraphNode } from "./projectDepth.js";
import { filterConnectedToLinkage, matchWarningNodeIds, projectDepth } from "./projectDepth.js";
import {
  clearDependencyLines,
  clearLinkageLines,
  clearTreeGuides,
  renderDependencyLines,
  renderLinkageLines,
  renderTreeGuides,
  setHoverReachable,
} from "./svgRenderer.js";
import { clearMinimap, renderMinimap } from "./minimap.js";
import {
  attachRenderScheduler,
  detachRenderScheduler,
  registerFrameUpdater,
  unregisterFrameUpdater,
} from "./renderScheduler.js";
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
const cardContextMenu = createCardContextMenu(
  (node) => {
    if (node.functionId) {
      vscodeApi.postMessage({
        type: "copyLinked",
        payload: { functionId: node.functionId },
      });
    }
  },
  () => {
    // 選択中の枠のうち functionId を持つものだけ集めてコピー要求を送る（model/table/file は対象外）。
    const functionIds = nodeCardEls
      .filter(({ nodeId }) => selectedNodeIds.has(nodeId))
      .map(({ functionId }) => functionId)
      .filter((id): id is string => id !== undefined);
    if (functionIds.length > 0) {
      vscodeApi.postMessage({ type: "copySelected", payload: { functionIds } });
    }
  },
);

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

// 孤立警告セクションの折りたたみ状態。再描画(renderOrphanWarnings)で DOM を作り直すため、
// 状態をモジュールスコープに保持しないと開閉がリセットされる。
let orphanCollapsed = false;

appRoot.appendChild(depthSwitchContainer);
appRoot.appendChild(legendContainer);
appRoot.appendChild(graphContainer);
appRoot.appendChild(orphanSection);

let currentOutput: LinkageOutput | undefined;
let currentDepth: Depth = DEFAULT_DEPTH;
// 「連携のみ」表示か「すべて表示」か。既定は連携のみ（ルート連携ビューを見やすく保つ）。
let showConnectedOnly = true;
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
      return;
    }
    if (e.key === "Escape" && searchBox.isOpen()) {
      e.preventDefault();
      clearSearchHighlight();
      searchMatchIds = [];
      searchQuery = "";
      searchBox.close();
      return;
    }
    // 検索ボックス入力中はグラフ操作キーを無効化（検索に委ねる）。
    if (searchBox.isOpen() && document.activeElement?.tagName === "INPUT") {
      return;
    }
    // PageDown / PageUp: 1ページ分（ビューポート高の 90%）下/上へパン。
    if ((e.key === "PageDown" || e.key === "PageUp") && cy) {
      e.preventDefault();
      const pan = cy.pan();
      const dy = graphContainer.clientHeight * 0.9 * (e.key === "PageDown" ? -1 : 1);
      cy.pan({ x: pan.x, y: pan.y + dy });
      return;
    }
    // 矢印キー: 固定ステップで上下左右に画面移動。
    if (
      cy &&
      (e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight")
    ) {
      e.preventDefault();
      const STEP = 100;
      const pan = cy.pan();
      const dx = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
      const dy = e.key === "ArrowUp" ? STEP : e.key === "ArrowDown" ? -STEP : 0;
      cy.pan({ x: pan.x + dx, y: pan.y + dy });
      return;
    }
    // タイプ移動: 修飾キーなしの印字可能1文字 → プレフィックス一致の枠へ移動。
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
      typeaheadNavigate(e.key);
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

/** ズーム上限（原寸の 130% まで拡大を許容）。初期表示は applyInitialView で zoom=1 に固定。 */
const MAX_ZOOM = 1.3;
/** ズーム下限（枠が多いときの極小化を防ぐ。はみ出しは右ドラッグパン/ホイールで閲覧）。 */
const MIN_ZOOM = 0.2;

/**
 * フロントエンドのディレクトリ別サブゾーンの既知ディレクトリ（表示順＝連携同数時の左右タイブレーク）。
 * 既知集合に属さないファイルは `other` に集約する。
 */
const FRONTEND_DIR_ORDER = ["components", "composables", "pages", "utils", "libs"] as const;
const OTHER_DIR = "other";
const FRONTEND_DIRS = new Set<string>(FRONTEND_DIR_ORDER);

/**
 * ソース相対パスからサブゾーン分類用のディレクトリ名を返す。
 * パスのいずれかのセグメントが既知ディレクトリと一致すれば最初の一致を採用（`src/components/...` も拾う）、
 * 無ければ `other`。`file` 未設定（バックエンド route 等）も `other`。
 */
function topDir(file: string | undefined): string {
  if (!file) return OTHER_DIR;
  for (const seg of file.split("/")) {
    if (FRONTEND_DIRS.has(seg)) return seg;
  }
  return OTHER_DIR;
}

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
/** フロントのディレクトリ別サブゾーン（dir → 枠要素）。outer の frontendZone 内に重ねて描く。 */
let frontendSubZones = new Map<string, HTMLElement>();

/** ディレクトリ別フロントカード数を既知順（FRONTEND_DIR_ORDER→other）で返す。0 件のディレクトリは除く。 */
function frontendDirCounts(nodes: GraphNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.side !== "frontend") continue;
    const d = topDir(n.sourceLocation?.file);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const ordered = new Map<string, number>();
  for (const d of [...FRONTEND_DIR_ORDER, OTHER_DIR]) {
    if (counts.has(d)) ordered.set(d, counts.get(d)!);
  }
  return ordered;
}

function renderBackgroundZones(dirCounts: Map<string, number>, backendCount: number): void {
  if (frontendZone) frontendZone.remove();
  if (backendZone) backendZone.remove();
  for (const z of frontendSubZones.values()) z.remove();
  frontendSubZones = new Map();

  const theme = buildTheme();
  const frontendCount = [...dirCounts.values()].reduce((a, b) => a + b, 0);

  // 矩形（left/top/width/height）は updateZonePositions が実カード位置から算出する。
  // 固定 50% をやめることで、縮尺・解像度に依らずカードが必ずゾーン内に収まる。
  // outer のフロントエンド枠（全サブゾーンを内包する薄い外枠）。ヘッダは左上に置く。
  frontendZone = document.createElement("div");
  frontendZone.style.cssText = [
    "position:absolute",
    "display:none",
    `background:${theme.apiCall}08`,
    `border:1px solid ${theme.apiCall}25`,
    "border-radius:10px",
    "pointer-events:none",
    "z-index:2",
    "box-sizing:border-box",
  ].join(";");

  const feHeader = document.createElement("div");
  feHeader.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px 0;";
  feHeader.innerHTML = `<span style="font-size:12px;font-weight:600;color:${theme.apiCall}">フロントエンド <span style="font-weight:400;font-size:11px;color:${theme.textSub}">呼び出し元</span></span><span style="background:${theme.apiCall};color:#1f1f1f;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${frontendCount}</span>`;
  frontendZone.appendChild(feHeader);

  // ディレクトリ別サブゾーン（outer より濃い縁＋ディレクトリ名ヘッダ）。
  for (const [dir, count] of dirCounts) {
    const sub = document.createElement("div");
    sub.dataset.zoneDir = dir;
    sub.style.cssText = [
      "position:absolute",
      "display:none",
      `background:${theme.apiCall}10`,
      `border:1px dashed ${theme.apiCall}45`,
      "border-radius:8px",
      "pointer-events:none",
      "z-index:3",
      "box-sizing:border-box",
    ].join(";");
    const subHeader = document.createElement("div");
    subHeader.style.cssText = "padding:6px 10px 0;";
    subHeader.innerHTML = `<span style="font-size:11px;font-weight:600;color:${theme.apiCall}">${dir} <span style="font-weight:400;color:${theme.textSub}">(${count})</span></span>`;
    sub.appendChild(subHeader);
    frontendSubZones.set(dir, sub);
  }

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
  for (const sub of frontendSubZones.values()) graphContainer.appendChild(sub);
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

  /**
   * structural エッジを優先した深さ優先訪問順（primaryParentOf が渡された場合は主親のみ辿る）。
   * `rootKey` が渡された場合は、ルート（部分木）を昇順キーで並べてから訪問する（ペア整列用）。
   */
  function treeOrder(
    group: GraphNode[],
    structEdges: GraphEdge[],
    primaryParentOf?: Map<string, string>,
    rootKey?: (id: string) => number,
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

    const orderedRoots =
      rootKey === undefined ? roots : [...roots].sort((a, b) => rootKey(a.id) - rootKey(b.id));
    for (const r of orderedRoots) visit(r.id);
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

  function layoutColumn(group: GraphNode[], x: number, rootKey?: (id: string) => number): void {
    const se = groupStructEdges(group);
    const { depthMap: colDepths, parentOf: colParentOf } = calcDepths(group, se);
    for (const [k, v] of colParentOf) primaryParentOf.set(k, v);
    const ordered = treeOrder(group, se, colParentOf, rootKey);

    let y = TOP_Y + NODE_CARD_H / 2;
    for (const node of ordered) {
      const depth = colDepths.get(node.id) ?? 0;
      depths.set(node.id, depth);
      positions[node.id] = { x, y };
      const wCount = (warningsByNode.get(node.id) ?? []).length;
      y += NODE_CARD_H + wCount * WARNING_ITEM_H + ROW_GAP;
    }
  }

  /**
   * 連携の無い枠を多列グリッドで配置する（縦長の圧縮）。`baseX` の外側（`dir`=-1 左 / +1 右）へ
   * 列を並べ、各列 `maxRows` 行で折り返す。連携線は持たないので depth 0・主親なしで配置する。
   */
  const GRID_COL_W = NODE_CARD_W + 30;
  const GRID_ROW_H = NODE_CARD_H + ROW_GAP;
  function layoutGrid(group: GraphNode[], baseX: number, dir: 1 | -1, maxRows: number): void {
    group.forEach((node, i) => {
      const col = Math.floor(i / maxRows);
      const row = i % maxRows;
      depths.set(node.id, 0);
      positions[node.id] = {
        x: baseX + dir * GRID_COL_W * (col + 1),
        y: TOP_Y + NODE_CARD_H / 2 + row * GRID_ROW_H,
      };
    });
  }

  // フロント↔バック連携に到達する枠の集合（linkage 端点から全エッジ無向 BFS）。
  const connectedIds = ((): Set<string> => {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    };
    for (const e of edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    const keep = new Set<string>();
    const q: string[] = [];
    const enqueue = (id: string): void => {
      if (!keep.has(id)) {
        keep.add(id);
        q.push(id);
      }
    };
    for (const e of edges) {
      if (e.kind !== "linkage") continue;
      enqueue(e.source);
      enqueue(e.target);
    }
    while (q.length > 0) {
      const id = q.shift()!;
      for (const n of adj.get(id) ?? []) enqueue(n);
    }
    return keep;
  })();

  const connFE = frontendNodes.filter((n) => connectedIds.has(n.id));
  const connBE = backendNodes.filter((n) => connectedIds.has(n.id));
  const unconnBE = backendNodes.filter((n) => !connectedIds.has(n.id));

  // バックエンドは従来どおり右列（連携あり）＋外側グリッド（連携なし）に配置する。
  layoutColumn(connBE, RIGHT_X);
  const MIN_GRID_ROWS = 12;
  const gridRows = Math.max(connFE.length, connBE.length, MIN_GRID_ROWS);
  layoutGrid(unconnBE, RIGHT_X, 1, gridRows);

  // フロントエンドはディレクトリ単位でクラスタ化し、連携を優先しつつグループ表示する（#2）。
  // - クラスタ内: バックの Y を基準にした整列キーで並べ（連携線を短く）、各クラスタを縦グリッドに折り返す。
  // - クラスタの横並び: 連携ノードを多く含む順に LEFT_X（バック寄り）から外側（左）へ。
  const alignKey = buildFrontendAlignmentKey(frontendNodes, edges, positions);

  const feGroups = new Map<string, GraphNode[]>();
  for (const n of frontendNodes) {
    const d = topDir(n.sourceLocation?.file);
    (feGroups.get(d) ?? feGroups.set(d, []).get(d)!).push(n);
  }
  const dirRank = (d: string): number => {
    const i = (FRONTEND_DIR_ORDER as readonly string[]).indexOf(d);
    return i === -1 ? FRONTEND_DIR_ORDER.length : i;
  };
  const orderedGroups = [...feGroups.entries()].sort((a, b) => {
    const ca = a[1].filter((n) => connectedIds.has(n.id)).length;
    const cb = b[1].filter((n) => connectedIds.has(n.id)).length;
    if (ca !== cb) return cb - ca; // 連携の多いクラスタを先（＝バック寄り）に
    return dirRank(a[0]) - dirRank(b[0]); // 同数は既知ディレクトリ順で決定的に
  });

  const FE_MAX_ROWS = gridRows; // クラスタ縦グリッドの折り返し行数（バック側の高さに揃える）
  const DIR_GAP = 40; // クラスタ間の横間隔（サブゾーン枠が重ならない余白）
  let bandRight = LEFT_X; // 最も連携の多いクラスタの右端基準（バック寄り）
  for (const [, members] of orderedGroups) {
    const ordered = [...members].sort((a, b) => alignKey(a.id) - alignKey(b.id));
    const cols = Math.max(1, Math.ceil(ordered.length / FE_MAX_ROWS));
    ordered.forEach((node, i) => {
      const col = Math.floor(i / FE_MAX_ROWS);
      const row = i % FE_MAX_ROWS;
      depths.set(node.id, 0);
      positions[node.id] = {
        x: bandRight - col * GRID_COL_W, // col0 を右端（バック寄り）、以降を左へ
        y: TOP_Y + NODE_CARD_H / 2 + row * GRID_ROW_H,
      };
    });
    bandRight -= cols * GRID_COL_W + DIR_GAP; // 次のクラスタはさらに左へ
  }

  return { positions, depths, primaryParentOf };
}

/**
 * ペア整列用のルート並び替えキーを作る。
 *
 * 各フロントノードに「連携相手のバックエンドノードの Y 平均」を割り当て（直接 linkage が無いノードは
 * structural 隣接から伝播）、その値が小さい順にフロントの部分木（生成クライアントの Factory→Fp→
 * ParamCreator 等の鎖）を並べる。これにより連携する枠が相手と近い高さに並び、連携線が短く＆交差が減る。
 * 連携を持たない孤立ノードは末尾（Infinity）に置く。
 */
function buildFrontendAlignmentKey(
  frontendNodes: GraphNode[],
  edges: GraphEdge[],
  backendPositions: Record<string, { x: number; y: number }>,
): (id: string) => number {
  const frontendIds = new Set(frontendNodes.map((n) => n.id));

  // 1. 直接 linkage を持つフロントノード → 連携相手バックエンドの Y 平均。
  const sum = new Map<string, { total: number; count: number }>();
  for (const edge of edges) {
    if (edge.kind !== "linkage") continue;
    for (const [fe, be] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      if (!frontendIds.has(fe)) continue;
      const by = backendPositions[be]?.y;
      if (by === undefined) continue;
      const acc = sum.get(fe) ?? { total: 0, count: 0 };
      acc.total += by;
      acc.count += 1;
      sum.set(fe, acc);
    }
  }
  const targetY = new Map<string, number>();
  for (const [id, { total, count }] of sum) targetY.set(id, total / count);

  // 2. structural 隣接（無向）で targetY を伝播（鎖の祖先/子孫へ波及）。
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!frontendIds.has(a) || !frontendIds.has(b)) return;
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
  };
  for (const edge of edges) {
    if (edge.kind === "structural") {
      link(edge.source, edge.target);
      link(edge.target, edge.source);
    }
  }
  const queue = [...targetY.keys()];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const value = targetY.get(id)!;
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!targetY.has(neighbor)) {
        targetY.set(neighbor, value);
        queue.push(neighbor);
      }
    }
  }

  return (id: string): number => targetY.get(id) ?? Number.POSITIVE_INFINITY;
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
  /** 対応する関数 ID（選択枠コピーの対象。route/apiCall/function 枠のみ持つ）。 */
  functionId?: string;
  /** ソース位置（コード→枠フォーカスの照合に使う）。 */
  sourceLocation?: { file: string; line: number };
  /** フロントのディレクトリ別サブゾーン分類（frontend のみ。backend は undefined）。 */
  dir?: string;
  /** 毎tick描画の高速化用キャッシュ（renderNodeCards でカード生成時に1回だけ格納する）。 */
  /** 対応する Cytoscape ノード参照（毎tickの getElementById を避ける）。 */
  cyNode: NodeSingular;
  /** structural 深度（毎tickの dataset 文字列パースを避ける）。 */
  depthVal: number;
  /** 警告件数（ゾーン高さの解析的算出に使う）。 */
  warnCount: number;
};
let nodeCardEls: NodeCardEntry[] = [];
let nodeCardUpdateFn: (() => void) | null = null;

/** Ctrl/Cmd+クリックで複数選択中のノード id 集合。「選択した枠をコピー」の対象。 */
let selectedNodeIds = new Set<string>();
/** 現在の選択が Ctrl/Cmd による複数選択モードか。true のときだけ背景色で強調する。 */
let selectionMultiMode = false;

/**
 * 選択状態を全カードに反映する。選択中はリング＋ソフトグローで強調し、Ctrl 複数選択モードのときだけ
 * 背景色（`selectedBg`）も付ける（単一クリック選択はリングのみ・背景色なし）。非選択は既定背景へ戻す。
 */
function applySelectionHighlight(): void {
  const theme = buildTheme();
  for (const { el, nodeId } of nodeCardEls) {
    const sel = selectedNodeIds.has(nodeId);
    el.style.background = sel && selectionMultiMode ? theme.selectedBg : theme.cardBg;
    el.style.boxShadow = sel ? `0 0 0 2px ${theme.selected}, 0 0 10px ${theme.selected}66` : "";
  }
}

/** 指定ノードが画面中央に来るようにパンする（ミニマップのクリック移動と同じ式）。 */
function panToNode(nodeId: string): void {
  if (!cy) return;
  const cyNode = cy.getElementById(nodeId);
  if (!cyNode.length) return;
  const pos = cyNode.position();
  const zoom = cy.zoom();
  cy.pan({
    x: graphContainer.clientWidth / 2 - pos.x * zoom,
    y: graphContainer.clientHeight / 2 - pos.y * zoom,
  });
}

/** 指定ノードを「オンマウス相当」に強調する（到達集合を明るく＋線を強調）。ホバーと逆遷移で共用。 */
function focusNodeEmphasis(nodeId: string): void {
  const reachable = reachableNodeIds(nodeId);
  for (const { el, nodeId: nid } of nodeCardEls) {
    el.style.filter = reachable.has(nid) ? HOVER_BRIGHTNESS : "";
  }
  setHoverReachable(reachable);
}

/** タイプ移動（typeahead）の入力バッファと無入力タイマー。 */
let typeaheadBuffer = "";
let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 打鍵プレフィックスに前方一致する最初の枠を単一選択し、中央へパンする。
 * 連続打鍵でプレフィックスを伸ばせる（~800ms 無入力でバッファをリセット）。
 */
function typeaheadNavigate(ch: string): void {
  typeaheadBuffer += ch.toLowerCase();
  if (typeaheadTimer) clearTimeout(typeaheadTimer);
  typeaheadTimer = setTimeout(() => {
    typeaheadBuffer = "";
  }, 800);

  // searchText は `label + file`（小文字）で先頭がラベルなので、先頭一致＝ラベル前方一致になる。
  const hit = nodeCardEls.find(({ searchText }) => searchText.startsWith(typeaheadBuffer));
  if (!hit) return;
  selectionMultiMode = false;
  selectedNodeIds = new Set([hit.nodeId]);
  applySelectionHighlight();
  panToNode(hit.nodeId);
}

/** 左下の操作ヘルプ（ラウンド枠・固定）。`graphContainer` 下端＝警告セクション直上に配置される。 */
let helpOverlayEl: HTMLElement | null = null;
function clearHelpOverlay(): void {
  helpOverlayEl?.remove();
  helpOverlayEl = null;
}
function renderHelpOverlay(): void {
  clearHelpOverlay();
  const box = document.createElement("div");
  box.setAttribute("data-help", "true");
  box.style.cssText = [
    "position:absolute",
    "left:10px",
    "bottom:10px", // graphContainer 下端＝警告セクション直上。展開/縮小に追従、ズーム/パン不動。
    "z-index:6",
    "pointer-events:none",
    "padding:6px 9px",
    "border-radius:6px",
    // 背景を40%透過（60%不透明）。文字は不透明のまま。
    "background:color-mix(in srgb, var(--vscode-editorWidget-background,#252526) 60%, transparent)",
    "border:1px solid var(--vscode-widget-border,#454545)",
    "box-shadow:0 2px 8px rgba(0,0,0,0.36)",
    "font-size:10px",
    "line-height:1.5",
    "color:var(--vscode-descriptionForeground,#9d9d9d)",
    "white-space:nowrap",
    "user-select:none",
  ].join(";");
  const lines = [
    "クリック=選択 / Ctrl+クリック=複数選択",
    "文字入力=枠へ移動 / PageUp·Down=上下",
    "右ドラッグ=パン / ホイール=ズーム",
    "文字クリック=コードへ / 右クリック=コピー / Ctrl+F=検索",
  ];
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    box.appendChild(row);
  }
  graphContainer.appendChild(box);
  helpOverlayEl = box;
}

/**
 * 表示中エッジ（structural+linkage）から構築する**有向**隣接（source→target）。連鎖ホバーに使う。
 *
 * 無向にすると、ファイル/関数依存グラフのように密に連結したグラフでは到達集合が全ノードになり
 * 減光が起きない。エッジの向き（呼び出し元→呼び出し先、フロント→バック）に沿って下流のみを
 * 辿ることで、連鎖を保ちつつ無関係な枝を減光する。
 */
let hoverAdj = new Map<string, Set<string>>();

/** ホバー時に到達カードへ適用する明度アップ（周辺は無変化）。調整可。 */
const HOVER_BRIGHTNESS = "brightness(1.6)";

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
    unregisterFrameUpdater(nodeCardUpdateFn);
    nodeCardUpdateFn = null;
  }
  for (const { el } of nodeCardEls) el.remove();
  nodeCardEls = [];
  selectedNodeIds.clear(); // 再描画（深度切替/再解析）でノード集合が変わるため選択をリセット
  cardContextMenu.close();
  clearTreeGuides(cy);
  clearLinkageLines();
  clearDependencyLines();
  clearMinimap(cy);
  clearHelpOverlay();
}

function updateNodeCardPositions(): void {
  if (!cy) return;
  const zoom = cy.zoom();
  const pan = cy.pan();
  const hw = NODE_CARD_W / 2;
  const hh = NODE_CARD_H / 2;

  for (const { el, cyNode, depthVal } of nodeCardEls) {
    if (!cyNode.length) continue;
    const pos = cyNode.position();
    const screenX = pos.x * zoom + pan.x;
    const screenY = pos.y * zoom + pan.y;
    const extraX = depthVal * INDENT_X * zoom;
    el.style.transform = `translate(${screenX - hw * zoom + extraX}px, ${screenY - hh * zoom}px) scale(${zoom})`;
  }

  updateZonePositions();
}

/** ゾーンパディング（カード bbox の外側余白, px）。 */
const ZONE_PADDING = 14;
/** ゾーン上部のヘッダ（見出し+件数）用に確保する追加の高さ（px）。 */
const ZONE_HEADER_SPACE = 30;

/**
 * フロント/バック背景ゾーンを、カードの画面矩形に合わせる。
 *
 * 矩形は `getBoundingClientRect()`（毎tickの強制リフローを誘発）ではなく、キャッシュした Cytoscape 位置・
 * zoom・pan・depth・警告件数から**解析的に算出**する（`updateNodeCardPositions` の transform と同一式）。
 * これによりパン/ズーム中の read-after-write レイアウトスラッシングを排除する。
 */
function updateZonePositions(): void {
  if (!cy) return;
  const zoom = cy.zoom();
  const pan = cy.pan();
  const hw = NODE_CARD_W / 2;
  const hh = NODE_CARD_H / 2;

  /**
   * `predicate` に一致するカードの画面 bbox に `zone` を合わせる。`topSpace`/`pad` でヘッダ余白・外周余白を調整。
   * outer フロント枠はサブゾーン（ヘッダ付き）を内包するため大きめの余白を与える。
   */
  const fit = (
    zone: HTMLElement | null,
    predicate: (entry: NodeCardEntry) => boolean,
    topSpace: number,
    pad: number,
  ): void => {
    if (!zone) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const entry of nodeCardEls) {
      if (!predicate(entry) || !entry.cyNode.length) continue;
      const pos = entry.cyNode.position();
      // カードの画面矩形（コンテナ相対）。transform の translate/scale と同じ計算。
      const left = pos.x * zoom + pan.x - hw * zoom + entry.depthVal * INDENT_X * zoom;
      const top = pos.y * zoom + pan.y - hh * zoom;
      const right = left + NODE_CARD_W * zoom;
      const bottom = top + (NODE_CARD_H + entry.warnCount * WARNING_ITEM_H) * zoom;
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, bottom);
      count++;
    }
    if (count === 0) {
      zone.style.display = "none";
      return;
    }
    zone.style.display = "block";
    zone.style.left = `${minX - pad}px`;
    zone.style.top = `${minY - topSpace}px`;
    zone.style.width = `${maxX - minX + pad * 2}px`;
    zone.style.height = `${maxY - minY + topSpace + pad}px`;
  };

  // outer フロント枠はサブゾーンのヘッダ帯（ZONE_HEADER_SPACE）＋自身のヘッダ帯を内包するため余白2段。
  fit(frontendZone, (e) => e.side === "frontend", ZONE_HEADER_SPACE * 2, ZONE_PADDING * 2);
  fit(backendZone, (e) => e.side === "backend", ZONE_HEADER_SPACE, ZONE_PADDING);
  for (const [dir, sub] of frontendSubZones) {
    fit(sub, (e) => e.side === "frontend" && e.dir === dir, ZONE_HEADER_SPACE, ZONE_PADDING);
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

    // 左クリックを cytoscape コンテナへ伝播させない。深くインデントされた枠は cy ノードの当たり判定外に
    // なり、伝播すると cytoscape が空きエリア tap を発火して選択を消してしまうため（右ボタンはパン/
    // コンテキストメニュー用に伝播を残す）。
    card.addEventListener("mousedown", (e) => {
      if (e.button === 0) e.stopPropagation();
    });

    // クリック: 通常=単一選択（リングのみ）/ Ctrl(Cmd)+クリック=トグル複数選択（背景色も付く）
    card.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        selectionMultiMode = true;
        if (selectedNodeIds.has(node.id)) selectedNodeIds.delete(node.id);
        else selectedNodeIds.add(node.id);
      } else {
        selectionMultiMode = false;
        selectedNodeIds = new Set([node.id]);
      }
      applySelectionHighlight();
    });

    // 右クリック: コンテキストメニュー。連携関数コピー(functionId 持ち)＋選択枠コピー(選択あり)を提示。
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (node.functionId || selectedNodeIds.size > 0) {
        cardContextMenu.open(e.clientX, e.clientY, node, selectedNodeIds.size);
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

    // ホバー: 周辺を減光するのではなく、連鎖（到達可能な全ノード）を「明るく」強調する。
    // 非到達は無変化。線（連携線・ツリーガイド）は svgRenderer 側へ到達集合を渡して太線＋明色で
    // 強調させる（毎tick再描画されるため）。`opacity` でなく `filter` を使い、検索の減光/強調と競合させない。
    card.addEventListener("mouseenter", () => {
      focusNodeEmphasis(node.id);
    });

    card.addEventListener("mouseleave", () => {
      for (const { el } of nodeCardEls) {
        el.style.filter = "";
      }
      setHoverReachable(null);
    });

    graphContainer.appendChild(card);
    nodeCardEls.push({
      el: card,
      nodeId: node.id,
      side: node.side,
      searchText: `${node.label} ${node.sourceLocation?.file ?? ""}`.toLowerCase(),
      functionId: node.functionId,
      sourceLocation: node.sourceLocation,
      dir: node.side === "frontend" ? topDir(node.sourceLocation?.file) : undefined,
      // 毎tickの getElementById / dataset パースを避けるため、生成時に1回だけキャッシュする。
      cyNode: cy.getElementById(node.id),
      depthVal: depths.get(node.id) ?? 0,
      warnCount: warnings.length,
    });
  }

  const updateFn = () => updateNodeCardPositions();
  nodeCardUpdateFn = updateFn;
  registerFrameUpdater(updateFn);
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

  // ヘッダ（クリックで折りたたみ/展開）
  const header = document.createElement("div");
  header.style.cssText = `padding:6px 12px 4px;font-size:13px;font-weight:600;color:${theme.textSub};letter-spacing:.3px;cursor:pointer;user-select:none;`;
  const indicator = document.createElement("span");
  indicator.style.cssText = "display:inline-block;width:1.2em;";
  const label = document.createElement("span");
  label.textContent = `該当ノードのない警告 (${orphans.length})`;
  header.appendChild(indicator);
  header.appendChild(label);
  orphanSection.appendChild(header);

  const list = document.createElement("div");
  // 高さ上限 + 縦スクロール。警告が多くてもセクションが伸び続けてグラフ領域を圧迫しないようにする
  // （ヘッダはセクション直下のままなので常時表示され、リスト部だけがスクロールする）。
  list.style.cssText =
    "display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px;max-height:22vh;overflow-y:auto;";

  // 折りたたみ状態を表示へ反映する（インジケータ ▼/▶ と list の表示切替）。
  const applyCollapsed = (): void => {
    indicator.textContent = orphanCollapsed ? "▶" : "▼";
    list.style.display = orphanCollapsed ? "none" : "flex";
  };
  applyCollapsed();
  header.addEventListener("click", () => {
    orphanCollapsed = !orphanCollapsed;
    applyCollapsed();
  });

  for (const w of orphans) {
    const kind = inferWarningKind(w);
    const icon = kind === "excluded" ? "■" : kind === "parse" ? "◆" : "○";
    const color = WARNING_KIND_COLOR[kind];

    // 警告チップは視認性のため従来比 1.5 倍のサイズで表示する。クリックで対象枠へフォーカス。
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
      "cursor:pointer",
    ].join(";");
    chip.addEventListener("click", () => focusWarningTarget(w));

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

/**
 * 初期表示を原寸(zoom=1)・コンテンツ最上部に固定する。
 * 枠が多くても fit による縮小をせず、最上部の枠が見える位置から原寸で表示する。
 * 横方向はコンテンツが画面に収まれば中央寄せ、収まらなければ最左（+余白）に寄せる。
 */
function applyInitialView(): void {
  if (!cy) return;
  const VIEW_PADDING = 50;
  cy.zoom(1);
  const bb = cy.elements().boundingBox();
  const rect = graphContainer.getBoundingClientRect();
  // 縦: コンテンツ最上部(bb.y1)を画面上端(+余白)へ。rendered_y = model_y*zoom + panY（zoom=1）。
  const panY = VIEW_PADDING - bb.y1;
  // 横: 収まるなら中央、収まらないなら最左。
  const panX = bb.w <= rect.width ? (rect.width - bb.w) / 2 - bb.x1 : VIEW_PADDING - bb.x1;
  cy.pan({ x: panX, y: panY });
}

function renderGraph(): void {
  if (!currentOutput) return;

  clearWarningOverlays();
  clearNodeCards();

  const projected = projectDepth(currentOutput, currentDepth);
  // 「連携のみ」表示時は、フロント↔バック連携に到達しない孤立ノード（多数の UI 部品）を除外する。
  const { nodes, edges } = showConnectedOnly
    ? filterConnectedToLinkage(projected.nodes, projected.edges)
    : projected;
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

  // 旧 cy のスケジューラを切り離し（保留 rAF をキャンセル・updater をクリア）てから破棄する。
  detachRenderScheduler(cy);
  cy?.destroy();
  cy = cytoscape({
    container: graphContainer,
    elements,
    style: buildCytoscapeStyle(),
    // ズーム上下限。fit も cy.zoom() もこの範囲にクランプされるため、枠が少ない/多いときの
    // 過剰拡大・極小化を防ぐ（手動ホイールズームも同じ範囲で頭打ちになる）。
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    layout: {
      // fit はしない（枠が多いと縮小され中ほどが表示されてしまうため）。初期表示は applyInitialView で
      // 常に原寸(zoom=1)・コンテンツ最上部に固定する。
      name: "preset",
      fit: false,
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

  // 新 cy の描画イベントをスケジューラへ接続（カード/線/ミニマップの毎tick更新を rAF で一括実行）。
  attachRenderScheduler(cy);

  // 初期表示を原寸(zoom=1)・コンテンツ最上部に固定する（枠の数に依らずトップから原寸で見せる）。
  applyInitialView();

  // ゾーンは cy 生成後に追加してキャンバス上に表示（z-index:2 > canvas:auto）
  renderBackgroundZones(frontendDirCounts(nodes), backendCount);

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
      selectedNodeIds.clear();
      applySelectionHighlight(); // 背景色＋リングを「選択なし」状態へ戻す
      for (const { el } of nodeCardEls) {
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
  renderDependencyLines(cy, graphContainer, nodes, edges, depths, primaryParentOf);
  renderMinimap(cy, graphContainer, nodes);
  renderHelpOverlay();
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
    return;
  }
  if (message.type === "focusNode") {
    focusNodeByLocation(message.payload.file, message.payload.line);
  }
});

/**
 * コード位置（root 相対ファイル＋行）に対応する枠を選び、オンマウス相当に強調＋中央へパンする（逆遷移）。
 * 同一ファイル内で `location.line <= line` の最大（＝その行を内包する定義）を選ぶ。
 */
function focusNodeByLocation(file: string, line: number): void {
  let best: { nodeId: string; line: number } | undefined;
  for (const { nodeId, sourceLocation } of nodeCardEls) {
    if (!sourceLocation || sourceLocation.file !== file) continue;
    if (sourceLocation.line <= line && (best === undefined || sourceLocation.line > best.line)) {
      best = { nodeId, line: sourceLocation.line };
    }
  }
  // 行で内包できなければ、同一ファイルの最初の枠にフォールバック。
  if (!best) {
    const fallback = nodeCardEls.find(({ sourceLocation }) => sourceLocation?.file === file);
    if (fallback) best = { nodeId: fallback.nodeId, line: 0 };
  }
  if (!best) return;
  // 対象枠を明確に目立たせる: カーソルフォーカス相当の選択リング＋オンマウス相当の明度強調＋中央へパン。
  selectionMultiMode = false;
  selectedNodeIds = new Set([best.nodeId]);
  applySelectionHighlight();
  focusNodeEmphasis(best.nodeId);
  panToNode(best.nodeId);
}

/** 警告の target に対応する枠を現在のカードから探す（ラベル/searchText 一致 → ファイル一致）。 */
function findWarningNodeId(target: string): string | undefined {
  const t = target.toLowerCase();
  const byLabel = nodeCardEls.find((e) => e.searchText.includes(t));
  if (byLabel) return byLabel.nodeId;
  const filePart = t.split(":")[0];
  const byFile = nodeCardEls.find((e) => (e.sourceLocation?.file ?? "").toLowerCase() === filePart);
  return byFile?.nodeId;
}

/**
 * 「該当ノードのない警告」クリック時、対象枠を探してフォーカス＆強調する。現ビューに無ければ
 * 「すべて表示」→「ルート連携ビュー」と切替えて再探索する（表示切替てでも探す）。
 */
function focusWarningTarget(w: Warning): void {
  const tryFocus = (): boolean => {
    const id = findWarningNodeId(w.target);
    if (!id) return false;
    focusNodeEmphasis(id);
    panToNode(id);
    return true;
  };
  if (tryFocus()) return;
  if (showConnectedOnly) {
    showConnectedOnly = false;
    renderGraph();
    if (tryFocus()) return;
  }
  if (currentDepth !== "route") {
    currentDepth = "route";
    renderGraph();
    tryFocus();
  }
}

createDepthSwitchControl(
  depthSwitchContainer,
  (depth) => {
    currentDepth = depth;
    renderGraph();
  },
  () => vscodeApi.postMessage({ type: "reanalyze" }),
  {
    initial: showConnectedOnly,
    onToggle: (connectedOnly) => {
      showConnectedOnly = connectedOnly;
      renderGraph();
    },
  },
);

renderLegend(legendContainer);

vscodeApi.postMessage({ type: "ready" });
