# Roadmap

## Overview
ApiVista は、モノレポ構成(`backend/` に FastAPI、`frontend/` に Nuxt.js)を持つプロジェクトを対象に、バックエンドのAPIルートとフロントエンドのAPI呼び出しの連携関係をグラフ/ダイアグラムとしてVSCode上に可視化するVSCode拡張機能である。

ルートレベルの連携だけでなく、ファイル単位・関数単位の呼び出しグラフも抽出し、Webview上で表示深度を3段階(ルート連携 / ファイル単位 / 関数単位)に切り替えながら閲覧できるようにする。連携判定はURLパスの静的文字列マッチングとOpenAPIスキーマ照合のハイブリッド方式で行う。

## Approach Decision
- **Chosen**: 技術領域ごとに4スペックへ分割(B案)
  - backend-route-extractor: FastAPIのPythonコードを TypeScript + web-tree-sitter(WASM)で AST解析し抽出
  - frontend-call-extractor: Nuxt.jsのVue/TS解析による抽出
  - route-linkage-engine: ハイブリッドマッチングによる連携構築
  - vscode-extension-ui: 拡張本体+Webviewグラフ表示
- **Why**: Python AST解析、TS/Vue解析、マッチングロジック、VSCode拡張+Webview UIは技術的に独立した領域であり、責任境界が明確で並行実装・個別テストが可能。依存関係も抽出器→連携エンジン→UIの一方向で整理しやすい。
- **Rejected alternatives**:
  - 単一スペックでのMVP構築: タスク数が20を超える見込みで、技術領域差が大きく設計がぼやけるため不採用
  - 垂直スライス先行: 初回実装が後続スペックの境界決定を左右し、設計やり直しコストが発生しやすいため不採用

## Scope
- **In**:
  - FastAPI(Python)ルート定義・関数呼び出しグラフの静的抽出
  - Nuxt.js(Vue/TS)のAPI呼び出し(`$fetch`/`useFetch`/axios等)・コンポーネント/関数呼び出しグラフの静的抽出
  - URLパス静的マッチング + OpenAPIスキーマ照合によるルート⇄フロントエンド呼び出しの連携構築
  - 3階層(ルート連携/ファイル単位/関数単位)のデータモデルと深度切り替え
  - VSCode拡張: ワークスペーススキャン、ファイル監視、コマンド、Webviewによるグラフ描画、ソースジャンプ
- **Out**:
  - 動的解析・実行時トレース(静的解析のみ)
  - FastAPI/Nuxt.js以外のフレームワークサポート
  - リクエスト/レスポンスの型不一致検出などの品質検証機能

## Constraints
- 対象プロジェクト構成はモノレポ(`frontend/` + `backend/`)を前提とする
- 拡張本体・全解析器はTypeScriptで実装するVSCode拡張機能
- 解析は静的解析(AST)のみで、対象プロジェクトの実行は不要
- 全抽出処理は拡張ホスト(Node/Electron)上でネイティブ動作し、エンドユーザーに外部ランタイム(Python/uv)やネイティブモジュール再ビルドを要求しない(「導入するだけで全OS動作」)。FastAPI/Python解析は web-tree-sitter(WASM)、Nuxt/TS解析は ts-morph を用いる。詳細は [tech.md](./tech.md) を参照

## Boundary Strategy
- **Why this split**: 抽出器(Python/TS)、連携エンジン、UIはそれぞれ異なる技術スタック・テスト手法を持つため、独立したスペックとして切り出すことでレビューとテストの境界が明確になる。抽出器2つは互いに依存せず並行実装可能。
- **Shared seams to watch**:
  - 抽出器(spec 1,2)が出力するデータモデル(ルート/呼び出し/呼び出しグラフのスキーマ)は連携エンジン(spec 3)とUI(spec 4)の入力契約となるため、最初に共通スキーマを固めることが重要
  - 深度(3階層)の表現方法は抽出データのスキーマとUIの描画ロジック双方に影響するため、spec 1/2 のデータモデル設計時にUI側の要件(spec 4)を意識する

## Specs (dependency order)
- [ ] backend-route-extractor -- FastAPIのPythonコードを TypeScript + web-tree-sitter(WASM)で AST解析し、ルート定義(パス・method・OpenAPIスキーマ参照)とファイル/関数単位の呼び出しグラフを抽出する。Dependencies: none
- [ ] frontend-call-extractor -- Nuxt.jsのVue/TSコードを解析し、API呼び出し(URL・method・呼び出し元位置)とコンポーネント/関数単位の呼び出しグラフを抽出する。Dependencies: none
- [ ] route-linkage-engine -- バックエンド/フロントエンドの抽出結果を受け取り、URLパス静的マッチング+OpenAPIスキーマ照合のハイブリッドでルートとAPI呼び出しを連携付け、3階層のデータモデルを構築する。Dependencies: backend-route-extractor, frontend-call-extractor
- [ ] vscode-extension-ui -- VSCode拡張本体(アクティベーション、ワークスペーススキャン、ファイル監視、コマンド)とWebviewによるグラフ可視化(深度切り替え、ソースジャンプ)を実装する。Dependencies: route-linkage-engine
