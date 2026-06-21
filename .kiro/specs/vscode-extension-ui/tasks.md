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

- [x] 3.2 graphPanelを実装する
  - パネルが無ければ生成、既にあれば`reveal`するシングルトン管理を行う
  - CSP/nonce付きHTMLシェル(webviewHtml)を構築し、`media/webview`を`localResourceRoots`で許可する
  - `LinkageOutput`を`postMessage`で送信し、`nodeClick`受信時に`sourceJump`へ委譲する
  - `sourceJump`が失敗(throw)した場合は`showErrorMessage`を呼び、パネルの表示内容は変更しない
  - 観測可能な完了状態: 単体テストで初回`createWebviewPanel`・2回目`reveal`の分岐、`nodeClick`→`sourceJump`呼び出し、`sourceJump`失敗時の`showErrorMessage`呼び出しが確認できる(vscode APIはモック)
  - _Requirements: 3.1, 5.1, 5.2_
  - _Boundary: graphPanel, webviewHtml_

- [ ] 4. コア: Webview深度投影・UI操作ロジック
- [x] 4.1 (P) projectDepthを実装する
  - `depth="route"`/`"file"`/`"function"`それぞれのノード/エッジ導出ロジックを実装する(file/functionは連携エッジと構造エッジを統合し重複を除去する)
  - 未連携のルート/API呼び出しを識別フラグ付きで含める
  - 観測可能な完了状態: 単体テストで3深度のノード/エッジ集合・参照整合性・決定的出力が確認できる
  - _Requirements: 3.2, 3.3, 4.2, 7.3_
  - _Boundary: webview/projectDepth_

- [x] 4.2 (P) depthSwitchControlを実装する
  - 3段階の深度切替UIを提示し選択変更時にコールバックで`Depth`を通知する
  - 観測可能な完了状態: jsdom単体テストで選択変更イベント発火時に正しい`Depth`がコールバックへ渡ることが確認できる
  - _Requirements: 4.1_
  - _Boundary: webview/depthSwitchControl_

- [x] 4.3 (P) warningsPanelを実装する
  - `Warning[]`の件数・内容を一覧表示する
  - 観測可能な完了状態: jsdom単体テストで0件/複数件それぞれの表示内容が確認できる
  - _Requirements: 7.1_
  - _Boundary: webview/warningsPanel_

- [x] 5. (P) reanalysisWatcherを実装する
  - グラフパネル生成時に`backend/`・`frontend/`配下の`FileSystemWatcher`を開始し、パネル破棄時に`dispose`する
  - 短時間内の連続保存イベントを1回の再解析に集約する(debounce)
  - 観測可能な完了状態: フェイクタイマーを用いた単体テストで複数イベントの1回集約と`dispose`後の非発火が確認できる
  - _Requirements: 6.1, 6.3_
  - _Depends: 2.2_
  - _Boundary: reanalysisWatcher_

- [x] 6. extension.tsでアクティベーション・コマンド登録・全コンポーネントの結線を行う
  - activate時に`apivista.showGraph`/`apivista.reanalyze`を登録する
  - `showGraph`実行時に`workspaceScanner`→`withProgress`表示→`analysisOrchestrator`→`graphPanel`生成→`reanalysisWatcher`起動の順で結線する
  - `reanalyze`実行時は`analysisOrchestrator`を再実行し既存パネルを更新する
  - `ScopeError`/`AnalysisError`を`showErrorMessage`で表示し、既存表示があれば保持する
  - 観測可能な完了状態: 単体テストで`showGraph`コマンド実行時の各コンポーネント呼び出し順序、`ScopeError`(backend/frontend不在・マルチルート)発生時の`showErrorMessage`呼び出しと後続処理停止、`AnalysisError`発生時の同様の挙動が確認できる(vscode APIはモック)
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 2.5, 6.2, 7.2_

