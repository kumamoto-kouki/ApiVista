/**
 * Vue SFC 抽出 + 行マッピング（design.md「sfc — Vue SFC 抽出 + 行マッピング」）。
 *
 * `@vue/compiler-sfc` の `parse()` を用い、`.vue` から `<script>`/`<script setup>` を
 * 結合した単一スクリプト本文（ts-morph へ渡す .ts 相当）と、各ブロックの結合本文行範囲 →
 * 元 `.vue` 開始行の対応（`segments`）を取得する（Issue 1: 複数ブロック併存の行補正）。
 * あわせて `<template>` から子コンポーネント参照（PascalCase 正規化）を収集する。
 * SFC パースエラーは `script=null` + `recordParseError` で記録し、Pass0 でのスキップに委ねる。
 *
 * 位置型 `SourceLocation` は正準 `models.ts` を import（再 export して既存利用元の互換を保つ）。
 * 警告コレクター契約 `SfcWarningCollector` は正準 `WarningCollector` の公開面から構造的に導出する
 * （1.3 統合: 重複型を解消しつつ挙動は不変）。
 */
import { parse } from "@vue/compiler-sfc";

import type { SourceLocation } from "./models.js";
import type { WarningCollector } from "./warnings.js";

export type { SourceLocation };

/** `parse()` の返す descriptor 型（公開 API から派生し、transitive 依存への直接 import を避ける）。 */
type SfcDescriptor = ReturnType<typeof parse>["descriptor"];
/** template ブロックの AST 型（`RootNode | undefined`）。 */
type TemplateAst = NonNullable<SfcDescriptor["template"]>["ast"];

/**
 * template AST 走査に必要な最小の構造的ノード形。
 * compiler-core の深い union（要素/テキスト/補間/式…）を直接扱う代わりに、
 * 走査で参照するプロパティだけを構造的に表現する（transitive 型へ依存しない）。
 */
interface TemplateNode {
  type: number;
  tag?: string;
  tagType?: number;
  loc?: { start: { line: number } };
  children?: unknown;
}

/** ソース位置。`file` は frontendRoot 相対 POSIX パス、`line` は 1 基底。 */
export interface SourceLocation {
  file: string;
  line: number;
}

/**
 * 警告コレクターの構造的契約（全 Pass 共有の `WarningCollector` と互換）。
 * `extractSfc` は SFC パースエラーのみ記録するため最小の表面のみを要求する。
 */
export interface SfcWarningCollector {
  record(target: string, reason: string): void;
  recordParseError(target: string, detail?: string): void;
}

/**
 * 結合本文の 1 領域（1 つの script ブロック）→ 元 `.vue` 行の対応。
 * `toSourceLocation` は結合本文の行 `L` が属する segment を引き、
 * `.vue` 実行番号 = `vueStartLine - 1 + (L - fromLine + 1)` で補正する。
 */
export interface ScriptSegment {
  /** 結合後スクリプト内での開始行（1 基底）。 */
  fromLine: number;
  /** 結合後スクリプト内での終了行（1 基底, 含む）。 */
  toLine: number;
  /** この領域が対応する .vue 実ファイルの開始行（1 基底）。 */
  vueStartLine: number;
}

/** ts-morph へ渡す結合スクリプト（`<script>` + `<script setup>` を結合）。 */
export interface ExtractedScript {
  /** ts-morph に渡すスクリプト本文（.ts 相当、`<script>` + `<script setup>` を結合）。 */
  content: string;
  /** 結合本文の各領域 → 元 .vue 行のマップ（Issue 1: 複数ブロック併存の行補正）。 */
  segments: ScriptSegment[];
  lang: "ts" | "js";
}

/** template 内で参照された子コンポーネント参照（Issue 1: コンポーネント間エッジ用）。 */
export interface ComponentRef {
  /** template 内で参照された子コンポーネント名（PascalCase 正規化）。 */
  name: string;
  location: SourceLocation;
}

/** `.vue` から抽出した script（結合・行オフセット保持）と template のコンポーネント参照。 */
export interface ExtractedSfc {
  script: ExtractedScript | null;
  /** `<template>` から抽出した子コンポーネント参照（Issue 1: コンポーネント間エッジ用）。 */
  componentRefs: ComponentRef[];
}

/**
 * `@vue/compiler-sfc` の `NodeTypes.ELEMENT`。enum は型のみの公開で実行時値が無いため
 * 数値リテラルで保持する（compiler-core の安定値）。
 */
const NODE_TYPE_ELEMENT = 1;
/** `ElementTypes.COMPONENT`（HTML ネイティブ要素=0 と区別する）。 */
const TAG_TYPE_COMPONENT = 1;
/** 動的 `<component :is>` は静的解決対象外のため除外する。 */
const DYNAMIC_COMPONENT_TAG = "component";

