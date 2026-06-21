/**
 * 深度別グラフ投影(design.md「webview/projectDepth」, tasks.md 4.1)。
 *
 * `LinkageOutput`(route-linkage-engineの出力)と選択中の`Depth`から、描画用の`GraphNode`/
 * `GraphEdge`集合を導出する純粋関数。副作用を持たず、DOM/Cytoscape/vscodeに一切依存しない
 * (`src/vscode-extension/webview/`配下の制約: Webviewはランタイムで`vscode`を解決できない)。
 *
 * - `depth="route"`: ノード=連携済みルート/API呼び出し(`unmatched:false`)+未連携のルート/
 *   API呼び出し(`unmatched:true`)。エッジ=`linkages[]`を結ぶ`linkage`エッジ。
 *   `RouteRef`/`ApiCallRef`自身はidを持たないため、`method`+`path(urlPattern)`+
 *   `handler/location.file`+`.line`から決定的に合成する(research.md「Decision: 深度別
 *   グラフ投影ロジックを純粋関数として分離する」がdepth切替の即時応答性のためクライアント側
 *   投影を要求しており、同一入力から常に同一idを導出できることがRequirement 7.3の決定的出力の
 *   前提となる)。
 * - `depth="file"`: ノード=`output.files`をそのまま投影。エッジ=各ファイルの`dependsOn[]`
 *   (`structural`)+各`linkage`を`entryFunctionId`/`enclosingFunctionId`→所属`file`へ投影した
 *   `linkage`エッジ(同一(source,target)組は重複除去)。
 * - `depth="function"`: ノード=`output.functions`をそのまま投影。エッジ=各関数の`calls[]`
 *   (`structural`)+各`linkage`の`entryFunctionId`⇄`enclosingFunctionId`を直結する`linkage`エッジ
 *   (重複除去は file 深度と同じ方式)。
 *
 * 参照整合性: route-linkage-engine自身が`entryFunctionId`/`enclosingFunctionId`/`file`の
 * 整合性を保証している(`models.ts`のコメント参照)ため、本モジュールは解決失敗を異常系として
 * 扱わず、解決できない参照は静かにスキップする(孤立エッジを作らないというdesign.mdの
 * Postconditionを優先する防御的実装。route-linkage-engineの契約違反を検出する責務は
 * 本モジュールの範囲外)。
 */
import type { ApiCallRef, LinkageOutput, RouteRef } from "../../route-linkage/models.js";

export type Depth = "route" | "file" | "function";

export interface GraphNode {
  /** 名前空間化済みID(route-linkage-engineのidをそのまま利用、route/apiCallは本関数が合成)。 */
  id: string;
  kind: "route" | "apiCall" | "file" | "function";
  /** バックエンド/フロントエンドの区別（左右ゾーン配置に使用）。route=backend, apiCall=frontend固定。
   *  file/functionはroute-linkage-engineのLinkedFileNode.side/LinkedFunctionNode.sideを引き継ぐ。 */
  side: "backend" | "frontend";
  label: string;
  unmatched: boolean;
  sourceLocation?: { file: string; line: number };
}

export interface GraphEdge {
  id: string;
  /** GraphNode.id */
  source: string;
  /** GraphNode.id */
  target: string;
  /** structural = calls[]/dependsOn[]由来 */
  kind: "linkage" | "structural";
}

/** ルートノードの決定的合成id。method+path+handler位置から導出する。 */
function routeNodeId(route: RouteRef): string {
  return `route:${route.method}:${route.path}:${route.handler.file}:${route.handler.line}`;
}

/** API呼び出しノードの決定的合成id。method+urlPattern+location位置から導出する。 */
function apiCallNodeId(apiCall: ApiCallRef): string {
  return `apiCall:${apiCall.method}:${apiCall.urlPattern}:${apiCall.location.file}:${apiCall.location.line}`;
}

function routeLabel(route: RouteRef): string {
  return `${route.method} ${route.path}`;
}

function apiCallLabel(apiCall: ApiCallRef): string {
  return `${apiCall.method} ${apiCall.urlPattern}`;
}

function projectRouteDepth(output: LinkageOutput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const linkage of output.linkages) {
    const routeId = routeNodeId(linkage.route);
    const apiCallId = apiCallNodeId(linkage.apiCall);

    nodes.push({
      id: routeId,
      kind: "route",
      side: "backend",
      label: routeLabel(linkage.route),
      unmatched: false,
      sourceLocation: { ...linkage.route.handler },
    });
    nodes.push({
      id: apiCallId,
      kind: "apiCall",
      side: "frontend",
      label: apiCallLabel(linkage.apiCall),
      unmatched: false,
      sourceLocation: { ...linkage.apiCall.location },
    });
    edges.push({
      id: `linkage:${apiCallId}->${routeId}`,
      source: apiCallId,
      target: routeId,
      kind: "linkage",
    });
  }

  for (const route of output.unmatchedRoutes) {
    nodes.push({
      id: routeNodeId(route),
      kind: "route",
      side: "backend",
      label: routeLabel(route),
      unmatched: true,
      sourceLocation: { ...route.handler },
    });
  }

  for (const apiCall of output.unmatchedApiCalls) {
    nodes.push({
      id: apiCallNodeId(apiCall),
      kind: "apiCall",
      side: "frontend",
      label: apiCallLabel(apiCall),
      unmatched: true,
      sourceLocation: { ...apiCall.location },
    });
  }

  return { nodes, edges };
}

