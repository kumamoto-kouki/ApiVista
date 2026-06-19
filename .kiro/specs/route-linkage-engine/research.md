# Research & Design Decisions: route-linkage-engine

## Summary
- **Feature**: `route-linkage-engine`(spec 3)
- **Discovery Scope**: New Feature(greenfield)。ただし入力契約は完成済みの backend-route-extractor / frontend-call-extractor の `AnalysisOutput`(`src/{backend,frontend}-analysis/models.ts`)で確定済み。外部依存・新ライブラリ・ネイティブ依存は無く、純TSのデータ変換ロジック。よって外部 discovery は不要で、既存契約の精読と統合設計の synthesis が中心。
- **Key Findings**:
  - 連携判定の主軸は **URLパス(パスパラメータ正規化)+ HTTPメソッド**。frontend `ApiCall` はスキーマ情報を持たないため、**OpenAPIスキーマ照合による絞り込みは v1 非対応**(backend `schemaRefs` は表示用付帯のみ)。
  - backend と frontend の `FunctionNode.id` / `FileNode` は**同一のID形式**(`<module>:<qualname>` / 相対POSIXパス)を使うため、統合時に**衝突しうる**。side 接頭辞による名前空間化が必須(Req5.6)。
  - frontend が委譲した **baseURL/相対パス正規化**は本specの責務(frontend requirements で明示)。設定情報源が無いため、正規化後セグメント列の **suffix 一致**で baseURL 接頭辞差を吸収する。

## Research Log

### 入力契約(両 AnalysisOutput)の精読
- **Context**: 本specは抽出を行わず、両抽出器の出力のみを入力にする。型は `src/backend-analysis/models.ts` と `src/frontend-analysis/models.ts`。
- **Findings**:
  - backend `AnalysisOutput { schemaVersion, routes: RouteDefinition[], functions: FunctionNode[], files: FileNode[], warnings }`。`RouteDefinition { method, path(prefix結合済み完全パス・名前付き `{name}` プレースホルダ), handler: SourceLocation, entryFunctionId, schemaRefs: SchemaReference[] }`。
  - frontend `AnalysisOutput { schemaVersion, apiCalls: ApiCall[], functions, files, warnings }`。`ApiCall { method, urlPattern(テンプレートリテラル正規化済み・匿名 `{}` プレースホルダ), enclosingFunctionId, location }`。**schemaRefs なし**。
  - `FunctionNode { id: "<module>:<qualname>", name, file, location, calls: string[] }`、`FileNode { id===path, dependsOn: string[] }`、`Warning { target, reason }`、`SourceLocation { file, line }` は両者**同形**。
- **Implications**: 本specは型安全のため両 `models.ts` から **型のみ import**(read-only、挙動結合なし)。出力型は `src/route-linkage/models.ts` に新設。プレースホルダ表記が backend=名前付き `{name}` / frontend=匿名 `{}` で異なる点が、パスマッチング正規化の核心。

### URLパスマッチングアルゴリズム
- **Context**: ルート⇄API呼び出しの対応を静的に判定する(Req2)。
- **Decision**:
  - **正規化 `canonicalize(path) → string[]`**: `/` で分割し空要素を除去、各セグメントが動的(`{name}` または `{}`)なら `"{}"` ワイルドカードへ畳む(パラメータ名非依存=Req2.2)。
  - **メソッド一致**: 双方を大文字化して厳密一致。
  - **判定 `matchKind(routePath, apiUrlPattern): "exact" | "suffix" | null`**:
    - セグメント等価 `segEq(x,y) = (x===y) || x==="{}" || y==="{}"`。
    - 全長一致で全セグメント等価 → `"exact"`。
    - 短い方が長い方の**末尾**(suffix)に整合 → `"suffix"`(先頭の baseURL/共通プレフィックス差を吸収=Req2.3)。
    - それ以外 → `null`(非連携)。
- **Rationale**: 設定情報源(baseURL定義)が入力に無いため、suffix 一致が「相対/baseURL差の吸収」を設定なしで近似する最も素直で決定的な規則。`matchKind` を結果に残し UI が確度を区別できる。
- **Risk/Mitigation**: suffix 一致は過剰マッチ(短いパスが多数のルートに一致)を生みうる。→ 多重一致は全保持(Req3.1)し `matchKind` と診断で区別、誤った単一化はしない。`exact` を優先表現。

