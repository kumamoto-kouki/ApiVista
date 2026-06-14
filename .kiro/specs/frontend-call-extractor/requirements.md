# Requirements Document

## Project Description (Input)
ApiVista のルート連携エンジン(route-linkage-engine)とグラフ可視化(vscode-extension-ui)は、Nuxt.js フロントエンドの「どのコード(コンポーネント/composable)が、どのURL/HTTPメソッドでAPIを呼び出し、内部でどのファイル・関数を経由しているか」という構造化データを必要とする。これが無いと、バックエンドルートとの連携判定も3階層可視化も実現できない。

現状(greenfield)、対象プロジェクトの `frontend/` 配下の Nuxt.js(Vue3/TS)コードを解析する仕組みは存在しない。

`frontend/` 配下の Vue/TS/JS ソースを静的解析(AST)し、以下を構造化データとして出力できるようにする:
- API呼び出し一覧(`$fetch`/`useFetch`/axios 等による HTTPメソッド・URLパス・呼び出し元のファイル/関数位置)
- API呼び出しに至るまでのファイル単位・関数(コンポーネント/composable)単位の呼び出しグラフ(2レベル)

出力データは backend-route-extractor の出力と**対称的なスキーマ**とし、route-linkage-engine と vscode-extension-ui が共通利用できる形式とする。

実装方針(プロジェクト全体の steering [tech.md](../../steering/tech.md) に準拠): TypeScript + ts-morph(Vue SFC は別途 SFC パースを併用)で実装し、VSCode 拡張ホスト(Node/Electron)上でインプロセス動作させる。エンドユーザーに外部ランタイムの別途インストールを要求しない(「拡張を導入するだけで動作する」)。検証はブラウザを使用せず vitest による単体テストで行う。

### Scope
- **In**: Nuxt.js(Vue3 + `$fetch`/`useFetch`/axios)における API 呼び出しの検出と URL/method/呼び出し元位置の抽出、API呼び出しを起点としたファイル単位・関数(コンポーネント/composable)単位の呼び出しグラフ構築(静的解析)、抽出結果を backend-route-extractor と対称的なスキーマの構造化データとして出力するインターフェース
- **Out**: 動的解析・実行時トレース、バックエンド側の解析(backend-route-extractor が担当)、連携マッチングロジック(route-linkage-engine が担当)、VSCode拡張UIやWebview描画(vscode-extension-ui が担当)、Nuxt.js 以外のフレームワーク対応

### Constraints
- 対象は `frontend/` ディレクトリ配下の Nuxt.js(Vue3)コードを前提とする
- 静的解析のみで、対象プロジェクトの実行・依存パッケージのインストールを抽出処理の前提条件としない
- 抽出器自体の実行に、利用者環境への外部の言語ランタイム・パッケージマネージャの別途インストールを前提としない
- 出力データスキーマは backend-route-extractor の出力と対称的に設計し、route-linkage-engine と vscode-extension-ui(3階層表示)双方の要件を満たすこと

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
