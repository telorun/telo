import type { InvokeContext } from "@telorun/sdk";

/**
 * The transport-neutral `Shell.Host` contract — the module's central seam.
 * Every driver (the bundled local host, and future `shell-ssh` / Docker / k8s
 * modules) implements `ShellHost`; the generic operations (`Shell.Command`,
 * `Shell.CommandStream`) and the ref resolver depend only on this file, never
 * on a concrete driver. Mirrors `sql`'s `sqlite-driver-interface.ts` split.
 */

/** One record in a `Shell.CommandStream` output stream. */
export type StreamPart =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; exitCode: number; signal: string | null }
  | { type: "error"; error: { message: string; code?: string } };

export interface BufferedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * What to run. `command` runs through the host's shell (`<shell> -c <command>`);
 * `args` execs the program `args[0]` with `args.slice(1)` **directly, without a
 * shell**, so an argument can never be reinterpreted as shell syntax (no
 * injection). Exactly one form per call.
 */
export type CommandSpec = { command: string } | { args: string[] };

export interface RunOptions {
  /**
   * Per-call environment overlay, merged over the host's base env. A `null`
   * value **unsets** an inherited variable (so a secret in the host env can be
   * kept out of the child), which a plain override could not do.
   */
  env?: Record<string, string | null>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Kill the child and fail after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * The execution primitive every driver implements. `exec` composes the command
 * for its target and returns a lazy handle the operations consume either
 * buffered (`Shell.Command`) or streamed (`Shell.CommandStream`) — exactly one
 * per call. The host owns all composition (shell/argv resolution, env merge,
 * cwd) so the operations stay backend-agnostic. (Named `exec`, not `run`, to
 * avoid the Runnable capability's reserved `run()`.)
 */
export interface ShellHost {
  exec(spec: CommandSpec, options: RunOptions, ctx?: InvokeContext): ExecutionHandle;
}

interface CommandInputShape {
  command?: unknown;
  args?: unknown;
}

/**
 * Resolve a `Shell.Command` / `Shell.CommandStream` input into a `CommandSpec`,
 * enforcing exactly-one-of `command` / `args`. Shared by both operation
 * controllers so the shell-vs-argv contract stays in one place.
 */
export function toCommandSpec(input: CommandInputShape, kind: string): CommandSpec {
  const hasCommand = typeof input?.command === "string" && input.command.length > 0;
  const hasArgs = Array.isArray(input?.args) && input.args.length > 0;
  if (hasCommand && hasArgs) {
    throw new Error(`${kind}: provide either 'command' or 'args', not both`);
  }
  if (hasCommand) return { command: input.command as string };
  if (hasArgs) {
    const args = input.args as unknown[];
    if (!args.every((a) => typeof a === "string")) {
      throw new Error(`${kind}: 'args' must be an array of strings`);
    }
    // args[0] is the program to exec; an empty one spawns to an opaque ENOENT.
    // Later args may legitimately be empty strings, so only guard the program.
    if ((args[0] as string).length === 0) {
      throw new Error(`${kind}: 'args[0]' (the program to run) must be a non-empty string`);
    }
    return { args: args as string[] };
  }
  throw new Error(`${kind}: one of 'command' (a non-empty string) or 'args' (a non-empty string array) is required`);
}

export interface ExecutionHandle {
  /** Spawn, collect all output, and resolve once the process exits. */
  buffered(): Promise<BufferedResult>;
  /** Spawn on iteration; yield stdout/stderr records then a terminal exit/error. */
  stream(): AsyncIterable<StreamPart>;
}