### ID名前空間化(衝突回避)
- **Context**: backend/frontend の `FunctionNode.id`・`FileNode.id` が同形式で衝突しうる(Req5.6)。
- **Decision**: 統合データ内の全ノードID・参照(`calls[]`/`dependsOn[]`/`entryFunctionId`/`enclosingFunctionId`/`FunctionNode.file`)に side 接頭辞を付与する: `"backend:" + originalId` / `"frontend:" + originalId`。各ノードに `side: "backend"|"frontend"` を保持。
- **Implications**: 参照貫通(Req5.4)は「名前空間化後のID」で一貫させる。元IDは接頭辞を剥がせば復元可能(可逆)。これにより両側のグラフを単一配列に統合しても一意。

### 出力モデル(3階層統合)
- **Context**: vscode-extension-ui が階層1/2/3 + ソースジャンプで参照(Req5/6)。
- **Decision**: `LinkageOutput { schemaVersion, linkages, unmatchedRoutes, unmatchedApiCalls, functions, files, warnings }`。
  - `RouteLinkage { route: RouteRef, apiCall: ApiCallRef, matchKind }`(階層1。matched ペア。多重一致は複数 linkage)。
  - `RouteRef`(backend由来: method/path/handler/entryFunctionId[名前空間化]/schemaRefs[付帯])、`ApiCallRef`(frontend由来: method/urlPattern/enclosingFunctionId[名前空間化]/location)。
  - `unmatchedRoutes`/`unmatchedApiCalls`(Req3.2/3.3)。
  - `functions`(階層3)/`files`(階層2)= 両側統合・名前空間化・`side` 付き。
  - `warnings` = 両入力の警告 + 本エンジン診断(多重一致/未連携 等)を集約(Req6.3)。
- **schemaVersion**: 本specの出力は独自スキーマのため `SCHEMA_VERSION=1` を route-linkage 独自に定義(入力の schemaVersion とは別軸。Req6.2)。

### 共有型(`src/shared/`)の扱い — build vs adopt
- **Context**: backend/frontend が `FunctionNode`/`FileNode`/`Warning`/`SourceLocation`/`SCHEMA_VERSION` を**重複定義**。route-linkage が両方を消費するため DRY の契機。
- **Decision(synthesis)**: **v1 では `src/shared/` への物理統合は行わない**。route-linkage は両 `models.ts` から**型のみ import**して入力を受け、出力型は自前定義する。理由:
  - 共通型を `src/shared/` へ移すには**完成済み2スペック(backend/frontend)のソースを改変**し、両者の vitest/tsc/eslint・`/kiro-validate-impl` を再検証する必要があり、回帰リスクとコストが高い。
  - 型のみ import は挙動結合を生まず、roadmap の依存方向(抽出器→連携エンジン)とも一致。
  - → `src/shared/` 統合は**将来のリファクタ候補**として記録し、再検証トリガ(共通スキーマ変更時)に紐づける。本spec内では `src/route-linkage/models.ts` の出力型に集中する。

## Risks & Mitigations
- リスク: suffix マッチの過剰一致 → 対応: 多重一致を全保持し `matchKind`/診断で区別、UIに判断を委ねる(誤単一化しない)。
- リスク: 両側ID衝突 → 対応: side 接頭辞で名前空間化(可逆)。
- リスク: 入力スキーマ変更(backend/frontend の `AnalysisOutput` 改訂)→ 対応: 入力検証(`schemaVersion=1`・必須配列)で早期失敗(Req1.2)。再検証トリガに明記。
- リスク: frontend スキーマ情報の将来追加で disambiguation 要望 → 対応: v1 は付帯のみ、将来拡張として保留(再検証トリガ)。

## References
- 入力契約: `src/backend-analysis/models.ts` / `src/frontend-analysis/models.ts`(`AnalysisOutput`・ID体系・対称スキーマ)
- frontend-call-extractor requirements(baseURL/相対パス正規化を route-linkage へ委譲する旨)・research.md(`src/shared/` を route-linkage 着手時の将来候補と記録)
- 恒久方針 [.kiro/steering/tech.md](../../steering/tech.md)(TS・拡張ホスト・静的・外部ランタイム不要・vitest)
- 振り返り [.claude/reports/2026-06-19-frontend-call-extractor.md](../../../.claude/reports/2026-06-19-frontend-call-extractor.md)(共通 rules / `src/shared/` 統合は本spec で判断、と記録)
