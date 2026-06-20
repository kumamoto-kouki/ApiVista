import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../cli.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/route-linkage/__tests__ -> repo root -> tests/fixtures/route-linkage
const FIXTURES_DIR = join(here, "..", "..", "..", "tests", "fixtures", "route-linkage");
const BACKEND_JSON = join(FIXTURES_DIR, "backend.analysis.json");
const FRONTEND_JSON = join(FIXTURES_DIR, "frontend.analysis.json");

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links the fixture pair: exit 0, single JSON on stdout, no JSON on stderr", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([BACKEND_JSON, FRONTEND_JSON]);
    } finally {
      restore();
    }

    expect(code).toBe(0);

    const stdout = captured.stdout.join("");
    const parsed: unknown = JSON.parse(stdout);
    const output = parsed as { schemaVersion: number; linkages: unknown[] };
    expect(output.schemaVersion).toBe(1);
    expect(output.linkages.length).toBeGreaterThan(0);

    const stderr = captured.stderr.join("");
    expect(stderr.includes('"schemaVersion"')).toBe(false);
  });

  it("prints usage to stderr and returns 2 when fewer than two arguments are given", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([BACKEND_JSON]);
    } finally {
      restore();
    }

    expect(code).toBe(2);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });

  it("prints usage to stderr and returns 2 when no arguments are given", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([]);
    } finally {
      restore();
    }

    expect(code).toBe(2);
    expect(captured.stdout.join("")).toBe("");
  });

  it("returns non-zero (1) and writes an error to stderr for a nonexistent file", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main(["/nonexistent/backend.json", FRONTEND_JSON]);
    } finally {
      restore();
    }

    expect(code).toBe(1);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });

  it("returns non-zero (1) and writes an error to stderr when the backend path holds a frontend-shaped AnalysisOutput", () => {
    const { captured, restore } = captureStreams();
    let code: number;
    try {
      code = main([FRONTEND_JSON, FRONTEND_JSON]);
    } finally {
      restore();
    }

    expect(code).toBe(1);
    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("").length).toBeGreaterThan(0);
  });
});
