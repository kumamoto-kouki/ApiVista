# Implementation Plan

- [ ] 1. 基盤: プロジェクト構成・出力モデル・テストフィクスチャ
- [x] 1.1 Pythonパッケージのビルド構成とCLIスケルトンを整備する
  - `pyproject.toml`に`[build-system]`(hatchling)・`[tool.hatch.build.targets.wheel]`・`pydantic>=2.12`依存・`[project.scripts]`を設定し、`src/apivista_backend_analysis/`パッケージの初期構成(`__init__.py`)を作成する
  - 観測可能な完了状態: `uv run apivista-backend-analysis --help`がエラーなく実行され、使用方法が表示される
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 1.2 出力モデル・schemaVersion・ID採番ヘルパーを定義する
  - `AnalysisOutput`, `RouteDefinition`, `SchemaReference`(`role: Literal["request","response"]`含む), `FunctionNode`, `FileNode`, `Warning`, `SourceLocation`を`extra="forbid"`で定義し、`schemaVersion=1`を設定する
  - 関数ID(`<module-dotted-path>:<qualname>`)・ファイルID(`backend_root`相対POSIXパス)を導出する採番ヘルパーを実装する
  - 観測可能な完了状態: `AnalysisOutput`の`model_json_schema()`が妥当なJSON Schemaを返し、同一入力に対して採番ヘルパーが決定的に同じIDを返すことを単体テストで確認できる
  - _Requirements: 4.1, 4.2, 4.3, 2.1, 2.2_

- [x] 1.3 エラー・警告コレクターを実装する
  - 構文エラー(`ParserSyntaxError`/`UnicodeDecodeError`)や解析対象外の除外理由を受け取り、`target`/`reason`を持つ`Warning`へ変換するコレクターを実装する
  - 観測可能な完了状態: コレクターに記録したエラー・除外理由が、出力スキーマに沿った`Warning`のリストへ変換されることを単体テストで確認できる
  - _Requirements: 5.1, 5.2, 5.3_

- [ ] 1.4 クロスファイル検証用のFastAPIサンプルアプリ・フィクスチャを作成する
  - `tests/fixtures/sample_app/`に、複数ファイルにわたる`include_router`のprefixチェーン、`FastAPI()`インスタンス、ローカル定義/別ファイルからimportするPydanticモデル(リクエスト/レスポンス双方)、静的に解決できないパスを持つルート、構文エラーを含むファイルを用意する
  - 観測可能な完了状態: 構文エラーファイル以外がlibcstでパース可能であり、後続タスクの検証フィクスチャとして利用できる
  - _Requirements: 1.2, 1.3, 2.1, 5.1, 5.2_

- [ ] 2. モジュールマップ構築(Pass0)を実装する
  - `backend/`配下の`.py`を走査し、モジュールドット表記とファイルパスの対応・公開トップレベル名一覧を構築し、`backend/`配下かどうかを判定するヘルパーを提供する。構文エラーファイルはエラーコレクター経由で警告化しスキップする
  - 観測可能な完了状態: `tests/fixtures/sample_app`に対して実行すると、各モジュールのドット表記とファイルパスの対応が正しく構築され、構文エラーファイルがスキップされて警告が1件記録される
  - _Requirements: 1.3, 3.3, 6.1, 5.1_
  - _Boundary: Module Map Builder_

- [ ] 3. コア: ファイル単位抽出(Pass1)
- [ ] 3.1 (P) ルートデコレータ抽出をデコレータ形状判定とパス解決の2段階で実装する
  - HTTPメソッド名(`get`/`post`/`put`/`delete`/`patch`)に一致する属性呼び出しデコレータのみをルート候補として認識し、プログラム的なルート登録(`add_api_route`等)は対象外とする。第1引数が文字列リテラルであればパス確定、それ以外は未解決候補としてエラーコレクターに警告を記録する
  - 観測可能な完了状態: `sample_app`の動的パスルートが未解決候補として警告に記録され、リテラルパスのルートはメソッド・パス・ハンドラを持つ候補として抽出されることを単体テストで確認できる
  - _Requirements: 1.1, 1.4, 5.2, 5.3_
  - _Boundary: Route and Schema Extractor(ルートデコレータ抽出)_

