/**
 * ID 体系（design.md「ID体系」。backend `src/backend-analysis/ids.ts` と同形）。
 *
 * - 関数ID: `<module-path>:<qualname>`
 * - ファイルID: frontendRoot 相対 POSIX パス
 *
 * いずれも純関数で、同一入力に対し決定的に同じ文字列を返す。
 */
import { relative, sep } from "node:path";

/**
 * 関数IDを採番する。
 *
 * @param modulePath モジュールパス（fileId の拡張子なし表現など）。例 `composables/useUserApi`
 * @param qualname 宣言名（ネストは `.` 連結）/ `.vue` のコンポーネント名。例 `fetchUsers` / `Users`
 * @returns 例 `composables/useUserApi:fetchUsers`
 */
export function makeFunctionId(modulePath: string, qualname: string): string {
  return `${modulePath}:${qualname}`;
}

/**
 * ファイルIDを採番する（frontendRoot 相対 POSIX パス）。
 *
 * `node:path` の `relative` で相対化し、プラットフォーム区切り文字を `/` に正規化する。
 *
 * @param frontendRoot 例 `/x/frontend`
 * @param filePath 例 `/x/frontend/composables/useUserApi.ts`
 * @returns 例 `composables/useUserApi.ts`
 */
export function makeFileId(frontendRoot: string, filePath: string): string {
  const rel = relative(frontendRoot, filePath);
  return sep === "/" ? rel : rel.split(sep).join("/");
}
