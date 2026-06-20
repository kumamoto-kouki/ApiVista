/**
 * @vscode/test-electron ランナースクリプト（task 1.3）。
 *
 * 実VSCodeをダウンロード・起動し、`extensionTestsPath` のMochaスイートを実行する。
 * design.md "Testing Strategy" の Integration Tests (`@vscode/test-electron`、実VSCode起動) を
 * 駆動する実行基盤であり、本ファイル自体はテストケースを持たない（スイート本体は
 * `src/vscode-extension/test/suite/`）。
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

// 本パッケージは "type": "module" (ESM) のため CommonJS の `__dirname` は使用できない。
// `import.meta.url` から同等のディレクトリパスを導出する。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // リポジトリルート（拡張のマニフェスト package.json が存在する場所）。
  // コンパイル後のこのファイルは out-test-electron/vscode-extension/test/runTest.js に位置するため、
  // out-test-electron/vscode-extension/test -> out-test-electron/vscode-extension -> out-test-electron
  // -> リポジトリルート の3階層上。
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");

  // コンパイル済みMochaスイートのエントリ（tsc出力先 out-test-electron/ 配下）。
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");

  // 単一ルートに backend/・frontend/ を直下に持つフィクスチャワークスペース
  // (tests/fixtures/sample_app + sample_nuxt 相当の構成、design.md Testing Strategy参照)。
  const workspacePath = path.resolve(extensionDevelopmentPath, "tests/fixtures/vscode_workspace");

  // CI/コンテナ環境ではroot権限で実行されることがあり、Electron/Chromiumのサンドボックスは
  // root権限下では起動を拒否する（"Running as root without --no-sandbox is not supported"）。
  // `--no-sandbox` はVSCode本体のCIやElectronベースのテストランナーで標準的に使われる起動引数。
  const launchArgs = [workspacePath, "--disable-extensions"];
  if (process.getuid?.() === 0) {
    launchArgs.push("--no-sandbox");
  }

  // 一部の実行環境ではシェルが `ELECTRON_RUN_AS_NODE=1` を継承しており、その場合 `code` バイナリは
  // Electron/VSCodeとして起動せず素のNodeプロセスとして起動してしまう（ワークスペースパスを
  // モジュールとして`require`しようとして失敗する等の誤動作を引き起こす）。実VSCodeを確実に
  // 起動するため、子プロセスへ引き継ぐ前にこの変数を取り除く。
  delete process.env.ELECTRON_RUN_AS_NODE;

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });
  } catch (error) {
    console.error("Failed to run integration tests", error);
    process.exit(1);
  }
}

void main();
