/**
 * @vitest-environment jsdom
 */
/**
 * `warningsPanel`の単体テスト(design.md「webview/warningsPanel」, tasks.md 4.3)。
 *
 * DOM表示ロジックのため`vitest + jsdom`で検証する(vitest.config.tsはデフォルト`node`環境のため、
 * このファイルのみ`@vitest-environment jsdom`で明示的にjsdomへ切り替える)。
 * 0件/1件/複数件それぞれの表示内容、再描画時の前回コンテンツの完全置換、
 * `innerHTML`不使用をカバーする(Requirement 7.1)。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { Warning } from "../../../route-linkage/models.js";
import { renderWarnings } from "../warningsPanel.js";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("renderWarnings", () => {
  it("renders a distinguishable zero/no-warnings state when warnings is empty", () => {
    const container = createContainer();

    renderWarnings(container, []);

    const text = container.textContent ?? "";
    expect(text).toContain("0");
    expect(text).not.toMatch(/api-1/);
  });

  it("shows the count and target/reason content for a single warning", () => {
    const container = createContainer();
    const warnings: Warning[] = [{ target: "api-1", reason: "schema mismatch" }];

    renderWarnings(container, warnings);

    const text = container.textContent ?? "";
    expect(text).toContain("1");
    expect(text).toContain("api-1");
    expect(text).toContain("schema mismatch");
  });

  it("shows the correct count and all warnings' target/reason content for multiple warnings", () => {
    const container = createContainer();
    const warnings: Warning[] = [
      { target: "api-1", reason: "schema mismatch" },
      { target: "api-2", reason: "missing handler" },
      { target: "api-3", reason: "ambiguous match" },
    ];

    renderWarnings(container, warnings);

    const text = container.textContent ?? "";
    expect(text).toContain("3");
    for (const warning of warnings) {
      expect(text).toContain(warning.target);
      expect(text).toContain(warning.reason);
    }
  });

  it("fully replaces previous content when called again with different warnings on the same container", () => {
    const container = createContainer();
    const firstWarnings: Warning[] = [
      { target: "api-1", reason: "schema mismatch" },
      { target: "api-2", reason: "missing handler" },
      { target: "api-3", reason: "ambiguous match" },
    ];
    const secondWarnings: Warning[] = [{ target: "api-9", reason: "unrelated reason" }];

    renderWarnings(container, firstWarnings);
    renderWarnings(container, secondWarnings);

    const text = container.textContent ?? "";
    expect(text).toContain("1");
    expect(text).toContain("api-9");
    expect(text).toContain("unrelated reason");
    for (const warning of firstWarnings) {
      expect(text).not.toContain(warning.target);
      expect(text).not.toContain(warning.reason);
    }
  });

  it("calls onTargetHover with the warning's target on mouseenter and null on mouseleave", () => {
    const container = createContainer();
    const warnings: Warning[] = [{ target: "api-1", reason: "schema mismatch" }];
    const onTargetHover = vi.fn();

    renderWarnings(container, warnings, onTargetHover);

    const item = container.querySelector("li");
    expect(item).not.toBeNull();
    item?.dispatchEvent(new MouseEvent("mouseenter"));
    expect(onTargetHover).toHaveBeenLastCalledWith("api-1");

    item?.dispatchEvent(new MouseEvent("mouseleave"));
    expect(onTargetHover).toHaveBeenLastCalledWith(null);
  });

  it("does not throw when no onTargetHover is provided and a warning item is hovered", () => {
    const container = createContainer();
    const warnings: Warning[] = [{ target: "api-1", reason: "schema mismatch" }];

    renderWarnings(container, warnings);

    const item = container.querySelector("li");
    expect(() => item?.dispatchEvent(new MouseEvent("mouseenter"))).not.toThrow();
  });

  it("does not assign to .innerHTML anywhere in the implementation source", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(here, "../warningsPanel.ts");
    const source = readFileSync(sourcePath, "utf-8");

    expect(source).not.toMatch(/\.innerHTML\s*=/);
  });
});
