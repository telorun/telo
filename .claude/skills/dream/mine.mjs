#!/usr/bin/env node
// Usage: node mine.mjs [--sessions N] [--grep <regex>]... [--out <file>]
// Digests this project's last N main-session transcripts (newest first, /dream sessions skipped)
// into what a person said and what went wrong: every human prompt, corrections flagged with the
// assistant text they answered, interrupts, refused tool calls, hook blocks and repeated tool errors.
// --grep keeps only prompts matching a regex (case-insensitive) and adds matching tool errors.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let sessions = 30;
let out;
const greps = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--sessions") sessions = Number(args[++i]);
  else if (arg === "--grep") greps.push(new RegExp(args[++i], "i"));
  else if (arg === "--out") out = args[++i];
  else {
    console.error(`unknown argument: ${arg}`);
    process.exit(1);
  }
}
if (!Number.isInteger(sessions) || sessions < 1) {
  console.error("--sessions must be a positive integer");
  process.exit(1);
}

const projectDir = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "projects",
  process.cwd().replace(/[^A-Za-z0-9]/g, "-"),
);

const CORRECTION =
  /\b(no|not|don'?t|do not|never|always|stop|wrong|why did you|i said|i told|instead|again|revert|undo|should(n'?t)?|must(n'?t)?|actually)\b|!!|\?\?/i;
const NOISE =
  /^(<task-notification>|Another Claude session sent a message|This session is being continued|<local-command|Caveat:|\[Subagent hand-back\])/;
const STRIP = /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g;

const clip = (text, n) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function describeCall(call) {
  if (!call) return "unknown tool";
  const input = call.input ?? {};
  const detail = input.command ?? input.file_path ?? input.skill ?? input.description ?? "";
  return `${call.name}${detail ? ` \`${clip(String(detail), 160)}\`` : ""}`;
}

function digestSession(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const calls = new Map();
  const events = [];
  const errors = [];
  let title = "";
  let branch = "";
  let start = "";
  let lastAssistant = "";
  let command = "";
  let isDream = false;

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "ai-title") title = entry.aiTitle ?? title;
    if (entry.isSidechain) continue;
    if (entry.gitBranch) branch = entry.gitBranch;
    if (!start && entry.timestamp) start = entry.timestamp.slice(0, 16).replace("T", " ");

    if (entry.type === "assistant") {
      for (const block of entry.message?.content ?? []) {
        if (block.type === "tool_use") calls.set(block.id, block);
        if (block.type === "text" && block.text.trim()) lastAssistant = block.text;
      }
      continue;
    }
    if (entry.type !== "user") continue;

    const content = entry.message?.content;
    if (entry.toolUseResult !== undefined || entry.sourceToolAssistantUUID) {
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== "tool_result" || block.is_error !== true) continue;
        const text = typeof block.content === "string" ? block.content : textOf(block.content);
        const call = describeCall(calls.get(block.tool_use_id));
        if (/doesn'?t want to proceed|tool use was rejected/i.test(text)) {
          events.push({ tag: "refused", text: call, context: lastAssistant });
        } else if (/hook (error|blocked)|Blocked:/i.test(text)) {
          events.push({ tag: "hook", text: `${call} — ${clip(text, 240)}` });
        } else {
          const first = text.split("\n").find((l) => l.trim() && !/^Exit code \d+$/.test(l.trim()));
          errors.push({ call, text: clip(first ?? text, 160) });
        }
      }
      continue;
    }
    if (entry.isMeta) continue;

    const raw = textOf(content).replace(STRIP, "").trim();
    if (!raw || NOISE.test(raw)) continue;
    const name = raw.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
    if (name) {
      const commandArgs = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
      command = `${name} ${clip(commandArgs, 120)}`.trim();
      if (name === "/dream") isDream = true;
      events.push({ tag: "command", text: command });
      continue;
    }
    if (/^\[Request interrupted by user/.test(raw)) {
      events.push({ tag: "interrupt", text: clip(raw, 200), context: lastAssistant });
      continue;
    }
    const correction = CORRECTION.test(raw);
    events.push({
      tag: correction ? "correction" : "prompt",
      text: clip(raw, 700),
      context: correction ? lastAssistant : undefined,
      command,
    });
  }
  return { title, branch, start, events, errors, isDream };
}

const files = readdirSync(projectDir)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => ({ name, path: join(projectDir, name), mtime: statSync(join(projectDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

const digested = [];
for (const file of files) {
  if (digested.length >= sessions) break;
  const session = digestSession(file.path);
  if (session.isDream) continue;
  if (!session.events.some((event) => event.tag !== "command")) continue;
  digested.push({ id: file.name.replace(/\.jsonl$/, ""), ...session });
}

const matches = (text) => greps.length === 0 || greps.some((re) => re.test(text));
const report = [];
const range = digested.length
  ? `${digested.at(-1).start} → ${digested[0].start}`
  : "none";
report.push(`# Dream digest — ${digested.length} sessions (${range})`, "");

const errorCounts = new Map();
for (const session of digested) {
  for (const error of session.errors) {
    const key = `${error.call.split(" ")[0]} — ${error.text}`;
    const seen = errorCounts.get(key) ?? { count: 0, sessions: new Set() };
    seen.count++;
    seen.sessions.add(session.id.slice(0, 8));
    errorCounts.set(key, seen);
  }
}
const repeated = [...errorCounts.entries()]
  .filter(([key, seen]) => seen.count >= 3 && matches(key))
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 40);
report.push("## Repeated tool errors (≥3)", "");
for (const [key, seen] of repeated) {
  report.push(`- ${seen.count}× in ${seen.sessions.size} sessions: ${key}`);
}
if (repeated.length === 0) report.push("- none");
report.push("");

for (const session of digested) {
  const kept = session.events.filter(
    (event) => event.tag === "command" || matches(event.text),
  );
  if (!kept.some((event) => event.tag !== "command")) continue;
  report.push(`## ${session.id.slice(0, 8)} · ${session.start} · ${session.branch} · ${session.title}`, "");
  for (const event of kept) {
    report.push(`- [${event.tag}] ${event.text}`);
    if (event.context) report.push(`  ↳ answering: ${clip(event.context, 400)}`);
  }
  report.push("");
}

const text = report.join("\n");
if (out) {
  writeFileSync(out, text);
  console.log(`${out}: ${digested.length} sessions, ${text.length} chars`);
} else {
  process.stdout.write(text);
}
