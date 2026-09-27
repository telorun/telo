#!/usr/bin/env node
// PreToolUse hook on Bash: refuses what no Claude session may do, in any permission mode —
// merging a pull request, and pushing anything but an explicitly named `rust-parity/*` branch
// (the only pushes CLAUDE.md allows, made by the rust-parity skill).

const fs = require("node:fs");

const command = JSON.parse(fs.readFileSync(0, "utf-8"))?.tool_input?.command ?? "";
const reason = refusal(command);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked by git-publish-guard: ${reason}`,
      },
    }),
  );
}

function refusal(text) {
  if (/\bgh\s+pr\s+merge\b/.test(text) || /\/pulls\/[^\s/]+\/merge\b/.test(text)) {
    return "merging a pull request is the user's alone.";
  }
  if (/\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(text)) {
    return "merging a pull request is the user's alone.";
  }
  for (const match of text.matchAll(/\bgit(?:\s+-C\s+\S+)*\s+push\b([^;&|\n]*)/g)) {
    const problem = pushProblem(match[1].trim().split(/\s+/).filter(Boolean));
    if (problem) return problem;
  }
  return null;
}

function pushProblem(args) {
  const positional = [];
  for (const arg of args) {
    if (/^(--all|--mirror|--tags|--delete|-d|--force|-f|--prune)$/.test(arg)) {
      return `\`git push ${arg}\` is not allowed; only --force-with-lease on a rust-parity/* branch is.`;
    }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) {
    return "a push must name its rust-parity/* branch explicitly.";
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return "a forced refspec (`+…`) is not allowed; use --force-with-lease.";
    const destination = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
    if (!/^(refs\/heads\/)?rust-parity\/[^\s]+$/.test(destination)) {
      return `pushing \`${destination || refspec}\` is not allowed; only rust-parity/* branches may be pushed.`;
    }
  }
  return null;
}
