/**
 * 警告コレクター（design.md「warnings」。backend `src/backend-analysis/warnings.ts` と同流儀）。
 *
 * 全 Pass が共有し、部分的失敗（構文/SFC エラー・動的 URL/method の除外・未解決 callee）の
 * 理由を `Warning{target, reason}` として挿入順に蓄積する。出力スキーマ準拠の形で取り出せる。
 *
 * `extractSfc`（sfc.ts）/ `buildProject`（project.ts）が要求する構造的契約
 * （`record` / `recordParseError`）を満たす正準実装。
 */
import type { Warning } from "./models.js";

export class WarningCollector {
  private readonly entries: Warning[] = [];

  /**
   * 除外・診断の警告を記録する（Req4.3）。
   *
   * @param target 対象識別子（fileId / functionId / API 呼び出し識別子など）
   * @param reason 機械可読な除外理由
   */
  record(target: string, reason: string): void {
    this.entries.push({ target, reason });
  }

  /**
   * 構文/SFC パースエラーによるファイルスキップを記録する（Req4.1）。
   *
   * @param target 対象 fileId
   * @param detail 任意の補足（パーサ由来の詳細など）
   */
  recordParseError(target: string, detail?: string): void {
    const reason =
      detail === undefined || detail.length === 0 ? "syntax error" : `syntax error: ${detail}`;
    this.record(target, reason);
  }

  /** 蓄積済みの警告（挿入順）。出力スキーマの `warnings` に直接使える防御的コピー。 */
  get warnings(): Warning[] {
    return [...this.entries];
  }
}
