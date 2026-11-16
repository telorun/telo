#!/usr/bin/env node
// PostToolUse hook: after Claude edits a file the module-mentions check reads,
// checks the text the edit WROTE (an Edit's `new_string`, each MultiEdit
// `new_string`, a Write's whole `content`) so a mention already in the file does
// not block every edit to it. Findings go to stderr with exit 2.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  REMEDY,
  createMatcher,
  inScope,
  loadVocabulary,
  repoRoot,
} from "../../scripts/check-module-mentions.mjs";

const input = JSON.parse(readFileSync(0, "utf-8"));
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || input?.tool_response?.success === false) process.exit(0);

const file = relative(repoRoot, filePath).split("\\").join("/");
if (file.startsWith("..") || !inScope(file)) process.exit(0);

const written =
  input.tool_name === "Write"
    ? [input.tool_input.content]
    : input.tool_name === "MultiEdit"
      ? (input.tool_input.edits ?? []).map((edit) => edit.new_string)
      : [input.tool_input.new_string];

const current = readFileSync(filePath, "utf-8");
const findMentions = createMatcher(loadVocabulary({ cache: true }));
const findings = [];
for (const text of written) {
  if (typeof text !== "string" || text.length === 0) continue;
  const offset = current.indexOf(text);
  const before = offset < 0 ? "" : current.slice(0, offset);
  const lineOffset = before.split("\n").length - 1;
  const columnOffset = before.length - (before.lastIndexOf("\n") + 1);
  for (const { line, column, what } of findMentions(text)) {
    const at = line === 1 ? column + columnOffset : column;
    findings.push(`${file}:${line + lineOffset}:${at}: ${what}`);
  }
}

if (findings.length === 0) process.exit(0);
process.stderr.write(`The edit to ${file} mentions a module:\n${findings.join("\n")}\n\n${REMEDY}\n`);
process.exit(2);
