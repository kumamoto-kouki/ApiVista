import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../cli.js";
import { resetPythonParser } from "../parser.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

interface Captured {
  stdout: string[];
  stderr: string[];
}

function captureStreams(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: [], stderr: [] };
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  return {
    captured,
    restore: (): void => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("cli main", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("analyzes sample_app: exit 0, single JSON on stdout, no JSON on stderr (Req 4.1, 5.1)", async () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = await main([SAMPLE_APP]);
    } finally {
      restore();
    }

    expect(code).toBe(0);

    // stdout must be exactly one JSON payload (a single AnalysisOutput object).
    const stdout = captured.stdout.join("");
    const parsed: unknown = JSON.parse(stdout);
    expect(typeof parsed).toBe("object");
    const output = parsed as {
      schemaVersion: number;
      routes: unknown[];
      warnings: unknown[];
    };
    expect(output.schemaVersion).toBe(1);
    expect(output.routes.length).toBe(4);

    // warnings present (broken.py + dynamic route) yet exit is still 0 (Req 5.1).
    expect(output.warnings.length).toBeGreaterThan(0);

    // stderr must not contain the JSON payload (stdout is reserved for JSON).
    const stderr = captured.stderr.join("");
    expect(stderr.includes('"schemaVersion"')).toBe(false);
  });

  it("prints usage to stderr and returns 2 when no backendRoot arg is given", async () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = await main([]);
    } finally {
      restore();
    }

    expect(code).toBe(2);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });

  it("returns non-zero (1) and writes error to stderr for a nonexistent directory", async () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = await main(["/nonexistent/path/xyz"]);
    } finally {
      restore();
    }

    expect(code).toBe(1);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });
});
