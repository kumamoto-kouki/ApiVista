/**
 * Mochaテストスイートエントリ（task 1.3）。
 *
 * `@vscode/test-electron` の `extensionTestsPath` から呼び出され、コンパイル済み
 * `out-test-electron/vscode-extension/test/suite/**\/*.test.js` をglob探索してMochaへ登録する。
 * 標準的な @vscode/test-electron ボイラープレートに従う。
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Mocha from "mocha";
import { glob } from "glob";

// 本パッケージは "type": "module" (ESM) のため CommonJS の `__dirname` は使用できない。
// `import.meta.url` から同等のディレクトリパスを導出する。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
  });

  const testsRoot = path.resolve(__dirname, "..");

  const files = await glob("**/*.test.js", { cwd: testsRoot });

  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