- [ ] 3.2 (P) router関係と`FastAPI()`インスタンスの抽出を実装する
  - `APIRouter(prefix=...)`定義、`include_router(prefix=...)`呼び出し、および`FastAPI()`/`FastAPI(...)`インスタンス生成を抽出し、`FastAPI()`インスタンスをパス解決のBFS起点候補としてマークする
  - 観測可能な完了状態: `sample_app`に対して実行すると、`FastAPI()`インスタンスが起点候補として識別され、`include_router`のprefix関係を含む関係グラフが構築されることを確認できる
  - _Requirements: 1.2, 1.3_
  - _Boundary: Route and Schema Extractor(router関係抽出)_

- [ ] 3.3 (P) スキーマ参照候補とクラス定義レジストリの抽出を実装する
  - ハンドラの引数アノテーション(リクエスト)・戻り値アノテーション(レスポンス)を解決し、ローカル定義は定義位置を、import由来は完全修飾名を、それぞれ`role="request"`/`"response"`付きの参照候補として記録する。各ファイルのトップレベルクラス定義(クラス名・基底クラス名・定義位置)をレジストリ用に収集する
  - 観測可能な完了状態: `sample_app`に対して実行すると、ローカル定義モデル・別ファイルからimportしたモデルの双方についてrole付きの参照候補が抽出され、トップレベルクラスがレジストリエントリとして収集されることを確認できる
  - _Requirements: 2.1_
  - _Boundary: Route and Schema Extractor(スキーマ参照候補抽出)_

- [ ] 3.4 (P) ハンドラ本体内の呼び出し式抽出を実装する
  - ルートハンドラ本体内の関数呼び出し式を収集し、呼び出しグラフ構築(Pass2b)への中間データとする
  - 観測可能な完了状態: `backend/`内の別関数を呼び出すハンドラに対して実行すると、その呼び出し先を参照する呼び出し式エントリが抽出されることを確認できる
  - _Requirements: 3.1_
  - _Boundary: Route and Schema Extractor(呼び出し式抽出)_

- [ ] 3.5 Pass1の各抽出結果を1ファイル1パスの抽出処理へ統合する
  - `MetadataWrapper`+`ScopeProvider`(`unsafe_skip_copy`)を用いて3.1-3.4の抽出結果をファイル単位の抽出結果(ルート候補・router関係・スキーマ参照候補・クラス定義レジストリ・呼び出し式)にまとめ、構文エラーのあるファイルはエラーコレクターに記録してスキップする
  - 観測可能な完了状態: `sample_app`の全ファイルに対して実行すると、構文エラーファイルが`skipped=True`として警告に記録され、他ファイルはファイル単位の抽出結果を返すことを確認できる
  - _Requirements: 1.1, 1.4, 2.1, 5.1, 5.2, 5.3_
  - _Depends: 3.1, 3.2, 3.3, 3.4_
  - _Boundary: Route and Schema Extractor_

- [ ] 4. コア: クロスファイル解決(Pass2a/2b/2c)
- [ ] 4.1 (P) `FastAPI()`起点のルートパス解決を実装する
  - router関係グラフから`FastAPI()`インスタンスをBFS起点として一意に特定し(0件/2件以上は警告として全ルート未確定扱い)、`include_router`のprefixを連結して完全URLパスを算出する。循環は検出し無限ループしない。確定したルートには採番ヘルパーで`entryFunctionId`を設定する
  - 観測可能な完了状態: `sample_app`に対して実行すると、prefixチェーンに基づく完全パスを持つルート定義が生成され、チェーンが確定できないルートは警告付きで結果から除外されることを確認できる
  - _Requirements: 1.2, 1.3, 5.2, 5.3_
  - _Depends: 3.5_
  - _Boundary: Route Path Resolver_

- [ ] 4.2 (P) 関数単位・ファイル単位の呼び出しグラフ構築を実装する
  - ルートハンドラを起点に、モジュールマップを用いて呼び出し式を解決しながら関数単位の呼び出しグラフを再帰構築する(`backend/`外への呼び出しは終端、循環呼び出しは1回のみ訪問)。関数単位グラフからファイル単位の依存グラフを導出する。各ノードIDは採番ヘルパーで設定する
  - 観測可能な完了状態: `sample_app`に対して実行すると、ハンドラから別関数への呼び出しが関数単位グラフのエッジとして表現され、外部ライブラリへの呼び出しは関数ノードに追加されず、ファイル単位の依存グラフが正しく導出されることを確認できる
  - _Requirements: 3.1, 3.2, 3.3_
  - _Depends: 3.5_
  - _Boundary: Call Graph Builder_

