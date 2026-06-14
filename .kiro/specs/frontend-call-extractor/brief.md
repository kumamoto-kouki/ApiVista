# Brief: frontend-call-extractor

## Problem
ApiVista のグラフ可視化機能(vscode-extension-ui)とルート連携エンジン(route-linkage-engine)は、Nuxt.jsフロントエンドの「どのコード(コンポーネント/composable)がどのURL/methodでAPIを呼び出し、内部でどのファイル・関数を経由しているか」という構造化データを必要とする。これが無いと、バックエンドルートとの連携判定も可視化も実現できない。

## Current State
greenfieldであり、対象プロジェクト(`frontend/` 配下のNuxt.jsコード)を解析する仕組みは存在しない。

## Desired Outcome
`frontend/` 配下のVue/TS/JSソースコードを静的解析し、以下を構造化データとして出力できる:
- API呼び出し一覧(`$fetch`/`useFetch`/axios等によるHTTPメソッド・URLパス・呼び出し元のファイル/関数位置)
- API呼び出しに至るまでのファイル単位・関数(コンポーネント/composable)単位の呼び出しグラフ(2レベル)

出力データは backend-route-extractor の出力と対称的なスキーマとし、route-linkage-engine と vscode-extension-ui が共通利用できる形式(JSON等)とする。

## Approach
TypeScript/Vue SFCの静的解析(ASTベース)により、`$fetch`/`useFetch`/axios呼び出しを検出してURL・methodを抽出する。呼び出し元のコンポーネント/composableを起点に、ファイル単位・関数単位の呼び出しグラフを構築する。

## Scope
- **In**:
  - Nuxt.js(Vue3 + `$fetch`/`useFetch`/axios)におけるAPI呼び出しの検出とURL/method/呼び出し元位置の抽出
  - API呼び出しを起点としたファイル単位・関数(コンポーネント/composable)単位の呼び出しグラフ構築(静的解析)
  - 抽出結果を構造化データ(JSON等)として出力するインターフェース(backend-route-extractorと対称的なスキーマ)
- **Out**:
  - 動的解析・実行時トレース
  - バックエンド側の解析(backend-route-extractorが担当)
  - 連携マッチングロジック(route-linkage-engineが担当)
  - VSCode拡張UIやWebview描画(vscode-extension-uiが担当)
  - Nuxt.js以外のフレームワーク対応

## Boundary Candidates
- API呼び出し検出(`$fetch`/`useFetch`/axios呼び出しパターンの解析)
- 呼び出しグラフ抽出(ファイル単位/コンポーネント・関数単位)
- 出力データスキーマ定義(backend-route-extractorとの対称性確保)

## Out of Boundary
- route-linkage-engineが行う連携マッチングロジック
- vscode-extension-uiが行うUI/Webview表示・深度切り替え・ファイル監視

## Upstream / Downstream
- **Upstream**: なし(対象プロジェクトのVue/TS/JSソースコードを直接読み込む)
- **Downstream**: route-linkage-engine(抽出データを連携マッチングの入力として使用)、vscode-extension-ui(深度切り替え表示の入力として使用)

## Existing Spec Touchpoints
- **Extends**: なし(新規スペック)
- **Adjacent**: backend-route-extractor(同様の役割をバックエンド側で担う。出力データスキーマの設計方針を揃える必要がある)、route-linkage-engine(本スペックの出力スキーマがそのまま入力契約となる)

## Constraints
- 対象は `frontend/` ディレクトリ配下のNuxt.js(Vue3)コードを前提とする
- 静的解析のみで、対象プロジェクトの実行・依存パッケージのインストールは不要であることが望ましい
- 出力データスキーマは backend-route-extractor の出力と対称的に設計し、route-linkage-engine と vscode-extension-ui(3階層表示)双方の要件を満たすこと

## Design Phase Note
- WebAssembly(`@vscode/wasm-wasi`)化は再検討の上、不採用とする
  - 理由1: `@vscode/wasm-wasi`(WASI based WebAssembly Execution Engine)は現時点でもexperimental/pre-releaseであり、Web版VSCode拡張での有効化に既知の問題が報告されている。VSCode公式ブログでもproduction向け拡張での使用は推奨されていない
  - 理由2: 本解析処理はts-morph(Node.jsライブラリ)ベースであり、VSCode拡張ホスト(Node.js/Electron)上でネイティブに動作する。追加構成なしに「VSCode上で完結」という目標を既に満たしているため、WASM化のメリットは薄い
  - vscode.dev等のWeb版VSCode拡張対応が将来的にスコープに入った場合のみ、`@vscode/wasm-wasi`の成熟度を再確認の上で再検討する
