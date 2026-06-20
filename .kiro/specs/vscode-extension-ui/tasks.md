# Implementation Plan

- [ ] 1. 基盤: 拡張マニフェスト・共有型・統合テスト基盤
- [x] 1.1 package.json拡張マニフェストと新規依存・ビルドスクリプトを追加する
  - `engines.vscode`/`main`/`contributes.commands`(`apivista.showGraph`, `apivista.reanalyze`)/`activationEvents`(`onStartupFinished`)をpackage.jsonに設定する
  - `dependencies`に`cytoscape`、`devDependencies`に`esbuild`・`@types/cytoscape`を追加し、`bundle:webview`スクリプトを`build`から呼び出す
  - `tsconfig.json`の`lib`に`"DOM"`を追加する
  - 観測可能な完了状態: `package.json`の`contributes.commands`に2コマンドが定義され、`npm run build`がエラーなく完走する
  - _Requirements: 1.2, 1.3, 8.1_

- [x] 1.2 拡張⇄Webview間メッセージ型(webviewProtocol)を定義する
  - `HostToWebviewMessage`(`linkageData`)と`WebviewToHostMessage`(`ready`, `nodeClick`)の判別可能合併型を定義する
  - 観測可能な完了状態: 拡張ホスト側・Webview側双方からこの型をimportして`tsc`が型エラーなく完走する
  - _Requirements: 3.1, 5.1_

- [x] 1.3 統合テスト用フィクスチャワークスペースと@vscode/test-electron実行基盤を構築する
  - `backend/`・`frontend/`を直下に持つ単一ルートのフィクスチャワークスペースを用意する(既存`tests/fixtures/sample_app`・`sample_nuxt`相当の構成を組み合わせる)
  - `@vscode/test-electron`のランナースクリプトとmochaベースのテストスイートエントリを構築し、`test:integration`スクリプトを追加する(現状`@vscode/test-electron`はdevDependencyとしてのみ存在し、ランナー・テストスイートは未配線のため新規構築する)
  - 観測可能な完了状態: `test:integration`スクリプトが実VSCodeを起動し、空のテストスイートが正常終了する
  - _Requirements: 1.1, 2.1, 2.2, 2.5, 3.1, 6.1, 6.3_

- [ ] 2. コア: ワークスペーススキャンと解析オーケストレーション
- [x] 2.1 (P) workspaceScannerを実装する
  - 単一ワークスペースフォルダでない場合に`ScopeError`(multi-root)をthrowする
  - `backend/`不在時・`frontend/`不在時にそれぞれ`ScopeError`をthrowする
  - 検証成功時に`backendRoot`/`frontendRoot`の絶対パスを返す
  - 観測可能な完了状態: 単体テストで上記3パターン+正常系が確認できる
  - _Requirements: 2.1, 2.2, 2.5_
  - _Boundary: workspaceScanner_

- [x] 2.2 (P) analysisOrchestratorを実装する
  - `analyzeBackend`(非同期)→`analyzeFrontend`(同期)→`linkRoutes`(同期)の順に呼び出す
  - いずれかがthrowした場合は`AnalysisError`でラップして伝播させる
  - 観測可能な完了状態: 単体テストで呼び出し順序・正常返却・`AnalysisError`ラップが確認できる
  - _Requirements: 2.1, 2.3, 6.2, 8.2_
  - _Boundary: analysisOrchestrator_

- [ ] 3. コア: ソースジャンプとWebviewパネル基盤
- [x] 3.1 (P) sourceJumpを実装する
  - ワークスペース相対パスを絶対URIに変換し`showTextDocument`で開く
  - 該当行へ`Selection`/`revealRange`でジャンプする
  - ファイルを開けない場合はエラーをthrowする
  - 観測可能な完了状態: 単体テストで変換・ジャンプ・エラー伝播が確認できる
  - _Requirements: 5.1, 5.2_
  - _Boundary: sourceJump_

