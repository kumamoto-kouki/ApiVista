# Implementation Plan

- [ ] 1. 基盤: 解析モジュールのビルド・テスト基盤と共有ユーティリティ
- [x] 1.1 TypeScript解析モジュールのビルド・テスト基盤とパーサ初期化を整備する
  - `web-tree-sitter`(^0.25系)とPython文法WASMを依存に追加し、vitestのテスト設定を用意する
  - パーサ初期化(WASM init→Python文法ロード→言語設定)をプロセス内シングルトンとして提供し、拡張ホスト/Node双方でWASMの所在を解決できる仕組みにする
  - 観測可能な完了状態: 既存の`tests/fixtures/sample_app`(Pythonソース)を入力に、外部ランタイム(Python/uv)無しでパース木が取得できることをsmokeテストで確認できる
  - _Requirements: 6.2, 6.4_
  - _Boundary: parser_

- [x] 1.2 出力データモデル・schemaVersion・ID/qualname/位置/警告の共有ユーティリティを定義する
  - 出力モデル(ルート定義・スキーマ参照・関数ノード・ファイルノード・警告・ソース位置)と`schemaVersion=1`を型安全に定義する
  - 関数ID(`<module-dotted-path>:<qualname>`)・ファイルID(backend_root相対POSIXパス)の採番、qualname構築(祖先のクラス/関数を`.`連結)、行番号(0基底→1基底へ+1)、文字列リテラルのクオート除去、警告コレクターを提供する
  - 観測可能な完了状態: 同一入力に対し採番・qualname・位置ヘルパが決定的に同じ結果を返すこと、警告が出力スキーマ準拠の形へ変換されることを単体テストで確認できる
  - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3_
  - _Boundary: models, ids, astUtils, warnings_

- [ ] 2. コア: モジュールマップ(Pass0)とファイル単位抽出(Pass1)
- [x] 2.1 モジュールマップ構築(Pass0)を実装する
  - `backend/`配下のPythonファイルを走査し、モジュールドット表記↔ファイルパスの対応と公開トップレベル名を構築する。構文エラーは構文木のエラーフラグで検出し、当該ファイルをスキップして警告を1件記録する
  - モジュール名が内部モジュールか(祖先パッケージ含む)を判定するヘルパーを提供する
  - 観測可能な完了状態: `sample_app`に対して実行すると各モジュールの対応が構築され、構文エラーファイルがスキップされて警告が1件記録されることを確認できる
  - _Requirements: 1.3, 3.3, 5.1, 6.1_
  - _Boundary: moduleMap_

- [x] 2.2 ファイル単位のシンボルテーブル(スコープ解決の代替)を実装する
  - 各ファイルのトップレベルのimport・クラス定義・関数定義を走査し、名前を「ローカルクラス定義位置」「import由来の完全修飾名」「ビルトイン」「その他」へ解決する表を構築する
  - 観測可能な完了状態: `routers/users.py`で`UserRequest`/`UserResponse`がimport由来として、`routers/items.py`で`ItemResponse`がローカルクラス定義として解決されることを単体テストで確認できる
  - _Requirements: 2.1, 3.1_
  - _Boundary: symbolTable_

- [x] 2.3 (P) ルートデコレータ抽出を実装する
  - HTTPメソッド名(get/post/put/delete/patch)に一致する属性呼び出しデコレータのみをルート候補として認識し、プログラム的登録(add_api_route等)は対象外とする。第1引数が文字列リテラルならパス確定、それ以外は未解決として警告を記録する
  - 観測可能な完了状態: `sample_app`の動的パスルートが未解決として警告に記録され、リテラルパスのルートがメソッド・パス・ハンドラを持つ候補として抽出されることを確認できる
  - _Requirements: 1.1, 1.4, 5.2, 5.3_
  - _Boundary: extractors/routes_

- [x] 2.4 (P) router関係と`FastAPI()`インスタンスの抽出を実装する
  - `APIRouter(prefix=...)`定義、`include_router(prefix=...)`呼び出し(対象オブジェクト名・included router式・prefixリテラル)、`FastAPI()`インスタンス生成を抽出し、`FastAPI()`をパス解決のBFS起点候補としてマークする
  - 観測可能な完了状態: `sample_app`に対して実行すると`app`が起点候補として識別され、items(prefix `/api`)/users(prefix無し)の関係グラフが構築されることを確認できる
  - _Requirements: 1.2, 1.3_
  - _Boundary: extractors/routers_

