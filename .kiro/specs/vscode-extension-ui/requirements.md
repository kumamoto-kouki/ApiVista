# Requirements Document

## Project Description (Input)
vscode-extension-ui は、ApiVista の最終提供物となるVSCode拡張機能本体である。

- **誰が困っているか**: モノレポ(`backend/` = FastAPI、`frontend/` = Nuxt.js)を保守する開発者。route-linkage-engine が生成する「バックエンドルート⇄フロントエンドAPI呼び出し」の連携データと3階層(ルート連携/ファイル単位/関数単位)の呼び出しグラフは、VSCode上で直感的に閲覧・ナビゲートできなければ価値を持たない。
- **現状(greenfield)**: VSCode拡張のプロジェクト構造・アクティベーション・Webview等は何も存在しない。`package.json` にも拡張マニフェスト(`engines.vscode`/`main`/`contributes`/`activationEvents`)が未設定。
- **何を変えるか**: ワークスペース内の `backend/`・`frontend/` をスキャンし、各抽出器(backend-route-extractor / frontend-call-extractor)と route-linkage-engine を実行して連携データを取得し、Webview上にグラフ/ダイアグラム形式で描画する。表示深度を3段階(ルート連携/ファイル単位/関数単位)で切り替え可能にし、グラフ上のノードクリックで対応するソースコードへジャンプできるようにする。ソースコード変更時の再解析(ファイル監視または再解析コマンド)も提供する。

実装方針(steering [tech.md](../../steering/tech.md) に準拠): TypeScript で実装し、VSCode 拡張ホスト(Node/Electron)上で動作させる。Webview描画ライブラリの選定は設計フェーズで行う。検証はブラウザを使用せず、拡張本体は `@vscode/test-electron`、Webview内ロジックは vitest + jsdom(`acquireVsCodeApi` モック)で行う。

## Introduction
vscode-extension-ui は、backend-route-extractor / frontend-call-extractor / route-linkage-engine が生成する3階層の連携データを、VSCode上でアクティベート可能な拡張機能として可視化する。ワークスペースのスキャンと解析実行、Webview上でのグラフ描画と深度切り替え、グラフノードからのソースジャンプ、ソースコード変更に追従した再解析(自動ファイル監視と手動コマンドの両方)、解析時の警告・失敗の可視化を提供する。本スペックはVSCode拡張本体とWebview UIの責務を持ち、抽出・連携マッチングのロジック自体は持たない(各上流スペックの責務)。

## Boundary Context
- **In scope**: 拡張機能のアクティベーション・コマンド登録、単一ルートワークスペース(`backend/`・`frontend/` を直下に持つ前提)のスキャンと解析実行(各抽出器 + route-linkage-engine の呼び出し)、Webview上での3階層(ルート連携/ファイル単位/関数単位)グラフ描画と深度切り替え、グラフノードからのソースジャンプ、ソースコード変更に対する自動ファイル監視による再解析と、ユーザーが明示的に実行できる再解析コマンドの両方、解析中の警告(warnings)および解析失敗のUI上での可視化
- **Out of scope**: バックエンド/フロントエンドのルート・呼び出し抽出ロジック自体(backend-route-extractor / frontend-call-extractor が担当)、連携マッチングロジック自体(route-linkage-engine が担当)、動的解析・実行時トレース、マルチルートワークスペース(複数ワークスペースフォルダ)対応
- **Adjacent expectations**: 入力契約は route-linkage-engine の `LinkageOutput`(`schemaVersion=1`)であり、本拡張はそのスキーマに依存する。本拡張は対象プロジェクトのソースコードを実行せず、各抽出器・route-linkage-engine が返す解析結果のみを用いる。ワークスペースルート直下に `backend/`・`frontend/` ディレクトリが存在することを前提とし、見つからない場合はエラー表示で利用者に通知する(マルチルートワークスペースは非対応として明示する)。

## Requirements

### Requirement 1: 拡張機能のアクティベーションとコマンド登録
**Objective:** As a ApiVistaを利用する開発者, I want VSCode上で拡張機能を有効化しコマンドにアクセスしたい, so that 追加のセットアップなしに連携可視化機能を使い始められる

#### Acceptance Criteria
1. When ユーザーがワークスペースを開く, the ApiVista拡張機能 shall アクティベートする
2. The ApiVista拡張機能 shall 連携グラフを表示するコマンドをコマンドパレットに登録する
3. The ApiVista拡張機能 shall 再解析を実行するコマンドをコマンドパレットに登録する

### Requirement 2: ワークスペーススキャンと解析実行
**Objective:** As a 開発者, I want ワークスペース内のbackend/frontendコードを解析し連携データを取得したい, so that 各解析ツールを個別に手動実行する手間なく連携状況を把握できる

