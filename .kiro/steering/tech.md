# Technology Stack

## Architecture

ApiVista は単一の VSCode 拡張機能であり、全構成要素を **TypeScript で実装し拡張ホスト(Node.js / Electron)上で動作させる**。バックエンド(FastAPI/Python)・フロントエンド(Nuxt.js/Vue/TS)双方の静的解析も拡張ホスト内で完結させ、エンドユーザーに外部ランタイム(Python / uv 等)やネイティブモジュールの再ビルドを一切要求しない。

4つのスペックに分割される(依存順): `backend-route-extractor` → / `frontend-call-extractor` → `route-linkage-engine` → `vscode-extension-ui`。詳細は [roadmap.md](./roadmap.md) を参照。

## Core Technologies

- **Language**: TypeScript(strict mode)
- **Runtime**: VSCode 拡張ホスト(Node.js / Electron)。スタンドアロンの外部プロセスは持たない
- **Extension API**: VSCode Extension API

## Key Libraries

開発パターンに影響する主要ライブラリのみ記載する。

- **ts-morph**: フロントエンド(Nuxt.js Vue/TS)解析。純 JavaScript/TypeScript 実装でネイティブ依存なし。
- **web-tree-sitter(WASM)**: バックエンド(FastAPI/Python)解析。Python 文法は Microsoft 公式の [`@vscode/tree-sitter-wasm`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm) が提供するプリビルド `.wasm` を使用する。

## Development Standards

### Type Safety
- TypeScript strict mode。`any` を使用しない。境界では入力を検証する。

### Code Quality
- ESLint(typescript-eslint)+ Prettier。

### Testing
- **VSCode 上で完結させる(ブラウザ不使用)**:
  - 拡張本体(アクティベーション・コマンド・ワークスペーススキャン・ファイル監視)の統合テストは `@vscode/test-electron`(実 VSCode/Electron 起動)で行う。
  - Webview 内ロジック・解析ロジックの単体テストは `vitest`(+ `jsdom`、`acquireVsCodeApi` はモック)で行う。
  - ブラウザ操作による E2E(Playwright 等)は採用しない。VSCode 拡張の Webview は Electron 内でホストされ、ブラウザ E2E は実環境との差異が大きいため。

## Key Technical Decisions

### 「導入するだけで動く / 全OS動作」原則
- 全解析器は拡張ホスト上で動作し、**エンドユーザーに Python/uv 等の外部ランタイムやネイティブモジュールの再ビルドを要求しない**ことを最優先の制約とする。
- そのため Python 解析に **ネイティブ Node アドオン(node-tree-sitter 等)は不採用**。これらは VSCode の Electron ABI 向け再ビルドと OS/arch 別プリビルドバイナリ同梱が必須で、ABI 不一致やプラットフォーム別の読み込み失敗を招き「導入のみ動作」を壊すため。代わりに **WASM 版(web-tree-sitter)** を用いる(単一 `.wasm` で全OS同一動作、ネイティブコンパイル不要)。

### WASM の扱いの区別(混同しないこと)
- **実行ランタイムとしての WASM/WASI(`@vscode/wasm-wasi`)は不採用**: experimental かつ Web 拡張での有効化に既知問題があり、本プロジェクトの解析は Node ネイティブで足りるため。
- **ライブラリ実装としての WASM(web-tree-sitter)は採用**: パーサエンジンを WASM 化したライブラリにすぎず、通常の Node/拡張ホスト内で動作する。クロスプラットフォーム性のため採用。両者は別概念。

### 開発時ツールと配布物の区別
- 上記「外部ランタイム不要」原則は**配布される拡張機能のエンドユーザー実行**に対する制約である。
- 開発時のツール(`.mcp.json` の serena/semgrep が使う uvx、過去の ruff/pytest 等)はこの原則の対象外であり、開発者環境にのみ存在すればよい。

---
_Document standards and patterns, not every dependency_
