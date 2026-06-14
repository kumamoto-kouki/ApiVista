#!/usr/bin/env node
// PostToolUse hook: auto-format/lint the file just edited or written.
// Reads the hook event JSON from stdin and dispatches based on file extension.
// Non-blocking: any failure here must not interrupt the agent's work.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {
    // ignore: formatting/lint failures should not block the agent
  }
}

let event;
try {
  event = JSON.parse(readFileSync(0, "utf-8"));
} catch {
  process.exit(0);
}

const filePath = event?.tool_input?.file_path;
if (!filePath || !existsSync(filePath)) {
  process.exit(0);
}

const ext = path.extname(filePath);

if ([".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(ext)) {
  run("npx", ["eslint", "--fix", filePath]);
  run("npx", ["prettier", "--write", filePath]);
}

process.exit(0);
