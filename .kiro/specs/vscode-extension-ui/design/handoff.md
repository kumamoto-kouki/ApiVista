# ApiVista ルート連携グラフ — 実装ハンドオフ仕様

VSCode 拡張の Webview グラフ可視化。**Cytoscape.js**（図形ノード＋矢印エッジ＋ラベル）で再現する前提の設計仕様。

参照プロトタイプ: `ApiVista Graph.dc.html`（standalone 版: `ApiVista Graph.standalone.html`）
スクリーンショット: `screenshots/handoff-route.png` / `handoff-file.png` / `handoff-func.png`

---

## 1. 画面構成

```
┌─ Toolbar ───────────────────────────────────────────────┐
│ ApiVista [ルート連携|ファイル単位|関数単位]   矢印=方向    │
├─ Legend ────────────────────────────────────────────────┤
│ R ルート / API APIコール / F ファイル / fn 関数 / 未連携 / 連携 / 構造 │
├─ Canvas ────────────────────────────────────────────────┤
│  ┌ フロントエンド(左) ┐        ┌ バックエンド(右) ┐        │
│  │  node card        │ ──連携→ │  node card        │       │
│  │   └ warning(直下)  │        │   └ warning(直下) │       │
│  └───────────────────┘        └──────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

- **フロントエンド = 左ブロック / バックエンド = 右ブロック**（背景ゾーンで色分け、見出し＋件数）。
- 警告は右パネルに分離せず、**該当ノードの直下にネスト表示**（対応関係を空間的に表現、結線は不要）。
- 粒度（ルート/ファイル/関数）は同時に1つだけ表示。切替時は前ビューを完全に破棄。

---

## 2. ノード（4種別）— 色＋形＋頭文字

| 種別 | 役割 | 色(既定) | VSCodeテーマ変数(推奨) | 形 (Cytoscape `shape`) | 頭文字ラベル |
|---|---|---|---|---|---|
| route   | バックエンド/呼び出し先 | `#3794ff` 青 | `charts.blue`   | `round-rectangle` | `R` |
| apicall | フロントエンド/呼び出し元 | `#89d185` 緑 | `charts.green`  | `hexagon`         | `API` |
| file    | ファイル | `#c586c0` 紫 | `charts.purple` | `rectangle`       | `F` |
| function| 関数 | `#d7ba7d` 黄 | `charts.yellow` | `ellipse`         | `fn` |
| **未連携** (unmatched) | 対応相手なし | `#f14c4c` 赤 | `charts.red` / `errorForeground` | 各形のまま | 赤枠＋赤頭文字 |

- 色は固定せず **テーマ変数追従**（役割ごとに別色という方針のみ固定）。
- ノード表示情報（プロトでは常時カード内に表示）: 種別名 / ラベル（例 `GET /api/users`）/ ソース位置 `file:line`（クリックでエディタへジャンプ）/ 接続数 / 未連携バッジ。

### side（バック/フロント）の確定ルール
- `route` 種別 = 常にバックエンド、`apicall` 種別 = 常にフロントエンド。
- `file` / `function` は元データの `side: "backend" | "frontend"` を使用（グラフへ渡す）。

---

## 3. エッジ（2種別）— 必ず矢印で向きを表現

| 種別 | 意味 | 描画 | 矢印 | Cytoscape |
|---|---|---|---|---|
| linkage | バック↔フロントの連携 | 実線・曲線、中央ガター | source→target に矢印 | `curve-style: bezier`, `target-arrow-shape: triangle`, `line-style: solid` |
| structural | import / 関数呼び出し（同一side内） | 実線・**インデント＋エルボー（ツリー）** | 親→子に矢印 | `taxi`(elbow) もしくは bezier、ネスト配置 + `target-arrow` |

- **全エッジは片方向 `source → target`**（双方向概念なし）。`linkage` は「呼び出し元(フロント) → 呼び出し先(バック)」。
- `structural` は視認性のため**呼び出し元の直下に呼び出し先をネスト表示**し、種別色の実線エルボー＋矢印で接続。
- 共有依存（複数から import される等）は **各親の下に重複表示してよい**（1ノード1回の制約は撤廃）。

---

## 4. 警告（warnings）

各警告 = `target`（パス/ファイル名）＋ `reason` ＋ `kind`。グラフ上の対応ノードへ `node` で紐付け。

| kind | インジケータ色 | 例 |
|---|---|---|
| unmatched | 赤 `#f14c4c` | 未連携のルート / 未連携のAPI呼び出し |
| excluded  | 黄 `#d7ba7d` | URLが静的に決定できず除外 |
| parse     | 橙 `#e0944a` | 構文エラー / 解析失敗 |

- 各ノードと**同じ色インジケータ**＋左ボーダーで結びつけ、**該当ノードの直下**に配置。
- 現ビューに対応ノードが無い警告は、各ブロック末尾の「**該当ノードのない警告**」にまとめる。
- ホバー: 対応ノードをハイライト＋周辺以外を減光。クリック: 対応ノードへフォーカス（選択）。

---

## 5. インタラクション仕様

