# 2026-06-19 frontend-call-extractor 実装振り返り

## 何を実装したか
Nuxt.js(Vue/TS/JS)コードを静的解析し、API呼び出し(`$fetch`/`useFetch`/`axios` の method・URLパターン・内包ノード・位置)、関数/コンポーネント/composable 単位の有向呼び出しグラフ、ファイル単位グラフを単一の `AnalysisOutput`(backend と対称・`schemaVersion=1`・schemaRefs 無し)として返す抽出器を、**TypeScript + ts-morph + @vue/compiler-sfc** で実装(`src/frontend-analysis/`、公開API `analyzeFrontend()` 同期 + 開発用CLI)。全15サブタスク・326 tests / tsc / eslint green、`/kiro-validate-impl` GO。backend-route-extractor のパイプライン/スキーマ/ID体系を対称流用。

## 詰まった点・繰り返した判断

### 1. Nuxt auto-import 解決が本specの核
`$fetch`/`useFetch`/composable は import 文なしで呼べるため、callee 解決を多段化する必要があった。判断基準: **(a) 明示 import(`~/`/`@/`/相対エイリアスを `resolveSpecifierToFileId` で fileId 化)→ (b) auto-import フォールバック(全ファイル横断 `exportIndex` の名前一致・一意のみ)→ (c) template 参照は `componentIndex`(Nuxt ディレクトリ接頭辞命名)で解決**。`frontend/`外・未解決・**非一意**・属性アクセスは**終端**(誤エッジを作らない)。これが backend の相対import解決に対応する。

### 2. `.vue` の取り扱い(SFC + 行マッピング + 生ソース)
`.vue` は ts-morph で直接解析不可 → `@vue/compiler-sfc` で `<script>`/`<script setup>` を結合抽出し仮想 `.ts` として Project 投入。**複数 script ブロック併存の行補正**は `segments{fromLine,toLine,vueStartLine}` で `vueStartLine - 1 + (L - fromLine + 1)`。template 参照抽出(`extractTemplateRefs`)が `.vue` **生ソース**を要したため、`FrontendProject.getVueSource(fileId)` アクセサを 4.1 で追加(宣言済みの正当な境界拡張・挙動不変)。

### 3. Pass 間の責務分担を毎タスクで意識
Pass1 抽出器は候補のみ出し、解決は Pass2(4.1)に集約する分担を一貫させた:
- 3.1 `extractApiCalls` は `enclosingFunctionId=""` プレースホルダで出力 → 4.1 が内包ノードを解決して確定(Req1.4)。
- caller/ノードIDは全 Pass で `makeFunctionId(stripExtension(fileId), qualname|componentName)` 統一(参照貫通 `enclosingFunctionId==id`, `file==fileId` の不変条件)。
- コンポーネントノード命名は `fileMap` の `componentNameFromFileId`/`stripExtension` を再利用(3.2/3.4 が export 化して共有)— 命名のドリフトを防ぎ 4.1 の連結を保証。

### 4. 構文/SFCエラー skip を全 Pass に伝播(横断知見)
`.ts/.js` の構文エラー検出は `buildProject` ではなく `fileMap.ts`(`getSyntacticDiagnostics`)で行う設計になったため、**Pass1 以降は `project.fileIds` ではなく `fileMap.fileIds` を反復**して skip を尊重する必要があった(さもないと Req4.1 の skip 漏れ)。SFCエラーは `extractSfc` 由来、.ts 構文エラーは `fileMap` 由来で各1件・二重記録なし。tasks.md Implementation Notes に明記して 3.x/4.1 へ伝えた。

### 5. 運用摩擦(今セッション固有・コード品質とは無関係)
- **spend-limit 中断が複数回**。特に2件が厄介だった:
  - **1.3**: 実装サブエージェントが型統合の途中で中断し、外部プロセスが**壊れた状態(tsc TS2440/2484・eslint・backend e2e 回帰)をコミット**。コミット済み状態を機械検証で再現 → ローカル重複 `SourceLocation` 宣言削除・未使用 import 除去の**外科的修復**で回復。
  - **4.1(callGraph)**: 実装者がテスト + `getVueSource` アクセサだけ書いて**脱線(無関係な docker-compose 質問に回答)**、実装本体未作成。良質なテスト(RED 仕様)とアクセサを活かし、新規実装者に「テスト/project.ts は触らず callGraph.ts のみ完成」と指示して完成。
