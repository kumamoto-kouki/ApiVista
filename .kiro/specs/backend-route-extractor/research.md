# Research & Design Decisions: backend-route-extractor

## Summary
- **Feature**: `backend-route-extractor`
- **Discovery Scope**: New Feature (greenfield)
- **Key Findings**:
  - libcst単体では複数ファイルにまたがる`include_router`チェーンやimport越えの呼び出しグラフを解決できない。自前のモジュールマップ構築を前提とした多段パス設計が必要
  - 出力スキーマはPydantic `model_json_schema()`を正とし、再帰構造(呼び出しグラフ)はネストではなくID参照のエッジリストとして表現することで、JSON Schema生成・downstream TS型生成の既知の落とし穴を回避できる
  - CLIの入出力契約(stdout=JSON専用、stderr=ログ、errors/warningsをJSON内に構造化、終了コードは「実行可否」のみを表す)は、route-linkage-engine/vscode-extension-uiとの連携を見据えて本specで確定しておくべき

## Research Log

### libcstによるFastAPI解析パターン
- **Context**: ルートデコレータ抽出、prefixチェーン解決、呼び出しグラフ構築、Pydanticスキーマ参照抽出、構文エラー時の部分実行をlibcstで実現する方法を調査
- **Sources Consulted**: libcst公式ドキュメント(matchers, metadata.ScopeProvider/FullyQualifiedNameProvider), libcst APIリファレンス
- **Findings**:
  - デコレータ抽出は`MatcherDecoratableVisitor`+`libcst.matchers`で十分(`CSTTransformer`は不要)。`m.SimpleString()`はクオート込み文字列を返すため別途クオート除去が必要
  - `FullyQualifiedNameProvider`/`ScopeProvider`は単一ファイル内のシンボル解決には有効だが、`include_router`のprefix値の伝播・集約や`__init__.py`経由のre-exportは追えない
  - `libcst.parse_module()`は構文エラー時に`ParserSyntaxError`(独立クラス、`SyntaxError`を継承しない)を投げる。bytesのまま渡すことでエンコーディングcookie検出をlibcstに委ねられる
  - `MetadataWrapper`はノードのディープコピーを伴いコストが高い。読み取り専用解析では`unsafe_skip_copy=True`が利用可能
  - 前方参照文字列アノテーション・ワイルドカードimport・`TYPE_CHECKING`ブロック・動的importは`ScopeProvider`の解決対象外(既知の限界として受容)
- **Implications**:
  - 「Pass0: 自前モジュールマップ構築 → Pass1: 各ファイル抽出(MetadataWrapper+ScopeProvider, unsafe_skip_copy) → Pass2: ルートパス解決+呼び出しグラフ構築」の3段構成を採用
  - 解決できないケース(前方参照アノテーション、動的import等)はベストエフォートとし、解決不能な場合は`warnings`に記録して処理を継続する設計とする

