// Build placeholder for task 1.1 — the real Webview entry (Cytoscape init, message
// handling, depth switching) is implemented in task 7. This file exists solely so
// that `bundle:webview` has a valid entry point and `npm run build` succeeds end-to-end.
import type { WebviewToHostMessage } from "../webviewProtocol.js";

// Type-only smoke check (task 1.2): proves webview-side code can resolve the shared
// host<->webview message protocol types under real tsc compilation (not just vitest).
// Real message dispatch/handling lands in task 7; this function is intentionally minimal.
export function describeWebviewMessage(message: WebviewToHostMessage): string {
  return message.type;
}