- [x] 2.5 (P) スキーマ参照候補とクラス定義レジストリの抽出を実装する
  - ルートハンドラの引数アノテーション(リクエスト)・戻り値アノテーション(レスポンス)を解決し、ローカル定義は定義位置を、import由来は完全修飾名を、それぞれrole付きの参照候補として記録する。ビルトイン型は除外する。トップレベルクラス定義(クラス名・基底クラス名・位置)をレジストリ用に収集する
  - 観測可能な完了状態: `sample_app`でローカル定義モデル・別ファイルからimportしたモデル双方のrole付き参照候補が抽出され、トップレベルクラスがレジストリエントリとして収集されることを確認できる
  - _Requirements: 2.1_
  - _Depends: 2.2_
  - _Boundary: extractors/schemas_

- [x] 2.6 (P) 呼び出し式抽出と関数定義レジストリ収集を実装する
  - ルートハンドラ本体内の呼び出し式(呼び出し元qualname・callee名)を収集し、あわせて当該ファイルの全関数/メソッド定義(名前・qualname・位置)を呼び出しグラフ解決用の索引として収集する
  - 観測可能な完了状態: `backend/`内の別関数を呼び出すハンドラに対して、その呼び出し式エントリと、解決先となる関数定義レジストリエントリが抽出されることを確認できる
  - _Requirements: 3.1_
  - _Boundary: extractors/calls_

- [x] 2.7 Pass1の各抽出結果を1ファイル1パスの抽出処理へ統合する
  - 2.3-2.6の抽出(ルート候補・router関係・スキーマ参照候補・クラス定義/関数定義レジストリ・呼び出し式)をファイル単位の抽出結果にまとめ、構文エラーのあるファイルはスキップ済みとして警告に記録する
  - 観測可能な完了状態: `sample_app`の全ファイルに対し、構文エラーファイルがスキップ扱いで警告に記録され、他ファイルはファイル単位の抽出結果を返すことを確認できる
  - _Requirements: 1.1, 1.4, 2.1, 3.1, 5.1, 5.2, 5.3_
  - _Depends: 2.3, 2.4, 2.5, 2.6_
  - _Boundary: extractFile_

- [ ] 3. コア: クロスファイル解決(Pass2a/2b/2c)
- [x] 3.1 (P) `FastAPI()`起点のルートパス解決を実装する
  - router関係グラフから`FastAPI()`インスタンスをBFS起点として一意に特定し(0件/2件以上は警告として全ルート未確定扱い)、include_routerのprefixを連結して完全URLパスを算出する。循環は検出し無限ループしない。確定ルートには採番ヘルパで起点関数IDを設定する
  - 観測可能な完了状態: `sample_app`でprefixチェーンに基づく完全パス(`/api/items/{item_id}`・`/users`等)を持つルート定義が生成され、確定できないルートは警告付きで除外されることを確認できる
  - _Requirements: 1.2, 1.3, 5.2, 5.3_
  - _Depends: 2.7_
  - _Boundary: resolver/routePaths_

- [x] 3.2 (P) 関数単位・ファイル単位の呼び出しグラフ構築を実装する
  - ルートハンドラを起点に、シンボルテーブルのimport束縛・モジュールマップ・関数定義レジストリを用いて呼び出し式を関数IDへ解決しながら関数単位グラフを再帰構築する。`backend/`外への呼び出しおよび解決不能なcalleeは終端、循環呼び出しは1回のみ訪問とする。関数単位グラフからファイル単位の依存グラフを導出する
  - 観測可能な完了状態: `sample_app`でハンドラから別関数(helper)への呼び出しがエッジとして表現され、外部ライブラリ呼び出しはノードに追加されず、ファイル単位依存グラフが導出されることを確認できる
  - _Requirements: 3.1, 3.2, 3.3_
  - _Depends: 2.2, 2.7_
  - _Boundary: resolver/callGraph_

