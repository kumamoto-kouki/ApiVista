/**
 * グラフの枠（関数ノード）を起点に、連結する全関数を Markdown 形式でクリップボードへコピーする。
 *
 * 連結グラフ:
 * - 同 side の呼び出し関係 `LinkedFunctionNode.calls[]`（無向辺として扱う）
 * - フロント⇄バックのルート連携 `linkage.apiCall.enclosingFunctionId ⇄ linkage.route.entryFunctionId`
 *
 * 起点関数 ID から無向 BFS で連結成分を求め、各関数のコードを
 * `openTextDocument` + DocumentSymbol の range から抽出して Markdown 化する。
 */
import { join } from "node:path";

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

/** ファイル拡張子から Markdown フェンス用の言語識別子を返す。 */
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

/**
 * `output` から無向隣接（calls[] ＋ ルート連携の enclosing⇄entry）を構築する。
 * 戻り値は関数 ID → 隣接関数 ID 集合。両端が `functions` に存在する辺のみを張る。
 */
function buildFunctionAdjacency(output: LinkageOutput): Map<string, Set<string>> {
  const ids = new Set(output.functions.map((f) => f.id));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!ids.has(a) || !ids.has(b) || a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };

  for (const fn of output.functions) {
    for (const callee of fn.calls) link(fn.id, callee);
  }
  for (const l of output.linkages) {
    link(l.apiCall.enclosingFunctionId, l.route.entryFunctionId);
  }
  return adj;
}

/** 起点 ID から無向 BFS で到達する関数 ID 集合（起点含む）を返す。 */
function reachableFunctionIds(adj: Map<string, Set<string>>, focalId: string): Set<string> {
  const visited = new Set<string>([focalId]);
  const queue = [focalId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

/** Markdown を生成する（先頭が起点関数）。 */
function buildMarkdown(focalName: string, snippets: FunctionSnippet[]): string {
  const lines: string[] = [`# ApiVista: 連携関数コピー — \`${focalName}\``];
  for (const fn of snippets) {
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
 * 起点関数 ID から連結する全関数を Markdown でクリップボードにコピーする。
 *
 * @param output 表示中 / キャッシュ済みの LinkageOutput
 * @param focalFunctionId 起点関数の名前空間化済み ID（`LinkedFunctionNode.id`）
 * @param backendRoot バックエンドルートの絶対パス
 * @param frontendRoot フロントエンドルートの絶対パス
 * @returns コピーした関数数（0 = 起点不明 / 抽出不能）
 */
export async function copyLinkedChain(
  output: LinkageOutput,
  focalFunctionId: string,
  backendRoot: string,
  frontendRoot: string,
): Promise<number> {
  const byId = new Map<string, LinkedFunctionNode>(output.functions.map((f) => [f.id, f]));
  if (!byId.has(focalFunctionId)) return 0;

  const adj = buildFunctionAdjacency(output);
  const reachable = reachableFunctionIds(adj, focalFunctionId);

  // 起点を先頭に、残りは (side, file, line) 昇順で決定的に整列する。
  const ordered = [...reachable]
    .map((id) => byId.get(id))
    .filter((f): f is LinkedFunctionNode => f !== undefined)
    .sort((a, b) => {
      if (a.id === focalFunctionId) return -1;
      if (b.id === focalFunctionId) return 1;
      if (a.side !== b.side) return a.side < b.side ? -1 : 1;
      if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
      return a.location.line - b.location.line;
    });

  const snippets: FunctionSnippet[] = [];
  for (const fn of ordered) {
    const root = fn.side === "backend" ? backendRoot : frontendRoot;
    const code = await extractCode(join(root, fn.location.file), fn.name);
    if (code) {
      snippets.push({
        funcName: fn.name,
        fileRelPath: fn.location.file,
        lang: langFromExt(fn.location.file),
        code,
      });
    }
  }

  if (snippets.length === 0) return 0;

  const focalName = byId.get(focalFunctionId)?.name ?? snippets[0].funcName;
  await vscode.env.clipboard.writeText(buildMarkdown(focalName, snippets));
  return snippets.length;
}
