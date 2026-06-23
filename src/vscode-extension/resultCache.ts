/**
 * 解析結果（LinkageOutput）を context.storageUri 配下に JSON 形式で永続化する。
 * 読み込み失敗（ファイル不在・破損）は undefined を返して握り潰す。
 * 書き込み失敗はログせずに無視する（キャッシュは best-effort）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LinkageOutput } from "../route-linkage/index.js";

const CACHE_FILE = "apivista-result.json";

export async function loadCachedResult(storageDir: string): Promise<LinkageOutput | undefined> {
  try {
    const json = await readFile(join(storageDir, CACHE_FILE), "utf8");
    return JSON.parse(json) as LinkageOutput;
  } catch {
    return undefined;
  }
}

export async function saveCachedResult(storageDir: string, output: LinkageOutput): Promise<void> {
  try {
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, CACHE_FILE), JSON.stringify(output));
  } catch {
    // best-effort: キャッシュ書き込み失敗は解析結果の表示には影響しない
  }
}
