// The harness with a fake agent: the container seam writes a known app into the workspace and
// answers with a canned Claude Code result; everything after it (booting the app, the contract
// tests, the record) is the real code. Run: node --test benchmarks/authoring/tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { appLauncher, assertContractsReadable, runContract, teloCommand } from "../app-launcher.mjs";
import { runAttempt } from "../attempt.mjs";
import { writeComparison } from "../comparison-generation.mjs";
import { renderSummary, summarize } from "../summary.mjs";
import { leadIntake, repoRoot } from "../tasks.mjs";
import { prepareWorkspace } from "../workspace.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const solutions = join(here, "__fixtures__/solutions");
process.env.TELO_COMMAND ??= `${join(repoRoot, "node_modules/.bin/bun")} ${join(repoRoot, "cli/nodejs/bin/telo.ts")}`;

const scratch = mkdtempSync(join(tmpdir(), "authoring-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// What Claude Code's stream-json output holds: two tool calls in one message, one repeated in a
// later event, then the result.
function agentOutput({ cost = 4.12, tokens = { input: 182340, output: 41210, cacheRead: 2410388, cacheWrite: 201544 } } = {}) {
  const events = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1" }, { type: "tool_use", id: "t2" }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t2" }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "done" }, { type: "tool_use", id: "t3" }], usage: { input_tokens: 20, output_tokens: 7 } } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 38,
      total_cost_usd: cost,
      usage: { input_tokens: tokens.input, output_tokens: tokens.output, cache_read_input_tokens: tokens.cacheRead, cache_creation_input_tokens: tokens.cacheWrite },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const attemptOptions = (overrides) => ({
  attempt: 1,
  commit: "8b808da48",
  teloVersion: "0.112.0",
  model: "claude-opus-5-5",
  outDir: join(scratch, "out"),
  timeoutMs: 60 * 60_000,
  maxBudgetUsd: 20,
  ...overrides,
});

const fakeAgent = (build, result = {}) => async ({ workspace }) => {
  build(workspace);
  return { stdout: agentOutput(), stderrTail: "", exitCode: 0, timedOut: false, wallSeconds: 1460, ...result };
};

const refusing = {
  launcher: { prepare() {}, start: () => assert.fail("the app must not be booted") },
  contract: () => assert.fail("the contract tests must not run"),
};
const real = { launcher: appLauncher, contract: runContract };

let builtNode;
before(() => {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc", { paths: [join(leadIntake, "node")] });
  builtNode = join(scratch, "built-node");
  const build = spawnSync(process.execPath, [tsc, "-p", join(leadIntake, "node/tsconfig.json"), "--outDir", join(builtNode, "dist")], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
});

// A directory of links, not one link to the directory: pnpm's .bin shims locate packages relative
// to the path they are invoked by, so each one is reached through a wrapper that runs the real shim.
const linkModules = (workspace) => {
  const source = join(leadIntake, "node_modules");
  const target = join(workspace, "node_modules");
  mkdirSync(join(target, ".bin"), { recursive: true });
  for (const entry of readdirSync(source)) {
    if (entry !== ".bin") symlinkSync(join(source, entry), join(target, entry));
  }
  for (const bin of readdirSync(join(source, ".bin"))) {
    const wrapper = join(target, ".bin", bin);
    writeFileSync(wrapper, `#!/bin/sh\nexec "${join(source, ".bin", bin)}" "$@"\n`);
    chmodSync(wrapper, 0o755);
  }
};

const nodeBuild = (workspace) => {
  cpSync(join(builtNode, "dist"), join(workspace, "dist"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { start: "node dist/server.js" } }));
  linkModules(workspace);
};

const unix = { skip: process.platform === "win32" && "symlinks and the process group need a POSIX host" };

