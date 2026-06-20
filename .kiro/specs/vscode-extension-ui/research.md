# Research & Design Decisions

## Summary
- **Feature**: `vscode-extension-ui`
- **Discovery Scope**: New Feature(greenfield、フルディスカバリー)
- **Key Findings**:
  - `analyzeBackend`(backend-route-extractor)は **非同期**、`analyzeFrontend`(frontend-call-extractor)は **同期**、`linkRoutes`(route-linkage-engine)は **同期**。3者をオーケストレーションする層は非同期/同期混在を吸収する必要がある。
  - グラフ描画ライブラリは **Cytoscape.js**(MIT、深度切替・フィルタリングAPIが明確、クリックイベントが単純)を採用する。
  - VSCode Webviewはオフライン・CSP制約があり、CDN読み込み不可・ローカルバンドル必須。バンドルには **esbuild**(開発時ツール、配布物には同梱せず成果物のみ同梱)を採用する。
  - ファイル監視・ソースジャンプはVSCode標準APIのみで実現可能(`vscode.workspace.createFileSystemWatcher`、`vscode.window.showTextDocument`)。外部パッケージ追加は不要。
  - `package.json` に拡張マニフェスト(`engines`/`main`/`contributes`/`activationEvents`)が未設定であることを確認。本specで初めて確立する。

## Research Log

### 既存3スペックの公開API形状
- **Context**: AnalysisOrchestratorが3つの公開APIをどう呼び出すかを決めるため、正確なシグネチャとエラー挙動を確認する必要があった。
- **Sources Consulted**: `src/backend-analysis/index.ts`、`src/frontend-analysis/index.ts`、`src/route-linkage/index.ts`、各 `cli.ts`。
- **Findings**:
  - `analyzeBackend(backendRoot: string, options?: AnalyzeOptions): Promise<AnalysisOutput>` — `backendRoot`が存在しない/ディレクトリでない場合のみthrow。構文エラー等の部分的失敗は`warnings`に記録され、解析自体は成功として返る。
  - `analyzeFrontend(frontendRoot: string, options?: AnalyzeFrontendOptions): AnalysisOutput` — 同期。エラー挙動はbackendと対称。
  - `linkRoutes(backendOutput: BackendAnalysisOutput, frontendOutput: FrontendAnalysisOutput): LinkageOutput` — 純粋・同期。`schemaVersion!==1`または必須配列欠落でthrow。
  - 3つのCLIラッパは同一規約(try/catch、stdout=単一JSON、stderr=エラーのみ、終了コード0/1/2)で対称的に実装されている。
- **Implications**: AnalysisOrchestratorは`await analyzeBackend(...)`→`analyzeFrontend(...)`(同期呼び出しだがawait可)→`linkRoutes(...)`の順で呼び、いずれかがthrowした場合は呼び出し元(コマンドハンドラ)に伝播させ、`vscode.window.showErrorMessage`で表示する一貫したエラー処理にする。

### グラフ描画ライブラリの比較
- **Context**: 3階層・深度切替・ノードクリックでのソースジャンプに適したWebview向けグラフ描画ライブラリの選定。
- **Sources Consulted**: Cytoscape.js / vis-network / D3.js の公式ドキュメント・ライセンス情報。
- **Findings**: 比較は下記「Architecture Pattern Evaluation」参照。Cytoscape.jsは`cy.elements().add()/remove()`、`cy.nodes('[depth=1]')`等のフィルタAPI、`cy.on('tap','node',handler)`のクリックハンドリングが深度切替・ソースジャンプの要件に直接合致する。
- **Implications**: グラフ描画ライブラリとして Cytoscape.js を採用(`dependencies`に追加)。

### VSCode Webviewの制約とパターン
- **Context**: Webviewはオフライン・CSP制約下で動作し、CDN読み込みができない。
- **Sources Consulted**: VSCode公式Webview API知識(`createWebviewPanel`、`asWebviewUri`、`localResourceRoots`、CSP nonceパターン)。
- **Findings**: ローカルJSバンドルを`webview.asWebviewUri`経由で読み込む必要があり、CSPは`nonce`ベースで`script-src 'nonce-xxx'`を指定する。拡張⇄Webview間は`postMessage`/`onDidReceiveMessage`の双方向メッセージング。
- **Implications**: Webview用のTS資産(`src/vscode-extension/webview/`)はesbuildで単一バンドル(`media/webview/bundle.js`)へビルドし、拡張ホスト側はそのURIをHTMLへ埋め込むだけにする。

### ファイル監視・ソースジャンプ
- **Findings**: `vscode.workspace.createFileSystemWatcher` + `RelativePattern`でglob監視、`onDidChange`/`onDidCreate`/`onDidDelete`で変更検知。`vscode.window.showTextDocument` + `Selection`/`revealRange`でジャンプ。いずれもVSCode標準APIのみで実現可能。
- **Implications**: 新規npm依存は不要(`vscode`型のみ`@types/vscode`は既存)。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Cytoscape.js | グラフ理論ベースの可視化ライブラリ(MIT) | フィルタ/階層レイアウト/クリックイベントAPIが充実、深度切替に直結 | バンドルサイズが中程度(gzip約112KB) | **採用** |
| vis-network | ネットワーク可視化ライブラリ(Apache-2.0/MIT) | DataSetによる動的add/remove | レイアウト・拡張性がCytoscapeに劣る | 不採用 |
| D3.js (force-directed) | 汎用データ可視化ライブラリ | 自由度最大 | グラフ専用UI(選択/階層/イベント)を自前実装する必要があり工数大 | 不採用 |