### 出力スキーマとPython-TS連携
- **Context**: Pydanticモデルベースの出力スキーマをJSON Schema化し、downstreamのTS型生成・CLI呼び出し契約をどう設計すべきかを調査
- **Sources Consulted**: Pydantic v2公式ドキュメント(`model_json_schema`, `ConfigDict`), json-schema-to-typescript, Ruff/mypy VSCode拡張の呼び出しパターン, Semgrep/mypy/RuffのCLI出力設計
- **Findings**:
  - Pydantic v2の`Optional[X]`は`anyOf: [X, null]`形式。discriminated unionをリスト要素やネストモデルに直接使うと既知のスキーマ生成バグ(GitHub issue #8628, #6884)に当たる
  - `pydantic2ts`等の自動ラッパーは保守停滞傾向。`model_json_schema()` → `json-schema-to-typescript`の直接連携が安定
  - Ruff拡張は「ワークスペースのPython環境を一切見ない」方式でバンドル版を使用し、信頼されていないワークスペースでも安全。mypy拡張はアクティブなPython環境に依存し依存衝突の既知issueがある
  - Semgrepはstdoutに進捗文字列が混入しダウンストリームのJSONパースが壊れる既知の問題がある → stdoutはJSON専用にすべき
- **Implications**:
  - 呼び出しグラフはネスト再帰構造を避け、`functions[].calls`(関数ID配列)・`files[].dependsOn`(ファイルID配列)というエッジリスト形式で表現する(discriminated union問題の回避、循環参照の安全な表現)
  - 全モデルに`extra="forbid"`を設定し、閉じたJSON Schema/TS型を生成可能にする
  - CLIはstdout=JSON専用、stderr=ログ、`errors`/`warnings`はJSON内の構造化配列、終了コードは「解析自体の実行可否」のみを表す設計とする
  - CLIのバンドル・実行環境(uv/uvx等)はvscode-extension-uiの責務として本specのOut of Boundaryに明記(Ruff方式の知見はそちらに引き継ぐ)

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 単一パス(ファイル単位で完結) | 各ファイルを独立に解析し即座に結果を出力 | シンプル、並列化容易 | `include_router`のprefixチェーンやimport越えの呼び出し解決が不可能 | 要件1.2/1.3/3.1-3.3を満たせず不採用 |
| 多段パス(Pass0モジュールマップ→Pass1抽出→Pass2解決) | プロジェクト全体のモジュールマップを先に構築し、後続パスでクロスファイル解決を行う | クロスファイル解決が可能、各パスの責務が明確 | パス間の中間データ構造の設計が必要 | **採用**。libcst metadata providerの限界を自前ロジックで補う |
| FullRepoManager + TypeInferenceProvider(Pyre) | libcstのフルリポジトリ機能と型推論を併用 | より正確な型解決 | 初期化コストが高い、Pyre依存の追加、`backend/`外パッケージのインストール不要という制約(6.3)と相反 | 不採用 |

## Design Decisions

### Decision: 呼び出しグラフをID参照のエッジリストとして表現する
- **Context**: 関数単位・ファイル単位の呼び出しグラフ(要件3.1-3.3)をJSON出力としてどう表現するか
- **Alternatives Considered**:
  1. 各関数ノードに子ノードをネストした再帰木構造
  2. フラットな`functions`/`files`リスト + ID参照によるエッジリスト(`calls`/`dependsOn`)
- **Selected Approach**: 2を採用。`functions[].calls: list[str]`(関数ID)、`files[].dependsOn: list[str]`(ファイルID)
- **Rationale**: 再帰木構造はPydantic JSON Schema生成時の循環参照・discriminated union問題(research.md参照)に当たりやすく、また同一関数が複数ルートから呼ばれる場合に重複表現となる。エッジリストは循環呼び出しも安全に表現でき、3階層(ルート/ファイル/関数)間のID参照(要件4.2)とも自然に整合する
- **Trade-offs**: 消費側(route-linkage-engine/vscode-extension-ui)はID解決のための索引構築が必要になるが、JSONのシンプルさ・安全性の方が優先度が高い
- **Follow-up**: route-linkage-engine設計時に、このID参照形式が連携マッチングの入力として十分か再確認する

### Decision: CLI出力契約(stdout=JSON専用、warnings配列、終了コード)
- **Context**: 対象プロジェクトの依存未インストールやコードの問題は日常的に発生するため、これらをどう報告するか
- **Alternatives Considered**:
  1. 解析失敗を非0終了コードで表現し、stderrに詳細を出力
  2. stdoutのJSON内に`warnings`/`errors`配列として構造化し、終了コードは「解析実行自体の可否」のみを表す
- **Selected Approach**: 2を採用
- **Rationale**: ファイル単位の構文エラーやルートのパス未解決は「データの一部」であり、ツール自体の異常ではない。機械可読な形でJSON内に残すことで、vscode-extension-ui側でVSCode診断として表示できる
- **Trade-offs**: CLI呼び出し側は終了コードだけでなくJSON内の`warnings`も確認する必要がある
- **Follow-up**: vscode-extension-ui設計時に、`warnings`の`target`フィールド(ファイルパス/ルート識別子)からVSCode診断へのマッピング方法を検討する

## Risks & Mitigations
- リスク: `include_router`が条件分岐内で呼ばれる等、静的解析で追えないルーター構成が実プロジェクトに存在する — 対応: そのようなルートは完全パス未解決として`warnings`に記録し処理を継続する(5.2)設計により、ツール全体のクラッシュを避ける
- リスク: メソッド呼び出し(`self.repo.get_user()`)は型推論なしでは呼び出し先を特定できない — 対応: 設計上は属性アクセス経由の呼び出しをベストエフォートとし、解決不能な場合は呼び出しグラフに含めない(終端扱い)。実装時にfixtureで挙動を明確化する
- リスク: Pydantic v2のJSON Schema出力が将来バージョンで変わる可能性 — 対応: `schemaVersion`フィールドで出力契約を明示し、変更時はバージョンをインクリメントする

## References
- libcst公式ドキュメント(matchers, metadata.ScopeProvider, FullyQualifiedNameProvider) — Pass設計の根拠
- Pydantic v2 `model_json_schema` ドキュメント — Optional/discriminated unionの出力形式に関する既知の制約
- json-schema-to-typescript — JSON SchemaからTS型生成の標準的な選択肢(downstream specで利用)
