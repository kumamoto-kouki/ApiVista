# 2026-06-15 backend-route-extractor 実装振り返り

## 何を実装したか
FastAPI(Python)コードを静的解析し、ルート定義(完全URLパス・method・ハンドラ)、スキーマ参照(role付き)、関数/ファイル単位の呼び出しグラフを単一の `AnalysisOutput` として返す抽出器を、**TypeScript + web-tree-sitter(WASM)** で実装(`src/backend-analysis/`、公開API `analyzeBackend()` + 開発用CLI)。当初の Python(libcst)実装から全面再実装し、旧Python資産は撤去。128 tests / tsc / eslint green、`/kiro-validate-impl` GO。

## 詰まった点・繰り返した判断

### 1. 方針転換(Python/libcst → TS/web-tree-sitter)の連鎖
「VSCode拡張を導入するだけで全OS動作・外部ランタイム不要」という方針が、backend が Python CLI である点と衝突。さらに「TSで再実装」→ ts-morph は Python 非対応 → tree-sitter → node-tree-sitter は Electron ABI 問題で「導入のみ動作」を壊す → **web-tree-sitter(WASM、`^0.25`固定で `@vscode/tree-sitter-wasm` とABI整合)** に到達。判断基準: **「導入のみで全OS動作」を満たすには、配布物にネイティブABI依存を持ち込まない**(WASMライブラリは可、ネイティブNodeアドオンは不可)。実行ランタイムとしてのWASM/WASI(`@vscode/wasm-wasi`)とライブラリ実装のWASM(web-tree-sitter)は別概念。

### 2. libcst固有機能のTS側代替を何度も意識した
tree-sitter には ScopeProvider/matchers/例外送出が無い。毎タスクで同じ代替判断を反復した: 構文エラーは `rootNode.hasError`、位置は0基底→+1、スコープ解決は自前 `symbolTable`、文字列リテラルは自前 `stripStringLiteral`。

### 3. ID整合と相対import解決(Pass2の核)
`entryFunctionId = FunctionNode.id = schemaRefsキー` を `makeFunctionId(pathToModule.get(fileId), qualname)` で一致させること、qualname は祖先 class/function を `.` 連結すること、を Pass1/2a/2b/2c で繰り返し守る必要があった。Pass2 の3解決器が**すべて相対import解決を必要**としたため、共有 `resolver/imports.ts` に切り出して再利用(設計レビューの指摘で先回り)。

### 4. resolver は symbolTable を引数で受ける(設計署名からの逸脱)
`FileExtractionResult` が tree/symbolTable を持たないため、`resolveRoutePaths`/`buildCallGraph` は `symbolTables: Map<fileId, Map<string,Binding>>` を追加引数で受け、orchestration(`index.ts`)が一括構築して渡す形にした。design.md の署名から逸脱したが正当(レビュー承認済み)。

### 5. 運用上の摩擦(コード品質とは無関係)
- **外部プロセスによる先行コミット**: 実装サブエージェントの成果物(test/source)が、私の `git add`/commit 前に外部プロセスで(時に誤ったメッセージで)コミットされる事象が複数回発生(例: 3.3 が `cdae6d5` で「.gitignore」表記でコミット)。`git status --porcelain` と `git ls-files` を都度確認し、未コミット分のみ選択コミットすることで吸収できた。
- **spend-limit 中断**: サブエージェントが0トークンで失敗する中断が複数回。コミット済み状態+機械検証(tests/tsc/eslint)を根拠に再開でき、状態を見失わなかった。

## `.claude/rules/` 化の候補(強く推奨)
`src/backend-analysis/**` を対象にした規約ファイルが有用。パターンが Pass2 で3回反復し、今後 frontend-call-extractor/route-linkage-engine でも類似判断が出る見込み。記載すべき判断基準(Why):
- web-tree-sitter は `^0.25` 固定(WASM ABI整合)。ネイティブNodeアドオンは「導入のみ動作」を壊すため不可。
- 構文エラーは例外でなく `rootNode.hasError`。位置は0基底→`SourceLocation.line`へ+1。
- スコープ解決は無いので per-file `symbolTable` を使う。相対import解決は `resolver/imports.ts` を再利用(自前で再実装しない)。
- ID整合: `makeFunctionId(pathToModule.get(fileId), qualname)` を全Passで使い、qualname規則を守る。
- ModuleMapのドット表記(basename付き)とfileId(basename無し)は文字列変換せずlookupで対応。

## スキル化の候補
- 特になし。本実装の進め方(SDD: requirements→design→validate-design→tasks→impl の autonomous オーケストレーション)は既存スキル群で十分回った。
- ただし「外部プロセス先行コミット」への対処(選択コミット前の `git status`/`ls-files` 確認)は kiro-impl の運用上の留意点として有効に機能した。

## 関連
- 恒久方針は [.kiro/steering/tech.md](../../.kiro/steering/tech.md)、転換の経緯は [.kiro/specs/backend-route-extractor/research.md](../../.kiro/specs/backend-route-extractor/research.md)(設計転換 2026-06-14)。