- [ ] 3.2 graphPanelを実装する
  - パネルが無ければ生成、既にあれば`reveal`するシングルトン管理を行う
  - CSP/nonce付きHTMLシェル(webviewHtml)を構築し、`media/webview`を`localResourceRoots`で許可する
  - `LinkageOutput`を`postMessage`で送信し、`nodeClick`受信時に`sourceJump`へ委譲する
  - `sourceJump`が失敗(throw)した場合は`showErrorMessage`を呼び、パネルの表示内容は変更しない
  - 観測可能な完了状態: 単体テストで初回`createWebviewPanel`・2回目`reveal`の分岐、`nodeClick`→`sourceJump`呼び出し、`sourceJump`失敗時の`showErrorMessage`呼び出しが確認できる(vscode APIはモック)
  - _Requirements: 3.1, 5.1, 5.2_
  - _Boundary: graphPanel, webviewHtml_

- [ ] 4. コア: Webview深度投影・UI操作ロジック
- [ ] 4.1 (P) projectDepthを実装する
  - `depth="route"`/`"file"`/`"function"`それぞれのノード/エッジ導出ロジックを実装する(file/functionは連携エッジと構造エッジを統合し重複を除去する)
  - 未連携のルート/API呼び出しを識別フラグ付きで含める
  - 観測可能な完了状態: 単体テストで3深度のノード/エッジ集合・参照整合性・決定的出力が確認できる
  - _Requirements: 3.2, 3.3, 4.2, 7.3_
  - _Boundary: webview/projectDepth_

- [ ] 4.2 (P) depthSwitchControlを実装する
  - 3段階の深度切替UIを提示し選択変更時にコールバックで`Depth`を通知する
  - 観測可能な完了状態: jsdom単体テストで選択変更イベント発火時に正しい`Depth`がコールバックへ渡ることが確認できる
  - _Requirements: 4.1_
  - _Boundary: webview/depthSwitchControl_

- [ ] 4.3 (P) warningsPanelを実装する
  - `Warning[]`の件数・内容を一覧表示する
  - 観測可能な完了状態: jsdom単体テストで0件/複数件それぞれの表示内容が確認できる
  - _Requirements: 7.1_
  - _Boundary: webview/warningsPanel_

- [ ] 5. (P) reanalysisWatcherを実装する
  - グラフパネル生成時に`backend/`・`frontend/`配下の`FileSystemWatcher`を開始し、パネル破棄時に`dispose`する
  - 短時間内の連続保存イベントを1回の再解析に集約する(debounce)
  - 観測可能な完了状態: フェイクタイマーを用いた単体テストで複数イベントの1回集約と`dispose`後の非発火が確認できる
  - _Requirements: 6.1, 6.3_
  - _Depends: 2.2_
  - _Boundary: reanalysisWatcher_

- [ ] 6. extension.tsでアクティベーション・コマンド登録・全コンポーネントの結線を行う
  - activate時に`apivista.showGraph`/`apivista.reanalyze`を登録する
  - `showGraph`実行時に`workspaceScanner`→`withProgress`表示→`analysisOrchestrator`→`graphPanel`生成→`reanalysisWatcher`起動の順で結線する
  - `reanalyze`実行時は`analysisOrchestrator`を再実行し既存パネルを更新する
  - `ScopeError`/`AnalysisError`を`showErrorMessage`で表示し、既存表示があれば保持する
  - 観測可能な完了状態: 単体テストで`showGraph`コマンド実行時の各コンポーネント呼び出し順序、`ScopeError`(backend/frontend不在・マルチルート)発生時の`showErrorMessage`呼び出しと後続処理停止、`AnalysisError`発生時の同様の挙動が確認できる(vscode APIはモック)
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 2.5, 6.2, 7.2_

- [ ] 7. webview/main.tsでWebviewエントリの結線とCytoscape描画を実装する
  - `acquireVsCodeApi`を1度だけ呼び出し`ready`メッセージ送信後に`linkageData`を受信してCytoscapeで初期描画する
  - `projectDepth`/`depthSwitchControl`/`warningsPanel`を結線する
  - ノードクリック時に`sourceLocation`を含む`nodeClick`メッセージをホストへ送信する
  - 再解析後の新しい`linkageData`メッセージ受信時に現在の深度で再描画する
  - 観測可能な完了状態: 目視確認(`/run`等)でグラフ描画・深度切替・ノードクリック送信・警告表示が動作する(Cytoscape初期化はDOM/Canvas依存のため単体テスト対象外、design.md Testing Strategyに明記)
  - _Requirements: 3.1, 4.2, 5.1_

