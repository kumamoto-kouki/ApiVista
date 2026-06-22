/**
 * 共有 import 解決ユーティリティ（Pass2a/2b/2c 共通基盤）。
 *
 * symbolTable の `import` 束縛が持つ完全修飾名（相対 import は先頭ドットを保持）を、
 * `ModuleMap` を使って「どの内部モジュールの・どの名前か」に正規化する。
 *
 * いずれも純関数で副作用を持たない（design.md「symbolTable(ScopeProvider代替)」
 * および「resolver/routePaths(Pass2a)」の前提）。
 */
import type { ModuleMap } from "../moduleMap.js";

/**
 * Python の相対ドット名を絶対ドット名へ解決する。
 *
 * 先頭ドット数 `k` を数え、`currentModule` の末尾 `k` セグメントを落としてから、
 * ドットを除いた残り（あれば）を連結する。
 *
 * - `resolveRelativeModule("..helpers", "sample_app.routers.items")` → `"sample_app.helpers"`
 * - `resolveRelativeModule(".routers.items", "sample_app.main")` → `"sample_app.routers.items"`
 * - 先頭ドットが無い名前は既に絶対であり、そのまま返す。
 *
 * 既知の限界: `currentModule` がパッケージ本体（`__init__.py` 由来）の場合、相対 import の
 * 基点はそのパッケージ自身であるべきだが、本実装は常に末尾セグメントを 1 段落とすため
 * `__init__` モジュールでは 1 段ずれる。sample_app のフィクスチャはこのケースを使わない。
 */
export function resolveRelativeModule(dotted: string, currentModule: string): string {
  let dotCount = 0;
  while (dotCount < dotted.length && dotted[dotCount] === ".") {
    dotCount += 1;
  }
  if (dotCount === 0) {
    // 既に絶対。
    return dotted;
  }

  const remainder = dotted.slice(dotCount); // ドットを除いた残り（空文字の場合あり）。
  const baseSegments = currentModule.split(".");
  // 先頭ドット k 個 → 末尾 k セグメントを落とす。
  const kept = baseSegments.slice(0, Math.max(0, baseSegments.length - dotCount));

  if (remainder.length === 0) {
    return kept.join(".");
  }
  return [...kept, remainder].join(".");
}

/** import 完全修飾名の解決結果。 */
export interface ResolvedImport {
  /** 内部/外部を問わず推定したモジュールのドット表記（解決不能時のフォールバック含む）。 */
  moduleDotted: string | null;
  /** モジュール内の名前（モジュール丸ごと import のときは `""`）。 */
  name: string;
  /** 内部モジュールに解決できたときの fileId。外部/未解決は `null`。 */
  targetFileId: string | null;
}

/**
 * symbolTable の `import` 束縛 `qualifiedName`（先頭ドットを持ち得る）を、
 * import 元ファイルの `fileId` の文脈で `{moduleDotted, name, targetFileId}` に正規化する。
 *
 * 手順:
 * 1. `currentModule = map.pathToModule.get(currentFileId)`。
 * 2. `absolute = resolveRelativeModule(qualifiedName, currentModule)`（絶対ならそのまま）。
 * 3. `absolute` を「`moduleToPath` に存在する最長プレフィックス（=実モジュール）」+ 末尾名 に分割。
 *    `absolute` 自体がモジュールキーなら `name=""`（モジュール import）。
 *    どの module プレフィックスにも一致しなければ、末尾セグメントを `name`、残りを
 *    `moduleDotted`（外部の可能性）とするフォールバック。
 * 4. `targetFileId = moduleDotted ? map.moduleToPath.get(moduleDotted) ?? null : null`。
 */
export function resolveImportQualifiedName(
  qualifiedName: string,
  currentFileId: string,
  map: ModuleMap,
): ResolvedImport {
  const currentModule = map.pathToModule.get(currentFileId) ?? "";
  const absolute = resolveRelativeModule(qualifiedName, currentModule);
  const segments = absolute.split(".");

  // モジュールキーに一致する最長プレフィックスを探す。
  for (let end = segments.length; end >= 1; end -= 1) {
    const candidate = segments.slice(0, end).join(".");
    if (map.moduleToPath.has(candidate)) {
      const name = segments.slice(end).join(".");
      const targetFileId = map.moduleToPath.get(candidate) ?? null;
      return { moduleDotted: candidate, name, targetFileId };
    }
  }

  // rootSegment 付きで再試行する（絶対 import で rootSegment を省略するパターン対応）。
  // 例: backendRoot="backend" → moduleMap キーは "backend.routers.posts" だが、
  //     Python コード上の import は "from routers import posts"（"backend." 省略）。
  const rootSegment = currentModule.split(".")[0];
  if (
    rootSegment !== undefined &&
    rootSegment.length > 0 &&
    !absolute.startsWith(`${rootSegment}.`)
  ) {
    const withRoot = `${rootSegment}.${absolute}`;
    const withRootSegments = withRoot.split(".");
    for (let end = withRootSegments.length; end >= 1; end -= 1) {
      const candidate = withRootSegments.slice(0, end).join(".");
      if (map.moduleToPath.has(candidate)) {
        const name = withRootSegments.slice(end).join(".");
        const targetFileId = map.moduleToPath.get(candidate) ?? null;
        return { moduleDotted: candidate, name, targetFileId };
      }
    }
  }

  // フォールバック: 末尾セグメントを名前、残りをモジュール（外部の可能性）とみなす。
  if (segments.length <= 1) {
    return { moduleDotted: absolute, name: "", targetFileId: null };
  }
  const name = segments[segments.length - 1] ?? "";
  const moduleDotted = segments.slice(0, segments.length - 1).join(".");
  return { moduleDotted, name, targetFileId: null };
}
