/**
 * Pass1 template コンポーネント参照抽出（design.md「extractors/defs, calls, templates(Pass1)」, Req2.1）。
 *
 * `.vue` の `<template>` 内の子コンポーネント参照を、
 * 「当該 `.vue` のコンポーネントノード（親）→ 子コンポーネント名」の**エッジ候補**として収集する。
 * これが 4.1（callGraph）で `fileMap.componentIndex` により子コンポーネントノードへ解決され、
 * 「ページ→コンポーネント→composable→API」の到達経路を呼び出しグラフ上で連結する（Issue 1）。
 *
 * **責務境界（3.4 は「親ノード → 子コンポーネント名」候補まで）**:
 * - 親（caller）: 当該 `.vue` の単一コンポーネントノード。命名は `fileMap.componentNameFromFileId` を
 *   再利用し（3.2/defs のコンポーネントノード qualname と一致＝4.1 の親 ID 突合が破綻しない）、
 *   id は `makeFunctionId(modulePath, name)` で採番する（参照貫通の不変条件、backend と対称）。
 * - 子（callee）: 子コンポーネント名のみを保持する。子名 → fileId/コンポーネントノードの**解決**は
 *   4.1（componentIndex）の責務であり、本 Pass は名前収集に徹する（calls.ts の callee 方針と対称）。
 *
 * **template 走査の再利用（Depends: 1.1）**: 子参照の列挙・PascalCase 正規化・動的 `<component :is>`/
 * HTML 要素の除外は `extractSfc`（1.1）の `componentRefs` が既に済ませている。本 Pass はそれを
 * 親コンポーネントノードへ束ねるのみで、template AST 走査を再実装しない。
 *
 * SFC パースエラーの `.vue` は `extractSfc` が `componentRefs=[]` + `recordParseError` を行うため、
 * 本 Pass は空のエッジ候補を返す（Pass0 でのスキップに整合。Req4.1。二重記録なし）。
 *
 * 本モジュールは `.vue` 生ソースを受け取る純粋抽出関数（副作用は collector への記録のみ＝extractSfc 経由）。
 */
import { componentNameFromFileId, stripExtension } from "../fileMap.js";
import { makeFunctionId } from "../ids.js";
import type { SourceLocation } from "../models.js";
import { extractSfc, type SfcWarningCollector } from "../sfc.js";

/**
 * template 由来のコンポーネント間エッジ候補（design「当該コンポーネントノード → 子コンポーネントノード」）。
 *
 * `parentNodeId`/`parentComponentName` は当該 `.vue` の単一コンポーネントノードを指す
 * （4.1 が `FunctionNode.id` 起点として用いる）。`childComponentName` は子コンポーネント名
 * （PascalCase。fileId/ノードへの解決は 4.1 の componentIndex）。`location` は `<Child/>` の `.vue` 行。
 */
export interface TemplateRefEdge {
  /** 親コンポーネントノードの `FunctionNode.id`（`<module-path>:<qualname>`）。 */
  parentNodeId: string;
  /** 親コンポーネントノードの qualname（`.vue` のコンポーネント名）。 */
  parentComponentName: string;
  /** 子コンポーネント名（PascalCase。解決は 4.1 componentIndex）。 */
  childComponentName: string;
  /** template 内の参照位置（`.vue` 実ファイル行）。 */
  location: SourceLocation;
}

/**
 * `.vue` の template から子コンポーネント参照をエッジ候補として収集する（Pass1）。
 *
 * @param vueSource `.vue` ファイルの生ソース（`extractSfc` に渡して template 参照を取得する）
 * @param fileId frontendRoot 相対 POSIX の `.vue` fileId（親ノード命名・location.file に使用）
 * @param collector 警告コレクター（SFC パースエラーは `extractSfc` が記録する）
 */
export function extractTemplateRefs(
  vueSource: string,
  fileId: string,
  collector: SfcWarningCollector,
): TemplateRefEdge[] {
  // 子参照の列挙・PascalCase 正規化・動的/HTML 除外は 1.1 の extractSfc が済ませている。
  const { componentRefs } = extractSfc(vueSource, fileId, collector);
  if (componentRefs.length === 0) {
    return [];
  }

  // 親 = 当該 .vue の単一コンポーネントノード（命名・id は 3.2/fileMap と同一情報源）。
  const parentComponentName = componentNameFromFileId(fileId);
  const parentNodeId = makeFunctionId(stripExtension(fileId), parentComponentName);

  return componentRefs.map((ref) => ({
    parentNodeId,
    parentComponentName,
    childComponentName: ref.name,
    location: ref.location,
  }));
}
