/**
 * errorReport（純粋なエラーレポート生成）の単体テスト。
 * vscode 非依存のため、フェイクを使わずに直接検証できる。
 */
import { describe, expect, it } from "vitest";

import {
  buildErrorReport,
  normalizeError,
  type EnvInfo,
  type ErrorReportData,
} from "../errorReport.js";

const ENV: EnvInfo = {
  apiVista: "0.1.0",
  vscode: "1.99.0",
  os: "linux 6.0.0",
  node: "v20.0.0",
};

function makeData(overrides: Partial<ErrorReportData>): ErrorReportData {
  return {
    context: "ルート連携グラフを表示",
    occurredAt: "2026-06-26T00:00:00.000Z",
    env: ENV,
    workspace: { backend: true, frontend: true },
    ...overrides,
  };
}

describe("normalizeError", () => {
  it("Error の name/message/stack を取り出す", () => {
    const err = new Error("boom");
    const n = normalizeError(err);
    expect(n.name).toBe("Error");
    expect(n.message).toBe("boom");
    expect(n.stack).toContain("boom");
    expect(n.causes).toEqual([]);
  });

  it("ScopeError 風の reason フィールドを message に併記する", () => {
    class ScopeError extends Error {
      constructor(
        public readonly reason: string,
        message: string,
      ) {
        super(message);
        this.name = "ScopeError";
      }
    }
    const n = normalizeError(new ScopeError("missing-backend", "backend/ がありません"));
    expect(n.name).toBe("ScopeError");
    expect(n.message).toContain("backend/ がありません");
    expect(n.message).toContain("reason: missing-backend");
  });

  it("AnalysisError 風の cause を再帰的に causes へ展開する", () => {
    class AnalysisError extends Error {
      constructor(
        public readonly cause: unknown,
        message: string,
      ) {
        super(message);
        this.name = "AnalysisError";
      }
    }
    const inner = new Error("root cause");
    const n = normalizeError(new AnalysisError(inner, "解析に失敗しました"));
    expect(n.name).toBe("AnalysisError");
    expect(n.causes).toHaveLength(1);
    expect(n.causes[0]!.message).toBe("root cause");
  });

  it("文字列や非 Error を落とさずに正規化する", () => {
    expect(normalizeError("just a string").message).toBe("just a string");
    expect(normalizeError("just a string").name).toBe("UnknownError");
    expect(normalizeError({ code: 42 }).message).toContain("42");
  });

  it("循環 cause を安全に打ち切る", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(() => normalizeError(a)).not.toThrow();
  });
});

describe("buildErrorReport", () => {
  it("エラーありレポートに種別・メッセージ・スタック・環境・記入欄を含む", () => {
    const error = normalizeError(
      Object.assign(new Error("解析に失敗しました"), { name: "AnalysisError" }),
    );
    const md = buildErrorReport(makeData({ error }));

    expect(md).toContain("# ApiVista エラーレポート");
    expect(md).toContain("- 操作: ルート連携グラフを表示");
    expect(md).toContain("`AnalysisError`");
    expect(md).toContain("解析に失敗しました");
    expect(md).toContain("<details><summary>スタックトレース</summary>");
    expect(md).toContain("| ApiVista | 0.1.0 |");
    expect(md).toContain("| VSCode | 1.99.0 |");
    expect(md).toContain("## 再現手順");
    expect(md).toContain("<!-- ここに記入してください -->");
  });

  it("cause チェーンのスタックを Caused by として連結する", () => {
    const inner = new Error("inner");
    inner.stack = "InnerStack";
    const outer = Object.assign(new Error("outer"), { name: "AnalysisError", cause: inner });
    const md = buildErrorReport(makeData({ error: normalizeError(outer) }));
    expect(md).toContain("Caused by");
    expect(md).toContain("InnerStack");
  });

  it("ワークスペース構成の有無を反映する", () => {
    const md = buildErrorReport(makeData({ workspace: { backend: true, frontend: false } }));
    expect(md).toContain("- backend/: あり");
    expect(md).toContain("- frontend/: なし");
  });

  it("workspace 省略時は構成セクションを出さない", () => {
    const md = buildErrorReport(makeData({ workspace: undefined }));
    expect(md).not.toContain("## ワークスペース構成");
  });

  it("error 未指定（空テンプレート）では記入欄を出すがスタックは出さない", () => {
    const md = buildErrorReport(makeData({ error: undefined, context: "手動作成" }));
    expect(md).not.toContain("## エラー内容");
    expect(md).not.toContain("スタックトレース");
    expect(md).toContain("## 再現手順");
    expect(md).toContain("## 期待した動作");
    expect(md).toContain("## 実際の動作");
    expect(md).toContain("## 補足情報");
    expect(md).toContain("<!-- ここに記入してください -->");
  });
});
