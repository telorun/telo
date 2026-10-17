#!/usr/bin/env node
// Usage: node agent-report.mjs <agentId> <file> [heading]
// Appends a subagent's final report, verbatim, to <file> (created with its directories when
// missing), under "# <heading>" when one is given, and prints the size of the subagent's context.
// Exits 1 when the transcript or a report in it cannot be found.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [agentId, file, heading] = process.argv.slice(2);
if (!agentId || !file) {
  console.error("usage: agent-report.mjs <agentId> <file> [heading]");
  process.exit(1);
}

const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

function findTranscript() {
  if (!existsSync(projectsDir)) return undefined;
  const name = `agent-${agentId}.jsonl`;
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projectsDir, project.name);
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const candidate = join(projectDir, session.name, "subagents", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const transcript = findTranscript();
if (!transcript) {
  console.error(`agent ${agentId}: no transcript under ${projectsDir}`);
  process.exit(1);
}

// The report is the last hand-back the agent made; an agent that ended on plain text reports
// with that text. Lines that do not parse (the last one may be mid-write) are skipped.
let report;
let context = 0;
for (const line of readFileSync(transcript, "utf8").split("\n")) {
  if (line.length === 0) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry?.type !== "assistant") continue;
  const usage = entry.message?.usage;
  if (usage) {
    const sum =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    if (Number.isFinite(sum) && sum > 0) context = sum;
  }
  const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
  for (const block of content) {
    if (block?.type === "tool_use" && typeof block.input?.message === "string") {
      if (block.name === "SubagentHandback") report = block.input.message;
    } else if (block?.type === "text" && block.text.trim().length > 0) {
      report = block.text;
    }
  }
}
if (!report) {
  console.error(`agent ${agentId}: no report in ${transcript}`);
  process.exit(1);
}

mkdirSync(dirname(file), { recursive: true });
const prefix = existsSync(file) && readFileSync(file, "utf8").length > 0 ? "\n---\n\n" : "";
appendFileSync(file, `${prefix}${heading ? `# ${heading}\n\n` : ""}${report.trimEnd()}\n`);
console.log(`agent ${agentId}: report (${report.length} chars) appended to ${file}`);
console.log(`agent ${agentId}: context ${context} tokens`);
