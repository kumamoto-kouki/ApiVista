# Implementation Plan

- [ ] 1. 基盤: 解析基盤・共有ユーティリティ・フィクスチャ
- [x] 1.1 SFC抽出基盤(@vue/compiler-sfc)を整備する
  - `@vue/compiler-sfc` を依存に追加し、`.vue` から `<script>`/`<script setup>` を結合抽出する仕組みを用意する。結合本文の各領域→元 `.vue` 開始行の対応(segments)と、template からの子コンポーネント参照(PascalCase 正規化)を取得する。SFCパースエラーは script を null とし警告を記録する
  - 観測可能な完了状態: サンプル `.vue`(`<script setup>` 単独 / `<script>`+`<script setup>` 併存)から script 本文・segments・コンポーネント参照が取得でき、併存時の行マッピングが正しいことを単体テストで確認できる
  - _Requirements: 3.3, 4.1_
  - _Boundary: sfc_

- [x] 1.2 ts-morph Project 構築を実装する
  - `frontend/` 配下の `.ts/.js` と、抽出済み `.vue` スクリプト(仮想 `.ts`)を ts-morph Project へ投入し、fileId(frontendRoot相対POSIX)に紐づく SourceFile を取得できるようにする
  - 観測可能な完了状態: `sample_nuxt` の `.ts`/`.vue` が Project に載り、fileId から SourceFile を引けることを確認できる
  - _Requirements: 5.1, 5.2_
  - _Depends: 1.1_
  - _Boundary: project_

- [x] 1.3 出力モデル・ID・警告・AST/URLユーティリティを定義する
  - 出力モデル(API呼び出し・関数ノード・ファイルノード・警告・ソース位置)と `schemaVersion=1` を backend と対称的に型安全に定義する。関数ID・ファイルIDの採番、URLテンプレート正規化(`${expr}`→プレースホルダ)、segments による行補正、警告コレクターを提供する
  - 観測可能な完了状態: 同一入力に対し採番が決定的、`` `/api/users/${id}` `` が `/api/users/{}` へ正規化、segment 行補正が正しいことを単体テストで確認できる
  - _Requirements: 1.3, 3.2, 3.3, 4.3_
  - _Boundary: models, ids, warnings, astUtils_

- [x] 1.4 Nuxt サンプルフィクスチャを作成する
  - `tests/fixtures/sample_nuxt/` に意図的な検証ケースを配置する: `<script setup>` 直下 `useFetch` + template の `<UserList/>`、ネスト配置コンポーネント(`components/base/Button.vue`→`<BaseButton/>`)、テンプレートリテラル動的URL、auto-import composable(`axios` 呼び出し)、完全動的URL、構文エラーファイル、`~/`/`@/` エイリアス import、`<script>`+`<script setup>` 併存例
  - 観測可能な完了状態: 上記ケースが揃い、後続の抽出/解決タスクの解析INPUTとして利用できる
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 4.1, 4.2_
  - _Boundary: fixtures_

- [ ] 2. Pass0: ファイルマップと名前索引
- [x] 2.1 ファイルマップ(Pass0)を実装する
  - `frontend/` 配下の対象ファイルから fileId 集合・エクスポート名索引(関数/composable)・コンポーネント名索引(Nuxt のディレクトリ接頭辞付き命名規約に準拠)を構築し、import 指定子(相対 / `~/` / `@/`)を fileId へ解決するヘルパーを提供する。構文/SFCエラーのファイルはスキップして警告を記録する
  - 観測可能な完了状態: `sample_nuxt` で composable/関数名・コンポーネント名(`UserList`/`BaseButton`)が索引化され、`~/` 指定子が解決され、構文エラーファイルがスキップされて警告が記録されることを確認できる
  - _Requirements: 2.3, 4.1, 5.1_
  - _Depends: 1.1, 1.2, 1.3_
  - _Boundary: fileMap_

- [ ] 3. コア: ファイル単位抽出(Pass1)
- [x] 3.1 (P) API呼び出し抽出を実装する
  - `$fetch`/`useFetch`/`axios` の各形態を認識し、HTTPメソッド(呼び出し名/options、無指定は既定GET)・URLパターン(リテラル/テンプレートリテラルはプレースホルダ正規化)・呼び出し元位置を抽出する。URL骨格/methodが静的決定不能なら除外して警告を記録し、認識対象外の呼び出しは抽出しない
  - 観測可能な完了状態: `sample_nuxt` で各形態の method/URLパターンが抽出され、動的URL(`buildUrl()` 等)が除外+警告、認識対象外が非抽出となることを確認できる
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 4.2_
  - _Depends: 1.3_
  - _Boundary: extractors/apiCalls_

