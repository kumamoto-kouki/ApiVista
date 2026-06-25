/**
 * 障害時に GitHub Issue へそのまま貼り付けられる Markdown エラーレポートを生成する純粋モジュール。
 *
 * - vscode / Node の副作用 API に依存しない純関数（`normalizeError` / `buildErrorReport`）として実装し、
 *   単体テストから直接検証できるようにする。環境値・ワークスペース情報は呼び出し側（extension.ts）が
 *   収集して `ErrorReportData` として渡す。
 * - 自動収集できる情報（種別・メッセージ・スタック・cause チェーン・各種バージョン・backend/frontend 有無）は
 *   埋め、自動取得できない項目（再現手順・期待/実際の動作・補足）は利用者が補記する記入欄として用意する。
 * - エラー種別は vscode 依存クラス（ScopeError 等）を import せず、`name`/`reason`/`cause` のダックタイピングで判定する。
 */

/** 正規化したエラー。`cause` を辿った連鎖を `causes[]` に保持する。 */
export interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
  causes: NormalizedError[];
}

/** レポートに載せる実行環境情報。 */
export interface EnvInfo {
  apiVista: string;
  vscode: string;
  os: string;
  node: string;
}

/** ワークスペース構成（backend/ frontend/ の有無のみ）。 */
export interface WorkspaceInfo {
  backend: boolean;
  frontend: boolean;
}

/** `buildErrorReport` への入力。`error` 未指定なら空テンプレートを生成する。 */
export interface ErrorReportData {
  /** 発生時の操作（コマンド名や進捗タイトル）。 */
  context: string;
  /** 発生日時（ISO 文字列）。 */
  occurredAt: string;
  error?: NormalizedError;
  env: EnvInfo;
  workspace?: WorkspaceInfo;
}

/** 任意の値が文字列プロパティを持つか安全に取り出す。 */
function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 任意の例外値を `NormalizedError` へ正規化する。
 *
 * - `Error`: name/message/stack を取り出す。`ScopeError` の `reason` のような付加フィールドは message に併記する。
 * - `AnalysisError` 等の `cause`（unknown）は再帰的に `causes[]` へ展開する。
 * - 文字列・その他: message に文字列化した値を入れ、name は "UnknownError" とする。
 */
export function normalizeError(error: unknown, seen: Set<unknown> = new Set()): NormalizedError {
  // 循環 cause からの保護。
  if (error !== null && typeof error === "object") {
    if (seen.has(error)) {
      return { name: "CircularError", message: "(循環参照のため省略)", causes: [] };
    }
    seen.add(error);
  }

  if (error instanceof Error) {
    const obj = error as unknown as Record<string, unknown>;
    let message = error.message;
    const reason = readString(obj, "reason");
    if (reason !== undefined) message = `${message} (reason: ${reason})`;

    const causes: NormalizedError[] = [];
    if ("cause" in obj && obj.cause !== undefined && obj.cause !== null) {
      causes.push(normalizeError(obj.cause, seen));
    }
    return {
      name: error.name || "Error",
      message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
      causes,
    };
  }

  if (typeof error === "string") {
    return { name: "UnknownError", message: error, causes: [] };
  }

  let message: string;
  try {
    message = JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: "UnknownError", message, causes: [] };
}

/** スタック＋cause チェーンを 1 つのテキストへ連結する。 */
function renderStackChain(error: NormalizedError): string {
  const blocks: string[] = [];
  const walk = (e: NormalizedError, prefix: string): void => {
    const head = prefix === "" ? "" : `${prefix}: `;
    blocks.push(`${head}${e.stack ?? `${e.name}: ${e.message}`}`);
    for (const c of e.causes) walk(c, "Caused by");
  };
  walk(error, "");
  return blocks.join("\n\n");
}

const FILL_IN = "<!-- ここに記入してください -->";

/**
 * `ErrorReportData` から Markdown エラーレポートを生成する。
 * `error` が未指定の場合は記入欄中心の空テンプレートを返す。
 */
export function buildErrorReport(data: ErrorReportData): string {
  const { context, occurredAt, error, env, workspace } = data;
  const lines: string[] = [];

  lines.push("# ApiVista エラーレポート");
  lines.push("");
  lines.push(
    "> このレポートをそのまま Issue に貼り付けてください。`<!-- -->` の項目は分かる範囲で記入してください（任意）。",
  );
  lines.push("");

  lines.push("## 発生状況");
  lines.push("");
  lines.push(`- 操作: ${context}`);
  lines.push(`- 日時: ${occurredAt}`);
  lines.push("");

  if (error) {
    lines.push("## エラー内容");
    lines.push("");
    lines.push(`- 種別: \`${error.name}\``);
    lines.push(`- メッセージ: ${error.message}`);
    lines.push("");
    lines.push("<details><summary>スタックトレース</summary>");
    lines.push("");
    lines.push("```");
    lines.push(renderStackChain(error));
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("## 環境");
  lines.push("");
  lines.push("| 項目 | 値 |");
  lines.push("| --- | --- |");
  lines.push(`| ApiVista | ${env.apiVista} |`);
  lines.push(`| VSCode | ${env.vscode} |`);
  lines.push(`| OS | ${env.os} |`);
  lines.push(`| Node | ${env.node} |`);
  lines.push("");

  if (workspace) {
    lines.push("## ワークスペース構成");
    lines.push("");
    lines.push(`- backend/: ${workspace.backend ? "あり" : "なし"}`);
    lines.push(`- frontend/: ${workspace.frontend ? "あり" : "なし"}`);
    lines.push("");
  }

  lines.push("## 再現手順");
  lines.push("");
  lines.push(FILL_IN);
  lines.push("");
  lines.push("## 期待した動作");
  lines.push("");
  lines.push(FILL_IN);
  lines.push("");
  lines.push("## 実際の動作");
  lines.push("");
  lines.push(FILL_IN);
  lines.push("");
  lines.push("## 補足情報");
  lines.push("");
  lines.push("<!-- スクリーンショット、対象プロジェクトの特徴など、あれば記入してください -->");
  lines.push("");

  return lines.join("\n");
}