| 操作 | 挙動 |
|---|---|
| ノード hover | 当該＋隣接ノード/エッジを強調、他を減光(opacity .24) |
| ノード click | 選択（青アウトライン `#0078d4` ＋グロー）。`file:line` をエディタで開く想定 |
| 警告 hover | 対応ノードをフォーカス強調 |
| 警告 click | 対応ノードを選択フォーカス（無い場合はトースト通知） |
| **空きエリア click** | **選択を解除** |
| 粒度切替 | データセット差し替え・選択/ホバー状態リセット |

---

## 6. データ模型（スキーマ）

```ts
type NodeType = "route" | "apicall" | "file" | "function";
type Side = "backend" | "frontend";

interface GraphNode {
  id: string;
  type: NodeType;
  side: Side;
  label: string;        // 例 "GET /api/users", "routers/items.py", "fetchUser()"
  source: string;       // "file:line"（クリックでジャンプ）
  unmatched?: boolean;  // 対応相手が見つからない
}

interface GraphEdge {
  id: string;
  source: string;       // node id（呼び出し元 / 親）
  target: string;       // node id（呼び出し先 / 子）
  kind: "linkage" | "structural";
}

interface Warning {
  id: string;
  target: string;       // ルートのパスやファイル名
  reason: string;
  kind: "unmatched" | "excluded" | "parse";
  side: Side;
  nodeId: string | null;// 現粒度での対応ノード（無ければ null）
}
```

### サンプル（ルート連携ビュー）

```json
{
  "nodes": [
    {"id":"r1","type":"route","side":"backend","label":"GET /api/users","source":"routers/users.py:12"},
    {"id":"r4","type":"route","side":"backend","label":"GET /api/items","source":"routers/items.py:8","unmatched":true},
    {"id":"a1","type":"apicall","side":"frontend","label":"GET /api/users","source":"composables/useUserApi.ts:8"},
    {"id":"a5","type":"apicall","side":"frontend","label":"GET /api/widgets","source":"composables/useWidgets.ts:5","unmatched":true}
  ],
  "edges": [
    {"id":"e1","source":"a1","target":"r1","kind":"linkage"}
  ],
  "warnings": [
    {"id":"w6","target":"/api/widgets","reason":"未連携のAPI呼び出し","kind":"unmatched","side":"frontend","nodeId":"a5"},
    {"id":"w10","target":"/api/items","reason":"未連携のルート","kind":"unmatched","side":"backend","nodeId":"r4"}
  ]
}
```

> 構造ビュー（file/function）では `kind:"structural"` のエッジが同一side内に現れ、ツリー（ネスト）で描画する。

---

## 7. 配色トークン（ダークテーマ）

| 用途 | 既定値 | 備考 |
|---|---|---|
| 背景 | `#1f1f1f` | editor.background |
| パネル/ブロック地 | `#181818` / 種別色5%ティント | |
| ボーダー | `#2b2b2b` / 種別色18% | |
| カード地 | `#252526`（強調時 `#2d2d30`） | opaqueに保つ |
| 文字(主/副) | `#cccccc` / `#9d9d9d` / `#6e6e6e` | |
| 選択アウトライン | `#0078d4` | focusBorder |
| エッジ(通常/強調/減光) | `#8a8a8a` / `#e8e8e8` / `#383838` | |

固定パレット依存を避け、上記はテーマ変数へマッピングすること。

---

## 8. Cytoscape.js 実装ステップ

> ネスト（構造ツリー）と「警告をノード直下に配置」はレイアウトの工夫が要る。**linkage は Cytoscape の自動レイアウト、structural は手動ネスト**で表現するのが最も再現性が高い。

### 8-1. テーマ変数の取得（Webview 側）

VSCode は Webview の `<body>` に CSS 変数を注入する。固定色の代わりにこれを読む:

```js
const css = getComputedStyle(document.body);
const v = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
const THEME = {
  route:    v('--vscode-charts-blue',   '#3794ff'),
  apicall:  v('--vscode-charts-green',  '#89d185'),
  file:     v('--vscode-charts-purple', '#c586c0'),
  function: v('--vscode-charts-yellow', '#d7ba7d'),
  unmatched:v('--vscode-charts-red',    '#f14c4c'),
  edge:     v('--vscode-editorLineNumber-foreground', '#8a8a8a'),
  edgeHi:   v('--vscode-foreground',    '#e8e8e8'),
  cardBg:   v('--vscode-editorWidget-background', '#252526'),
  border:   v('--vscode-widget-border', '#2b2b2b'),
  selected: v('--vscode-focusBorder',   '#0078d4'),
  text:     v('--vscode-foreground',    '#cccccc'),
};
// テーマ変更に追従: MutationObserver で body class 変化 → 再取得 → cy.style().update()
```

### 8-2. データ → Cytoscape elements

```js
const initials = { route:'R', apicall:'API', file:'F', function:'fn' };

const elements = [
  ...nodes.map(n => ({ data: {
    id: n.id, type: n.type, side: n.side,
    label: `${initials[n.type]}  ${n.label}`,   // 頭文字＋ラベル
    source: n.source, unmatched: !!n.unmatched,
  }})),
  ...edges.map(e => ({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind } })),
];
```

