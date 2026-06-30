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

export interface RunOptions {
  /** Per-call environment overlay, merged over the host's base env. */
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Kill the child and fail after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * The execution primitive every driver implements. `exec` composes the command
 * for its target and returns a lazy handle the operations consume either
 * buffered (`Shell.Command`) or streamed (`Shell.CommandStream`) — exactly one
 * per call. The host owns all composition (`<shell> -c <command>`, env merge,
 * cwd) so the operations stay backend-agnostic. (Named `exec`, not `run`, to
 * avoid the Runnable capability's reserved `run()`.)
 */
export interface ShellHost {
  exec(command: string, options: RunOptions, ctx?: InvokeContext): ExecutionHandle;
}

export interface ExecutionHandle {
  /** Spawn, collect all output, and resolve once the process exits. */
  buffered(): Promise<BufferedResult>;
  /** Spawn on iteration; yield stdout/stderr records then a terminal exit/error. */
  stream(): AsyncIterable<StreamPart>;
}