- [ ] 3.2 (P) 定義レジストリ抽出(コンポーネントノード規約含む)を実装する
  - トップレベル関数・名前付き矢印関数・`use*` composable を定義として収集し、各 `.vue` を単一のコンポーネントノード(ファイル/ディレクトリ由来 PascalCase 名)として登録する。`<script setup>` 直下など名前付き関数に内包されない呼び出しは当該コンポーネントノードに帰属させる
  - 観測可能な完了状態: `sample_nuxt` で関数/composable/各 `.vue` のコンポーネントノードが収集され、`<script setup>` 直下の `useFetch` の内包ノードがコンポーネントノードになることを確認できる
  - _Requirements: 1.4, 2.1_
  - _Depends: 1.3_
  - _Boundary: extractors/defs_

- [ ] 3.3 (P) 呼び出し式抽出を実装する
  - 各定義(関数/composable/コンポーネントノード)本体内の呼び出し式を、呼び出し元の識別子(qualname)・callee 名・位置として収集する
  - 観測可能な完了状態: `sample_nuxt` で各定義本体内の呼び出しが呼び出し元付きで収集されることを確認できる
  - _Requirements: 2.1_
  - _Depends: 1.3_
  - _Boundary: extractors/calls_

- [ ] 3.4 (P) template コンポーネント参照抽出を実装する
  - `.vue` の template から子コンポーネント参照を、当該コンポーネントノード→子コンポーネントのエッジ候補として収集する(動的 `<component :is>` 等は対象外)
  - 観測可能な完了状態: `pages/users.vue` の `<UserList/>` がコンポーネント参照として抽出されることを確認できる
  - _Requirements: 2.1_
  - _Depends: 1.1_
  - _Boundary: extractors/templates_

- [ ] 4. コア: クロスファイル解決(Pass2)
- [ ] 4.1 有向呼び出しグラフ構築とAPI注釈を実装する
  - 関数/composable/コンポーネントノードを起点に、明示import(エイリアス解決)・エクスポート名索引(auto-import)・コンポーネント名索引(template 参照)で callee を解決し、呼び出し元→呼び出し先の有向エッジを構築する。`frontend/`外/未解決/非一意は終端、同一ノードは1回訪問。各API呼び出しを内包ノードに注釈し、関数単位グラフからファイル単位グラフを導出する
  - 観測可能な完了状態: `sample_nuxt` で「ページ→子コンポーネント→composable→API呼び出し」が `calls` で連結し、auto-import composable が解決され、外部ライブラリ呼び出しが終端、ファイル単位グラフが導出されることを確認できる
  - _Requirements: 1.4, 2.1, 2.2, 2.3_
  - _Depends: 2.1, 3.1, 3.2, 3.3, 3.4_
  - _Boundary: resolver/callGraph_

- [ ] 5. 統合: 出力アセンブリと公開API・CLI
- [ ] 5.1 出力アセンブラを実装する
  - API呼び出し・呼び出しグラフ(関数単位・ファイル単位)・警告を単一の出力データセット(schemaVersion含む)へ統合する
  - 観測可能な完了状態: 各API呼び出しが内包ノードIDに基づき正しく配置され、API呼び出し→関数ノード→ファイルノードの参照が解決できることを確認できる
  - _Requirements: 3.1, 3.2, 3.3_
  - _Depends: 4.1_
  - _Boundary: assemble_

- [ ] 5.2 拡張ホスト内インプロセス公開APIを実装する
  - frontend_root を受け取り Pass0-2 とアセンブラを順に実行して出力データセットを返す。対象コードは実行せず静的解析のみで、解析できた場合は警告を含んでも値を返し、引数が存在しない/ディレクトリでない場合はエラーとする
  - 観測可能な完了状態: `analyzeFrontend` 相当の呼び出しが `sample_nuxt` に対し単一の出力データセットを返し、外部ランタイムの別途インストール無しに完了することを確認できる
  - _Requirements: 3.1, 5.1, 5.2, 5.3, 5.4_
  - _Depends: 5.1_
  - _Boundary: index_

