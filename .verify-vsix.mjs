/**
 * VSIX インストール検証スクリプト
 * 開発モード（--extensionDevelopmentPath）を使わず、展開済み VSIX から拡張機能をロードして動作確認する。
 */
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const REPO = "/var/syslabo/ApiVista";
const VSCODE_BIN = path.join(REPO, ".vscode-test/vscode-linux-x64-1.125.1/code");
const VSIX_PATH = path.join(REPO, "apivista-0.1.0.vsix");
const WORKSPACE = "/var/syslabo/blog-api";
const SHOT_DIR = "/tmp/verify-vsix-shots";

fs.mkdirSync(SHOT_DIR, { recursive: true });

// VSIX を展開して一時 extensions ディレクトリに配置する
const extDir = fs.mkdtempSync("/tmp/vsix-ext-");
const extractDir = fs.mkdtempSync("/tmp/vsix-extract-");
console.log("=== VSIX 展開 ===");
console.log("  extDir:", extDir);
execSync(
  `python3 -c "import zipfile; zipfile.ZipFile('${VSIX_PATH}').extractall('${extractDir}')"`,
);
const extTarget = path.join(extDir, "kumamoto-kouki.apivista-0.1.0");
fs.mkdirSync(extTarget, { recursive: true });
execSync(`cp -r "${extractDir}/extension/." "${extTarget}/"`);
console.log("  インストール先:", extTarget);
console.log("  ファイル:", fs.readdirSync(extTarget).join(", "));

const userDataDir = fs.mkdtempSync("/tmp/vsix-userdata-");

function findWebviewFrame(page) {
  return page
    .frames()
    .find((f) => f.url().includes("vscode-webview://") && f.url().includes("/fake.html"));
}

async function shot(page, name) {
  const f = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: f });
  console.log("  screenshot:", f);
}

async function main() {
  console.log(
    "\n=== Step 1: VSCode 起動（VSIX インストール済み、--extensionDevelopmentPath なし）===",
  );
  const app = await electron.launch({
    executablePath: VSCODE_BIN,
    args: [
      WORKSPACE,
      // 開発モードとの違い: extensionDevelopmentPath を使わない
      // 代わりに展開済み VSIX を extensions-dir で指定
      `--extensions-dir=${extDir}`,
      `--user-data-dir=${userDataDir}`,
      "--disable-workspace-trust",
      "--no-sandbox",
      "--skip-release-notes",
      "--skip-welcome",
      "--disable-telemetry",
    ],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    timeout: 60_000,
  });

  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  console.log("  起動完了、8秒待機...");
  await new Promise((r) => setTimeout(r, 8000));

  console.log("\n=== Step 2: ApiVista: Show Route Linkage Graph 実行 ===");
  await page.keyboard.press("Control+Shift+P");
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.type("ApiVista: Show Route Linkage Graph", { delay: 25 });
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 10000)); // 解析に時間がかかる可能性
  await shot(page, "vsix-01-route-linkage");

  const webviewFrame = findWebviewFrame(page);
  console.log("  webview frame found:", !!webviewFrame);

  if (webviewFrame) {
    console.log("\n=== Step 3: ファイル単位ビュー ===");
    await webviewFrame.locator('button[data-value="file"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    await shot(page, "vsix-02-file-depth");

    console.log("\n=== Step 4: 関数単位ビュー ===");
    await webviewFrame.locator('button[data-value="function"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    await shot(page, "vsix-03-function-depth");

    console.log("\n=== Step 5: ルート連携ビュー → ノードクリック（ソースジャンプ確認） ===");
    await webviewFrame.locator('button[data-value="route"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    const cardCount = await webviewFrame.locator(".node-card").count();
    console.log("  node-card count:", cardCount);
    if (cardCount > 0) {
      await webviewFrame.locator(".node-card").first().click();
      await new Promise((r) => setTimeout(r, 2000));
      await shot(page, "vsix-04-node-click");
    }
  } else {
    console.log("  ⚠ webview frame が見つかりません。グラフ表示に失敗した可能性があります。");
    await shot(page, "vsix-01b-error-state");
  }

  await new Promise((r) => setTimeout(r, 1000));
  await app.close();

  // 後片付け
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });

  console.log("\n=== 完了 ===");
  console.log("スクリーンショット:", SHOT_DIR);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