- [x] 3.3 (P) クロスファイルのスキーマ参照解決を実装する
  - スキーマ参照候補とクラス定義レジストリ・モジュールマップを用い、import由来候補を定義位置へ解決する。基底クラスが`BaseModel`(レジストリ内で推移的に到達する場合を含む)である候補のみスキーマ参照として確定し、解決不能候補は警告に記録してハンドラのスキーマ参照を空にする
  - 観測可能な完了状態: 別ファイル定義のリクエスト/レスポンスモデルを参照するハンドラについてクラス名・定義位置・roleが解決され、モデル型注釈のないハンドラはスキーマ参照が空になることを確認できる
  - _Requirements: 2.1, 2.2, 5.3_
  - _Depends: 2.7_
  - _Boundary: resolver/schemaRefs_

- [ ] 4. 統合: 出力アセンブリと公開API・CLI
- [x] 4.1 各パスの結果を統合する出力アセンブラを実装する
  - ルート定義・スキーマ参照(起点関数IDでマージ)・呼び出しグラフ/ファイルグラフ・警告を単一の出力データセット(schemaVersion含む)へ統合する
  - 観測可能な完了状態: `sample_app`で各ルートのスキーマ参照が起点関数IDに基づき正しくマージされ、ルート→関数ノード→ファイルノードの参照が全て解決できることを確認できる
  - _Requirements: 4.1, 4.2, 4.3_
  - _Depends: 3.1, 3.2, 3.3_
  - _Boundary: assemble_

- [x] 4.2 拡張ホスト内インプロセス公開APIを実装する
  - backend_rootを受け取り、Pass0-2とアセンブラを順に実行して出力データセットを返す非同期APIを実装する。対象コードは実行せず静的解析のみで、解析できた場合は警告を含んでも正常に値を返し、引数が存在しない/ディレクトリでない場合はエラーとする
  - 観測可能な完了状態: `analyzeBackend`相当の呼び出しが`sample_app`に対し単一の出力データセットを返し、外部ランタイムの別途インストール無しに完了することを確認できる
  - _Requirements: 4.1, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 4.1_
  - _Boundary: index_

- [x] 4.3 開発・E2E用のCLIラッパを実装する
  - 公開APIを呼び出し、出力データセットのJSONのみを標準出力へ、ログを標準エラーへ出力する薄いラッパを実装する。存在しない/ディレクトリでない引数は非0終了、解析実行できた場合は警告を含んでも終了コード0とする
  - 観測可能な完了状態: `sample_app`に対する実行で終了コード0・標準出力に単一JSON、存在しないディレクトリ指定で非0終了となることを確認できる
  - _Requirements: 4.1, 4.3, 5.1_
  - _Depends: 4.2_
  - _Boundary: cli_

- [ ] 5. 検証: 統合テスト・E2Eと旧資産撤去
- [x] 5.1 (P) クロスファイル解決の統合テストを追加する
  - 複数ファイルにわたるprefixチェーンの完全パス算出、動的パスルートの除外と警告、循環呼び出しを含む呼び出しグラフの終端処理、別ファイル定義モデル(推移的`BaseModel`継承を含む)のスキーマ参照解決を`sample_app`に対して検証する
  - 観測可能な完了状態: 上記観点のテストが`sample_app`に対して実行され、すべて成功する
  - _Requirements: 1.2, 1.3, 2.1, 2.2, 3.1, 3.3, 5.2_
  - _Depends: 3.1, 3.2, 3.3_

- [x] 5.2 公開API・CLIのE2Eテストを追加する
  - `sample_app`に対する解析で単一の出力データセット(schemaVersion含む)が得られ、ルート→関数→ファイルの参照が貫通すること、構文エラーファイルと未解決ルートに対応する警告が含まれること、外部ランタイム(Python/uv)無しでNode上で完走すること(6.4)、存在しないディレクトリで非0終了となることを検証する
  - 観測可能な完了状態: E2Eテストが解析成功ケースと引数不正ケースの両方で期待した出力・警告・終了コードを検証し、成功する
  - _Requirements: 4.1, 4.3, 5.1, 5.3, 6.1, 6.4_
  - _Depends: 4.2, 4.3, 5.1_

