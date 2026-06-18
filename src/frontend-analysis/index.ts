/**
 * 公開API（design.md「index — analyzeFrontend」, Requirements 3.1, 5.1, 5.2, 5.3, 5.4）。
 *
 * `frontendRoot` を受け取り、Pass0（buildProject / buildFileMap）→ Pass1+Pass2（extractPerFile /
 * buildCallGraph / deriveFileGraph / annotateApiCalls）→ Assembler を順に実行し、単一の
 * `AnalysisOutput`（`schemaVersion=1`）を返す拡張ホスト内インプロセス公開API。
 *
 * - 対象コードは実行せず**静的解析のみ**（ts-morph / @vue/compiler-sfc で AST 化するだけ。Req5.2）。
 * - 対象プロジェクトの依存インストールを前提としない（ts-morph はインメモリ・依存解決スキップで
 *   ベストエフォート解決。Req5.3）。
 * - ts-morph / @vue/compiler-sfc は純JS のため外部ランタイム/ネイティブ再ビルド不要で Node 単独で完走
 *   する。同期 API（ts-morph 同期 = 非 async）。Req5.4。
 * - 解析自体が成立すれば、部分的失敗（構文/SFC エラー・動的 URL/method）は `warnings` に記録した
 *   うえで正常に値を返す（throw しない。Req4.x）。
 * - 引数不正（`frontendRoot` が存在しない / ディレクトリでない）のみ `Error` を throw する（Req5.1）。
 * - 決定性: ファイル走査は fileId 昇順で固定（buildProject / extractPerFile が担保）。同一入力→同一出力。
 *
 * 本モジュールは各 Pass（project / fileMap / resolver / assemble / warnings）を **import 利用のみ**で
 * オーケストレーションし、抽出ロジックを再実装しない。
 */
import { statSync } from "node:fs";

import { assembleOutput } from "./assemble.js";
import { buildFileMap } from "./fileMap.js";
import { buildProject } from "./project.js";
import {
  annotateApiCalls,
  buildCallGraph,
  deriveFileGraph,
  extractPerFile,
} from "./resolver/callGraph.js";
import { WarningCollector } from "./warnings.js";

import type { AnalysisOutput } from "./models.js";

// 消費側（route-linkage-engine / vscode-extension-ui）がパッケージ入口から型を import
// できるよう、出力契約の公開型・定数を再エクスポートする（backend index.ts と対称）。
export type {
  AnalysisOutput,
  ApiCall,
  FileNode,
  FunctionNode,
  SourceLocation,
  Warning,
} from "./models.js";
export { SCHEMA_VERSION } from "./models.js";

/** `analyzeFrontend` のオプション（design.md「AnalyzeFrontendOptions」）。 */
export interface AnalyzeFrontendOptions {
  /** 解析対象拡張子の上書き等（任意・将来拡張用）。既定は .ts/.js/.vue。 */
  include?: string[];
}

/**
 * `frontendRoot` が解析可能なディレクトリであることを検証する（Req5.1）。
 * 存在しない / ディレクトリでない場合は `Error` を throw する。対象コードは実行しない（同期 stat のみ）。
 */
function assertFrontendRoot(frontendRoot: string): void {
  let stats;
  try {
    stats = statSync(frontendRoot);
  } catch {
    throw new Error(`frontendRoot does not exist: ${frontendRoot}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`frontendRoot is not a directory: ${frontendRoot}`);
  }
}

/**
 * `frontendRoot` 配下の Nuxt（Vue3/TS/JS）コードを静的解析し、単一の `AnalysisOutput` を返す（同期）。
 *
 * @param frontendRoot 解析対象 frontend ルートの絶対パス（存在するディレクトリであること）
 * @param _options 将来拡張用オプション（`include` は v1 未配線・無視。検証もしない）
 * @returns `schemaVersion=1` の単一 `AnalysisOutput`（部分的失敗は `warnings` に記録）
 * @throws `frontendRoot` が存在しない / ディレクトリでない場合
 */
export function analyzeFrontend(
  frontendRoot: string,
  _options?: AnalyzeFrontendOptions,
): AnalysisOutput {
  assertFrontendRoot(frontendRoot);

  // `_options.include` は v1 では未配線（将来拡張用）。project.ts が .ts/.js/.vue を固定で走査する
  // ため、現状は受け取っても無視する（バリデーションもしない）。署名は design 公開契約・backend 対称
  // のため残すが本文では未使用であることを明示する。
  void _options;

  const collector = new WarningCollector();

  // Pass0: ts-morph Project 構築（.vue は抽出スクリプトを仮想 .ts 化。SFC エラーは skip+警告）。
  const project = buildProject(frontendRoot, collector);

  // Pass0: ファイルマップ（fileId 集合・エクスポート名/コンポーネント名索引。.ts/.js 構文エラーは skip+警告）。
  const fileMap = buildFileMap(frontendRoot, project, collector);

  // Pass1: 各ファイルの API 呼び出し / 定義 / 呼び出し式 / template 参照を抽出（skip を尊重）。
  const perFile = extractPerFile(project, fileMap, collector);

  // Pass2: 有向呼び出しグラフ → ファイル単位グラフ → API 呼び出しを内包ノードへ注釈。
  const functions = buildCallGraph(perFile, fileMap, project);
  const files = deriveFileGraph(functions);
  const apiCalls = annotateApiCalls(perFile);

  // Assembler: 単一の AnalysisOutput（schemaVersion=1）へ統合（Req3.1）。
  return assembleOutput(apiCalls, functions, files, collector.warnings);
}
