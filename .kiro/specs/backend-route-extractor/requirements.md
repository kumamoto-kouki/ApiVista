# Requirements Document

## Project Description (Input)
ApiVista のグラフ可視化機能(vscode-extension-ui)とルート連携エンジン(route-linkage-engine)は、FastAPIバックエンドの「どのルートがどのパス/methodで定義され、内部でどのファイル・関数を呼び出しているか」という構造化データを必要とする。これが無いと、連携判定も可視化も実現できない。

greenfieldであり、対象プロジェクト(`backend/` 配下のFastAPIコード)を解析する仕組みは存在しない。

`backend/` 配下のPythonソースコードを静的解析(AST)し、以下を構造化データとして出力できるようにする:
- FastAPIのルート定義一覧(HTTPメソッド、パス、ハンドラ関数、関連するOpenAPI/Pydanticスキーマへの参照)
- ルートハンドラからの呼び出しグラフ(ファイル単位・関数単位の2レベル)

出力データは route-linkage-engine と vscode-extension-ui が共通スキーマとして利用できる形式(JSON等)とする。

PythonのASTモジュール(またはそれに準ずる静的解析手法)を用いて、FastAPIのデコレータ(`@app.get`, `@router.post` 等)からルート定義を抽出し、ハンドラ関数本体を再帰的に解析して呼び出しグラフ(ファイル間・関数間)を構築するアプローチを想定する。

### Scope
- **In**: FastAPIルートデコレータの検出とパス/method/ハンドラ関数の抽出、ハンドラが参照するPydanticモデル(リクエスト/レスポンス)などOpenAPIスキーマ関連情報の抽出、ハンドラ関数を起点としたファイル単位・関数単位の呼び出しグラフ構築(静的解析)、抽出結果を構造化データ(JSON等)として出力するインターフェース
- **Out**: 動的解析・実行時トレース、フロントエンド側の解析(frontend-call-extractorが担当)、連携マッチングロジック(route-linkage-engineが担当)、VSCode拡張UIやWebview描画(vscode-extension-uiが担当)

### Constraints
- 対象は `backend/` ディレクトリ配下のFastAPI(Python)コードを前提とする
- 静的解析のみで、対象プロジェクトの実行・依存パッケージのインストールは不要であることが望ましい
- 出力データスキーマは route-linkage-engine と vscode-extension-ui(3階層表示: ルート連携/ファイル単位/関数単位)双方の要件を満たす設計とする

## Introduction
Backend Route Extractorは、FastAPIバックエンド(`backend/`配下)のPythonソースコードを静的解析し、ルート定義(HTTPメソッド・URLパス・ハンドラ関数)、関連するスキーマ参照、およびハンドラを起点とするファイル単位・関数単位の呼び出しグラフを構造化データとして出力する。この出力データは、route-linkage-engineによる連携マッチングおよびvscode-extension-uiによる3階層(ルート連携/ファイル単位/関数単位)可視化の入力契約として利用される。

## Boundary Context
- **In scope**: `backend/`配下のFastAPIルート定義の抽出(デコレータ方式、`include_router`のprefix結合による完全パス算出を含む)、ルートハンドラに関連するリクエスト/レスポンスモデルの参照抽出、ハンドラを起点とした`backend/`内コードのファイル単位・関数単位の呼び出しグラフ構築、これらを統合した構造化データの出力
- **Out of scope**: フロントエンド側コードの解析(frontend-call-extractorが担当)、ルートと呼び出しの連携マッチング(route-linkage-engineが担当)、UI/Webviewでの可視化(vscode-extension-uiが担当)、動的解析・実行時トレース、デコレータ方式以外のプログラム的ルート登録(`add_api_route`等)、`backend/`外(標準ライブラリ・外部パッケージ)への呼び出し追跡
- **Adjacent expectations**: 出力データのスキーマは、route-linkage-engineの入力契約およびvscode-extension-uiの3階層表示要件を満たすことが前提となる。frontend-call-extractorの出力と対称的な構造を持つことが期待される

## Requirements

### Requirement 1: ルート定義の抽出
**Objective:** As a route-linkage-engineおよびvscode-extension-uiの開発者, I want FastAPIのルート定義(HTTPメソッド・完全なURLパス・ハンドラ関数)を構造化データとして取得したい, so that フロントエンドとの連携判定やグラフ可視化の入力として利用できる