- [ ] 8. 検証: 統合テスト
- [ ] 8.1 アクティベーション・コマンド登録の統合テストを追加する
  - 観測可能な完了状態: テスト実行でコマンドリストに両コマンドが含まれることを確認できる
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 8.2 グラフ表示コマンドのEnd-to-End統合テストを追加する
  - フィクスチャワークスペースで`showGraph`コマンドを実行し、Webviewパネルが生成されることを検証する
  - 観測可能な完了状態: テスト実行でパネルが生成されエラーが発生せず、外部ランタイム無しでNode/Electronのみで完走することを確認できる
  - _Requirements: 2.1, 3.1, 8.1, 8.2_

- [ ] 8.3 異常系(backend/frontend不在・マルチルート)の統合テストを追加する
  - 観測可能な完了状態: `showErrorMessage`が呼ばれグラフパネルが生成されないことを確認できる
  - _Requirements: 2.2, 2.5_

- [ ] 8.4 保存時自動再解析の統合テストを追加する
  - パネル表示中に`backend/`配下のファイルを変更保存し再解析が走り表示が更新されることを検証する
  - 観測可能な完了状態: 保存後に`graphPanel`へ新しい`LinkageOutput`が渡ることを確認できる
  - _Requirements: 6.1, 6.3_

## Implementation Notes
- `@vscode/test-electron`は本リポジトリでこれまで一度も配線されていない(devDependencyとしてのみ存在)。タスク1.3でランナー・テストスイート・フィクスチャワークスペースを新規構築する。
- `analyzeFrontend`は同期、`analyzeBackend`はTRUE非同期(WASM初期化を伴う)。`analysisOrchestrator`はこの非対称性を吸収し、呼び出し順序は`analyzeBackend`→`analyzeFrontend`→`linkRoutes`で統一する。
- Webview側コード(`src/vscode-extension/webview/`)は`vscode`モジュールへの直接importを持たない(プラットフォーム制約上実行時にも不可能)。`webviewProtocol.ts`の型のみ拡張ホスト側と共有する。
- `webview/main.ts`のCytoscape初期化はDOM/Canvas依存のため単体テスト対象外。目視確認(`/run`等)で検証する。
- `tsconfig.json`の`exclude`(`src/**/*.test.ts`/`src/**/__tests__/**`)により、vitestテストファイルは`tsc -p tsconfig.json`では型チェックされない(vitestはesbuildでトランスパイルのみ・型チェックなし)。型の正しさをテストファイル経由で保証したい場合は`tsconfig.typecheck.json`(`noEmit:true`・テスト除外なしで`tsc`)+`npm run typecheck:tests`を使うこと(タスク1.2で新設)。
- `@vscode/test-electron`系のtsconfig派生(`tsconfig.test-electron.json`)は **outDirを本番ビルド(`out/`)と必ず分離する**(`out-test-electron/`)こと。`extends`した子configの`exclude`は親の`exclude`を継承せず完全に上書きするため、子で`exclude`を再定義すると親の除外(`*.test.ts`等)が silently 復活し、同じ`outDir`を共有していると本番ビルドへ漏れ込む(タスク1.3でレビュー3回REJECTの原因)。さらに子configの`include`は対象を最小限に絞り(例: `src/vscode-extension/test/**/*.ts`のみ)、`npm run test:integration`相当のスクリプトには毎回`rm -rf <outDir>`の事前クリーンを入れること(plainな`tsc`は削除されたソースのコンパイル済み出力を自動で消さないため、stale出力が再実行され続ける)。
- `tests/fixtures/vscode_workspace/{backend,frontend}/`は`sample_app`/`sample_nuxt`のコピーで構成した統合テスト専用フィクスチャワークスペース(単一ルート直下にbackend/frontendを持つ構成)。`@vscode/test-electron`のサンドボックス実行には環境依存の対応が必要だった: `libgtk-3.so.0`不足→`apt-get install libgtk-3-0`、ESM環境で`__dirname`不可→`fileURLToPath(import.meta.url)`、シェルの`ELECTRON_RUN_AS_NODE=1`がElectron起動を阻害→spawn前に`delete process.env.ELECTRON_RUN_AS_NODE`、root実行でサンドボックス不可→`process.getuid?.()===0`時のみ`--no-sandbox`付与。
