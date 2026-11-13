/**
 * What a program hosting the release commands supplies: its adapters (both
 * halves), where it writes, and the extra work its ecosystems need around the
 * generic commands. `telo-release` registers the shipped ecosystems; `telo
 * release` adds `telo` and its own subcommands.
 */

import type { Argv } from "yargs";
import type { EcosystemAdapter } from "../adapter.js";
import type { ParseLedgerOptions } from "../ledger.js";
import type { ReleasePlan } from "../release-plan.js";
import type { EvidenceAdapter } from "./evidence.js";
import type { MarkerRead, ReleaseWorkspace } from "./workspace.js";

export interface Style {
  ok(text: string): string;
  dim(text: string): string;
  error(text: string): string;
  warn(text: string): string;
}

/**
 * Stdout is the machine surface: under `-o json` it carries the `emit` envelope
 * and nothing else, so `line` goes silent there. Stderr is the human surface in
 * both formats.
 */
export interface ReleaseOutput {
  line(text: string): void;
  errLine(text: string): void;
  emit(payload: Record<string, unknown>): void;
  progress(text: string): void;
  readonly style: Style;
  readonly errStyle: Style;
}

export interface ReleaseHost {
  /** How the commands are invoked, for messages (`telo release`). */
  readonly command: string;
  readonly adapters: readonly EcosystemAdapter[];
  readonly evidence: readonly EvidenceAdapter[];
  /** Per ecosystem this host does not serve, the host that does. */
  readonly ecosystemHosts?: Readonly<Record<string, string>>;
  readonly ledger?: ParseLedgerOptions;
  readonly readMarker?: MarkerRead;
  readonly output: () => ReleaseOutput;
  /** Options every subcommand takes beside the generic ones. */
  readonly globalOptions?: (yargs: Argv) => Argv;
  /** Subcommands of this host's own. */
  readonly subcommands?: (yargs: Argv, guarded: Guard) => Argv;
  /** More of `check`'s gate, judged with the plan the gate formed: what it
   *  found, and whether it holds. */
  readonly check?: (
    workspace: ReleaseWorkspace,
    plan: ReleasePlan,
    argv: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly ok: boolean; readonly payload: Record<string, unknown> }>;
  /** Writes `apply` makes once every planned unit carries its version, before
   *  the ledger is recorded; workspace-relative. */
  readonly afterApply?: (
    workspace: ReleaseWorkspace,
    plan: ReleasePlan,
    argv: Readonly<Record<string, unknown>>,
  ) => Promise<readonly string[]>;
}

/** Wraps a handler so a failure is one line and exit status 1. */
export type Guard = <T>(handler: (argv: T) => Promise<void>) => (argv: T) => Promise<void>;