- [ ] 4.3 (P) クロスファイルのスキーマ参照解決を実装する
  - スキーマ参照候補とクラス定義レジストリ・モジュールマップを用い、import由来の候補を定義位置に解決する。基底クラスが`BaseModel`(レジストリ内で推移的に到達する場合も含む)である候補のみ`SchemaReference`として確定し、解決不能な候補は警告に記録してハンドラの`schemaRefs`を空にする
  - 観測可能な完了状態: `sample_app`の、別ファイルで定義されたリクエストモデルを参照するハンドラについて、`className`・定義位置・`role`が解決され、モデル型注釈のないハンドラは`schemaRefs`が空になることを確認できる
  - _Requirements: 2.1, 2.2, 5.3_
  - _Depends: 3.5_
  - _Boundary: Schema Reference Resolver_

- [ ] 5. 統合: 出力アセンブリとCLI
- [ ] 5.1 各パスの結果を統合する出力アセンブラを実装する
  - ルート定義(4.1)・スキーマ参照(4.3、ハンドラIDでマージ)・呼び出しグラフ/ファイルグラフ(4.2)・警告を`AnalysisOutput`(schemaVersion含む)へ統合する
  - 観測可能な完了状態: `sample_app`に対して実行すると、`routes[].schemaRefs`が`entryFunctionId`に基づいて正しくマージされ、`routes[].entryFunctionId` → `functions[].id` → `functions[].file` → `files[].id`の参照が全て解決できることを確認できる
  - _Requirements: 4.1, 4.2, 4.3_
  - _Depends: 4.1, 4.2, 4.3_
  - _Boundary: Output Assembler_

- [ ] 5.2 stdout/stderr/終了コード契約に従うCLIエントリポイントを実装する
  - `<backend-dir> [--output-file <path>]`を受け取り、Pass0-2とアセンブラを順に実行する。stdoutには`AnalysisOutput`のJSONのみを出力(または`--output-file`に書き出し)、ログはstderrへ出力する。存在しない/ディレクトリでない引数は非0終了、解析自体が実行できた場合は警告を含んでいても終了コード0とする
  - 観測可能な完了状態: `apivista-backend-analysis tests/fixtures/sample_app`を実行すると終了コード0で単一のJSONオブジェクトがstdoutに出力され、構文エラーファイルと未解決ルートに対応する警告が含まれることを確認できる
  - _Requirements: 6.1, 6.2, 6.3, 5.1_
  - _Depends: 5.1_
  - _Boundary: CLI Entrypoint_

- [ ] 6. 検証: 統合テストとE2Eテスト
- [ ] 6.1 (P) クロスファイル解決の統合テストを追加する
  - 複数ファイルにわたるprefixチェーンの完全パス算出(1.2, 1.3)、動的パスルートの除外と警告記録(5.2)、循環呼び出しを含む呼び出しグラフの終端処理(3.1, 3.3)、別ファイル定義モデル(推移的`BaseModel`継承を含む)のスキーマ参照解決(2.1, 2.2)を`sample_app`に対して検証するテストを実装する
  - 観測可能な完了状態: 上記観点のテストが`sample_app`に対して実行され、すべて成功する
  - _Requirements: 1.2, 1.3, 2.1, 2.2, 3.1, 3.3, 5.2_
  - _Depends: 4.1, 4.2, 4.3_

- [ ] 6.2 CLIのE2Eテストを追加する
  - `sample_app`に対するサブプロセス実行でstdoutが単一のJSON(schemaVersion含む)のみであり、stderrにJSON以外の内容が混入しないこと、構文エラー・未解決ルートに対応する警告が記録されること、終了コードが0であることを検証する。加えて存在しないディレクトリを指定した場合に非0終了となることを検証する
  - 観測可能な完了状態: `test_cli_integration.py`が`sample_app`実行ケースと存在しないディレクトリ指定ケースの両方で期待した終了コード・出力分離・警告内容を検証し、成功する
  - _Requirements: 4.1, 4.3, 5.1, 5.3, 6.1, 6.2, 6.3_
  - _Depends: 5.2_
