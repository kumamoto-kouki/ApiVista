/**
 * 拡張ホスト⇄Webview間メッセージプロトコル（型のみ、双方からimport）。
 *
 * design.md「Data Contracts & Integration」に定義された判別可能合併型をそのまま実装する。
 * `src/vscode-extension/webview/` 配下のコードは `vscode` モジュールを実行時に解決できない
 * （VSCode Webviewのプラットフォーム制約）ため、本ファイルはランタイム依存・副作用を持たない
 * 型定義のみで構成する（`vscode` import 禁止）。
 *
 * `LinkageOutput` は route-linkage-engine の出力契約（`schemaVersion=1`）を型のみ import する。
 */
import type { LinkageOutput } from "../route-linkage/models.js";

/** ホスト→Webview方向のメッセージ。現時点では連携データ送信のみ（将来拡張に備え合併型のまま保持）。 */
export type HostToWebviewMessage = { type: "linkageData"; payload: LinkageOutput };

/** Webview→ホスト方向のメッセージ。初期化完了通知・ノードクリック（ソースジャンプ要求）・連携関数コピー要求・再解析要求。 */
export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "nodeClick"; payload: { file: string; line: number } }
  | { type: "copyLinked"; payload: { functionId: string } }
  | { type: "copySelected"; payload: { functionIds: string[] } }
  | { type: "reanalyze" };
