/**
 * ID 体系（design.md「ID体系」）。
 *
 * - 関数ID: `<module-dotted-path>:<qualname>`
 * - ファイルID: backendRoot 相対 POSIX パス
 *
 * いずれも純関数で、同一入力に対し決定的に同じ文字列を返す。
 */
import { relative, sep } from "node:path";

/**
 * 関数IDを採番する。
 *
 * @param moduleDottedPath 例 `sample_app.routers.items`
 * @param qualname 例 `get_item` / `ItemRouter.get_item`
 * @returns 例 `sample_app.routers.items:get_item`
 */
export function makeFunctionId(moduleDottedPath: string, qualname: string): string {
  return `${moduleDottedPath}:${qualname}`;
}

/**
 * ファイルIDを採番する（backendRoot 相対 POSIX パス）。
 *
 * `node:path` の `relative` で相対化し、プラットフォーム区切り文字を `/` に正規化する。
 *
 * @param backendRoot 例 `/x/sample_app`
 * @param filePath 例 `/x/sample_app/routers/items.py`
 * @returns 例 `routers/items.py`
 */
export function makeFileId(backendRoot: string, filePath: string): string {
  const rel = relative(backendRoot, filePath);
  return sep === "/" ? rel : rel.split(sep).join("/");
}
