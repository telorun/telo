import { PackageURL } from "packageurl-js";

/**
 * Which external program a controller candidate needs, and what to say when it
 * is not there.
 *
 * Two halves read this. The **loader** reads it to phrase a failure: a
 * `pkg:npm` controller is installed by a package manager and a `pkg:cargo` one
 * is compiled by cargo, so when the spawn fails with "not found" the message
 * names the program and how to get it instead of surfacing a bare `ENOENT`.
 * **`telo check`** reads it to answer the same question ahead of time, by
 * probing for the programs a manifest's own closure actually calls for.
 *
 * The rule and the wording live here — in the kernel — because those are the
 * two halves' only shared ground: the analyzer must stay runnable in a browser,
 * so it can spawn nothing and knows nothing about processes, and the kernel
 * cannot import the CLI.
 *
 * **The loader never probes.** A pre-flight check spends a process launch on
 * every boot to answer a question that only matters on the path that is about
 * to ask it anyway, and a boot needing no such controller must launch nothing.
 * Recognising the spawn's own failure costs nothing when the program is there.
 */

export interface ToolRequirement {
  /** The program as it is looked up on `PATH`. */
  readonly tool: string;
  /** Why this controller needs it, as a clause: "… is delivered from npm". */
  readonly why: string;
  /** What the reader should do about it. */
  readonly install: string;
}

/** The package manager the kernel installs npm-delivered controllers with.
 *  `TELO_PKG_MANAGER` overrides it, so the message names what was actually
 *  looked for rather than always saying `npm`. */
export function packageManagerName(env: NodeJS.ProcessEnv): string {
  return env.TELO_PKG_MANAGER?.trim() || "npm";
}

/**
 * What a candidate needs beyond the kernel itself, or `undefined` when it needs
 * nothing — the bundled case, which is how the standard library delivers and
 * the only kind a standalone binary can load.
 */
export function toolRequirement(
  purl: string,
  env: NodeJS.ProcessEnv,
): ToolRequirement | undefined {
  let parsed: PackageURL;
  try {
    parsed = PackageURL.fromString(purl);
  } catch {
    return undefined;
  }
  if (parsed.type === "npm") return packageManagerRequirement(env);
  if (parsed.type === "cargo") return CARGO_REQUIREMENT;
  return undefined;
}

/** The package manager an npm-delivered controller is installed with. */
export function packageManagerRequirement(env: NodeJS.ProcessEnv): ToolRequirement {
  const tool = packageManagerName(env);
  return {
    tool,
    why: "this controller is delivered as an npm package, which has to be installed before it can be loaded",
    install:
      tool === "npm"
        ? "Install Node.js, which carries npm, or set TELO_PKG_MANAGER to a package manager that is on PATH."
        : `Install ${tool}, or set TELO_PKG_MANAGER to a package manager that is on PATH.`,
  };
}

/** The toolchain a `pkg:cargo` controller is compiled by. */
export const CARGO_REQUIREMENT: ToolRequirement = {
  tool: "cargo",
  why: "this controller is a Rust crate, which has to be compiled before it can be loaded",
  install: "Install a Rust toolchain (https://rustup.rs), which carries cargo and rustc.",
};

/**
 * Whether a spawn failed because the program is not there.
 *
 * **Spawn-level signals only.** A direct spawn reports `ENOENT`. Through a
 * shell the binary always resolves — `cmd.exe` and `sh` do exist — so the miss
 * arrives as the shell's own exit code instead: 9009 on Windows, 127 on POSIX.
 *
 * Matching the failure's TEXT as well is what this deliberately does not do,
 * and the reason is that the text belongs to the tool, not to the spawn: npm
 * says `404 Not Found` about a package that does not exist, and a cargo build
 * says ``linker `cc` not found`` about a broken toolchain. Both contain "not
 * found", and both would be reclassified — the npm one into "install Node.js"
 * for an author whose dependency is simply misspelled, and the cargo one into
 * an env-missing fallthrough that DISCARDS the compiler's diagnosis and ends
 * the run with a generic "no controller found". That is error swallowing; a
 * wrong exit code is not worth it.
 */
export function isCommandNotFound(err: unknown): boolean {
  // `code` is the errno for a failed spawn and the exit status for a command
  // that ran, so a shell's "not recognized" code arrives through it too.
  const code: unknown = (err as { code?: unknown } | undefined)?.code;
  const status: unknown = (err as { status?: unknown } | undefined)?.status;
  if (code === "ENOENT") return true;
  return code === 9009 || code === 127 || status === 9009 || status === 127;
}

/** The sentence a missing tool gets, wherever it is discovered. `subject` names
 *  what wanted it — a kind at runtime, a module at check time — so the reader
 *  knows which part of the manifest to look at. */
export function missingToolMessage(requirement: ToolRequirement, subject: string): string {
  return `${subject} needs "${requirement.tool}", which is not on PATH: ${requirement.why}. ${requirement.install}`;
}
