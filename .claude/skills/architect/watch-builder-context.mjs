#!/usr/bin/env node
// Usage: node watch-builder-context.mjs <agentId> [thresholdTokens=700000] [intervalSeconds=60]
// Exits 0 once the subagent's context passes the threshold; exits 1 when its transcript cannot be read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [agentId, thresholdArg = "700000", intervalArg = "60"] = process.argv.slice(2);
if (!agentId) {
  console.error("usage: watch-builder-context.mjs <agentId> [thresholdTokens] [intervalSeconds]");
  process.exit(1);
}
const threshold = Number(thresholdArg);
const intervalMs = Number(intervalArg) * 1000;
const transcriptWaitMs = 120_000;

const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

function findTranscript() {
  const name = `agent-${agentId}.jsonl`;
  for (const project of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, project);
    let sessions;
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOTDIR") continue;
      throw error;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const candidate = join(projectDir, session.name, "subagents", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function contextTokens(transcript) {
  const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (error) {
      // The last line may be mid-write; any other unparseable line is a real failure.
      if (i === lines.length - 1) continue;
      throw error;
    }
    const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
    if (usage) {
      return (
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      );
    }
  }
  return 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let transcript = findTranscript();
for (let waited = 0; !transcript && waited < transcriptWaitMs; waited += 5000) {
  await sleep(5000);
  transcript = findTranscript();
}
if (!transcript) {
  console.error(`no transcript for agent ${agentId} under ${projectsDir} after ${transcriptWaitMs / 1000}s`);
  process.exit(1);
}

for (;;) {
  const tokens = contextTokens(transcript);
  if (tokens > threshold) {
    console.log(`agent ${agentId}: context ${tokens} tokens passed threshold ${threshold}`);
    process.exit(0);
  }
  await sleep(intervalMs);
}
