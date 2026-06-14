/**
 * web-tree-sitter ブートストラップ。
 *
 * Python 文法 WASM を読み込んだ tree-sitter パーサをプロセス内シングルトンとして
 * 提供する。ネイティブモジュールを一切使わず、単一の `.wasm` を読むだけで全 OS で
 * 同一に動作するため、エンドユーザーに Python/uv 等の外部ランタイムを要求しない
 * (Requirements 6.2, 6.4)。
 *
 * WASM の所在解決:
 * - `wasmDir` を渡した場合（VSCode 拡張は `context.extensionUri` 由来の同梱パスを渡す）、
 *   その配下の `tree-sitter.wasm`（ランタイム）と `tree-sitter-python.wasm`（文法）を使う。
 * - 省略した場合（Node/開発・テスト）、node_modules から解決する。
 *
 * 注意: web-tree-sitter は `^0.25` に固定し、文法 WASM と ABI を整合させること
 * （0.26 は WASM ABI 非互換）。
 */
import { createRequire } from "node:module";
import { join } from "node:path";

import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

interface WasmLocations {
  runtime: string;
  pythonGrammar: string;
}

function resolveWasmLocations(wasmDir?: string): WasmLocations {
  if (wasmDir !== undefined) {
    return {
      runtime: join(wasmDir, "tree-sitter.wasm"),
      pythonGrammar: join(wasmDir, "tree-sitter-python.wasm"),
    };
  }
  return {
    runtime: require.resolve("web-tree-sitter/tree-sitter.wasm"),
    pythonGrammar: require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm"),
  };
}

let initPromise: Promise<void> | null = null;
let parserPromise: Promise<Parser> | null = null;

/**
 * Python 文法をロード済みのパーサを返す（初回のみ初期化、以降はキャッシュを返す）。
 *
 * @param wasmDir WASM 同梱ディレクトリ。省略時は node_modules から解決する。
 *   シングルトンのため、`wasmDir` は最初の呼び出し時の値のみ有効。
 */
export function getPythonParser(wasmDir?: string): Promise<Parser> {
  if (parserPromise !== null) {
    return parserPromise;
  }

  parserPromise = (async (): Promise<Parser> => {
    const { runtime, pythonGrammar } = resolveWasmLocations(wasmDir);

    if (initPromise === null) {
      initPromise = Parser.init({
        locateFile: (scriptName: string): string =>
          scriptName.endsWith(".wasm") ? runtime : scriptName,
      });
    }
    await initPromise;

    const language = await Language.load(pythonGrammar);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();

  return parserPromise;
}

/**
 * キャッシュ済みパーサを破棄する（主にテスト用）。WASM ランタイムの初期化状態は保持する。
 */
export function resetPythonParser(): void {
  parserPromise = null;
}
