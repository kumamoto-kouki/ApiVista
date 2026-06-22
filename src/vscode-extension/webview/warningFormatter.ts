import type { Warning } from "../../route-linkage/models.js";

export type WarningKind = "unmatched" | "excluded" | "parse";

export const WARNING_KIND_COLOR: Record<WarningKind, string> = {
  unmatched: "#f14c4c",
  excluded: "#d7ba7d",
  parse: "#e0944a",
};

const REASON_JA: Record<string, string> = {
  "unmatched-api-call": "未連携のAPIコール",
  "unmatched-route": "未連携のルート",
  "dynamic-url-unsupported": "URLを静的に解決できません",
  "multiple-route-match": "複数のルートに一致するAPIコール",
  "unsupported-decorator": "未対応のデコレーター",
};

export function translateReason(reason: string): string {
  if (REASON_JA[reason]) return REASON_JA[reason];
  const r = reason.toLowerCase();
  if (r.startsWith("syntax error")) {
    const detail = reason.replace(/^syntax error:?\s*/i, "").trim();
    if (!detail) return "構文エラー";
    if (detail.toLowerCase().includes("missing end tag")) return "構文エラー：終了タグがありません";
    return `構文エラー：${detail}`;
  }
  if (r.includes("excluded api call") || (r.includes("excluded") && r.includes("url"))) {
    return "除外：URLを静的に決定できません";
  }
  if (
    r.includes("statically resolved") ||
    r.includes("statically determined") ||
    r.includes("statically determinable") ||
    r.includes("not statically")
  ) {
    return "ルートパスを静的に解決できません";
  }
  return reason;
}

export function inferWarningKind(warning: Warning): WarningKind {
  const r = warning.reason;
  if (r === "dynamic-url-unsupported" || r === "multiple-route-match") return "excluded";
  if (r === "unsupported-decorator") return "parse";
  if (r.includes("除外") || r.includes("静的") || r.includes("URL")) return "excluded";
  if (r.includes("構文") || r.includes("解析") || r.includes("エラー") || r.includes("error"))
    return "parse";
  return "unmatched";
}