- [x] 7. webview/main.tsでWebviewエントリの結線とCytoscape描画を実装する
  - `acquireVsCodeApi`を1度だけ呼び出し`ready`メッセージ送信後に`linkageData`を受信してCytoscapeで初期描画する
  - `projectDepth`/`depthSwitchControl`/`warningsPanel`を結線する
  - ノードクリック時に`sourceLocation`を含む`nodeClick`メッセージをホストへ送信する
  - 再解析後の新しい`linkageData`メッセージ受信時に現在の深度で再描画する
  - 観測可能な完了状態: 目視確認(`/run`等)でグラフ描画・深度切替・ノードクリック送信・警告表示が動作する(Cytoscape初期化はDOM/Canvas依存のため単体テスト対象外、design.md Testing Strategyに明記)
  - _Requirements: 3.1, 4.2, 5.1_

- [ ] 8. 検証: 統合テスト
- [x] 8.1 アクティベーション・コマンド登録の統合テストを追加する
  - 観測可能な完了状態: テスト実行でコマンドリストに両コマンドが含まれることを確認できる
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 8.2 グラフ表示コマンドのEnd-to-End統合テストを追加する
  - フィクスチャワークスペースで`showGraph`コマンドを実行し、Webviewパネルが生成されることを検証する
  - 観測可能な完了状態: テスト実行でパネルが生成されエラーが発生せず、外部ランタイム無しでNode/Electronのみで完走することを確認できる
  - _Requirements: 2.1, 3.1, 8.1, 8.2_

- [x] 8.3 異常系(backend/frontend不在・マルチルート)の統合テストを追加する
  - 観測可能な完了状態: `showErrorMessage`が呼ばれグラフパネルが生成されないことを確認できる
  - _Requirements: 2.2, 2.5_

