/**
 * CSP/nonce付きHTMLシェルの構築（design.md「webviewHtml」, Requirements 3.1, 5.1）。
 *
 * Webviewへ表示するHTML文字列を構築するのみの責務を持つ。`localResourceRoots`等の
 * `WebviewPanel`/`WebviewOptions`自体の設定は呼び出し元（`graphPanel.ts`）の責務であり、
 * 本モジュールはそれらを設定しない（design.md「graphPanel」の責務境界に従う）。
 *
 * - ランダムな`nonce`を生成し、`<script>`タグと`Content-Security-Policy`メタタグの双方に使用する
 *   （nonceの一致がスクリプト実行の許可条件、VSCode Webviewの標準CSPパターン）。
 * - スクリプトは`media/webview/bundle.js`（esbuildのビルド生成物）を`webview.asWebviewUri`で
 *   Webview向けURIへ変換して参照する。
 * - `style-src`/`img-src`は`webview.cspSource`に制限する（VSCode Webview拡張専用の擬似オリジン）。
 */
import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomUUID();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "webview", "bundle.js"),
  );

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ApiVista</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
