/**
 * `telo release` as a host of the release command tree: the shipped ecosystems
 * plus `telo` (its pure half in the analyzer, its evidence half here), the Telo
 * ledger shape, the marker read the editor also runs, and Telo's own additions —
 * `--registry`, the `floor`, `stage` and `imports` subcommands, the `requires:`
 * and crate-input checks in `check`, and the `>=unreleased` rewrite in `apply`.
 */

import { TELO_RELEASE_ADAPTERS, TELO_SURFACE_VERSION } from "@telorun/analyzer";
import { SHIPPED_EVIDENCE, type EvidenceAdapter, type ReleaseHost, type ReleaseOutput } from "@telorun/release/node";
import type { Argv } from "yargs";
import { output } from "../output.js";
import { checkWorkspaceRequires } from "./check-requires.js";
import { checkCrateInputs } from "./crate-inputs.js";
import { teloEvidence } from "./evidence.js";
import { TELO_LEDGER_OPTIONS } from "./ledger-store.js";
import type { RegistryRungs } from "./targets.js";
import { strandedUnreleasedFloors, writeUnreleasedFloors } from "./unreleased-floors.js";
import { discoverModules, teloMarkerRead } from "./workspace.js";

/** `--registry`, then `TELO_OCI_REGISTRY` — the rungs below the marker. */
export function registryRungs(argv: Readonly<Record<string, unknown>>): RegistryRungs {
  return {
    ...(typeof argv.registry === "string" && argv.registry ? { flag: argv.registry } : {}),
    ...(process.env.TELO_OCI_REGISTRY ? { env: process.env.TELO_OCI_REGISTRY } : {}),
  };
}

/** The release tree's writes, through the CLI's `Output` seam. */
function cliOutput(): ReleaseOutput {
  const out = output();
  return {
    line: (text) => out.line(text),
    errLine: (text) => out.errLine(text),
    emit: (payload) => out.emit(payload),
    progress: (text) => out.progress(text),
    style: out.stdout,
    errStyle: out.stderr,
  };
}

export interface TeloHostOptions {
  readonly rungs?: (argv: Readonly<Record<string, unknown>>) => RegistryRungs;
  readonly subcommands?: ReleaseHost["subcommands"];
}

export function teloReleaseHost(options: TeloHostOptions = {}): ReleaseHost {
  const evidence: EvidenceAdapter[] = [...SHIPPED_EVIDENCE, teloEvidence(options.rungs ?? registryRungs)];
  return {
    command: "telo release",
    adapters: TELO_RELEASE_ADAPTERS,
    evidence,
    ledger: TELO_LEDGER_OPTIONS,
    readMarker: teloMarkerRead,
    output: cliOutput,
    globalOptions: (y: Argv) =>
      y.option("registry", {
        type: "string",
        describe:
          "Publish destination base (oci://host/org) for modules whose anchor and release.ecosystems.telo name none. Falls back to TELO_OCI_REGISTRY, then to each module's own recorded base.",
      }),
    ...(options.subcommands ? { subcommands: options.subcommands } : {}),
    async check(released, plan) {
      const out = cliOutput();
      const workspace = { ...released, modules: discoverModules(released.root, released.units) };
      // Declared telo floors, each proven equal to the measured one by RUNNING
      // the published CLI: the CLI at the floor accepts, the release below rejects.
      const requires = await checkWorkspaceRequires(workspace, { currentVersion: TELO_SURFACE_VERSION });
      for (const c of requires.checks) {
        const count = `${c.modules.length} module${c.modules.length === 1 ? "" : "s"}`;
        if (c.status === "passed") out.line(`${out.style.ok("✓")}  telo ${c.floor}  ${out.style.dim(`${count} verified`)}`);
        else out.errLine(`${out.errStyle.error("✗")}  telo ${c.floor}  ${count} not verified (${c.detail ?? "unknown"})`);
      }
      const stranded = strandedUnreleasedFloors(released, plan);
      const failures = [...requires.failures, ...stranded];
      for (const failure of failures) out.errLine(`${failure.module}: ${out.errStyle.error(failure.code)} ${failure.message}`);
      // Prebuilt files of a crate in this repository must not be older than it.
      const crateInputs = await checkCrateInputs(workspace.modules);
      for (const failure of crateInputs) {
        out.errLine(
          `${out.errStyle.error("✗")}  ${failure.module}${failure.source ? `  source '${failure.source}'` : ""}  ${failure.message}`,
        );
      }
      return {
        ok: !requires.refuted && stranded.length === 0 && requires.errors.length === 0 && crateInputs.length === 0,
        payload: { requires: { checks: requires.checks, failures, errors: requires.errors }, crateInputs },
      };
    },
    async afterApply(workspace, plan) {
      return writeUnreleasedFloors(workspace, plan);
    },
  };
}
