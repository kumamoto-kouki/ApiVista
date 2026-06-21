import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = "/var/syslabo/ApiVista";
const VSCODE_BIN = path.join(REPO, ".vscode-test/vscode-linux-x64-1.125.1/code");
const WORKSPACE = path.join(REPO, "tests/fixtures/vscode_workspace");
const SHOT_DIR = "/tmp/verify-shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const userDataDir = fs.mkdtempSync("/tmp/apivista-verify-user-data-");

function findWebviewFrame(page) {
  return page
    .frames()
    .find((f) => f.url().includes("vscode-webview://") && f.url().includes("/fake.html"));
}

async function shot(page, name) {
  const f = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: f });
  console.log("screenshot:", f);
}

async function main() {
  console.log("=== Step 1: VSCode起動 ===");
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

  console.log("=== Step 2: コマンドパレットから ApiVista: Show Route Linkage Graph を実行 ===");
  await page.keyboard.press("Control+Shift+P");
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.type("ApiVista: Show Route Linkage Graph", { delay: 25 });
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 6000));
  await shot(page, "01-graph-route-depth-breadthfirst");

  const webviewFrame = findWebviewFrame(page);
  console.log("webview frame found:", !!webviewFrame);

  if (webviewFrame) {
    console.log("=== Step 3: 深度切替 → ファイル単位 (エッジ色/レイアウト確認) ===");
    await webviewFrame.locator('button[data-value="file"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    await shot(page, "02-graph-file-depth-breadthfirst");

    console.log("=== Step 4: 警告オーバーレイの確認 ===");
    await webviewFrame.locator('button[data-value="route"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    await shot(page, "03-warning-overlay-route");
    // 警告オーバーレイが存在すればホバー確認
    const overlayCount = await webviewFrame.locator(".warning-overlay").count();
    console.log("warning-overlay count:", overlayCount);
    if (overlayCount > 0) {
      await webviewFrame.locator(".warning-overlay").first().hover();
      await new Promise((r) => setTimeout(r, 1000));
      await shot(page, "04-warning-overlay-hover");
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
  await app.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log("done");
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
