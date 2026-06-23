/**
 * 右クリックした関数と、ルート連携で結びついた反対側の関数を Markdown 形式でクリップボードにコピーする。
 *
 * 処理フロー:
 * 1. カーソル位置の関数を DocumentSymbol から特定
 * 2. LinkageOutput でルート連携している反対側の関数を検索
 * 3. 各関数のコードを openTextDocument + DocumentSymbol の range から抽出
 * 4. Markdown 生成 → クリップボードへコピー
 */
import { relative } from "node:path";

import * as vscode from "vscode";

import type { LinkageOutput } from "../route-linkage/index.js";
import type { LinkedFunctionNode } from "../route-linkage/models.js";

/** 関数コードと付帯情報。 */
interface FunctionSnippet {
  funcName: string;
  fileRelPath: string;
  lang: string;
  code: string;
}

/** ファイル拡張子から言語識別子を返す。 */
function langFromExt(filePath: string): string {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".vue")) return "vue";
  if (filePath.endsWith(".ts")) return "typescript";
  return "javascript";
}

/** DocumentSymbol の階層を平坦化し Function/Method 種別のみを返す。 */
function flattenFunctionSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];
  for (const sym of symbols) {
    if (sym.kind === vscode.SymbolKind.Function || sym.kind === vscode.SymbolKind.Method) {
      result.push(sym);
    }
    if (sym.children.length > 0) {
      result.push(...flattenFunctionSymbols(sym.children));
    }
  }
  return result;
}

/** カーソル位置を含む関数シンボルを返す。 */
async function findFunctionAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.DocumentSymbol | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    document.uri,
  );
  if (!symbols) return undefined;
  const funcs = flattenFunctionSymbols(symbols);
  // カーソルを含む最も内側のシンボルを返す
  return funcs
    .filter((s) => s.range.contains(position))
    .sort((a, b) => {
      const aLen = a.range.end.line - a.range.start.line;
      const bLen = b.range.end.line - b.range.start.line;
      return aLen - bLen; // 小さい範囲（内側）を優先
    })[0];
}

/** ファイルを開いて指定関数名の range からコードを抽出する。 */
async function extractCode(absolutePath: string, funcName: string): Promise<string | undefined> {
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(absolutePath);
  } catch {
    return undefined;
  }
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    doc.uri,
  );
  if (!symbols) return undefined;
  const funcs = flattenFunctionSymbols(symbols);
  const sym = funcs.find((s) => s.name === funcName);
  if (!sym) return undefined;
  return doc.getText(sym.range);
}

/** バックエンドハンドラと連携するフロントエンド関数スニペットを収集する。 */
async function collectLinkedFromBackend(
  output: LinkageOutput,
  matchedLinkages: typeof output.linkages,
  frontendRoot: string,
): Promise<FunctionSnippet[]> {
  const result: FunctionSnippet[] = [];
  const seen = new Set<string>();
  for (const linkage of matchedLinkages) {
    const fnId = linkage.apiCall.enclosingFunctionId;
    if (seen.has(fnId)) continue;
    seen.add(fnId);
    const fn = output.functions.find((f) => f.id === fnId) as LinkedFunctionNode | undefined;
    if (!fn) continue;
    const feAbs = `${frontendRoot}/${fn.location.file}`;
    const code = await extractCode(feAbs, fn.name);
    if (code) {
      result.push({
        funcName: fn.name,
        fileRelPath: fn.location.file,
        lang: langFromExt(fn.location.file),
        code,
      });
    }
  }
  return result;
}

/** フロントエンド関数と連携するバックエンドハンドラスニペットを収集する。 */
async function collectLinkedFromFrontend(
  output: LinkageOutput,
  matchedLinkages: typeof output.linkages,
  backendRoot: string,
): Promise<FunctionSnippet[]> {
  const result: FunctionSnippet[] = [];
  const seen = new Set<string>();
  for (const linkage of matchedLinkages) {
    const handlerFile = linkage.route.handler.file;
    const handlerKey = `${handlerFile}:${linkage.route.handler.line}`;
    if (seen.has(handlerKey)) continue;
    seen.add(handlerKey);
    const beFn = output.functions.find(
      (f) =>
        f.side === "backend" &&
        f.location.file === handlerFile &&
        f.location.line === linkage.route.handler.line,
    ) as LinkedFunctionNode | undefined;
    const beAbs = `${backendRoot}/${handlerFile}`;
    const handlerName = beFn?.name ?? linkage.route.handler.file;
    const code = await extractCode(beAbs, handlerName);
    if (code) {
      result.push({
        funcName: handlerName,
        fileRelPath: handlerFile,
        lang: langFromExt(handlerFile),
        code,
      });
    }
  }
  return result;
}

