import type { AnalysisDiagnostic, LoadedGraph, Range } from "@telorun/analyzer";
import { DiagnosticSeverity } from "@telorun/analyzer";
import {
  isCommandNotFound,
  missingToolMessage,
  toolRequirement,
  type ToolRequirement,
} from "@telorun/kernel";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Report, at check time, the external programs this manifest's controllers will
 * need and this machine does not have.
 *
 * **Check may probe; boot may not.** A running app must not spend a process
 * launch discovering what it is about to launch anyway, so the kernel builds
 * its message out of the spawn's own failure. Check has no such constraint, and
 * answering the question here is what turns "the deploy failed" into a line the
 * author reads before deploying. What the two halves share is the rule and the
 * wording — which candidate needs which tool, and what to say — which is the
 * kernel's table; only the probing is here, because the analyzer must stay
 * runnable in a browser and can spawn nothing.
 *
 * **A warning, never an error.** The machine running `telo check` is frequently
 * not the machine that will run the app — a CI container with no package
 * manager is checking a manifest that will run somewhere that has one — so a
 * missing tool here says nothing about whether the manifest is right. For the
 * same reason this belongs nowhere near the check-versus-run agreement suite:
 * the two halves are answering different questions on purpose.
 */

/** The diagnostic code a missing tool reports under. */
export const CONTROLLER_TOOL_MISSING = "CONTROLLER_TOOL_MISSING";

export interface ProbeOptions {
  /** Where `TELO_PKG_MANAGER` is read from, and what the probe spawns with.
   *  Defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether a program is on `PATH`. Injectable because the alternative is a
   *  test that asserts a property of the machine it runs on: "this tool is
   *  absent" is false wherever someone has installed it, and "this tool is
   *  present" is false wherever spawning is denied — and the probe's own rule
   *  is that an unanswerable question reports present, so such a test fails
   *  for the right behaviour. */
  readonly exists?: (tool: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

/** One kind's demand: the tools that could satisfy it, and where it was
 *  declared. A kind is only in trouble when EVERY one of them is missing. */
interface KindDemand {
  readonly module: string;
  /** Canonical source of the module the kind was declared in, for locating the
   *  `imports:` entry that pulled it in. */
  readonly moduleSource: string;
  readonly requirements: ToolRequirement[];
}

/** Where a diagnostic about `moduleSource` should point: the `imports:` entry
 *  that pulled that module in, in the file that wrote it.
 *
 *  The alternative is no range at all, which renders at the entry manifest's
 *  line 1 while the message names a module by URL — so the reader is told a
 *  file and a line that have nothing to do with the thing to change. What they
 *  can act on is the import, and the graph records exactly which one. */
function importSite(
  graph: LoadedGraph,
  moduleSource: string,
): { data: { filePath: string }; range?: Range } | undefined {
  for (const [importingSource, aliases] of graph.importEdges) {
    for (const [alias, edge] of aliases) {
      if (edge.targetSource !== moduleSource) continue;
      const file = graph.modules.get(importingSource)?.owner;
      const range = file?.positions
        .map((position) => position.positionIndex?.get(`@key:imports.${alias}`))
        .find((candidate) => candidate !== undefined);
      return { data: { filePath: importingSource }, ...(range ? { range } : {}) };
    }
  }
  return undefined;
}

/**
 * What each kind in the graph needs beyond the kernel itself.
 *
 * A kind lists `controllers:` as *candidates*, and the kernel takes the first
 * one this host can load — so a kind offering a bundled controller beside a
 * Rust one needs no toolchain at all, and reporting the Rust candidate's cargo
 * would be a warning about a path that will never be taken. `std/console` is
 * exactly that shape. So a kind with any toolless candidate is dropped here,
 * and a kind whose candidates all need tools is reported only if every one of
 * those tools turns out to be absent.
 */
function kindDemands(graph: LoadedGraph, env: NodeJS.ProcessEnv): KindDemand[] {
  const demands: KindDemand[] = [];
  for (const [, module] of graph.modules) {
    for (const file of [module.owner, ...module.partials]) {
      for (const manifest of file.manifests) {
        const kind = (manifest as { kind?: unknown } | null)?.kind;
        if (kind !== "Telo.Definition" && kind !== "Telo.Abstract") continue;
        const candidates = (manifest as { controllers?: unknown }).controllers;
        if (!Array.isArray(candidates)) continue;
        const requirements: ToolRequirement[] = [];
        let toolless = false;
        for (const candidate of candidates) {
          if (typeof candidate !== "string") continue;
          const requirement = toolRequirement(candidate, env);
          if (!requirement) {
            toolless = true;
            break;
          }
          requirements.push(requirement);
        }
        if (toolless || requirements.length === 0) continue;
        // The ref as the author wrote it, falling back to the file it was read
        // from: enough for the reader to recognise which module this is.
        demands.push({
          module: file.requestedUrl || file.source,
          moduleSource: module.owner.source,
          requirements,
        });
      }
    }
  }
  return demands;
}

/**
 * Probe for each required tool once and report the ones that are absent.
 *
 * `--version` is the probe: it is the one argument every one of these programs
 * accepts, it touches nothing, and its exit code is not the question — a
 * program that ran at all is present, so any answer other than "could not be
 * launched" counts as found.
 */
export async function probeControllerTools(
  graph: LoadedGraph,
  options: ProbeOptions = {},
): Promise<AnalysisDiagnostic[]> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? commandExists;
  const demands = kindDemands(graph, env);
  if (demands.length === 0) return [];

  const present = new Map<string, boolean>();
  for (const demand of demands) {
    for (const requirement of demand.requirements) {
      if (present.has(requirement.tool)) continue;
      present.set(requirement.tool, await exists(requirement.tool, env));
    }
  }

  // One diagnostic per (tool, module), not per kind: a module whose twelve
  // kinds all need npm has one thing wrong with it, and twelve identical lines
  // would bury it.
  const reported = new Map<string, KindDemand & { requirement: ToolRequirement }>();
  for (const demand of demands) {
    if (demand.requirements.some((requirement) => present.get(requirement.tool))) continue;
    for (const requirement of demand.requirements) {
      reported.set(`${requirement.tool}\0${demand.module}`, { ...demand, requirement });
    }
  }

  return [...reported.values()].map(({ requirement, module, moduleSource }) => ({
    severity: DiagnosticSeverity.Warning,
    code: CONTROLLER_TOOL_MISSING,
    source: "telo-check",
    message: `${missingToolMessage(
      requirement,
      `A controller of ${module}`,
    )} This machine is not necessarily the one that will run the app, so this is a warning rather than an error.`,
    ...(importSite(graph, moduleSource) ?? {}),
  }));
}

export async function commandExists(tool: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(tool, ["--version"], {
      // Layered over the ambient environment rather than replacing it: `env`
      // is here to say which package manager to look for, and a caller that
      // passes only that would otherwise hand the spawn an environment with no
      // `PATH` — under which every tool on earth is missing.
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    // Absence is decided by the kernel's table, the same one the loader reports
    // with — so the two halves cannot disagree about what "not there" looks
    // like. Reading the exit status directly is what made this useless on
    // Windows: a shell reports a missing command as exit 9009, a number, which
    // a `typeof … === "number"` test reads as "it ran, so it exists".
    //
    // Anything else — a non-zero exit, a timeout, a permission error — counts as
    // present. A tool that answered at all is installed, and a probe that
    // cannot answer must not invent a warning about the author's manifest.
    return !isCommandNotFound(err);
  }
}