## Design Decisions

### Decision: グラフ描画ライブラリにCytoscape.jsを採用
- **Context**: 3階層・深度切替・ノードクリックでのソースジャンプを実現するグラフUIが必要。
- **Alternatives Considered**: vis-network、D3.js(force-directed)。
- **Selected Approach**: Cytoscape.jsをWebviewバンドルに含め、深度ごとのノード/エッジ集合を`cy.elements()`の入れ替えで切り替える。
- **Rationale**: フィルタAPI・クリックイベント・階層レイアウトが要件に直接合致し、自前実装コストが最小。
- **Trade-offs**: バンドルサイズはvis-networkよりやや大きいが、オフラインバンドル前提のため実害は小さい。
- **Follow-up**: 実装時に数千ノード規模でのレンダリング性能を目視確認する。

### Decision: 深度別グラフ投影ロジック(projectDepth)を純粋関数として分離する
- **Context**: `LinkageOutput`の3階層データ(`linkages`/`unmatchedRoutes`/`unmatchedApiCalls`/`functions`/`files`)から、選択中の深度に応じたノード/エッジ集合を導出する必要がある。特に depth=file・depth=function では、連携(route⇄apiCall)を `entryFunctionId`/`enclosingFunctionId` を介してファイル/関数粒度に投影した「連携エッジ」を、各側の構造的エッジ(`calls[]`/`dependsOn[]`)に重ねて描画する必要がある。
- **Alternatives Considered**: (1) 投影ロジックを拡張ホスト側で行い、深度ごとに別メッセージを送る。(2) Webview側で深度ごとに毎回ホストへ問い合わせる。
- **Selected Approach**: `LinkageOutput`全体を一度だけWebviewへ送り、Webview内の純粋関数`projectDepth(output, depth)`でクライアント側に投影する。
- **Rationale**: 深度切替はユーザー操作に対して即時応答する必要があり、ホストとの往復遅延を避けられる。`projectDepth`を純粋関数に分離することでCytoscape本体のDOM/Canvas依存から切り離し、vitestで直接単体テスト可能にする。
- **Trade-offs**: 初回ロード時のメッセージペイロードは3階層全データを含むため、巨大プロジェクトでは大きくなる可能性がある(現状のスケール要件には非該当、将来のページング/遅延ロードは再検証トリガーとして記録)。
- **Follow-up**: 実装時にメッセージサイズが問題化する規模かどうかを目視確認する。

### Decision: ファイル監視はグラフパネルを開いている間のみ稼働させる
- **Context**: Req6.1は「ソースファイル保存時に自動再解析」を要求するが、常時バックグラウンドで監視・解析を行うとパネルを開いていないユーザーにも解析コストを課す。
- **Alternatives Considered**: (1) アクティベーション直後から常時監視。(2) パネルを開いている間のみ監視(パネル破棄で監視も破棄)。
- **Selected Approach**: (2)を採用。`apivista.showGraph`コマンド実行時にパネルとファイル監視を生成し、パネルの`onDidDispose`で監視を`dispose()`する。
- **Rationale**: ユーザーがグラフを見ていない間の不要な解析コストを避ける(simplification)。Req1.1(アクティベーション)とRep6.1(保存時再解析)の両方を満たしつつ、最小の常時コストに留める。
- **Trade-offs**: パネルを閉じている間の変更は反映されず、次回オープン時に最新化される(要件上問題ない: Req6はパネル更新を指しており、無人時の即時反映は要求されていない)。
- **Follow-up**: なし。

### Decision: Webviewバンドルにesbuildを採用(開発時ツール、配布物には成果物のみ同梱)
- **Context**: Webview用TSコードはブラウザ実行のため単一JSへバンドルする必要がある。
- **Alternatives Considered**: webpack(高機能だが設定コストが高い)、手動concat(保守性が低い)。
- **Selected Approach**: esbuildで`src/vscode-extension/webview/main.ts`を`media/webview/bundle.js`へバンドルするビルドスクリプトを追加する。
- **Rationale**: 高速・設定が単純・VSCode拡張Webviewバンドルの定番手法。tech.mdの「外部ランタイム不要」原則は配布物のエンドユーザー実行に対する制約であり、esbuildは開発時ツールに留まるため抵触しない。
- **Trade-offs**: 新規devDependency追加。
- **Follow-up**: なし。

## Risks & Mitigations
- 大規模モノレポでのグラフノード数増大によるレンダリング性能劣化 — depth=function時のみ全関数ノードを表示し、depth=route/fileではノード数を絞ることで緩和。将来的な仮想化/ページングは再検証トリガーとして design.md に記録。
- `analyzeBackend`(非同期・WASM初期化)の初回解析レイテンシ — `vscode.window.withProgress`で進行状況を明示し、UXの不透明感を緩和(Req2.4)。
- Webviewバンドル(Cytoscape.js)の肥大化 — 現状スケールでは許容範囲。将来増大した場合はコード分割を再検証トリガーとして記録。

## References
- VSCode Webview API(公式ドキュメント知識): CSP/nonce、`asWebviewUri`、`localResourceRoots`、`postMessage`パターン
- Cytoscape.js 公式ドキュメント(MITライセンス、`cy.elements()`/`cy.on('tap', ...)` API)