/** Markdown を生成する。 */
function buildMarkdown(
  focal: FunctionSnippet,
  linked: FunctionSnippet[],
  routeLabel: string,
): string {
  const lines: string[] = [
    `# ApiVista: ルート連携関数コピー — \`${routeLabel}\``,
    "",
    `## \`${focal.funcName}\` — ${focal.fileRelPath}`,
    "",
    `\`\`\`${focal.lang}`,
    focal.code,
    "```",
  ];
  for (const fn of linked) {
    lines.push(
      "",
      `## \`${fn.funcName}\` — ${fn.fileRelPath}`,
      "",
      `\`\`\`${fn.lang}`,
      fn.code,
      "```",
    );
  }
  return lines.join("\n");
}

/**
 * カーソル位置の関数と連携関数を Markdown でクリップボードにコピーする。
 *
 * @param document 現在のエディタドキュメント
 * @param position カーソル位置
 * @param output キャッシュ済み LinkageOutput
 * @param backendRoot バックエンドルートの絶対パス
 * @param frontendRoot フロントエンドルートの絶対パス
 * @returns コピーした関数数（0 = 対象なし）
 */
export async function copyFunctionWithLinked(
  document: vscode.TextDocument,
  position: vscode.Position,
  output: LinkageOutput,
  backendRoot: string,
  frontendRoot: string,
): Promise<number> {
  const funcSymbol = await findFunctionAtCursor(document, position);
  if (!funcSymbol) return 0;

  const absPath = document.uri.fsPath;
  const isBackend = absPath.startsWith(backendRoot + "/") || absPath.startsWith(backendRoot + "\\");
  const isFrontend =
    absPath.startsWith(frontendRoot + "/") || absPath.startsWith(frontendRoot + "\\");

  if (!isBackend && !isFrontend) return 0;

  const root = isBackend ? backendRoot : frontendRoot;
  const relFile = relative(root, absPath).replace(/\\/g, "/");

  const focalCode = document.getText(funcSymbol.range);
  const focal: FunctionSnippet = {
    funcName: funcSymbol.name,
    fileRelPath: relFile,
    lang: langFromExt(absPath),
    code: focalCode,
  };

  const linked: FunctionSnippet[] = [];
  let routeLabel = funcSymbol.name;

  if (isBackend) {
    // バックエンドハンドラ → 連携するフロントエンド関数を検索
    const matchedLinkages = output.linkages.filter(
      (l) =>
        l.route.handler.file === relFile &&
        funcSymbol.range.contains(new vscode.Position(l.route.handler.line - 1, 0)),
    );
    if (matchedLinkages.length > 0) {
      const first = matchedLinkages[0].route;
      routeLabel = `${first.method} ${first.path}`;
    }
    linked.push(...(await collectLinkedFromBackend(output, matchedLinkages, frontendRoot)));
  } else {
    // フロントエンド関数 → 連携するバックエンドハンドラを検索
    const fn = output.functions.find(
      (f) => f.side === "frontend" && f.name === funcSymbol.name && f.location.file === relFile,
    ) as LinkedFunctionNode | undefined;
    if (fn) {
      const matchedLinkages = output.linkages.filter(
        (l) => l.apiCall.enclosingFunctionId === fn.id,
      );
      if (matchedLinkages.length > 0) {
        const first = matchedLinkages[0].route;
        routeLabel = `${first.method} ${first.path}`;
      }
      linked.push(...(await collectLinkedFromFrontend(output, matchedLinkages, backendRoot)));
    }
  }

  const markdown = buildMarkdown(focal, linked, routeLabel);
  await vscode.env.clipboard.writeText(markdown);
  return 1 + linked.length;
}