/**
 * `.vue` ソースから script（複数ブロック結合・オフセット保持）と
 * template のコンポーネント参照を抽出する。
 *
 * SFC パースエラーがある場合は `script=null` を返し、`recordParseError` で記録する
 * （Pass0 でファイルスキップ。Req4.1）。template の解析は best-effort で、script が
 * null でもエラーが無ければ参照抽出を試みる。
 *
 * @param vueSource `.vue` ファイルの生ソース
 * @param fileId frontendRoot 相対 POSIX の fileId（警告・位置の `file`）
 * @param collector 警告コレクター（SFC パースエラー記録用）
 */
export function extractSfc(
  vueSource: string,
  fileId: string,
  collector: SfcWarningCollector,
): ExtractedSfc {
  const { descriptor, errors } = parse(vueSource, { filename: fileId });

  if (errors.length > 0) {
    const detail = errors.map((e) => ("message" in e ? e.message : String(e))).join("; ");
    collector.recordParseError(fileId, detail);
    return { script: null, componentRefs: [] };
  }

  const script = buildScript(descriptor.script, descriptor.scriptSetup);
  const componentRefs = extractComponentRefs(descriptor.template?.ast, fileId);
  return { script, componentRefs };
}

/** `@vue/compiler-sfc` の script ブロック記述子の最小形（content / 開始行 / lang）。 */
interface ScriptBlockLike {
  content: string;
  loc: { start: { line: number } };
  lang?: string;
}

/**
 * `<script>` と `<script setup>` を出現順（通常 `<script>` → `<script setup>`）に結合し、
 * 各ブロックの結合本文行範囲 → 元 .vue 開始行（`segments`）を構築する。
 * 両ブロックとも無ければ `null`。
 */
function buildScript(
  script: ScriptBlockLike | null | undefined,
  scriptSetup: ScriptBlockLike | null | undefined,
): ExtractedScript | null {
  const blocks: ScriptBlockLike[] = [];
  if (script) {
    blocks.push(script);
  }
  if (scriptSetup) {
    blocks.push(scriptSetup);
  }
  if (blocks.length === 0) {
    return null;
  }

  const parts: string[] = [];
  const segments: ScriptSegment[] = [];
  let nextFromLine = 1;
  let lang: "ts" | "js" = "js";

  for (const block of blocks) {
    if (block.lang === "ts" || block.lang === "tsx") {
      lang = "ts";
    }
    // compiler-sfc の content は開始タグ行末（`>`）直後から始まり、先頭に改行を含むため、
    // content の行 N は .vue の `loc.start.line - 1 + N` に対応する。
    const lineCount = countLines(block.content);
    segments.push({
      fromLine: nextFromLine,
      toLine: nextFromLine + lineCount - 1,
      vueStartLine: block.loc.start.line,
    });
    parts.push(block.content);
    nextFromLine += lineCount;
  }

  return { content: parts.join("\n"), segments, lang };
}

/**
 * 結合時に `parts.join("\n")` で連結する前提での、1 ブロックが占める行数を返す。
 * 行数 = 改行数 + 1（空文字列も 1 行として扱う）。
 */
function countLines(content: string): number {
  let newlines = 0;
  for (const ch of content) {
    if (ch === "\n") {
      newlines += 1;
    }
  }
  return newlines + 1;
}

/**
 * `<template>` AST を走査し、子コンポーネント参照（`tagType === COMPONENT`）を収集する。
 * kebab-case / PascalCase を PascalCase に正規化し、動的 `<component :is>` は除外する。
 * 位置は template AST の行が `.vue` 絶対行のため、そのまま `SourceLocation` に使える。
 */
function extractComponentRefs(ast: TemplateAst, fileId: string): ComponentRef[] {
  const refs: ComponentRef[] = [];
  if (!ast) {
    return refs;
  }

  const visit = (node: TemplateNode): void => {
    if (isComponentElement(node)) {
      refs.push({
        name: toPascalCase(node.tag),
        location: { file: fileId, line: node.loc?.start.line ?? 1 },
      });
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        // 子は要素/テキスト/補間など。オブジェクトノードのみ再帰（文字列/symbol は走査対象外）。
        if (isTemplateNode(child)) {
          visit(child);
        }
      }
    }
  };

  visit(ast as unknown as TemplateNode);
  return refs;
}

/** 走査可能な構造的ノード（`type` を持つオブジェクト）か判定する。 */
function isTemplateNode(value: unknown): value is TemplateNode {
  return typeof value === "object" && value !== null && "type" in value;
}

/**
 * ノードが静的に解決可能な子コンポーネント要素か判定する。
 * `NodeTypes.ELEMENT` かつ `ElementTypes.COMPONENT`、かつ動的 `<component>` でないこと。
 */
function isComponentElement(node: TemplateNode): node is TemplateNode & { tag: string } {
  return (
    node.type === NODE_TYPE_ELEMENT &&
    node.tagType === TAG_TYPE_COMPONENT &&
    typeof node.tag === "string" &&
    node.tag !== DYNAMIC_COMPONENT_TAG
  );
}

/**
 * コンポーネントタグ名を PascalCase へ正規化する。
 * `user-list` / `UserList` → `UserList`、`base-button` → `BaseButton`。
 * 既に PascalCase の場合はセグメント分割が起きず、そのまま保持される。
 */
function toPascalCase(tag: string): string {
  return tag
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}