#### Acceptance Criteria
1. When `backend/`配下のPythonファイルに`@app.get`/`@app.post`/`@router.get`等のFastAPIルートデコレータが存在する場合, the Backend Route Extractor shall そのHTTPメソッド・パス文字列・ハンドラ関数を抽出する
2. When ルートが`include_router`を介してprefix付きで登録されている場合, the Backend Route Extractor shall そのprefixを結合した完全なURLパスを算出する
3. While 複数ファイルにわたるrouter登録チェーンが存在する, the Backend Route Extractor shall そのチェーンを解決し、各ルートの最終的な完全パスに反映する
4. The Backend Route Extractor shall デコレータ方式以外のプログラム的なルート登録を抽出対象としない

### Requirement 2: スキーマ参照の抽出
**Objective:** As a route-linkage-engineの開発者, I want 各ルートに関連するリクエスト/レスポンスモデルの参照情報を取得したい, so that OpenAPIスキーマ照合による連携の補強に利用できる

#### Acceptance Criteria
1. When ルートハンドラの引数またはレスポンスにPydanticモデル型が指定されている場合, the Backend Route Extractor shall そのモデルのクラス名と定義位置(ファイルパス)を当該ルートに関連付けて出力する
2. If ルートハンドラにリクエスト/レスポンスモデルの型情報が指定されていない場合, then the Backend Route Extractor shall 当該ルートのスキーマ参照を空として出力する

### Requirement 3: 呼び出しグラフの抽出
**Objective:** As a vscode-extension-uiの開発者, I want 各ルートハンドラを起点としたファイル単位・関数単位の呼び出しグラフを取得したい, so that 表示深度に応じた3階層の可視化が可能になる

#### Acceptance Criteria
1. When ルートハンドラ関数が解析される場合, the Backend Route Extractor shall そのハンドラが直接・間接的に呼び出す`backend/`配下の関数を再帰的に追跡し、関数単位の呼び出しグラフを構築する
2. The Backend Route Extractor shall 関数単位の呼び出しグラフから、各呼び出し先関数が定義されているファイルを集約したファイル単位の呼び出しグラフを導出する
3. If 呼び出し先の関数またはモジュールが`backend/`ディレクトリ外(標準ライブラリや外部パッケージ等)に存在する場合, then the Backend Route Extractor shall その呼び出しを呼び出しグラフの終端として扱い、それ以上の追跡を行わない

### Requirement 4: 構造化データ出力
**Objective:** As route-linkage-engineおよびvscode-extension-uiの開発者, I want ルート定義・スキーマ参照・呼び出しグラフを統合した3階層対応の構造化データを取得したい, so that 連携マッチングと深度切り替え可視化の双方の入力として利用できる

#### Acceptance Criteria
1. The Backend Route Extractor shall 抽出した全てのルート定義・スキーマ参照・呼び出しグラフ(ファイル単位・関数単位)を1つの構造化データセットとして出力する
2. The Backend Route Extractor shall 出力データにおいて、各ルートをルート連携(階層1)・ファイル単位(階層2)・関数単位(階層3)のいずれの階層からも参照できる形式で表現する
3. While 出力データセットが生成される, the Backend Route Extractor shall 抽出した各ルート・ファイル・関数をソースコード上の位置(ファイルパスおよび行番号)と関連付ける

### Requirement 5: エラーハンドリングと部分実行
**Objective:** As a開発者, I want 一部のファイルに問題があっても抽出処理全体が継続されることを期待する, so that 大規模なコードベースでも実用的な結果が得られる

#### Acceptance Criteria
1. If 解析対象のPythonファイルに構文エラーが含まれる場合, then the Backend Route Extractor shall 当該ファイルの解析をスキップし、他のファイルの解析を継続する
2. If ルートのパス文字列が静的に解決できない(動的に生成される)場合, then the Backend Route Extractor shall 当該ルートを抽出結果から除外し、解析を継続する
3. When ファイルまたはルートが解析対象から除外された場合, the Backend Route Extractor shall その除外理由を含む警告情報を出力データに記録する

### Requirement 6: 実行範囲とスコープ
**Objective:** As an operator, I want 抽出処理が`backend/`ディレクトリと静的解析のみに限定されることを期待する, so that 実行結果が予測可能で安全である

#### Acceptance Criteria
1. The Backend Route Extractor shall `backend/`ディレクトリ配下のPythonソースファイルのみを解析対象とする
2. The Backend Route Extractor shall 対象プロジェクトのコードを実行せず、静的解析のみによって抽出処理を行う
3. The Backend Route Extractor shall 対象プロジェクトの依存パッケージのインストールを抽出処理の前提条件としない