describe("a build attempt", unix, () => {
  test("is recorded with the parsed numbers, and passes when the contract tests do", async () => {
    const record = await runAttempt(attemptOptions({ task: "build", side: "node" }), { ...real, agent: fakeAgent(nodeBuild) });
    assert.deepEqual(record, {
      commit: "8b808da48",
      teloVersion: "0.112.0",
      model: "claude-opus-5-5",
      task: "build",
      side: "node",
      attempt: 1,
      tokens: { input: 182340, output: 41210, cacheRead: 2410388, cacheWrite: 201544 },
      costUsd: 4.12,
      turns: 38,
      toolCalls: 3,
      wallSeconds: 1460,
      contractTestsPassed: true,
      linesWritten: record.linesWritten,
    });
    assert.ok(record.linesWritten > 0);
  });

  test("passes on the Telo side through telo run", async () => {
    const starter = join(scratch, "telo-starter");
    prepareWorkspace("add-field", "telo", starter);
    const agent = fakeAgent((workspace) => {
      for (const file of ["telo.yaml", "light.yaml", "medium.yaml", "heavy.yaml"]) cpSync(join(starter, file), join(workspace, file));
    });
    const record = await runAttempt(attemptOptions({ task: "build", side: "telo" }), { ...real, agent });
    assert.equal(record.contractTestsPassed, true);
  });
});

// For each change task: the repo's own implementation passes the base cases and fails the added
// ones, and a solution passes both.
describe("a change task", unix, () => {
  for (const task of ["add-field", "add-validation-rule", "add-endpoint"]) {
    test(`${task}: the unmodified implementation fails and a solution passes`, async () => {
      const unmodified = await runAttempt(attemptOptions({ task, side: "node" }), { ...real, agent: fakeAgent(linkModules) });
      assert.equal(unmodified.contractTestsPassed, false);
      const solved = await runAttempt(
        attemptOptions({ task, side: "node", attempt: 2 }),
        {
          ...real,
          agent: fakeAgent((workspace) => {
            cpSync(join(solutions, task, "server.ts"), join(workspace, "src/server.ts"));
            linkModules(workspace);
          }),
        },
      );
      assert.equal(solved.contractTestsPassed, true);
      assert.ok(solved.linesWritten > 0 && solved.linesWritten < 40);
    });
  }
});

describe("the limits", () => {
  test("a timeout is a failed attempt with the tokens seen so far and an unknown cost", async () => {
    const record = await runAttempt(attemptOptions({ task: "add-field", side: "node" }), {
      ...refusing,
      agent: fakeAgent(
        (workspace) => {
          appendFileSync(join(workspace, "src/levels.ts"), "// one\n// two\n");
          writeFileSync(join(workspace, "notes.txt"), "a\nb\n\nc\n");
        },
        { stdout: agentOutput().split("\n").slice(0, 4).join("\n"), timedOut: true, exitCode: 137 },
      ),
    });
    assert.deepEqual(
      { passed: record.contractTestsPassed, tokens: record.tokens, costUsd: record.costUsd, turns: record.turns, toolCalls: record.toolCalls, linesWritten: record.linesWritten },
      { passed: false, tokens: { input: 30, output: 12, cacheRead: 0, cacheWrite: 0 }, costUsd: null, turns: 3, toolCalls: 3, linesWritten: 5 },
    );
  });

  test("a cost over the budget fails the attempt without booting the app", async () => {
    const agent = async () => ({ stdout: agentOutput({ cost: 20.5 }), stderrTail: "", exitCode: 0, timedOut: false, wallSeconds: 60 });
    const record = await runAttempt(attemptOptions({ task: "build", side: "telo" }), { ...refusing, agent });
    assert.equal(record.contractTestsPassed, false);
    assert.equal(record.costUsd, 20.5);
  });

  test("an agent that produced no result and was not timed out is a setup fault, not a failed attempt", async () => {
    const agent = async () => ({ stdout: "", stderrTail: "docker: image not found", exitCode: 125, timedOut: false, wallSeconds: 1 });
    await assert.rejects(runAttempt(attemptOptions({ task: "build", side: "node" }), { ...refusing, agent }), /no result \(exit 125\)[^]*image not found/);
  });
});