- [x] 5.3 旧Python実装資産を撤去する
  - TS実装のE2Eが通過した後、旧Python解析パッケージ・Pythonテスト・Pythonビルド構成(pyproject等)を削除する。解析対象の入力フィクスチャ(`tests/fixtures/sample_app`)は温存する
  - 観測可能な完了状態: 旧Python実装が除去されてもTSのE2E/単体テストが全て通過し、フィクスチャが残存していることを確認できる
  - _Requirements: 6.4_
  - _Depends: 5.2_

## Implementation Notes

- 実装基盤は web-tree-sitter(WASM)。`web-tree-sitter`は`^0.25`に固定し、Python文法WASM(`@vscode/tree-sitter-wasm`等、tree-sitter core v0.25系)とABI整合させること(0.26はWASM ABI非互換)。
- tree-sitterは構文エラーで例外を投げない。構文エラーは構文木のエラーフラグ(`rootNode.hasError`相当)で判定してskip+警告化する。
- 位置情報は0基底(行)で返るため、出力の`SourceLocation.line`(1基底)へ変換する際は+1する。
- スコープ解決(libcstのScopeProvider相当)は存在しないため、ファイル単位のシンボルテーブルを自前構築する(task 2.2)。スキーマ抽出(2.5)と呼び出しグラフ解決(3.2)が共有する。
- ID決定性: `qualname`は祖先の`class_definition`/`function_definition`を`.`連結して構築する共通規則で算出し、Pass1/2a/2b/2cで同一ハンドラのIDを一致させること(entryFunctionId = 関数ノードID = スキーマ参照マージキー)。
- ID非対称性: モジュールドット表記は`backend_root`のbasenameをルートに含む(例 `sample_app.routers.items`)が、ファイルIDは含まない相対パス(例 `routers/items.py`)。両者は文字列変換ではなくモジュールマップのルックアップで対応させる。
- `tests/fixtures/sample_app/**` は解析INPUT(Pythonソース)であり、旧Python実装を撤去(5.3)してもテスト入力として温存する。
- (task 1.1で確認)依存の実証済み組み合わせ: `web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`(`out/tree-sitter-python.wasm`)はABI整合し、`broken.py`が`rootNode.hasError=true`になることも確認済み。ランタイムWASMは`web-tree-sitter/tree-sitter.wasm`、文法は`tree-sitter-wasms/out/tree-sitter-python.wasm`をnode_modulesから解決(`parser.ts`の`getPythonParser(wasmDir?)`)。
- (task 1.1で確認)tsconfigはTS6+Node16で`@types/node`が自動適用されず、`compilerOptions.types: ["node"]`の明示が必要(`import.meta.url`/`node:*`解決のため)。テストファイルは`tsc`ビルドから除外し、型・実行はvitestが担う。
- (task 2.7で確認)`extractFile`の実装シグネチャは `extractFile(fileId, tree, collector)` の**3引数**(design.mdの4引数 `(…, map: ModuleMap, collector)` から map を省略)。Pass1抽出器はいずれもModuleMapを使わない(file-local、schemasは自前symbolTableを構築)ため。**ModuleMapはPass2(3.x/4.x)で別途スレッドする**こと。Pass1各抽出器のAPI: `extractRoutes(tree,fileId,collector)` / `extractRouterRelations(tree,fileId)` / `extractSchemaInfo(tree,fileId)→{refCandidates,classDefinitions}` / `extractCalls(tree,fileId)→{callExpressions,functionDefinitions}`。
- (task 3.1で確認・Pass2共通)相対import解決の共有ユーティリティ `src/backend-analysis/resolver/imports.ts` を新設(`resolveRelativeModule(dotted,currentModule)` / `resolveImportQualifiedName(qualifiedName,currentFileId,map)→{moduleDotted,name,targetFileId}`)。3.2/3.3 はこれを再利用すること。
- (task 3.1で確認)`resolveRoutePaths(perFile, map, collector, symbolTables)` は**第4引数 `symbolTables: Map<fileId, Map<string,Binding>>`** を取る(routerExpr の先頭識別子を import 解決するため。FileExtractionResult は tree/symbolTable を持たない)。**task 4.2 の orchestration で各ファイルの `buildSymbolTable(tree, fileId)` を perFile と同時に構築して渡す**こと。3.2(callGraph)も callee の import 解決に symbolTable が必要になる見込み。
