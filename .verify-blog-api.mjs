import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = "/var/syslabo/ApiVista";
const VSCODE_BIN = path.join(
  REPO,
  ".vscode-test/vscode-linux-x64-1.125.1/code",
);
const WORKSPACE = "/var/syslabo/blog-api";
const SHOT_DIR = "/tmp/verify-blog-api-shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const userDataDir = fs.mkdtempSync("/tmp/apivista-blogapi-verify-");

function findWebviewFrame(page) {
  return page
    .frames()
    .find(
      (f) =>
        f.url().includes("vscode-webview://") && f.url().includes("/fake.html"),
    );
}

async function shot(page, name) {
  const f = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: f });
  console.log("screenshot:", f);
}

async function main() {
  console.log("=== Step 1: VSCode起動 (blog-api) ===");
  const app = await electron.launch({
    executablePath: VSCODE_BIN,
    args: [
      WORKSPACE,
      `--extensionDevelopmentPath=${REPO}`,
      `--user-data-dir=${userDataDir}`,
      "--disable-extensions",
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
  await new Promise((r) => setTimeout(r, 8000));

  console.log("=== Step 2: ApiVista: Show Route Linkage Graph 実行 ===");
  await page.keyboard.press("Control+Shift+P");
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.type("ApiVista: Show Route Linkage Graph", { delay: 25 });
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 8000));
  await shot(page, "01-route-linkage");

  const webviewFrame = findWebviewFrame(page);
  console.log("webview frame found:", !!webviewFrame);

  if (webviewFrame) {
    console.log("=== Step 3: ファイル単位ビュー ===");
    await webviewFrame.locator('button[data-value="file"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    await shot(page, "02-file-depth");

    console.log("=== Step 4: 関数単位ビュー ===");
    await webviewFrame.locator('button[data-value="function"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    await shot(page, "03-function-depth");

    console.log("=== Step 5: ルート連携ビューに戻してノードクリック ===");
    await webviewFrame.locator('button[data-value="route"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    const cardCount = await webviewFrame.locator(".node-card").count();
    console.log("node-card count:", cardCount);
    if (cardCount > 0) {
      await webviewFrame.locator(".node-card").first().click();
      await new Promise((r) => setTimeout(r, 1500));
      await shot(page, "04-after-node-click");
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
  await app.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log("done. screenshots in", SHOT_DIR);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