describe("the contract tests", () => {
  test("are checked with the CLI under test, and one it cannot read is a setup fault naming its task", () => {
    assert.doesNotThrow(() => assertContractsReadable(["build"]));
    const unreadable = (manifest) => (manifest.includes("add-field") ? { passed: false, output: "MODULE_REQUIRES_NEWER_RUNTIME" } : { passed: true, output: "" });
    assert.throws(() => assertContractsReadable(["build", "add-field"], unreadable), /contract tests of add-field do not check[^]*MODULE_REQUIRES_NEWER_RUNTIME/);
  });
});

describe("the report", () => {
  const record = (task, side, passed, total, wallSeconds, costUsd) => ({
    model: "claude-opus-5-5",
    task,
    side,
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd,
    wallSeconds,
    contractTestsPassed: passed,
  });

  test("takes medians over passing attempts and the success rate over all", () => {
    const { rows } = summarize([
      record("build", "telo", true, 100, 600, 1),
      record("build", "telo", true, 300, 1200, 3),
      record("build", "telo", true, 900, 60, 9),
      record("build", "telo", false, 5, 5, 0.1),
      record("build", "node", false, 5, 5, 0.1),
    ]);
    assert.deepEqual(rows, [
      { task: "build", side: "telo", attempts: 4, passed: 3, successRate: 0.75, medianTokens: 300, medianCostUsd: 3, medianWallSeconds: 600 },
      { task: "build", side: "node", attempts: 1, passed: 0, successRate: 0, medianTokens: null, medianCostUsd: null, medianWallSeconds: null },
    ]);
    assert.match(renderSummary({ model: "claude-opus-5-5", rows }), /\| build \| node \| 0\/1 \| 0% \| - \| - \| - \|/);
  });

  test("refuses records of several models", () => {
    assert.throws(() => summarize([{ ...record("build", "telo", true, 1, 1, 1) }, { ...record("build", "node", true, 1, 1, 1), model: "other" }]), /several models/);
  });
});

describe("the family-1 comparison", () => {
  const generate = (name, startScript) => {
    const directory = join(scratch, name);
    for (const side of ["telo", "node"]) mkdirSync(join(directory, "built", side), { recursive: true });
    writeFileSync(join(directory, "built/node/package.json"), JSON.stringify({ scripts: { start: startScript } }));
    return { manifest: writeComparison({ directory, sides: ["telo", "node"] }) };
  };

  // Spawned as the lead-intake contract is: the bun shim needs a shell on Windows.
  const teloCheck = (manifest) => {
    const [command, ...args] = teloCommand();
    const windows = process.platform === "win32";
    return spawnSync(windows && command.endsWith("bun") ? `${command}.cmd` : command, [...args, "check", manifest], { encoding: "utf8", shell: windows });
  };

  test("over the built apps checks clean, with a cold cache for the Telo subject", () => {
    const { manifest } = generate("comparison", "node --enable-source-maps dist/server.js");
    const check = teloCheck(manifest);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.ok(readFileSync(manifest, "utf8").includes("TELO_CACHE_DIR: .telo"));
  });

  test("runs a plain `node` start script directly, and keeps npm for anything else", () => {
    const direct = readFileSync(generate("comparison-direct", "node --enable-source-maps dist/server.js").manifest, "utf8");
    assert.match(direct, /command: "node"\n\s+args: \["--enable-source-maps","dist\/server.js"\]/);
    const wrapped = readFileSync(generate("comparison-npm", "tsx watch src/server.ts && node x.js").manifest, "utf8");
    assert.match(wrapped, /command: "npm"\n\s+args: \["start","--silent"\]/);
    assert.match(wrapped, /scripts\.start is not a plain `node` command/);
  });
});
