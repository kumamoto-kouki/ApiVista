/**
 * 警告コレクター（design.md「warnings」）。
 *
 * 全 Pass が共有し、部分的失敗（構文エラー・静的解決不能）の理由を
 * `Warning{target, reason}` として挿入順に蓄積する。出力スキーマ準拠の形で取り出せる。
 */
import type { Warning } from "./models.js";

export class WarningCollector {
  private readonly entries: Warning[] = [];

  /**
   * 除外・診断の警告を記録する。
   *
   * @param target 対象識別子（fileId / functionId / ルート識別子など）
   * @param reason 機械可読な除外理由
   */
  record(target: string, reason: string): void {
    this.entries.push({ target, reason });
  }

  /**
   * 構文エラーによるファイルスキップを記録する。
   *
   * @param target 対象 fileId
   * @param detail 任意の補足（パーサ由来の詳細など）
   */
  recordParseError(target: string, detail?: string): void {
    const reason =
      detail === undefined || detail.length === 0 ? "syntax error" : `syntax error: ${detail}`;
    this.record(target, reason);
  }

  /** 蓄積済みの警告（挿入順）。出力スキーマの `warnings` に直接使える形。 */
  get warnings(): Warning[] {
    return [...this.entries];
  }
}
