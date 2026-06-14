# Brief: backend-route-extractor

## Problem
ApiVista のグラフ可視化機能(vscode-extension-ui)とルート連携エンジン(route-linkage-engine)は、FastAPIバックエンドの「どのルートがどのパス/methodで定義され、内部でどのファイル・関数を呼び出しているか」という構造化データを必要とする。これが無いと、連携判定も可視化も実現できない。

## Current State
greenfieldであり、対象プロジェクト(`backend/` 配下のFastAPIコード)を解析する仕組みは存在しない。

## Desired Outcome
`backend/` 配下のPythonソースコードを静的解析(AST)し、以下を構造化データとして出力できる:
- FastAPIのルート定義一覧(HTTPメソッド、パス、ハンドラ関数、関連するOpenAPI/Pydanticスキーマへの参照)
- ルートハンドラからの呼び出しグラフ(ファイル単位・関数単位の2レベル)

出力データは route-linkage-engine と vscode-extension-ui が共通スキーマとして利用できる形式(JSON等)とする。

## Approach
TypeScript + web-tree-sitter(WASM版 tree-sitter、Python文法は `@vscode/tree-sitter-wasm`)を用いて、`backend/` 配下のPythonソースを拡張ホスト(Node/Electron)上で静的解析する。FastAPIのデコレータ(`@app.get`, `@router.post` 等)からルート定義を抽出し、ハンドラ関数本体を再帰的に解析して呼び出しグラフ(ファイル間・関数間)を構築する。

## Scope
- **In**:
  - FastAPIルートデコレータの検出とパス/method/ハンドラ関数の抽出
  - ハンドラが参照するPydanticモデル(リクエスト/レスポンス)などOpenAPIスキーマ関連情報の抽出
  - ハンドラ関数を起点としたファイル単位・関数単位の呼び出しグラフ構築(静的解析)
  - 抽出結果を構造化データ(JSON等)として出力するインターフェース
- **Out**:
  - 動的解析・実行時トレース
  - フロントエンド側の解析(frontend-call-extractorが担当)
  - 連携マッチングロジック(route-linkage-engineが担当)
  - VSCode拡張UIやWebview描画(vscode-extension-uiが担当)

## Boundary Candidates
- ルート定義抽出(デコレータ解析)
- 呼び出しグラフ抽出(ファイル単位/関数単位)
- 出力データスキーマ定義

## Out of Boundary
- route-linkage-engineが行う連携マッチングロジック
- vscode-extension-uiが行うUI/Webview表示・深度切り替え・ファイル監視

## Upstream / Downstream
- **Upstream**: なし(対象プロジェクトのPythonソースコードを直接読み込む)
- **Downstream**: route-linkage-engine(抽出データを連携マッチングの入力として使用)、vscode-extension-ui(深度切り替え表示の入力として使用)

## Existing Spec Touchpoints
- **Extends**: なし(新規スペック)
- **Adjacent**: frontend-call-extractor(同様の役割をフロントエンド側で担う。出力データスキーマの設計方針を揃える必要がある)、route-linkage-engine(本スペックの出力スキーマがそのまま入力契約となる)

## Design Phase Note
- 実装方式を Python(libcst)CLI から **TypeScript + web-tree-sitter(WASM)** へ転換した。経緯:
  - 「VSCode上で完結させる / 導入するだけで動く」方針の下、Python CLI はエンドユーザーに Python+uv のインストールを暗黙要求し、frontend-call-extractor(ts-morph/Node ネイティブ)と非対称になるため不採用とした
  - ts-morph は TS/JS 専用で Python を解析できないため、Python 解析には tree-sitter を採用
  - tree-sitter のうち **node-tree-sitter(ネイティブアドオン)は不採用**。VSCode の Electron ABI 向け再ビルドと OS/arch 別プリビルドバイナリ同梱が必須で「導入のみ全OS動作」を壊すため。代わりに **web-tree-sitter(WASM、単一 `.wasm` で全OS同一動作)** を採用(Python文法は `@vscode/tree-sitter-wasm`)
  - この WASM はパーサライブラリであり、別途不採用とした実行ランタイム `@vscode/wasm-wasi` とは別概念で矛盾しない
- この転換により、旧 libcst ベースの design.md(Pass0–2c)・tasks.md・Python実装(`src/apivista_backend_analysis/`)は無効化され、requirements(特に実行範囲)から再設計する。要件の WHAT(ルート/スキーマ/呼び出しグラフ抽出、出力スキーマ)は大半が維持される

## Constraints
- 対象は `backend/` ディレクトリ配下のFastAPI(Python)コードを前提とする
- 静的解析のみで、対象プロジェクトの実行・依存パッケージのインストールは不要であることが望ましい
- 出力データスキーマは route-linkage-engine と vscode-extension-ui(3階層表示: ルート連携/ファイル単位/関数単位)双方の要件を満たす設計とする
- 実装は TypeScript で行い、Python解析は web-tree-sitter(WASM)を用いて拡張ホスト(Node/Electron)上で動作させる。エンドユーザーに Python/uv 等の外部ランタイムやネイティブモジュール再ビルドを要求しない(プロジェクト全体方針は [tech.md](../../steering/tech.md) を参照)
