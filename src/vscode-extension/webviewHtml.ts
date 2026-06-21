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
 *   `style-src`には`'unsafe-inline'`も加える: Cytoscape.js はノード/エッジ描画用canvasの
 *   位置・サイズをJSから直接インラインstyleとして設定するため、`'unsafe-inline'`が無いと
 *   ブラウザがその設定をCSP違反としてブロックし、グラフが描画されない
 *   （実機検証で発見。`script-src`は引き続きnonce限定のままで、許可範囲はスタイルのみ）。
 * - `<style>`ブロックで`html`/`body`/`#app`に高さ100%を与える。これが無いと`#graph`コンテナの
 *   高さが0pxに崩れ、Cytoscapeが要素を持っていても見える領域がゼロになる（実機検証で発見）。
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
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ApiVista</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; }
    #app { display: flex; flex-direction: column; height: 100%; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
