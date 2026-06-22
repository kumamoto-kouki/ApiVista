/**
 * グラフノードクリックからのソースジャンプ（design.md「sourceJump」, Requirements 5.1, 5.2）。
 *
 * - ワークスペース相対パス（`SourceLocation.file`）を`vscode.Uri.joinPath`で絶対URIへ変換し、
 *   `vscode.window.showTextDocument`でエディタに開く（単一ルートワークスペース前提、design.mdの
 *   既定境界に準拠）。
 * - 開いたエディタの該当行（1基底の`SourceLocation.line`）へ、0基底の`Selection`/`revealRange`で
 *   カーソル移動・スクロールする。
 * - ワークスペースフォルダが開かれていない場合、または`showTextDocument`が失敗（reject）した場合は
 *   呼び出し元へエラーを伝播させる（design.mdは`SourceJump`専用のエラークラスを定義していないため、
 *   素の`Error`をthrow、または`showTextDocument`自身のrejectionをそのまま伝播させる）。
 */
import * as vscode from "vscode";

export interface SourceLocation {
  file: string;
  line: number;
}

export async function reveal(location: SourceLocation): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    throw new Error("ワークスペースフォルダが開かれていません。ソースジャンプを実行できません。");
  }

  // sourceLocation.file は backend/ または frontend/ 相対パスのため、
  // ワークスペースルート直下→frontend/配下→backend/配下の順で試みる
  const candidates = [
    vscode.Uri.joinPath(workspaceFolder.uri, location.file),
    vscode.Uri.joinPath(workspaceFolder.uri, "frontend", location.file),
    vscode.Uri.joinPath(workspaceFolder.uri, "backend", location.file),
  ];

  for (const uri of candidates) {
    try {
      const editor = await vscode.window.showTextDocument(uri);
      const position = new vscode.Position(location.line - 1, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
      return;
    } catch {
      // 次の候補を試みる
    }
  }

  throw new Error(`${location.file}:${location.line} を開けませんでした`);
}
