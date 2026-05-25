#!/usr/bin/env node
// PostToolUse hook: runs `telo check` after Claude edits a top-level Telo
// manifest YAML, surfacing analyzer diagnostics via stderr + exit 2 so they
// land in the next turn's context.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Resolve the workspace root from this script's location (.claude/hooks/) so
// the pnpm invocation finds the root package.json's `telo` script regardless
// of Claude Code's CWD when it fires the hook.
const repoRoot = path.resolve(__dirname, "..", "..");

const input = (() => {
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
})();

const filePath = input?.tool_input?.file_path;
if (!filePath || !filePath.endsWith(".yaml")) process.exit(0);
if (input?.tool_response?.success === false) process.exit(0);
if (!fs.existsSync(filePath)) process.exit(0);

let head;
try {
  head = fs.readFileSync(filePath, "utf-8").split("\n").slice(0, 60).join("\n");
} catch {
  process.exit(0);
}

// Skip partials, fixtures, and non-Telo YAML. `telo check` on a partial fails
// noisily (no root doc) — only run on files that actually declare a runnable
// or library root.
if (!/^kind: Telo\.(Application|Library)/m.test(head)) process.exit(0);

const result = spawnSync("pnpm", ["-s", "run", "telo", "check", filePath], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30000,
  cwd: repoRoot,
});

if (result.status === 0) process.exit(0);

process.stderr.write(`telo check found issues in ${filePath}:\n`);
if (result.stdout) process.stderr.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(2);
