# AI 駆動開発

本プロジェクトは **Agentic SDLC(エージェント型ソフトウェア開発ライフサイクル)** で構築されました。コード生成からレビュー・検証まで、すべてのフェーズで AI を中心的に活用しています。

---

## AI アシスタント

| ツール | モデル | 用途 |
| --- | --- | --- |
| **Claude Code**(Anthropic) | Sonnet 系 | 実装・リファクタリング・デバッグ・ドキュメント生成の主エンジン |
| **Claude**(Anthropic) | Opus 系 | 設計フェーズのアーキテクチャレビュー(`/kiro-spec-design`, `/kiro-validate-design`)・複雑な意思決定 |

> モデル方針: 実装タスクは既定で Sonnet、設計フェーズのレビューや複雑なアーキテクチャ判断に Opus を充てる(コスト/精度のバランス)。

---

## 開発方法論

| 方法論 | 説明 |
| --- | --- |
| **Kiro-style Spec-Driven Development** | Discovery → Requirements(EARS 形式) → Design → Tasks → Implementation の 5 フェーズで仕様を先に固めてから AI が実装する構造化手法 |
| **Agentic SDLC** | サブエージェントを並列ディスパッチして探索・実装・レビューを自律的に進めるワークフロー |

### ワークフロー

| フェーズ | 工程 | コマンド | 任意/必須 |
| --- | --- | --- | --- |
| Phase 0 | ステアリング整備 | `/kiro-steering`, `/kiro-steering-custom` | 任意 |
| Discovery | アイデア整理(→ `brief.md` / `roadmap.md`) | `/kiro-discovery "idea"` | 任意 |
| Phase 1 仕様化 | Requirements(EARS 形式) | `/kiro-spec-requirements` | 必須 |
| Phase 1 仕様化 | ギャップ検証 | `/kiro-validate-gap` | 任意 |
| Phase 1 仕様化 | Design | `/kiro-spec-design` | 必須 |
| Phase 1 仕様化 | 設計レビュー | `/kiro-validate-design` | 任意 |
| Phase 1 仕様化 | Tasks | `/kiro-spec-tasks` | 必須 |
| Phase 1 仕様化 | 一括作成(単一 / 複数スペック) | `/kiro-spec-quick` / `/kiro-spec-batch` | 任意 |
| Phase 2 実装 | Implementation | `/kiro-impl {feature} [tasks]` | 必須 |
| Phase 2 実装 | 実装再検証 | `/kiro-validate-impl` | 任意 |
| 進捗確認 | いつでも実行可 | `/kiro-spec-status {feature}` | 任意 |

- **3 フェーズ承認**: Requirements → Design → Tasks → Implementation。各フェーズで人間レビューを挟み、意図的な高速化のときだけ `-y` を使う
- **自律実装**: `/kiro-impl` をタスク番号なしで実行するとサブエージェント(タスクごと) + 独立レビュー + 最終検証の自律モード。番号付きはメインコンテキストでの手動モード(いずれもレビュアーゲートを通過してから完了)

---

## スキル

スキルは `.claude/skills/kiro-*/SKILL.md` に配置され、会話コンテキストにアクセスして inline で実行されます(必要に応じて並列リサーチをサブエージェントへ委譲)。

### 仕様化〜実装

| スキル | フェーズ | 役割 |
| --- | --- | --- |
| `kiro-discovery` | 発見 | アイデアからアクション経路を決定し、`brief.md` / `roadmap.md` を作成 |
| `kiro-spec-init` / `kiro-spec-requirements` | 要件定義 | EARS 形式の要件文書を生成 |
| `kiro-spec-design` | 設計 | アーキテクチャ設計・境界コミットメント定義 |
| `kiro-spec-tasks` | タスク化 | 実装タスクの分割と依存順序の整理 |
| `kiro-spec-quick` | 一括 | 単一スペックを要件→設計→タスクまで一気に作成 |
| `kiro-spec-batch` | 一括 | roadmap から依存ウェーブ順に複数スペックを並列作成 |
| `kiro-impl` | 実装 | タスク単位の自律実装(サブエージェント + レビュアー) |

### 検証・レビュー・品質ゲート

| スキル | 役割 |
| --- | --- |
| `kiro-validate-gap` | 既存コードベースに対する実装ギャップ分析 |
| `kiro-validate-design` | 技術設計の品質レビュー・検証 |
| `kiro-validate-impl` | 要件・設計・タスクに対する実装の検証(クロスタスク統合・要件カバレッジ) |
| `kiro-review` | タスク局所の敵対的レビュープロトコル(レビュアーサブエージェントが使用) |
| `kiro-debug` | 根本原因優先のデバッグプロトコル(デバッガーサブエージェントが使用) |
| `kiro-verify-completion` | 成功・完了主張の前に行う「新鮮な証拠」ゲート |
| `kiro-spec-status` | スペックの進捗確認(いつでも実行可) |
| `kiro-steering` / `kiro-steering-custom` | `.kiro/steering/` を永続プロジェクトメモリとして整備 |

---

## ステアリングとスペック

