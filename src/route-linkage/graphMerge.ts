/**
 * 呼び出しグラフ統合(design.md「graphMerge.ts(グラフ統合)」、Req5.2/5.3/5.6)。
 *
 * backend/frontend 双方の関数/ファイルノードを `ids.namespaceFunctions`/`namespaceFiles` で
 * 名前空間化したうえで連結する。名前空間化そのもののロジックは `ids.ts`(タスク1.2)に委ね、
 * 本モジュールは「両側を連結する」という統合のみを担う。
 */
import type {
  FileNode as BackendFileNode,
  FunctionNode as BackendFunctionNode,
} from "../backend-analysis/models.js";
import type {
  FileNode as FrontendFileNode,
  FunctionNode as FrontendFunctionNode,
} from "../frontend-analysis/models.js";
import { namespaceFiles, namespaceFunctions } from "./ids.js";
import type { LinkedFileNode, LinkedFunctionNode } from "./models.js";

/** backend/frontend の関数ノードを名前空間化して連結する(side 付き・一意なID)。 */
export function mergeFunctions(
  backendFunctions: readonly BackendFunctionNode[],
  frontendFunctions: readonly FrontendFunctionNode[],
): LinkedFunctionNode[] {
  return [
    ...namespaceFunctions("backend", backendFunctions),
    ...namespaceFunctions("frontend", frontendFunctions),
  ];
}

/** backend/frontend のファイルノードを名前空間化して連結する(side 付き・一意なID)。 */
export function mergeFiles(
  backendFiles: readonly BackendFileNode[],
  frontendFiles: readonly FrontendFileNode[],
): LinkedFileNode[] {
  return [...namespaceFiles("backend", backendFiles), ...namespaceFiles("frontend", frontendFiles)];
}