- 毎回、**コミット済み状態 + 機械検証(tests/tsc/eslint)を信頼の基点**にして状態を見失わず再開できた。「外部プロセスの先行コミット(誤ラベル含む)」は backend でも起きた既知事象で、選択コミット前の `git status`/`ls-files` 確認で吸収。

### 6. reviewer 指摘の wart を親が是正(非ブロッキング)
- 5.2: 未配線 `options.include` への**捏造バリデーション(空配列 throw)**を除去し、署名は design 公開契約・backend 対称のため残して `void` で意図的未使用を明示。
- 4.1: ヘッダーコメントが `findEnclosingDef` と記載だが実体は行範囲ベース `resolveEnclosing` → コメントを正確化。
- 6.1/6.2 は reviewer が mutation を入れて非タウトロジーを実証(良い検証文化)。

## `.claude/rules/` 化の候補(強く推奨)
backend 振り返りで `src/backend-analysis/**` 規約を推奨したが、frontend で**同種パターンが出揃った**。両抽出器共通の判断基準を `src/{backend,frontend}-analysis/**` 規約(または両者をまたぐ規約)として切り出す価値が高い。記載すべき Why:
- **ID整合**: `makeFunctionId(<moduleパス>, qualname)` を全 Pass で使い、`enclosingFunctionId==FunctionNode.id`・`file==FileNode.id`・`calls[]/dependsOn[]==実在id` の参照貫通を不変条件にする。
- **skip 反復**: 構文/SFCエラーの skip は「対象 fileId 集合(`fileMap.fileIds`)を反復」で尊重する。エラー記録は1ファイル1件・二重記録しない。
- **callee/参照解決**: 明示 import → 名前索引フォールバック → 終端(外部/未解決/非一意)の三段。非一意は誤エッジを作らず終端。
- **Pass 間責務**: 抽出器は候補を出し解決は resolver に集約。プレースホルダ(`""`)を後段で確定。
- **対称スキーマ**: frontend は backend `RouteDefinition` の対称物 `ApiCall`(schemaRefs 無し)。`src/shared/` 統合は route-linkage-engine 着手時の DRY 契機(両出力を消費するため)。
- **.vue 固有**: 行補正は segments、生ソースは `getVueSource`、命名規約は `componentNameFromFileId` を共有(再実装しない)。

→ route-linkage-engine が両抽出器の出力を消費する=共通契約に最初に触れるスペックなので、**そこで `src/shared/` 型統合 + rules 切り出しを判断**するのが自然。

## スキル化の候補
- 新規スキルは不要。SDD の autonomous オーケストレーション(実装→機械検証→独立レビュー→選択コミット)は既存 `kiro-impl`/`kiro-review`/`kiro-validate-impl` で十分回った。
- ただし「**中断/脱線サブエージェントからの復旧手順**」が本セッションで繰り返し有効だった: ①`git status`/`git log`/`ls-files` でコミット済み状態を確定 → ②機械検証(tests/tsc/eslint)で健全性を再現 → ③部分成果(良質なテスト等)はサルベージし不足分のみ新規実装者に限定指示 → ④壊れたコミットは挙動不変の外科的修復。これは kiro-impl の運用上の留意点として記録に値する(スキル化までは不要)。

## 関連
- 恒久方針 [.kiro/steering/tech.md](../../.kiro/steering/tech.md)、discovery 経緯 [.kiro/specs/frontend-call-extractor/research.md](../../.kiro/specs/frontend-call-extractor/research.md)。
- 対称元の backend 振り返り [2026-06-15-backend-route-extractor.md](./2026-06-15-backend-route-extractor.md)。
- 次スペック route-linkage-engine が両出力の共通契約に最初に触れるため、`src/shared/` 統合・rules 化はそこで判断。
