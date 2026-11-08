// The container seam's real implementation: one `docker run` per attempt, holding only the
// attempt's workspace, running Claude Code non-interactively. Nothing here needs a model to be
// reachable until `run` is called.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { here, repoRoot } from "./tasks.mjs";

export const imageName = (prefix, side) => `${prefix}-${side}`;

export function buildImage({ side, prefix, teloVersion, claudeCodeVersion, hubMcpUrl }) {
  const context = mkdtempSync(join(tmpdir(), "authoring-image-"));
  try {
    copyFileSync(join(here, "docker", `${side}.Dockerfile`), join(context, "Dockerfile"));
    const args = ["build", "--tag", imageName(prefix, side)];
    if (claudeCodeVersion) args.push("--build-arg", `CLAUDE_CODE_VERSION=${claudeCodeVersion}`);
    if (side === "telo") {
      if (!teloVersion) throw new Error("the telo image needs --telo-version");
      copyFileSync(join(repoRoot, "apps/authoring-agent/chat/primer.md"), join(context, "primer.md"));
      writeFileSync(join(context, "mcp.json"), `${JSON.stringify({ mcpServers: { telo: { type: "http", url: hubMcpUrl } } }, null, 2)}\n`);
      args.push("--build-arg", `TELO_VERSION=${teloVersion}`);
    }
    const build = spawnSync("docker", [...args, context], { stdio: "inherit" });
    if (build.status !== 0) throw new Error(`docker build of the ${side} image failed (exit ${build.status})`);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

// `forwardEnv` names variables docker copies from this process into the container by name;
// their values are never read here.
export function dockerAgent({ prefix, forwardEnv }) {
  return async function run({ side, workspace, prompt, model, timeoutMs, maxBudgetUsd, outputFile }) {
    const name = `authoring-${process.pid}-${Date.now().toString(36)}`;
    const claude = [
      "claude", "-p", prompt,
      "--model", model,
      "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions",
      "--max-budget-usd", String(maxBudgetUsd),
      "--no-session-persistence",
    ];
    if (side === "telo") claude.push("--mcp-config", "/opt/agent/mcp.json", "--strict-mcp-config");
    const docker = [
      "run", "--rm", "--name", name,
      "--user", `${process.getuid()}:${process.getgid()}`,
      ...forwardEnv.flatMap((variable) => ["--env", variable]),
      "--volume", `${workspace}:/work`,
      imageName(prefix, side),
      ...claude,
    ];
    mkdirSync(join(outputFile, ".."), { recursive: true });
    const out = createWriteStream(outputFile);
    const child = spawn("docker", docker, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      out.write(chunk);
    });
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    let timedOut = false;
    const started = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync("docker", ["kill", name], { stdio: "ignore" });
    }, timeoutMs);
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    clearTimeout(timer);
    out.end();
    return { stdout, stderrTail: stderr, exitCode, timedOut, wallSeconds: Math.round((Date.now() - started) / 1000) };
  };
}
