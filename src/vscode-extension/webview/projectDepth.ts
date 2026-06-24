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
import type {
  ApiCallRef,
  LinkageOutput,
  RouteRef,
  SchemaReference,
  Warning,
} from "../../route-linkage/models.js";

export type Depth = "route" | "file" | "function";

export interface GraphNode {
  /** 名前空間化済みID(route-linkage-engineのidをそのまま利用、route/apiCallは本関数が合成)。 */
  id: string;
  kind: "route" | "apiCall" | "file" | "function" | "model" | "table";
  /** バックエンド/フロントエンドの区別（左右ゾーン配置に使用）。route=backend, apiCall=frontend固定。
   *  file/functionはroute-linkage-engineのLinkedFileNode.side/LinkedFunctionNode.sideを引き継ぐ。 */
  side: "backend" | "frontend";
  label: string;
  unmatched: boolean;
  sourceLocation?: { file: string; line: number };
  /**
   * この枠に対応する関数ノードの ID（名前空間化済み `LinkedFunctionNode.id`）。
   * route=`entryFunctionId` / apiCall=`enclosingFunctionId` / function=`fn.id`。
   * file 深度の枠は単一関数に対応しないため未設定。連鎖コピーの起点に使う。
   */
  functionId?: string;
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

/**
 * `schemaRefs` から「データモデル」ノード、`table=True`(tableName あり) なら「DB テーブル」ノードを足し、
 * `anchorId`（route / 関数 / ファイルのいずれかのノード）→ モデル → テーブル を structural エッジで連結する。
 * 複数の起点で共有されるモデル/テーブルは id で重複排除する（同一テーブルは 1 ノードに集約）。
 * 起点を差し替えるだけで route/file/function の各深度から再利用できる。
 */
function appendSchemaNodes(
  anchorId: string,
  schemaRefs: readonly SchemaReference[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  seenNodeIds: Set<string>,
  seenEdgeIds: Set<string>,
): void {
  for (const ref of schemaRefs) {
    const modelId = `model:${ref.className}:${ref.location.file}:${ref.location.line}`;
    if (!seenNodeIds.has(modelId)) {
      seenNodeIds.add(modelId);
      nodes.push({
        id: modelId,
        kind: "model",
        side: "backend",
        label: ref.className,
        unmatched: false,
        sourceLocation: { ...ref.location },
      });
    }
    const modelEdgeId = `schema:${anchorId}->${modelId}`;
    if (!seenEdgeIds.has(modelEdgeId)) {
      seenEdgeIds.add(modelEdgeId);
      edges.push({ id: modelEdgeId, source: anchorId, target: modelId, kind: "structural" });
    }

    if (ref.tableName === undefined) {
      continue;
    }
    const tableId = `table:${ref.tableName}`;
    if (!seenNodeIds.has(tableId)) {
      seenNodeIds.add(tableId);
      nodes.push({
        id: tableId,
        kind: "table",
        side: "backend",
        label: ref.tableName,
        unmatched: false,
        sourceLocation: { ...ref.location },
      });
    }
    const tableEdgeId = `tablemap:${modelId}->${tableId}`;
    if (!seenEdgeIds.has(tableEdgeId)) {
      seenEdgeIds.add(tableEdgeId);
      edges.push({ id: tableEdgeId, source: modelId, target: tableId, kind: "structural" });
    }
  }
}

function projectRouteDepth(output: LinkageOutput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();

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
      functionId: linkage.route.entryFunctionId,
    });
    appendSchemaNodes(routeId, linkage.route.schemaRefs, nodes, edges, seenNodeIds, seenEdgeIds);
    nodes.push({
      id: apiCallId,
      kind: "apiCall",
      side: "frontend",
      label: apiCallLabel(linkage.apiCall),
      unmatched: false,
      sourceLocation: { ...linkage.apiCall.location },
      functionId: linkage.apiCall.enclosingFunctionId,
    });
    edges.push({
      id: `linkage:${apiCallId}->${routeId}`,
      source: apiCallId,
      target: routeId,
      kind: "linkage",
    });
  }

  for (const route of output.unmatchedRoutes) {
    const routeId = routeNodeId(route);
    nodes.push({
      id: routeId,
      kind: "route",
      side: "backend",
      label: routeLabel(route),
      unmatched: true,
      sourceLocation: { ...route.handler },
      functionId: route.entryFunctionId,
    });
    appendSchemaNodes(routeId, route.schemaRefs, nodes, edges, seenNodeIds, seenEdgeIds);
  }

  for (const apiCall of output.unmatchedApiCalls) {
    nodes.push({
      id: apiCallNodeId(apiCall),
      kind: "apiCall",
      side: "frontend",
      label: apiCallLabel(apiCall),
      unmatched: true,
      sourceLocation: { ...apiCall.location },
      functionId: apiCall.enclosingFunctionId,
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
    // ファイル枠もコードジャンプ可能にする（ファイル先頭へ）。path は side ルート相対。
    sourceLocation: { file: file.path, line: 1 },
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

  // 各ルートの schemaRefs を、そのハンドラが属するファイルノードへ「ファイル → モデル → テーブル」で連結。
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  for (const route of allRoutes(output)) {
    const backendFileId = functionFileById.get(route.entryFunctionId);
    if (backendFileId === undefined || !fileIds.has(backendFileId)) {
      continue;
    }
    appendSchemaNodes(backendFileId, route.schemaRefs, nodes, edges, seenNodeIds, seenEdgeIds);
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
    functionId: fn.id,
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

  // 各ルートの schemaRefs を、そのハンドラ関数ノード（entryFunctionId）へ「関数 → モデル → テーブル」で連結。
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  for (const route of allRoutes(output)) {
    if (!functionIds.has(route.entryFunctionId)) {
      continue;
    }
    appendSchemaNodes(
      route.entryFunctionId,
      route.schemaRefs,
      nodes,
      edges,
      seenNodeIds,
      seenEdgeIds,
    );
  }

  return { nodes, edges };
}

/** 連携済み(linkages)・未連携(unmatchedRoutes)双方の全ルートを列挙する。 */
function allRoutes(output: LinkageOutput): RouteRef[] {
  return [...output.linkages.map((l) => l.route), ...output.unmatchedRoutes];
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
 * フロント↔バック連携に関与するノードのみへ絞り込む（「連携のみ」表示用）。
 *
 * `linkage` エッジの端点を起点に、全エッジ（structural も含む）を無向で辿って到達できるノードだけ残す。
 * これにより「呼び出し元コンポーネント → composable → 生成クライアント → ルート」のような連携の鎖は丸ごと
 * 残しつつ、どのルートにも到達しない孤立した UI 部品（多数の `0 接続` ノード）を除外する。
 * 残ったノードの両端を持つエッジのみ返す（孤立参照を作らない）。
 */
export function filterConnectedToLinkage(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
  };
  for (const edge of edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  const keep = new Set<string>();
  const queue: string[] = [];
  for (const edge of edges) {
    if (edge.kind !== "linkage") {
      continue;
    }
    for (const endpoint of [edge.source, edge.target]) {
      if (!keep.has(endpoint)) {
        keep.add(endpoint);
        queue.push(endpoint);
      }
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!keep.has(neighbor)) {
        keep.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
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

/**
 * `Warning` を対応する `GraphNode` id 集合へマッチさせる。
 *
 * 基本は `findMatchingNodeIds`（label 部分一致）だが、`unmatched-route` /
 * `unmatched-api-call` 診断は target に method を含まず path のみのため、同一 path の
 * **連携済みノード**にも部分一致してしまう。これらの reason に限り、対応する kind かつ
 * `unmatched===true` のノードへ限定し、連携済みノードへの誤付着を防ぐ。
 */
export function matchWarningNodeIds(warning: Warning, nodes: readonly GraphNode[]): string[] {
  const baseIds = new Set(findMatchingNodeIds(warning.target, nodes));
  const restrictTo = (kind: GraphNode["kind"]): string[] =>
    nodes.filter((n) => n.kind === kind && n.unmatched && baseIds.has(n.id)).map((n) => n.id);

  if (warning.reason === "unmatched-route") return restrictTo("route");
  if (warning.reason === "unmatched-api-call") return restrictTo("apiCall");
  return [...baseIds];
}
