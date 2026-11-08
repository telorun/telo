// One attempt: prepare a workspace, run the agent in it through the container seam, then boot the
// result outside the container and run the contract tests. The seams are plain objects so a test
// can replace the container and the app launcher.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentOutput } from "./claude-result.mjs";
import { freePort } from "./app-launcher.mjs";
import { TASKS, promptFor } from "./tasks.mjs";
import { linesWritten, prepareWorkspace } from "./workspace.mjs";

const totalTokens = (tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

async function checkApp({ task, side, workspace, seams }) {
  try {
    seams.launcher.prepare(workspace, side);
    const port = await freePort();
    const app = await seams.launcher.start(workspace, side, { port });
    try {
      const contract = await seams.contract(TASKS[task].contract, `http://127.0.0.1:${port}`);
      return { passed: contract.passed, log: contract.output };
    } finally {
      await app.stop();
    }
  } catch (error) {
    return { passed: false, log: `the app could not be built or started: ${error.message}` };
  }
}

export function attemptDirectory(outDir, task, side, attempt) {
  return join(outDir, "attempts", `${task}-${side}-${attempt}`);
}

// Returns the authoring.jsonl record. Throws when the agent never ran (no result, no tokens): that
// is a setup fault, not a failed attempt. The attempt's directory must not exist yet.
export async function runAttempt({ task, side, attempt, commit, teloVersion, model, outDir, timeoutMs, maxBudgetUsd }, seams) {
  const directory = attemptDirectory(outDir, task, side, attempt);
  const start = join(directory, "start");
  const workspace = join(directory, "workspace");
  mkdirSync(directory, { recursive: true });
  prepareWorkspace(task, side, start);
  cpSync(start, workspace, { recursive: true });

  const agent = await seams.agent({
    side,
    workspace,
    prompt: promptFor(task, side),
    model,
    timeoutMs,
    maxBudgetUsd,
    outputFile: join(directory, "agent.jsonl"),
  });
  const parsed = parseAgentOutput(agent.stdout);
  if (!agent.timedOut && !parsed.complete) {
    throw new Error(`${task}/${side}/${attempt}: the agent produced no result (exit ${agent.exitCode}). Last stderr:\n${agent.stderrTail}`);
  }
  if (!agent.timedOut && parsed.isError && totalTokens(parsed.tokens) === 0) {
    throw new Error(`${task}/${side}/${attempt}: the agent failed before using the model (${parsed.subtype ?? "error"}). Last stderr:\n${agent.stderrTail}`);
  }

  const overBudget = parsed.costUsd !== null && parsed.costUsd > maxBudgetUsd;
  const outOfLimits = agent.timedOut || overBudget;
  const check = outOfLimits ? { passed: false, log: agent.timedOut ? "timed out" : "over budget" } : await checkApp({ task, side, workspace, seams });
  writeFileSync(join(directory, "contract.log"), check.log);

  return {
    commit,
    teloVersion,
    model,
    task,
    side,
    attempt,
    tokens: parsed.tokens,
    costUsd: parsed.costUsd,
    turns: parsed.turns,
    toolCalls: parsed.toolCalls,
    wallSeconds: agent.wallSeconds,
    contractTestsPassed: check.passed,
    linesWritten: linesWritten(start, workspace),
  };
}