function projectFileDepth(output: LinkageOutput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = output.files.map((file) => ({
    id: file.id,
    kind: "file",
    side: file.side,
    label: file.path,
    unmatched: false,
  }));

  const fileIds = new Set(output.files.map((file) => file.id));
  const functionFileById = new Map(output.functions.map((fn) => [fn.id, fn.file]));

  const edges: GraphEdge[] = [];

  for (const file of output.files) {
    for (const dependencyId of file.dependsOn) {
      if (!fileIds.has(dependencyId)) {
        continue;
      }
      edges.push({
        id: `structural:${file.id}->${dependencyId}`,
        source: file.id,
        target: dependencyId,
        kind: "structural",
      });
    }
  }

  const seenLinkagePairs = new Set<string>();
  for (const linkage of output.linkages) {
    const frontendFileId = functionFileById.get(linkage.apiCall.enclosingFunctionId);
    const backendFileId = functionFileById.get(linkage.route.entryFunctionId);

    if (!frontendFileId || !backendFileId) {
      continue;
    }
    if (!fileIds.has(frontendFileId) || !fileIds.has(backendFileId)) {
      continue;
    }
    if (frontendFileId === backendFileId) {
      continue;
    }

    const pairKey = `${frontendFileId}->${backendFileId}`;
    if (seenLinkagePairs.has(pairKey)) {
      continue;
    }
    seenLinkagePairs.add(pairKey);

    edges.push({
      id: `linkage:${pairKey}`,
      source: frontendFileId,
      target: backendFileId,
      kind: "linkage",
    });
  }

  return { nodes, edges };
}

function projectFunctionDepth(output: LinkageOutput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = output.functions.map((fn) => ({
    id: fn.id,
    kind: "function",
    side: fn.side,
    label: fn.name,
    unmatched: false,
    sourceLocation: { ...fn.location },
  }));

  const functionIds = new Set(output.functions.map((fn) => fn.id));

  const edges: GraphEdge[] = [];

  for (const fn of output.functions) {
    for (const calleeId of fn.calls) {
      if (!functionIds.has(calleeId)) {
        continue;
      }
      edges.push({
        id: `structural:${fn.id}->${calleeId}`,
        source: fn.id,
        target: calleeId,
        kind: "structural",
      });
    }
  }

  const seenLinkagePairs = new Set<string>();
  for (const linkage of output.linkages) {
    const frontendFunctionId = linkage.apiCall.enclosingFunctionId;
    const backendFunctionId = linkage.route.entryFunctionId;

    if (!functionIds.has(frontendFunctionId) || !functionIds.has(backendFunctionId)) {
      continue;
    }

    const pairKey = `${frontendFunctionId}->${backendFunctionId}`;
    if (seenLinkagePairs.has(pairKey)) {
      continue;
    }
    seenLinkagePairs.add(pairKey);

    edges.push({
      id: `linkage:${pairKey}`,
      source: frontendFunctionId,
      target: backendFunctionId,
      kind: "linkage",
    });
  }

  return { nodes, edges };
}

/**
 * `output`と選択中の`depth`から、描画用のノード/エッジ集合を導出する。
 *
 * Preconditions: `output`は`isLinkageOutput`相当の構造(route-linkage-engineが既に保証)。
 * Postconditions: 戻り値の`edges`は両端が戻り値の`nodes`に存在するIDのみを参照する(孤立参照を作らない)。
 * Invariants: 同一入力に対して常に同一の出力(決定的)。
 */
export function projectDepth(
  output: LinkageOutput,
  depth: Depth,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  switch (depth) {
    case "route":
      return projectRouteDepth(output);
    case "file":
      return projectFileDepth(output);
    case "function":
      return projectFunctionDepth(output);
  }
}

/**
 * `Warning.target`(route/apiCallの`path`/`urlPattern`、もしくはファイルパス)に対応する
 * `GraphNode`のid集合を返す(警告一覧ホバー時のグラフ強調表示用)。
 *
 * `target`はノードのid自体ではなく(route/apiCallノードのidはmethod+位置情報を含む合成id、
 * fileノードのidはengine側で生成された不透明id)、`label`に部分文字列として現れる元の
 * パス文字列のため、`label.includes(target)`での部分一致をマッチング基準とする
 * (file深度: labelがfile.pathそのものなので完全一致相当になる。route深度:
 * labelは`"METHOD path"`の形のため`target`(pathのみ)が部分文字列として一致する)。
 */
export function findMatchingNodeIds(target: string, nodes: readonly GraphNode[]): string[] {
  return nodes.filter((node) => node.label.includes(target)).map((node) => node.id);
}
