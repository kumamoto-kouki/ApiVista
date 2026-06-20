/**
 * side 名前空間化(design.md「ID体系/名前空間化の不変条件」)。
 *
 * backend/frontend は独立に `FunctionNode.id` / `FileNode.id` を採番するため、
 * 統合データモデル内では衝突しうる。各IDに `side` 接頭辞を付与して一意化し、
 * `calls[]` / `file` / `dependsOn[]` などの参照も同じ接頭辞で貫通させる。
 *
 * 入力型は backend/frontend の `models.ts` から型のみ import する(read-only)。
 * 両モジュールの `FunctionNode`/`FileNode` は構造的に同形のため、union で受け取る。
 */
import type {
  FileNode as BackendFileNode,
  FunctionNode as BackendFunctionNode,
} from "../backend-analysis/models.js";
import type {
  FileNode as FrontendFileNode,
  FunctionNode as FrontendFunctionNode,
} from "../frontend-analysis/models.js";
import type { LinkedFileNode, LinkedFunctionNode, Side } from "./models.js";

/** `id` に `side` 接頭辞を付与する(`"<side>:<originalId>"`)。 */
export function namespaceId(side: Side, originalId: string): string {
  return `${side}:${originalId}`;
}

/**
 * 関数ノード配列を名前空間化する。`id` / `file` / `calls[]` を `namespaceId` で変換し、
 * `side` を付与する。`name` / `location` は変更しない。
 */
export function namespaceFunctions(
  side: Side,
  fns: ReadonlyArray<BackendFunctionNode | FrontendFunctionNode>,
): LinkedFunctionNode[] {
  return fns.map((fn) => ({
    id: namespaceId(side, fn.id),
    side,
    name: fn.name,
    file: namespaceId(side, fn.file),
    location: fn.location,
    calls: fn.calls.map((callId) => namespaceId(side, callId)),
  }));
}

/**
 * ファイルノード配列を名前空間化する。`id` / `dependsOn[]` を `namespaceId` で変換し、
 * `side` を付与する。`path` は変更しない。
 */
export function namespaceFiles(
  side: Side,
  files: ReadonlyArray<BackendFileNode | FrontendFileNode>,
): LinkedFileNode[] {
  return files.map((file) => ({
    id: namespaceId(side, file.id),
    side,
    path: file.path,
    dependsOn: file.dependsOn.map((depId) => namespaceId(side, depId)),
  }));
}