- [x] 8.4 保存時自動再解析の統合テストを追加する
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
- `import type`のみで参照しているモジュールへの相対パスが1階層ズレていても、vitest(esbuildのtranspile-onlyモード)は`import type`をコンパイル前に消去するため**実行時エラーにならずテストは緑のまま**になる(タスク4.1で発覚)。型のみimportを含むファイルを変更した際は、`vitest run`が通っても`npx tsc -p tsconfig.json --noEmit`(および`npm run typecheck:tests`)を必ず実行してパス解決を検証すること。
- `graphPanel.ts`の`showOrReveal`に`onDidDispose?`を追加(タスク6で`reanalysisWatcher`のライフサイクルをパネルに結びつけるための統合変更、既存シングルトン管理ロジックは無変更)。コンポーネントのライフサイクルを別コンポーネントに結びつける必要がある統合タスクでは、既存の承認済みコンポーネントへの**最小限・後方互換な追加**(オプション引数等)は妥当な対応であり、既存テストの再実行で無回帰を確認すること。
- `vi.fn().mockReturnValue(obj)`は呼び出し毎に同一オブジェクト参照を返すため、「2回目以降の呼び出しで別インスタンスが生成され誤った参照がdisposeされる」というクラスのリグレッションをテストが検出できない盲点になりうる(タスク6で発覚、reviewerがmutationテストで検出)。複数回呼ばれる可能性のあるファクトリ関数をモックする際は、`mockImplementation(() => 新規オブジェクト)`で呼び出し毎に別インスタンスを返すようにし、「同一インスタンスが再利用されている」ことを積極的に検証すること。
- `npm run test:integration`は元々`npm run build`を経由せず`out/`(本番ビルド)を再生成しなかったため、ソース変更後にリビルドを忘れると古い`out/vscode-extension/extension.js`に対してテストが偽の成功を返しうる(タスク8.1のレビューでmutation testが最初に偽陰性になったことで発覚)。`test:integration`スクリプトに`npm run build`を追加して修正済み。統合テストの結果を信頼する前提条件として、このスクリプトが常にリビルドしてから実行することを保証しておくこと。
- `@vscode/test-electron`統合テストで`vscode.window.createWebviewPanel(...)`呼び出し後に`vscode.window.tabGroups.all`を即座に検査すると、コマンドハンドラのPromiseが解決していても空配列が返ることがある(レンダラー側のタブUI反映が拡張ホスト側の`createWebviewPanel()`呼び出し完了より遅延するため)。パネル生成を検証する統合テストでは、固定`sleep`ではなく短いポーリング間隔+タイムアウト(例: 100ms間隔・5秒タイムアウト)でタブの出現を待つこと(タスク8.2で発覚)。
- `vscode.workspace.updateWorkspaceFolders(...)`は、先頭フォルダの変更や単一→マルチルートの遷移を行うと**拡張ホストプロセス自体を再起動する**(`@types/vscode`のドキュメントコメントに明記)。`@vscode/test-electron`の1つの`runTests()`セッション内で複数スペックを実行する統合テストでは、異常系(backend/frontend不在・マルチルート等)のワークスペース構成を一時的にシミュレートする際にこのAPIを使うとMochaスイート全体が壊れる。代わりに`Object.defineProperty(vscode.workspace, "workspaceFolders", { get: () => ... })`で`workspaceFolders`プロパティ自体を一時的にモンキーパッチし、`afterEach`で必ず元の値に復元すること(同様に`vscode.window.showErrorMessage`も同じ手法でモンキーパッチしてエラー表示の検証に使える。実VSCode拡張ホスト上のテストはプロダクションコードと同一プロセス・モジュール名前空間で動くため、この手法が成立する。タスク8.3で発覚)。
- **(タスク8.4で発覚・修正済みの本番バグ)** `extension.ts`の`runShowGraph`が`graphPanel.showOrReveal`の戻り値を見ずに毎回`createReanalysisWatcher()`を生成・起動していたため、パネルが既に開いている状態で`apivista.showGraph`を再実行すると(ごく普通のユーザー操作)、新しいwatcherが生成される一方でその`dispose()`はどのパネルの`onDidDispose`にも結線されず`FileSystemWatcher`がリークし、以後のファイル保存ごとに複数のwatcherが並行して再解析・`postLinkageUpdate`を行う不具合があった。`showOrReveal`の戻り値を`void`から`boolean`(true=新規パネル生成、false=既存パネルreveal)に変更し、`extension.ts`は`true`の場合のみwatcherを生成・起動するよう修正した。design.mdのService Interfaceに記載された「`start`はパネル生成時に1回のみ呼ばれる」という前提条件をコード側で機械的に保証する必要がある場合、対象APIの戻り値で生成有無を呼び出し元へ伝える設計が有効。
- **(タスク8.4で発覚・修正済みのharness不具合)** `runTest.ts`が`--user-data-dir`を指定していなかったため、`.vscode-test/user-data`の永続プロファイルのウィンドウ復元機能により`npm run test:integration`の1回の実行で**約7個の拡張ホストプロセスが並行起動**し、同一フィクスチャファイルへ競合書き込みすることでテストの非決定性・fixture汚染を引き起こしていた(タスク8.1〜8.3のレビューで観測された原因不明のログノイズ・間欠的失敗の主要因だったと判明)。`runTest.ts`で`mkdtempSync`による一意な一時ディレクトリを毎回`--user-data-dir`に指定し、`finally`で削除するよう修正(`process.exit()`は`finally`完了後に呼ぶよう順序に注意すること、`finally`内で同期的に`process.exit`すると後続のクリーンアップ処理がスキップされる)。`@vscode/test-electron`を使う統合テストでは**必ず`--user-data-dir`を分離する**こと。
- **(全タスク完了後の`/run`実機確認で発覚・修正済みの不具合)** design.mdが「Cytoscape本体の描画初期化はDOM/Canvas依存のため単体テスト対象外、目視確認で検証する」と明記していた通り、自動テストでは検出できない不具合が実機検証で2件見つかった: (1) `webviewHtml.ts`のCSPが`style-src`に`'unsafe-inline'`を含めておらず、Cytoscapeがcanvasへ設定するインラインstyleがブラウザにブロックされていた、(2) `webview/main.ts`の`#graph`コンテナに明示的な高さが無く(html/body/#appの高さ連鎖も無かったため)0pxに崩れ、要素は生成されても画面に何も見えない状態だった。修正: CSPに`'unsafe-inline'`を追加(scriptは引き続きnonce限定)、`webviewHtml.ts`に`html,body,#app`へ高さ100%を与える`<style>`ブロックを追加、`graphContainer`に`flex:1 1 auto`+`minHeight`+`position:relative`を付与。**Canvas/DOM依存のUIロジックを実装した際は、自動テストが緑でも実機(`xvfb-run`+Playwrightの`_electron`でVSCodeバイナリを直接起動し`--extensionDevelopmentPath`で拡張をロード、コマンドパレットからコマンド実行→スクリーンショット)で目視確認すること。今回はこの実機確認で初めて発覚した。
