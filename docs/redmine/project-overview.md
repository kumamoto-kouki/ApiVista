# ApiVista 概要

> このページの内容は、Redmineの「ApiVista」プロジェクトのWiki「概要」ページに貼り付けることを想定しています。

## プロジェクトの目的

ApiVistaは、モノレポ構成(`backend/` にFastAPI、`frontend/` にNuxt.js)を持つプロジェクトを対象に、バックエンドのAPIルートとフロントエンドのAPI呼び出しの連携関係をグラフ/ダイアグラムとしてVSCode上に可視化するVSCode拡張機能です。

ルートレベルの連携だけでなく、ファイル単位・関数単位の呼び出しグラフも抽出し、Webview上で表示深度を3段階(ルート連携 / ファイル単位 / 関数単位)に切り替えながら閲覧できます。連携判定はURLパスの静的文字列マッチングとOpenAPIスキーマ照合のハイブリッド方式で行います。

## スコープ

**含まれるもの**

- FastAPI(Python)のルート定義・関数呼び出しグラフの静的抽出
- Nuxt.js(Vue/TS)のAPI呼び出し(`$fetch`/`useFetch`/axios等)・コンポーネント/関数呼び出しグラフの静的抽出
- URLパス静的マッチング + OpenAPIスキーマ照合によるルート⇄フロントエンド呼び出しの連携構築
- 3階層(ルート連携/ファイル単位/関数単位)のデータモデルと深度切り替え
- VSCode拡張: ワークスペーススキャン、ファイル監視、コマンド、Webviewによるグラフ描画、ソースジャンプ

**含まれないもの**

- 動的解析・実行時トレース(静的解析のみ)
- FastAPI/Nuxt.js以外のフレームワークサポート
- リクエスト/レスポンスの型不一致検出などの品質検証機能

## 技術スタック

- **拡張本体**: TypeScript(VSCode Extension API)
- **バックエンド解析**: TypeScript + web-tree-sitter(WASM、Python文法は `@vscode/tree-sitter-wasm`)による FastAPI/Python の AST解析
- **フロントエンド解析**: TypeScript + ts-morph による Nuxt.js(Vue/TS)の解析
- **フロントエンド解析対象**: Nuxt.js(Vue/TS)
- **実行環境**: 全解析は拡張ホスト(Node/Electron)上で動作し、エンドユーザーに Python/uv 等の外部ランタイムを要求しない
- **ツール構成**: ESLint / Prettier、Vitest(+jsdom)、@vscode/test-electron(テスト)
- **AI開発支援**: Kiro-style Spec-Driven Development、MCPサーバー群(serena/context7/semgrep)

## スペック構成(依存関係順)

プロジェクトは技術領域ごとに4つのスペックに分割されています。

| 順序 | スペック名 | 内容 | 依存 |
| --- | --- | --- | --- |
| 1 | `backend-route-extractor` | FastAPIのPythonコードを TypeScript + web-tree-sitter(WASM)で AST解析し、ルート定義(パス・method・OpenAPIスキーマ参照)とファイル/関数単位の呼び出しグラフを抽出する | なし |
| 2 | `frontend-call-extractor` | Nuxt.jsのVue/TSコードを解析し、API呼び出し(URL・method・呼び出し元位置)とコンポーネント/関数単位の呼び出しグラフを抽出する | なし |
| 3 | `route-linkage-engine` | バックエンド/フロントエンドの抽出結果を受け取り、URLパス静的マッチング+OpenAPIスキーマ照合のハイブリッドでルートとAPI呼び出しを連携付け、3階層のデータモデルを構築する | 1, 2 |
| 4 | `vscode-extension-ui` | VSCode拡張本体(アクティベーション、ワークスペーススキャン、ファイル監視、コマンド)とWebviewによるグラフ可視化(深度切り替え、ソースジャンプ)を実装する | 3 |

抽出器(1, 2)は互いに依存せず並行実装が可能です。

## セットアップ方法

本プロジェクトは単一の VSCode 拡張機能(TypeScript)であり、`npm` で完結します。エンドユーザーに Python/uv 等の外部ランタイムは不要です。

```bash
npm install
```

> 注: backend-route-extractor は TypeScript + web-tree-sitter(WASM)で実装されています(旧 Python 実装は撤去済み)。解析対象の Python ソースは `tests/fixtures/sample_app/` にテスト入力としてのみ存在します。

## 開発の進め方

このプロジェクトはKiro-style Spec-Driven Developmentで進めています。各スペックは以下のフェーズを経て実装されます。

1. Discovery(課題・アプローチの整理)
2. Requirements(要件定義、EARS形式)
3. Design(設計)
4. Tasks(実装タスク分割)
5. Implementation(実装)

詳細は各スペックの `.kiro/specs/{feature}/` 配下のドキュメントを参照してください。
