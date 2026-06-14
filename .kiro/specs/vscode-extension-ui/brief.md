# Brief: vscode-extension-ui

## Problem
route-linkage-engine が生成する「バックエンドルート⇄フロントエンドAPI呼び出し」の連携データと3階層(ルート連携/ファイル単位/関数単位)の呼び出しグラフは、開発者がVSCode上で直感的に閲覧・ナビゲートできなければ価値を持たない。これを可視化し、ソースコードへのジャンプを提供するVSCode拡張機能本体が必要。

## Current State
greenfieldであり、VSCode拡張のプロジェクト構造・アクティベーション・Webview等は何も存在しない。

## Desired Outcome
VSCode拡張機能として以下を提供する:
- ワークスペース内の `backend/`・`frontend/` をスキャンし、各抽出器(backend-route-extractor / frontend-call-extractor)とrroute-linkage-engineを実行して連携データを取得
- Webview上にグラフ/ダイアグラム形式で連携関係を描画
- 表示深度を3段階(ルート連携 / ファイル単位 / 関数単位)で切り替え可能なUI操作
- グラフ上のノード(ルート・ファイル・関数)をクリックすると対応するソースコードの該当箇所にジャンプ
- ソースコード変更時にファイル監視で再解析・再描画を行う(または再解析コマンドを提供)

## Approach
TypeScriptでVSCode拡張を実装し、拡張のアクティベーション時にワークスペースをスキャン。route-linkage-engineの出力(3階層データ)を受け取り、Webview内でグラフ描画ライブラリ(例: Cytoscape.js等、設計フェーズで選定)を用いて深度切り替え可能なグラフUIをレンダリングする。グラフ上のノードクリックで `vscode.window.showTextDocument` 等を用いてソースジャンプを実現する。

## Scope
- **In**:
  - VSCode拡張のアクティベーション・コマンド登録(再解析・グラフ表示コマンド等)
  - ワークスペーススキャンとファイル監視
  - route-linkage-engine(およびその上流の抽出器)の実行・呼び出し
  - Webviewによるグラフ/ダイアグラム描画(グラフ描画ライブラリの選定を含む)
  - 深度切り替えUI(ルート連携/ファイル単位/関数単位の3階層)
  - グラフノードからソースコードへのジャンプ機能
- **Out**:
  - ルート・呼び出し情報の抽出ロジック自体(backend-route-extractor / frontend-call-extractorが担当)
  - 連携マッチングロジック自体(route-linkage-engineが担当)
  - 動的解析・実行時トレース

## Boundary Candidates
- 拡張本体(アクティベーション・コマンド・ワークスペーススキャン・ファイル監視)
- Webviewグラフ描画(深度切り替え含む)
- ソースジャンプ機能

## Out of Boundary
- 各抽出器・連携エンジンの解析ロジック自体(他3スペックが担当。本スペックはそれらを呼び出す側)

## Upstream / Downstream
- **Upstream**: route-linkage-engine(統合データを直接の入力として使用。間接的にbackend-route-extractor / frontend-call-extractorに依存)
- **Downstream**: なし(エンドユーザー向けの最終提供物)

## Existing Spec Touchpoints
- **Extends**: なし(新規スペック)
- **Adjacent**: route-linkage-engine(入力データスキーマの契約元)

## Constraints
- VSCode拡張機能(TypeScript)として実装する
- 対象プロジェクトはモノレポ構成(`frontend/` + `backend/`)を前提とする
- グラフ描画はWebview内で行い、3階層の深度切り替えに対応すること

## Design Phase Note
- WebviewのUI/グラフ描画(配色・タイポグラフィ・ノード/エッジのスタイル規約等)は、汎用デザインシステム(DESIGN.md的な固定パレット)ではなく、VSCodeのテーマCSS変数(`--vscode-editor-background`等)を前提とした軽量な設計指針として、本specの設計フェーズ(`/kiro-spec-design`)で検討する
- Webview検証方針はブラウザを使用せずVSCode上で完結させる:
  - 拡張本体(アクティベーション・コマンド登録・ワークスペーススキャン・ファイル監視)の統合テストは`@vscode/test-electron`(実VSCode/Electronを起動する公式テストランナー)で行う
  - Webview内のグラフ描画・深度切り替えロジックは、`acquireVsCodeApi`をモックした`vitest`+`jsdom`環境での単体テストとして検証する
  - ブラウザ操作によるE2E(Playwright等)は採用しない。VSCode拡張のWebviewはブラウザではなくElectron内でホストされるため、ブラウザE2Eは実環境との差異が大きく不要と判断