- [ ] 5.3 開発・E2E用のCLIラッパを実装する
  - 公開APIを呼び出し、出力データセットのJSONのみを標準出力へ、ログを標準エラーへ出力する薄いラッパを実装する。存在しない/ディレクトリでない引数は非0終了、解析実行できた場合は警告を含んでも終了コード0とする
  - 観測可能な完了状態: `sample_nuxt` に対する実行で終了コード0・標準出力に単一JSON、存在しないディレクトリ指定で非0終了となることを確認できる
  - _Requirements: 3.1, 4.3, 5.1_
  - _Depends: 5.2_
  - _Boundary: cli_

- [ ] 6. 検証: 統合テストとE2E
- [ ] 6.1 (P) クロスファイル解決の統合テストを追加する
  - `sample_nuxt` に対し: 各API呼び出し形態の method/URLパターン正規化、動的URL除外+警告、`<script setup>` 直下呼び出しのコンポーネントノード帰属、template 経由のコンポーネント間エッジ、auto-import/エイリアス解決、外部終端、構文エラー skip+警告、複数 script ブロックの行マッピングを検証する
  - 観測可能な完了状態: 上記観点のテストが `sample_nuxt` に対して実行され、すべて成功する
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_
  - _Depends: 4.1, 5.2_

- [ ] 6.2 公開API・CLIのE2Eテストを追加する
  - コンパイル済みCLIをサブプロセス起動して `sample_nuxt` を解析し、stdout が単一JSON(schemaVersion含む)のみ・stderr に非JSONが混入しないこと、動的URL/構文エラーに対応する警告が含まれること、外部ランタイム無しでNode上で完走すること、終了コードが0であること、存在しないディレクトリで非0終了となることを検証する
  - 観測可能な完了状態: E2Eテストが解析成功ケースと引数不正ケースの両方で期待した出力・警告・終了コードを検証し、成功する
  - _Requirements: 3.1, 4.3, 5.1, 5.4_
  - _Depends: 5.3, 6.1_

## Implementation Notes
- 実装基盤は ts-morph(既存依存 ^23)+ @vue/compiler-sfc(新規 ^3.5)。いずれも純JSで拡張ホスト(Node)上でインプロセス動作し、外部ランタイム/ネイティブ不要(Req5.4)。
- 出力スキーマ・ID体系は backend-route-extractor と対称(`FunctionNode`/`FileNode`/`Warning`/`SourceLocation`/`SCHEMA_VERSION` は同形、`ApiCall` は `RouteDefinition` の対称物で schemaRefs 無し)。当面 `src/frontend-analysis/models.ts` に自己完結で定義(完成済み backend を非改変)。`src/shared/` 統合は route-linkage-engine 着手時の将来候補。
- Nuxt auto-import が解決の肝: 関数/composable は `exportIndex`、template の `<Child/>` は `componentIndex`(ディレクトリ接頭辞付き命名)で解決。明示import は `~/`/`@/` エイリアスを frontendRoot 起点で解決。ts-morph シンボル解決は精度向上の補助。`frontend/`外/非一意は終端。
- `.vue` の行番号は segments(結合スクリプトの行範囲→元 .vue 開始行)で補正。`<script>`+`<script setup>` 併存に対応。
- ID整合: `ApiCall.enclosingFunctionId == FunctionNode.id`、`FunctionNode.file == FileNode.id`、`calls[]/dependsOn[] == id` を不変条件とする(backend と同じ参照貫通)。
- `tests/fixtures/sample_nuxt/**` は解析INPUT(Vue/TS source)。
- (既知の限界・v1スコープ)認識は呼び出し名(`$fetch`/`useFetch`/`axios`)ベース。カスタム axios インスタンス(`const api = axios.create(...); api.get(...)`)やリアクティブ/動的URLは非認識(design Non-Goals 参照)。実装でこれらに過剰対応しないこと。
- (2.1 知見)`buildFileMap` は生 ts-morph `Project` ではなく `FrontendProject`(project.ts の Pass0 生成物)を取る(実 fileId 反復/`.vue` segments/skip 状態がそこにしかないため)。設計署名との差異だがレビューで健全と承認済み。
- (2.1 知見・後続3.x/4.1 必読)`.ts/.js` の構文エラー検出は `buildProject` ではなく `fileMap.ts` の `getSyntacticDiagnostics` で行う。**Pass1(3.x)以降は `project.fileIds` ではなく `fileMap.fileIds` を反復**して構文エラーファイルの skip を尊重すること(さもないと Req4.1 の skip 漏れ・解析対象漏れが起きる)。SFCエラーは extractSfc 由来、.ts 構文エラーは fileMap 由来で各1件、二重記録なし。
