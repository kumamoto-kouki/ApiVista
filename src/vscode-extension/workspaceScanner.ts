/**
 * 単一ルート前提のbackend/frontend存在検証（design.md「workspaceScanner」, Requirements 2.1, 2.2, 2.5）。
 *
 * - `vscode.workspace.workspaceFolders`が単一ルートでなければ`ScopeError("multi-root")`をthrowする
 *   （0件=ワークスペース未オープンの場合も、AC2.5が定義する「単一ルートのみ対応」という前提から
 *   外れる構成として同じ`"multi-root"`に分類する。design.mdが定義する`reason`は
 *   `"missing-backend" | "missing-frontend" | "multi-root"`の3種のみであり、0件用の4種目は
 *   定義されていないため）。
 * - 単一ルート直下の`backend/`・`frontend/`ディレクトリ存在を検証し、いずれか欠落していれば
 *   対応する`ScopeError`をthrowする。
 * - 副作用なし（VSCode API・Node `fs`の読み取りのみ）。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

export interface ScannedWorkspace {
  backendRoot: string;
  frontendRoot: string;
}

export class ScopeError extends Error {
  constructor(
    public readonly reason: "missing-backend" | "missing-frontend" | "multi-root",
    message: string,
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

/** `dirPath`がディレクトリとして存在するかを検証する（ファイルとして存在する場合は不可とする）。 */
function isExistingDirectory(dirPath: string): boolean {
  return existsSync(dirPath) && statSync(dirPath).isDirectory();
}

export function validate(): ScannedWorkspace {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length !== 1) {
    throw new ScopeError(
      "multi-root",
      folders && folders.length > 1
        ? `複数のワークスペースフォルダ(${folders.length}件)が開かれています。ApiVistaは単一ルートワークスペースのみ対応します。`
        : "ワークスペースフォルダが開かれていません。ApiVistaは単一ルートワークスペースのみ対応します。",
    );
  }

  const rootFsPath = folders[0].uri.fsPath;
  const backendRoot = join(rootFsPath, "backend");
  const frontendRoot = join(rootFsPath, "frontend");

  if (!isExistingDirectory(backendRoot)) {
    throw new ScopeError(
      "missing-backend",
      `ワークスペースルート直下に backend/ ディレクトリが見つかりません: ${backendRoot}`,
    );
  }

  if (!isExistingDirectory(frontendRoot)) {
    throw new ScopeError(
      "missing-frontend",
      `ワークスペースルート直下に frontend/ ディレクトリが見つかりません: ${frontendRoot}`,
    );
  }

  return { backendRoot, frontendRoot };
}