### 8-3. style 設定例

```js
const style = [
  // --- nodes: 色＋形＋頭文字 ---
  { selector: 'node', style: {
      'background-color': THEME.cardBg,
      'border-width': 1.5,
      'border-color': ele => THEME[ele.data('type')],
      'label': 'data(label)',
      'color': THEME.text,
      'font-family': 'ui-monospace, Menlo, monospace',
      'font-size': 13,
      'text-valign': 'center', 'text-halign': 'center',
      'width': 'label', 'padding': '10px',
      'shape': ele => ({ route:'round-rectangle', apicall:'hexagon',
                         file:'rectangle', function:'ellipse' }[ele.data('type')]),
  }},
  // 未連携: 赤枠
  { selector: 'node[?unmatched]', style: {
      'border-color': THEME.unmatched, 'border-width': 2,
  }},
  // 選択 / フォーカス
  { selector: 'node:selected', style: {
      'border-color': THEME.selected, 'border-width': 2.5,
      'overlay-color': THEME.selected, 'overlay-opacity': 0.08,
  }},
  // 減光（フォーカス時に .dim クラスを付与）
  { selector: '.dim', style: { 'opacity': 0.25 }},

  // --- edges ---
  { selector: 'edge', style: {
      'width': 1.6,
      'line-color': THEME.edge,
      'target-arrow-color': THEME.edge,
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',          // linkage = 曲線
  }},
  // 構造（import/呼出）= エルボー＋種別色
  { selector: 'edge[kind = "structural"]', style: {
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'line-color': ele => THEME[ele.target().data('type')],
      'target-arrow-color': ele => THEME[ele.target().data('type')],
  }},
  { selector: 'edge.hi', style: {
      'width': 2.4, 'line-color': THEME.edgeHi, 'target-arrow-color': THEME.edgeHi,
  }},
];
```

### 8-4. layout（バック/フロント＝左右分割）

`side` で X を固定し、各サイド内は縦に並べる **preset レイアウト**が最も意図どおり。

```js
function presetPositions(nodes, edges) {
  const W = 260, ROW = 110, leftX = 180, rightX = 760, top = 80;
  // structural の親子から各サイドの表示順（親→子で連続）を作る
  const order = side => buildTreeOrder(nodes.filter(n => n.side === side), edges);
  const pos = {};
  ['frontend','backend'].forEach(side => {
    const x = side === 'frontend' ? leftX : rightX;
    order(side).forEach((n, i) => { pos[n.id] = { x, y: top + i * ROW }; });
  });
  return pos;  // → layout: { name: 'preset', positions: id => pos[id] }
}
```

- `buildTreeOrder`: structural の `source→target` を親→子とし、親の直後に子を続ける（共有子は各親の下に重複ノードを生成 = id に `__2` 等のサフィックスを付けた複製ノードを elements に追加）。
- 自動配置を使う場合は `dagre`（`rankDir: 'LR'`, `align`）でも可。ただし左右サイド固定の確実性は preset が上。
- **警告はノードではなく HTML オーバーレイ**で各ノード直下に描画するのが扱いやすい（`cy.on('render pan zoom', ...)` でノードの `renderedPosition` を取得して DOM を追従）。Cytoscape ノードとして警告を描く場合は、対応ノードのすぐ下に preset 配置し、`edge` ではなく近接で関連を示す。

### 8-5. インタラクション配線

```js
// hover: 隣接以外を減光
cy.on('mouseover', 'node', e => {
  const nbr = e.target.closedNeighborhood();
  cy.elements().addClass('dim');
  nbr.removeClass('dim'); nbr.edges().addClass('hi');
});
cy.on('mouseout', 'node', () => cy.elements().removeClass('dim hi'));

// click: 選択（VSCode へジャンプ依頼）
cy.on('tap', 'node', e => {
  vscode.postMessage({ command: 'reveal', source: e.target.data('source') });
});

// 空きエリア click: 選択解除
cy.on('tap', e => { if (e.target === cy) cy.elements().unselect(); });

// 警告 click: 対応ノードへフォーカス
function focusWarning(w) {
  if (!w.nodeId) { /* トースト: 該当ノードなし */ return; }
  const n = cy.getElementById(w.nodeId);
  cy.elements().addClass('dim'); n.closedNeighborhood().removeClass('dim');
  n.select(); cy.animate({ center: { eles: n }, duration: 200 });
}
```

### 8-6. 実装チェックリスト

- [ ] テーマ変数を読み、変更に MutationObserver で追従
- [ ] 4種別を 色＋形＋頭文字 で描画、未連携は赤枠
- [ ] linkage=bezier＋矢印 / structural=taxi(elbow)＋種別色＋矢印
- [ ] side で左右分割（preset）＋ structural はネスト順、共有子は複製
- [ ] 警告を対応ノード直下にHTMLオーバーレイ表示（同色インジケータ）
- [ ] hover減光 / click選択＋ジャンプ / 空きエリアで解除 / 警告→ノードフォーカス
- [ ] 粒度切替でグラフ全破棄→再生成（状態リセット）

