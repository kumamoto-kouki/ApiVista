# 開発ガイド

本プロジェクトは **単一の VSCode 拡張機能(TypeScript)** であり、拡張本体・全解析器とも `npm` で完結します。**エンドユーザーに Python/uv 等の外部ランタイムは不要**で、開発者環境にも特別な前提はありません(Node.js があれば十分)。

---

## セットアップ

```bash
npm install       # 依存インストール
```

---

## 主要コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run build` | TypeScript コンパイル + Webview バンドル(esbuild) + WASM コピー |
| `npm run bundle:webview` | `webview/main.ts` を IIFE 形式で `media/webview/bundle.js` にバンドル |
| `npm run copy-wasm` | `web-tree-sitter` / `tree-sitter-wasms` の `.wasm` を `media/wasm/` へコピー |
| `npm test` | 単体テスト実行(Vitest) |
| `npm run typecheck:tests` | テスト型チェック(`tsconfig.typecheck.json`、網羅 switch 検査含む) |
| `npm run test:integration` | ビルド後、`@vscode/test-electron` で拡張本体の統合テスト |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run package` | `apivista-{version}.vsix` を生成(`@vscode/vsce`) |

> `backend-analysis` は TypeScript + web-tree-sitter(WASM)で実装されています(旧 Python 実装は撤去済み)。解析対象の Python ソースは `tests/fixtures/sample_app/` にテスト入力としてのみ存在します。

---

## ビルドパイプライン

`npm run build` は次の 3 段を順に実行します。

1. **`tsc -p tsconfig.json`** — 拡張本体・解析器を `out/` へコンパイル
2. **`bundle:webview`** — `esbuild` で Webview を単独バンドル(`media/webview/bundle.js`)。Webview は `vscode` モジュールを実行時解決できないため、本体とは別バンドルにし、型のみを共有する
3. **`copy-wasm`** — Python 文法等の `.wasm` を `media/wasm/` へコピー。インストール済み拡張では `context.extensionUri` 経由でパス解決する

> `media/` は `.gitignore` 対象(ビルド生成物)です。拡張アイコンのような**コミットすべき静的資産**は `resources/`(例: `resources/icon.png`)に置きます。

---

## コード品質

- **TypeScript strict mode**。`any` を使用せず、境界では入力を検証する
- **ESLint(typescript-eslint) + Prettier**。`PostToolUse` フック(`.claude/hooks/format-on-edit.mjs`)が編集後に eslint/prettier を自動適用する
  - 注意: フックは新規 `let` を未再代入の時点で `const` に変換することがある。後から再代入を足すと `TS2588` になるため、再代入する変数は `let` のまま保つ

---

## テスト戦略(ブラウザ不使用・VSCode 上で完結)

| 対象 | 手法 |
| --- | --- |
| 拡張本体(アクティベーション・コマンド・ワークスペーススキャン・ファイル監視) | `@vscode/test-electron`(実 VSCode/Electron 起動)による統合テスト |
| Webview 内ロジック・解析ロジック | `vitest`(+ `jsdom`、`acquireVsCodeApi` はモック)による単体テスト |

- **ブラウザ E2E(Playwright 等)はプロダクションテストとして採用しません**。VSCode 拡張の Webview は Electron 内でホストされ、ブラウザ E2E は実環境との差異が大きいため
- ただし VSIX パッケージ検証・リリース前スクリーンショット取得には、`playwright-core` の `_electron` API を使った補助スクリプトを用います
- `svgRenderer` のような純描画モジュールは「目視確認」方針で、単体テストは設けず回帰(既存テストが壊れないこと)を主眼にします

---

## VSIX パッケージング

```bash
npm run package   # apivista-{version}.vsix を生成
```

- VSIX から除外すべきファイルは **`.vscodeignore`** で管理(`src/`・`tests/`・`.kiro/`・`.claude/`・`tsconfig*.json` 等)
- **依存の置き場所**:
  - `web-tree-sitter`(JS バインディング)は**実行時に必要**なため `dependencies`
  - `tree-sitter-wasms` は `.wasm` のコピーにのみ必要なため `devDependencies`(VSIX には含めない)
- 拡張アイコンは `package.json` の `"icon": "resources/icon.png"`(128×128 以上の正方形 PNG)

---

## ディレクトリ規約(`.claude/`)

| パス | 役割 |
| --- | --- |
| `.claude/rules/` | パス glob で対象ファイルに触れたときだけ読み込まれる「判断基準」。手順(How)ではなく判断基準(Why)を短く書く |
| `.claude/reports/` | 実装後の軽量な振り返り(`YYYY-MM-DD-<topic>.md`)。スペック実装完了後、特に手戻りが多かった点を記録 |
| `.claude/skills/kiro-*/` | Spec-Driven Development の各スキル(後述の [ai-driven-development.md](ai-driven-development.md) 参照) |