#### Acceptance Criteria
1. When ユーザーが連携グラフ表示コマンドを実行する, the ApiVista拡張機能 shall ワークスペースルート直下の `backend/`・`frontend/` ディレクトリを対象に各抽出器と route-linkage-engine を実行し、連携データを取得する
2. If ワークスペースルート直下に `backend/` または `frontend/` ディレクトリが見つからない場合, then the ApiVista拡張機能 shall エディタ内にエラーメッセージを表示する
3. The ApiVista拡張機能 shall 対象プロジェクトのソースコードを実行せず、各抽出器・route-linkage-engine が返す静的解析結果のみを用いて連携データを構築する
4. While 解析処理が実行中である間, the ApiVista拡張機能 shall 解析が進行中であることをユーザーに示す
5. Where ワークスペースが複数のワークスペースフォルダ(マルチルート)で構成されている場合, the ApiVista拡張機能 shall その構成を対象としない(単一ルートワークスペースのみを対象とする)

### Requirement 3: 3階層グラフ可視化
**Objective:** As a 開発者, I want ルート連携・ファイル単位・関数単位の呼び出し関係をグラフとして閲覧したい, so that バックエンドとフロントエンドの繋がりを直感的に理解できる

#### Acceptance Criteria
1. When 解析が成功する, the ApiVista拡張機能 shall 連携データをWebview上にグラフ/ダイアグラムとして描画する
2. The ApiVista拡張機能 shall ルート連携・ファイル単位・関数単位の3階層をグラフ上で表現する
3. While 連携データに未連携のルートまたはAPI呼び出しが含まれている間, the ApiVista拡張機能 shall それらをグラフ上で他の連携済みノードと区別可能な形で表示する

### Requirement 4: 表示深度の切り替え
**Objective:** As a 開発者, I want グラフの表示深度をルート連携/ファイル単位/関数単位の3段階で切り替えたい, so that 必要な詳細度で連携関係を確認できる

#### Acceptance Criteria
1. The ApiVista拡張機能 shall ルート連携/ファイル単位/関数単位の3段階を切り替える操作をWebview上に提供する
2. When ユーザーが深度切り替え操作を行う, the ApiVista拡張機能 shall 選択された深度に応じたグラフを再描画する

### Requirement 5: ソースジャンプ
**Objective:** As a 開発者, I want グラフ上のノードをクリックして対応するソースコードへ移動したい, so that 連携関係の実装箇所を即座に確認できる

#### Acceptance Criteria
1. When ユーザーがグラフ上のノード(ルート・ファイル・関数のいずれか)をクリックする, the ApiVista拡張機能 shall 対応するソースコードの該当箇所をエディタで開く
2. If クリックされたノードに対応するソース位置が解析結果に存在しない、またはそのファイルを開けない場合, then the ApiVista拡張機能 shall エラーメッセージを表示する

### Requirement 6: 再解析(自動ファイル監視と手動コマンド)
**Objective:** As a 開発者, I want ソースコード変更後に連携データを最新化したい, so that 表示しているグラフが常に実際のコードと一致した状態を保てる

#### Acceptance Criteria
1. When `backend/` または `frontend/` 配下のソースファイルが保存される, the ApiVista拡張機能 shall 自動的に再解析を実行する
2. When ユーザーが再解析コマンドを実行する, the ApiVista拡張機能 shall ワークスペースを再解析し、表示中のグラフを更新する
3. While 短時間内に複数回のソースファイル保存が連続する間, the ApiVista拡張機能 shall 重複した再解析を行わず、最新のソース状態を反映した解析結果を1回提示する

### Requirement 7: 警告・エラーの可視化
**Objective:** As a 開発者, I want 解析中に検出された警告や失敗を把握したい, so that 連携データの欠落や不完全な抽出に気づける

#### Acceptance Criteria
1. If 抽出器または route-linkage-engine が警告(warnings)を伴う解析結果を返す場合, then the ApiVista拡張機能 shall その警告をUI上で視認可能な形で表示する
2. If 解析処理自体が失敗する場合, then the ApiVista拡張機能 shall エディタ内にエラーメッセージを表示する
3. While 連携データの一部(ルートまたはAPI呼び出し)が未連携である間, the ApiVista拡張機能 shall 解析全体を失敗とせず、連携できた範囲のグラフを表示する

### Requirement 8: 実行環境制約
**Objective:** As an ApiVistaの利用者, I want 拡張機能を導入するだけで動作することを期待する, so that 追加のランタイムインストールなしに全環境で利用できる

#### Acceptance Criteria
1. The ApiVista拡張機能 shall 利用者環境への外部の言語ランタイムまたはパッケージマネージャの別途インストールを必要とせずに動作する
2. The ApiVista拡張機能 shall 対象プロジェクトのコードを実行せず、静的解析結果のみを用いて動作する
