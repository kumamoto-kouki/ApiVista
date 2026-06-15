# Research & Design Decisions: frontend-call-extractor

## Summary
- **Feature**: `frontend-call-extractor`
- **Discovery Scope**: New Feature(greenfield)。backend-route-extractor のパイプライン/出力スキーマ/ID体系/エッジリスト方式を対称流用し、解析基盤を TS/Vue 向けに置換する。
- **Key Findings**:
  - 解析基盤は **ts-morph(既存依存 ^23)+ @vue/compiler-sfc(新規 ^3.5)**。いずれも純JSで拡張ホスト(Node)上でインプロセス動作し、ネイティブモジュール/WASM/外部ランタイムを要しない(Req5.4)。
  - **Nuxt auto-import** が本specの中心的な技術課題。`$fetch`/`useFetch`/ユーザー composable は import文なしで呼べるため、(a)API呼び出し検出は呼び出し名マッチで足りる一方、(b)呼び出しグラフのクロスファイル解決は ts-morph シンボル解決に加え「エクスポート名索引フォールバック」が必要。
  - `.vue` は ts-morph で直接解析不可。@vue/compiler-sfc で `<script>`/`<script setup>` を抽出し、scriptブロック開始行で SourceLocation を補正する。

## Research Log

### ts-morph によるTS/JS解析・呼び出し解決
- **Context**: API呼び出し検出、関数/コンポーネント/composable 定義収集、クロスファイル呼び出し解決を TS/JS で行う手段。
- **Findings**:
  - ts-morph は TypeScript Compiler API のラッパー(純JS)。`Project` にソースを投入し、`CallExpression` 走査・シンボル/定義解決(`getSymbol`/`getDefinitionNodes`/参照)が可能。backend の自前 symbolTable より明示import解決は強力。
  - 位置は1基底(`getStartLineNumber()` 等)。backend(tree-sitter 0基底)と異なり +1 補正は不要。ただし `.vue` 由来は scriptブロック開始行オフセットが必要。
  - 対象プロジェクトの依存をインストールしなくても、ソースファイル集合から Project を構成して構文・ローカル解決は可能(型の完全解決は不要、Req5.3)。
- **Implications**: クロスファイル解決は「ts-morph シンボル解決 → 失敗時エクスポート名索引」の二段。`.ts/.js` は直接、`.vue` は抽出スクリプトを仮想 `.ts` として Project 投入。

### @vue/compiler-sfc による SFC スクリプト抽出
- **Context**: `.vue` から解析対象のスクリプトを取り出す。
- **Findings**: `parse(source)` が `descriptor.script` / `descriptor.scriptSetup`(各 `.content` と `.loc.start.line/offset`)と `errors` を返す。純JS。
- **Implications**: スクリプト本文を ts-morph に渡し、ts-morph 内行 `L` → 実ファイル行 = `scriptStartLine - 1 + L` で補正(`astUtils.toSourceLocation`)。`errors` があれば該当ファイルを skip + 警告(Req4.1)。`<script>` と `<script setup>` 双方がある場合は結合し各オフセットを保持。

### Nuxt auto-import の静的解析影響(重要)
- **Context**: Nuxt は `$fetch`(ofetch グローバル)、`useFetch`/`useAsyncData`(auto-import)、`composables/`・`utils/` のエクスポートを **import文なし**で利用可能にする。
- **Findings**: import文が無いため ts-morph のシンボル解決が及ばない呼び出しが生じる。一方 API呼び出し検出は呼び出し名(`$fetch`/`useFetch`/`axios.*`)のマッチで十分。
- **Decision**: 呼び出しグラフの callee 解決を二段構成にする — ① ts-morph シンボル/定義解決(明示import・同一ファイル)② 失敗時、全ファイル横断の**エクスポート名索引**(`exportIndex`)で名前一致(composable 等)を補完。一意に定まらない/`frontend/`外/未解決は終端(Req2.3)。これは backend の「相対import解決ユーティリティ」に対応する本specの肝。

### URLパターン正規化
- **Context**: 実呼び出しの多くはテンプレートリテラル(`` `/api/users/${id}` ``)。
- **Decision**: 文字列リテラルはそのまま、テンプレートリテラルは静的リテラル骨格を保持しつつ `${expr}` をプレースホルダ(`{}`)へ正規化して URLパターン化(Req1.3)。これにより backend の `/{item_id}` 表記と route-linkage-engine で照合可能。URL骨格自体が動的(変数/関数結果)でパターン化不能な場合のみ除外+警告(Req4.2)。baseURL/相対パスの prefix 補完は route-linkage-engine の責務(requirements で Out 明記)。

### 出力スキーマの対称化と共有型
- **Context**: route-linkage-engine と vscode-extension-ui は backend/frontend 両出力を共通利用する。
- **Decision**: `FunctionNode`/`FileNode`/`Warning`/`SourceLocation`/`SCHEMA_VERSION` は backend と同形。`ApiCall` は backend `RouteDefinition` の対称物(schemaRefs 無し)。当面は `src/frontend-analysis/models.ts` に自己完結で定義し、**完成済み backend を非改変**(回帰回避)。`src/shared/` への型統合は route-linkage-engine(両出力を消費)着手時の DRY 機会として将来候補に記録。

## Risks & Mitigations
- リスク: Nuxt auto-import の名前衝突(同名 composable が複数ファイル)で callee 解決が非一意 — 対応: 非一意は終端扱い(誤エッジを作らない)。実フィクスチャで挙動を固定。
- リスク: `.vue` の複雑な SFC(複数 script ブロック、lang 差異)で行マッピングがずれる — 対応: scriptブロックの `loc` を厳密に使い、`<script>`/`<script setup>` 双方を個別オフセットで扱う。フィクスチャで行番号を検証。
- リスク: ts-morph の Project 構築コスト(大規模 frontend) — 対応: 対象を `frontend/` 配下の対象拡張子に限定し、型チェックは行わず構文/解決のみ利用。

## References
- ts-morph 公式ドキュメント(Project, SourceFile, CallExpression, シンボル/定義解決) — Pass1/2 解析の根拠
- @vue/compiler-sfc `parse()` API(descriptor.script/scriptSetup, loc, errors) — SFC 抽出・行マッピングの根拠
- Nuxt 公式(auto-imports: components/composables/utils、`$fetch`/`useFetch`) — auto-import フォールバック設計の根拠
- backend-route-extractor `design.md` / `models.ts` — 対称スキーマ・ID体系・エッジリスト方式の流用元