| パス | 役割 |
| --- | --- |
| `.kiro/steering/` | プロジェクト全体のルール・文脈(`product.md` / `tech.md` / `structure.md` 等)。プロジェクトメモリとして読み込まれる |
| `.kiro/specs/{feature}/` | 個別機能の要件・設計・タスク文書 |

本プロジェクトは技術領域ごとに **4 つのスペック**に分割されています(依存順)。全スペック実装済み。

| 順序 | スペック | 内容 | 依存 |
| --- | --- | --- | --- |
| 1 | `backend-route-extractor` | FastAPI を web-tree-sitter(WASM)で AST 解析し、ルート定義と呼び出しグラフを抽出 | なし |
| 2 | `frontend-call-extractor` | Nuxt.js(Vue/TS)を解析し、API 呼び出しと呼び出しグラフを抽出 | なし |
| 3 | `route-linkage-engine` | URL 静的マッチング + OpenAPI 照合でルート⇄呼び出しを連携付け、3 階層モデルを構築 | 1, 2 |
| 4 | `vscode-extension-ui` | 拡張本体と Webview によるグラフ可視化 | 3 |

抽出器(1, 2)は互いに依存せず並行実装が可能です。詳細は各スペックの `.kiro/specs/{feature}/` 配下のドキュメントを参照してください。

---

## ハーネスエンジニアリング

本プロジェクトは、AI エージェント(Claude Code)が**確実かつ一貫して動作するように、エージェントの動作環境(ハーネス)そのものを設計・運用する**「ハーネスエンジニアリング」を採用しています。プロンプトでその都度指示するのではなく、規約・フック・メモリ・ツールをリポジトリに資産として組み込み、エージェントの振る舞いを構造的に制御します。

| 要素 | 配置 | 役割 |
| --- | --- | --- |
| **フック(Hooks)** | `.claude/hooks/` + `settings.json` | ツール実行に介入する自動処理。`PostToolUse`(`Edit`/`Write`/`MultiEdit`)で `format-on-edit.mjs` を起動し、編集直後に eslint/prettier を自動適用する(失敗してもエージェントの作業を止めない非ブロッキング設計) |
| **ルール(Rules)** | `.claude/rules/` | パス glob で対象ファイルに触れたときだけ読み込まれる「判断基準」。手順(How)ではなく**判断基準(Why)**を短く書き、陳腐化を避ける。実装が先・ルール化は後(同じ判断を 2 回下す場面で切り出す) |
| **レポート(Reports)** | `.claude/reports/` | スペック実装後の軽量な振り返り(`YYYY-MM-DD-<topic>.md`)。手戻りの多かった点を記録し、ルール化の判断材料にする |
| **スキル(Skills)** | `.claude/skills/kiro-*/` | Spec-Driven Development の各工程を inline 実行する手続き(上記スキル表) |
| **サブエージェント(Agents)** | `.claude/agents/kiro/` | 探索・実装・レビューを並列ディスパッチする専用エージェント定義 |
| **スラッシュコマンド(Commands)** | `.claude/commands/kiro/` | `/kiro-*` の起動口 |
| **ステアリング(Steering)** | `.kiro/steering/` | プロジェクト全体のルール・文脈を永続メモリとして常時読み込む |
| **メモリ / MCP** | `.mcp.json` ほか | 永続メモリと外部ツール接続(下記) |

### 設計原則

- **非ブロッキング**: フック等の補助処理は、失敗してもエージェントの本作業を中断しない
- **判断基準を資産化**: 繰り返す判断はプロンプトではなくルール/ステアリングに固定し、文脈に応じて自動ロードする
- **証拠ベースの完了**: `kiro-verify-completion` で、成功・完了の主張前に新鮮な証拠(テスト緑・ビルド成功等)を要求する
- **ツールの最小化**: 既存ツール(`gh` CLI 等)と役割が重複する MCP サーバーは導入しない

---

## MCP サーバー構成

`.mcp.json` で以下の MCP サーバーを構成しています。ツール数の肥大化を避けるため、既存ツール(`gh` CLI や拡張思考)と役割が重複するサーバーは導入していません。

| サーバー | 起動 | 用途 |
| --- | --- | --- |
| `serena` | `uvx`(git+oraios/serena) | セマンティックなコード検索・編集(LSP ベース) |
| `context7` | `npx @upstash/context7-mcp` | ライブラリの最新ドキュメント取得(FastAPI/Pydantic/tree-sitter/Nuxt 等のバージョン追従) |
| `semgrep` | `uvx semgrep-mcp` | 静的解析による脆弱性スキャン(OWASP Top10 系) |

- **ブラウザ操作系 MCP(Playwright 等)は不採用**。Webview 検証は `@vscode/test-electron` と `vitest`+`jsdom` で VSCode 上で完結させる方針のため
- `context7` は API キーなしでも動作しますが、レート制限緩和のため任意で設定できます:

  ```bash
  export CONTEXT7_API_KEY="..."  # context7.com で取得(任意)
  ```

  設定変更後は Claude Code の再起動(MCP サーバー再接続)が必要です。
