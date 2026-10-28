import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { inheritedEnvironment, spawned } from "./app-process.js";
import type { SelfInvocation } from "./self-invocation.js";

/**
 * A session's co-resident agent: `telo run --no-input <ref>` of the running
 * telo, as its own process group (stopped like a run, `stopAppProcess`), in the
 * session's `agent/` directory.
 *
 * Its output is not the CLI's and no client reads it, so it is appended to
 * `agent/agent.log` rather than written to the runner's streams.
 */
export interface AgentProcessArgs {
  telo: SelfInvocation;
  /** `AGENT_MODULE_REF`: an `oci://` reference or an absolute host path. */
  ref: string;
  /** The operator's agent env, the minted token included. */
  env: Record<string, string>;
  /** The session's `agent/` directory. */
  directory: string;
  /** The session's `workspace/` directory. */
  workspace: string;
}

export const AGENT_LOG_FILENAME = "agent.log";

export interface AgentProcess {
  child: ChildProcess;
  /** Settles once the spawn did or did not happen. */
  started: Promise<void>;
  log: string;
}

export async function spawnAgentProcess(args: AgentProcessArgs): Promise<AgentProcess> {
  const cache = path.join(args.directory, "telo-cache");
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const log = path.join(args.directory, AGENT_LOG_FILENAME);
  const output = await fs.open(log, "a", 0o600);
  try {
    const child = spawn(args.telo.command, [...args.telo.prefix, "run", "--no-input", args.ref], {
      cwd: args.directory,
      // What the runner supplies wins over the operator's env, as on the
      // container runners; the telo's own wins over everything.
      env: {
        ...inheritedEnvironment(process.env),
        ...args.env,
        WORKSPACE_DIR: args.workspace,
        TELO_HOST_STATE_DIR: args.directory,
        TELO_CACHE_DIR: cache,
        ...args.telo.env,
      },
      stdio: ["ignore", output.fd, output.fd],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    return { child, started: spawned(child), log };
  } finally {
    // The child holds its own copy of the descriptor once spawned.
    await output.close();
  }
}
