import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // src/vscode-extension/test/** holds Mocha specs for the @vscode/test-electron
    // integration harness (task 1.3). They use suite()/test() globals (Mocha TDD UI),
    // not vitest's describe()/it(), so vitest must not collect them.
    exclude: ["**/node_modules/**", "src/vscode-extension/test/**"],
  },
});
