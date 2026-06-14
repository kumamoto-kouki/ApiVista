# Brief: route-linkage-engine

## Problem
backend-route-extractor と frontend-call-extractor はそれぞれ独立にバックエンドのルート情報とフロントエンドのAPI呼び出し情報を抽出するが、両者を「どのフロントエンド呼び出しがどのバックエンドルートに対応するか」という連携関係として結びつける仕組みが存在しない。この連携関係こそが、vscode-extension-uiが可視化する中心的なデータとなる。

## Current State
greenfieldであり、抽出データ同士を結びつけるマッチングロジックは存在しない。

## Desired Outcome
backend-route-extractor の出力(ルート定義・OpenAPIスキーマ参照・呼び出しグラフ)と frontend-call-extractor の出力(API呼び出し・呼び出しグラフ)を入力として受け取り、以下を行う:
- URLパスの静的文字列マッチング(パスパラメータを考慮したパターンマッチ)による連携候補の特定
- OpenAPIスキーマ照合による連携の補強・精度向上(ハイブリッド方式)
- ルート連携(階層1)/ファイル単位(階層2)/関数単位(階層3)の3階層で参照可能な統合データモデルの構築
- 統合結果を vscode-extension-ui が利用できる構造化データ(JSON等)として出力

## Approach
両抽出器の出力データ(共通スキーマ)を読み込み、まずURLパス文字列のパターンマッチング(例: `/api/users/{id}` と `/api/users/123` のようなパス変数を考慮)でルート⇄呼び出しの対応候補を抽出する。次にOpenAPIスキーマ情報(存在する場合)を用いて候補の確度を補強・絞り込みする。最終的に、ルートレベルの連携グラフに加えて、各抽出器が提供するファイル/関数呼び出しグラフを統合し、3階層構造のデータを構築する。

## Scope
- **In**:
  - backend-route-extractor / frontend-call-extractor の出力データを入力とするマッチングロジック
  - URLパス静的マッチング(パスパラメータ対応)
  - OpenAPIスキーマ照合によるマッチング補強
  - 3階層(ルート連携/ファイル単位/関数単位)の統合データモデル構築
  - 統合結果の構造化データ出力インターフェース
- **Out**:
  - バックエンド/フロントエンドそれぞれのソースコード解析(各抽出器が担当)
  - VSCode拡張UIやWebview描画、深度切り替えUI(vscode-extension-uiが担当)
  - 動的解析・実行時の連携検証

## Boundary Candidates
- パスマッチングロジック(パスパラメータを含むURLパターンの対応付け)
- OpenAPIスキーマ照合ロジック
- 3階層データモデルの統合・出力スキーマ定義

## Out of Boundary
- 抽出データそのものの生成(2つの抽出器スペックが担当)
- UI表示・深度切り替えの実装(vscode-extension-uiが担当)

## Upstream / Downstream
- **Upstream**: backend-route-extractor(ルート・呼び出しグラフデータ)、frontend-call-extractor(API呼び出し・呼び出しグラフデータ)
- **Downstream**: vscode-extension-ui(統合データを可視化の入力として使用)

## Existing Spec Touchpoints
- **Extends**: なし(新規スペック)
- **Adjacent**: backend-route-extractor、frontend-call-extractor(入力スキーマの契約元)、vscode-extension-ui(出力スキーマの契約先)

## Constraints
- 入力データスキーマは backend-route-extractor / frontend-call-extractor の出力に依存するため、両スペックとの整合性を保つ必要がある
- 出力データスキーマは vscode-extension-ui の3階層表示(深度切り替え)要件を満たす設計とする
- マッチングはハイブリッド(静的パスマッチング + OpenAPI照合)方式を前提とする
- 実装は TypeScript で行い、拡張ホスト(Node/Electron)上で動作させる(外部ランタイム不要)

## Design Phase Note
- 本スペックも VSCode-native 方針に従う: TypeScript/Node ネイティブで実装し、検証は `vitest` による単体テストで行う。ブラウザE2E(Playwright等)・WASI実行ランタイム(`@vscode/wasm-wasi`)は使用しない。プロジェクト全体方針は [tech.md](../../steering/tech.md) を参照
