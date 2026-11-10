/**
 * `telo release` — one release system over the modules of a declared workspace.
 *
 * `add` writes a fragment; `status` explains what would bump and why; `check` is
 * the CI gate; `floor` writes each module's measured `requires.telo`; `apply` produces the Version PR; `verify` reconciles the ledger
 * against the registry; `stage` fetches the files `sources:` declares; `imports`
 * writes a consumer's imports of workspace modules in their published or their
 * relative form. `telo publish` still keys off version movement.
 *
 * It is the only reader of the marker's `release:` block. `telo run` reads its
 * `env:` block and the editor reads the whole file, but `check`, `publish`,
 * `install`, `upgrade`, `migrate`, `module` and the kernel behave identically
 * with or without one — and every block is optional — which is what keeps a
 * single-manifest repo, a bare `examples/` directory and a third-party module
 * checkout working with nothing added.
 */

import {
  LEDGER_PATH,
  LOCALLY_DERIVED_LAYERS,
  TELO_SURFACE_VERSION,
  diffLayerDigests,
  isFragmentKind,
  orderByImports,
  serializeFragment,
  type FragmentKind,
  type LayerDigests,
  type Ledger,
  type LedgerEntry,
  type ModuleKey,
  type ReleaseDiagnostic,
  type ReleasePlan,
} from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Argv } from "yargs";
import { readPublishedDigests } from "../bundle/payload-drift.js";
import { ModulePayloadBuilder } from "../bundle/module-payload.js";
import { createLogger, type Logger } from "../logger.js";
import { outEmit, outErrLine, outLine, outProgress } from "../output.js";
import { recordLedger, writePlannedVersions } from "../release/apply-plan.js";
import { checkWorkspaceRequires } from "../release/check-requires.js";
import {
  RegistryUnreachableError,
  floorText,
  sameFloor,
} from "../release/floor-measurement.js";
import { floorLine, measureAndWriteFloors } from "../release/floor-workspace.js";
import { checkCrateInputs } from "../release/crate-inputs.js";
import { digestPayload, type ModuleTarget } from "../release/evidence.js";
import { readImportGraph, resolveTargets } from "../release/targets.js";
import {
  deleteFragment,
  readLedger,
  writeFragment,
  writeLedger,
} from "../release/ledger-store.js";
import { planPayload, renderDiagnostics, renderPlan } from "../release/render.js";
import { createArchiveReader } from "@telorun/kernel";
import { stageModule, stageTargetsOf, type StageFailure, type StageOutcome } from "../release/stage.js";
import { loadWorkspace, requireModule, type Workspace } from "../release/workspace.js";
import { planWorkspace } from "../release/workspace-plan.js";
import { IMPORT_FORMS, releaseImportsCommand } from "./release-imports.js";

interface CommonArgv {
  registry?: string;
  base: string;
  carriedBy?: string;
}

function registryRungs(argv: CommonArgv): { flag?: string; env?: string } {
  return {
    ...(argv.registry ? { flag: argv.registry } : {}),
    ...(process.env.TELO_OCI_REGISTRY ? { env: process.env.TELO_OCI_REGISTRY } : {}),
  };
}

async function buildPlan(argv: CommonArgv, log: Logger): Promise<{
  workspace: Workspace;
  targets: ReadonlyMap<ModuleKey, ModuleTarget>;
  plan: ReleasePlan;
}> {
  const workspace = loadWorkspace();
  const { targets, plan } = await planWorkspace(workspace, {
    rungs: registryRungs(argv),
    baseRef: argv.base,
    ...(argv.carriedBy ? { carriedBy: argv.carriedBy } : {}),
    // A ticker, not a diagnostic: sixty-one of these are what a human watching a
    // two-minute build wants and what a CI log or a `-o json` consumer does not.
    onModule: (module, index, total) =>
      outProgress(log.err.dim(`  [${index + 1}/${total}] ${module.key}`)),
  });
  return { workspace, targets, plan };
}

/** The registry-verifiable half of a digest map. */
function withoutLocallyDerived(layers: LayerDigests): LayerDigests {
  return Object.fromEntries(
    Object.entries(layers).filter(([layer]) => !LOCALLY_DERIVED_LAYERS.has(layer)),
  );
}

/** The half the registry cannot answer for, kept across a reconciliation. */
function localOnly(layers: LayerDigests): LayerDigests {
  return Object.fromEntries(
    Object.entries(layers).filter(([layer]) => LOCALLY_DERIVED_LAYERS.has(layer)),
  );
}

function reportDiagnostics(plan: ReleasePlan, log: Logger): number {
  for (const line of renderDiagnostics(plan, log)) outErrLine(line);
  return plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
}

/**
 * Print, and stop the command where anything is an error.
 *
 * Shared because a command that reports a problem and then answers `ok: true` is
 * error swallowing at the one boundary where a MACHINE reads the answer: the
 * module publisher consumes `order`'s payload, so an order printed beside a
 * destination collision would be an order it knows is unpublishable, and both
 * modules would be pushed to the ref they share.
 */
function refuseOnErrors(diagnostics: readonly ReleaseDiagnostic[], log: Logger): boolean {
  for (const diagnostic of diagnostics) {
    const label =
      diagnostic.severity === "error" ? log.err.error(diagnostic.code) : log.err.warn(diagnostic.code);
    outErrLine(`${label}  ${diagnostic.message}`);
  }
  if (!diagnostics.some((diagnostic) => diagnostic.severity === "error")) return false;
  outEmit({ ok: false, diagnostics: [...diagnostics] });
  process.exitCode = 1;
  return true;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

/** `<kind>-<slug>.yaml`, so the pending directory sorts by kind and a second
 *  fragment for the same change is a visible duplicate rather than an
 *  overwrite. Deliberately not timestamped: a timestamp made every changie
 *  filename unique and therefore meaningless to read. */
function fragmentFilename(kinds: Iterable<FragmentKind>, body: string): string {
  const kind = [...kinds][0] ?? "Fixed";
  const slug =
    body
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "change";
  return `${kind.toLowerCase()}-${slug}.yaml`;
}

async function add(argv: CommonArgv & { module: string[]; kind: string; body: string }): Promise<void> {
  const log = createLogger(false);
  const workspace = loadWorkspace();

  if (!isFragmentKind(argv.kind)) {
    outErrLine(
      log.err.error("error") +
        `  '${argv.kind}' is not a release kind. Use Added, Changed, Deprecated, Removed, ` +
        `Fixed or Security.`,
    );
    process.exitCode = 1;
    return;
  }

  const modules = new Map<ModuleKey, FragmentKind>();
  for (const key of argv.module) {
    modules.set(requireModule(workspace, key).key, argv.kind);
  }

  const source = writeFragment(
    workspace.root,
    fragmentFilename(modules.values(), argv.body),
    serializeFragment(modules, argv.body),
  );
  outLine(`${log.ok("✓")}  ${source}`);
  outEmit({ ok: true, fragment: source, modules: [...modules.keys()] });
}

// ---------------------------------------------------------------------------
// status / check
// ---------------------------------------------------------------------------

async function status(argv: CommonArgv): Promise<void> {
  const log = createLogger(false);
  const { plan } = await buildPlan(argv, log);
  for (const line of renderPlan(plan, log)) outLine(line);
  reportDiagnostics(plan, log);
  outEmit({ ok: true, ...(planPayload(plan) as object) });
}

/**
 * The CI gate.
 *
 * It does **not** fail because a payload moved. Under a toolchain bump every
 * module's digest moves, and demanding sixty hand-written fragments for that
 * would be a tax on nobody's behalf — those land in the unattributed case, take
 * a patch, and ship. What it fails on is a plan that cannot be formed: a
 * fragment naming an unknown module, a major-inducing kind, a manifest version
 * that disagrees with its ledger entry, or digests taken against another
 * registry base.
 */
async function check(argv: CommonArgv): Promise<void> {
  const log = createLogger(false);
  const { workspace, plan } = await buildPlan(argv, log);
  for (const line of renderPlan(plan, log)) outLine(line);
  const errors = reportDiagnostics(plan, log);

  // Declared telo floors, each proven equal to the measured one by RUNNING the
  // published CLI (`release/check-requires.ts`): the CLI at the floor accepts the
  // module and the release just below it rejects it.
  const requires = await checkWorkspaceRequires(workspace, { currentVersion: TELO_SURFACE_VERSION });
  for (const c of requires.checks) {
    const label = `telo ${c.floor}`;
    const count = `${c.modules.length} module${c.modules.length === 1 ? "" : "s"}`;
    if (c.status === "passed") {
      outLine(`${log.ok("✓")}  ${label}  ${log.dim(`${count} verified`)}`);
    } else {
      // Unproven is a failure: a gate that cannot run must not pass.
      outErrLine(`${log.err.error("✗")}  ${label}  ${count} not verified (${c.detail ?? "unknown"})`);
    }
  }
  for (const failure of requires.failures) {
    outErrLine(`${failure.module}: ${log.err.error(failure.code)} ${failure.message}`);
  }
  if (requires.failures.length > 0) {
    outErrLine(
      `${requires.failures.length} module${requires.failures.length === 1 ? "" : "s"} failed.`,
    );
  }

  // Prebuilt files of a crate in this repository must not be older than the
  // crate: recomputed from the manifests, with no cargo run.
  const crateInputs = await checkCrateInputs(workspace.modules);
  for (const failure of crateInputs) {
    outErrLine(
      `${log.err.error("✗")}  ${failure.module}${failure.source ? `  source '${failure.source}'` : ""}  ${failure.message}`,
    );
  }

  const ok =
    errors === 0 && !requires.refuted && requires.errors.length === 0 && crateInputs.length === 0;
  outEmit({ ok, ...(planPayload(plan) as object), requires: { checks: requires.checks, failures: requires.failures, errors: requires.errors }, crateInputs });
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// floor
// ---------------------------------------------------------------------------

/**
 * Write the measured `requires.telo` of each workspace module, up or down.
 *
 * Measurement is the published CLI's verdict over the module (`release/
 * floor-measurement.ts`), so nobody writes a floor by hand: a registry that
 * cannot be reached, or a run that says nothing about its manifest, fails the
 * command with every file restored.
 */
async function floor(argv: CommonArgv & { module?: string[] }): Promise<void> {
  const log = createLogger(false);
  const workspace = loadWorkspace();
  const selected =
    argv.module && argv.module.length > 0
      ? argv.module.map((key) => requireModule(workspace, key))
      : workspace.modules.filter((module) => module.artifactKind === "registry");
  let results;
  try {
    results = await measureAndWriteFloors(workspace, selected);
  } catch (err) {
    if (err instanceof RegistryUnreachableError) {
      outErrLine(`${log.err.error("error")}: ${err.message}; nothing was written.`);
      outEmit({ ok: false });
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  for (const result of results) outLine(floorLine(result));
  outEmit({
    ok: true,
    floors: results.map((r) => ({
      module: r.module.key,
      from: floorText(r.from),
      to: floorText(r.to),
      changed: !sameFloor(r.from, r.to),
    })),
  });
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Write the plan: every manifest a module owns, its changelog, the ledger, and
 * the fragments consumed.
 *
 * The writes live in `release/apply-plan.ts`; this is the wiring — resolve, plan,
 * report, hand over.
 */
async function apply(argv: CommonArgv & { date?: string }): Promise<void> {
  const log = createLogger(false);
  const { workspace, targets, plan } = await buildPlan(argv, log);
  const errors = reportDiagnostics(plan, log);
  if (errors > 0) {
    outEmit({ ok: false, ...(planPayload(plan) as object) });
    process.exitCode = 1;
    return;
  }
  if (plan.modules.length === 0) {
    outLine("Nothing to release — every module matches the ledger.");
    outEmit({ ok: true, modules: [] });
    return;
  }

  const applied = writePlannedVersions(
    workspace,
    plan,
    argv.date ?? new Date().toISOString().slice(0, 10),
  );
  for (const module of applied) {
    outLine(`${log.ok("✓")}  ${module.key}  ${module.from} → ${module.to}`);
  }

  writeLedger(workspace.root, await recordLedger(workspace.root, targets, plan));
  for (const fragment of plan.fragments) deleteFragment(workspace.root, fragment);

  outLine(`${log.ok("✓")}  ${LEDGER_PATH}, ${plan.fragments.length} fragment(s) consumed`);
  outEmit({
    ok: true,
    ...(planPayload(plan) as object),
    written: [...applied.flatMap((module) => module.files), LEDGER_PATH],
  });
}

// ---------------------------------------------------------------------------
// order
// ---------------------------------------------------------------------------

/**
 * The workspace's modules in publish order — a dependency before its dependents.
 *
 * Not optional at publish time: canonicalization rewrites a relative import to
 * the sibling's assigned `<destination>@<version>` and publish then hard-fails
 * when that ref does not already resolve, so a sibling has to be pushed first. This replaced a regex
 * that read `imports:` out of the first YAML document by line shape.
 *
 * Reads the import graph only — no payloads are built, so it is cheap enough to
 * call from a release script.
 */
async function order(argv: CommonArgv): Promise<void> {
  const log = createLogger(false);
  const workspace = loadWorkspace();
  const ledger = readLedger(workspace.root);
  const { targets, assigned, diagnostics } = resolveTargets(workspace, ledger, registryRungs(argv));
  const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workspace.root, ".telo"), assigned });
  const graph = await readImportGraph(workspace, targets, builder);
  if (refuseOnErrors([...workspace.diagnostics, ...diagnostics, ...graph.diagnostics], log)) return;

  const evidence = workspace.modules.map((module) => ({
    key: module.key,
    name: module.name,
    version: module.version,
    artifactKind: module.artifactKind,
    registry: targets.get(module.key)?.registry ?? "",
    layers: {},
    inlines: new Map<ModuleKey, string[]>(),
    imports: graph.imports.get(module.key) ?? [],
    ownFilesChanged: false,
  }));

  // The destination travels WITH the order, because the publisher needs both and
  // deriving one of them for itself is how a multi-destination workspace plans
  // several bases and pushes them all to one. So do the in-repo imports: a
  // publish reads its siblings' published bytes, so the publisher stages exactly
  // the modules it pushes and what they import.
  const ordered = orderByImports(evidence).map((module) => ({
    key: module.key,
    destination: targets.get(module.key)?.destination,
    imports: module.imports,
  }));
  for (const entry of ordered) outLine(`${entry.key}\t${entry.destination ?? ""}`);
  outEmit({ ok: true, order: ordered });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Reconcile the ledger against the registry.
 *
 * **Ledger versus registry, not working copy versus registry.** The ledger is a
 * cache of the registry's answer, so the only question here is whether the cache
 * is stale — a hand edit, an `apply` whose publish then failed, a push made
 * outside the pipeline. It builds nothing and reads no local bytes.
 *
 * Comparing the local build instead would answer the PUBLISH gate's question
 * ("am I about to ship changed bytes at an unchanged version?"), which is
 * `payload-drift.ts`'s job and fires for every module on any commit after a
 * release — a shared-library edit, a lockfile bump, any source change at all
 * makes the working copy differ from what is published at the current version.
 * That is normal and is what `check` plans a bump for; reporting it here made
 * `verify` shout about all 59 modules and, worse, made `--write` fail to settle
 * anything, because re-recording the ledger cannot change what the working copy
 * builds.
 */
async function verify(argv: CommonArgv & { write: boolean }): Promise<void> {
  const log = createLogger(false);
  const workspace = loadWorkspace();
  const ledger = readLedger(workspace.root);
  const { targets, diagnostics } = resolveTargets(workspace, ledger, registryRungs(argv));
  // Before any reconciliation, and before `--write`: re-recording a ledger from
  // destinations that cannot all be right is how a wrong base gets cached as the
  // authoritative one.
  if (refuseOnErrors([...workspace.diagnostics, ...diagnostics], log)) return;

  const drifted: Array<{ key: ModuleKey; detail: string }> = [];
  const repaired = new Map<ModuleKey, LedgerEntry>(ledger.modules);

  const reportDrift = (key: ModuleKey, detail: string): void => {
    drifted.push({ key, detail });
    outErrLine(`${log.err.warn("drift")}  ${key}: ${detail}`);
  };

  // Only the registry-artifact modules are reconciled — an image module has no
  // published artifact to read a layer index from — so the count is theirs, not
  // the workspace's, or the ticker would stall at a number it never reaches.
  const reconciled = workspace.modules.filter(
    (module) => module.artifactKind !== "image" && targets.has(module.key),
  );
  for (const [index, module] of reconciled.entries()) {
    outProgress(log.err.dim(`  [${index + 1}/${reconciled.length}] ${module.key}`));
    const target = targets.get(module.key)!;
    const recorded = ledger.modules.get(module.key);
    const published = await readPublishedDigests(target.destination, module.version);

    if (published === null) {
      // Nothing published at this version. Not drift on its own — a module that
      // has never shipped has nothing to disagree with — but a ledger entry for
      // it is a claim about a version the registry does not have.
      if (recorded) {
        reportDrift(module.key, `the ledger records ${module.version}, which is not published`);
        if (argv.write) repaired.delete(module.key);
      }
      continue;
    }

    if (!recorded) {
      reportDrift(module.key, `published at ${module.version}, but the ledger has no entry`);
      // Recorded without a `manifest` digest, which nothing here can supply.
      // `check` then reads that as drift and plans a patch — the safe direction
      // (bump rather than miss), and the next `apply` fills it in.
      if (argv.write) {
        repaired.set(module.key, {
          version: module.version,
          registry: target.registry,
          layers: published,
        });
      }
      continue;
    }

    // Compare only what the registry can answer for. The `manifest` digest is
    // locally derived and unverifiable by construction (see
    // LOCALLY_DERIVED_LAYERS), so diffing the whole map would report it as
    // removed for every module, every run — a permanent false finding.
    const changes = diffLayerDigests(
      withoutLocallyDerived(recorded.layers),
      withoutLocallyDerived(published),
    );
    if (changes.length > 0) {
      reportDrift(
        module.key,
        `${changes.map((change) => change.layer).join(", ")} — the ledger disagrees with what ` +
          `is published at ${module.version}`,
      );
    }
    // Merge rather than replace, so reconciling the verifiable half does not
    // discard the half that has no other source.
    if (argv.write) {
      repaired.set(module.key, {
        version: module.version,
        registry: target.registry,
        layers: { ...localOnly(recorded.layers), ...published },
      });
    }
  }

  if (argv.write) {
    writeLedger(workspace.root, { modules: repaired });
    outLine(`${log.ok("✓")}  ${LEDGER_PATH} re-recorded from the registry`);
  } else if (drifted.length === 0) {
    outLine(`${log.ok("✓")}  ${LEDGER_PATH} matches the registry`);
  }
  outEmit({ ok: drifted.length === 0 || argv.write, drifted });
  if (drifted.length > 0 && !argv.write) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

/**
 * Fetch, verify and (with `--pin`) pin the files every module's `sources:`
 * block declares, and those of every library nested inside each module. Each archive is fetched once per module — the decoded archive
 * is dropped once its module is staged — and a file already on disk matching its
 * pin is not fetched at all.
 */
async function stage(argv: CommonArgv & { module?: string[]; pin: boolean }): Promise<void> {
  const log = createLogger(false);
  const workspace = loadWorkspace();
  const modules =
    argv.module && argv.module.length > 0
      ? argv.module.map((key) => requireModule(workspace, key))
      : workspace.modules;

  const outcomes: StageOutcome[] = [];
  const failures: StageFailure[] = [];
  const seen = new Set<string>();
  const targets = modules
    .flatMap((module) =>
      stageTargetsOf({ key: module.key, dir: module.dir, manifestPath: module.manifestPath }),
    )
    .filter((target) => !seen.has(target.manifestPath) && seen.add(target.manifestPath));
  for (const target of targets) {
    const result = await stageModule(target, { pin: argv.pin, archives: createArchiveReader() });
    for (const outcome of result.outcomes) {
      const mark = outcome.action === "verified" ? log.dim("·") : log.ok("✓");
      outLine(`${mark}  ${outcome.module}  ${outcome.source}  ${outcome.path}  ${log.dim(outcome.action)}`);
    }
    for (const failure of result.failures) {
      const where = [failure.source && `source '${failure.source}'`, failure.path, failure.url]
        .filter(Boolean)
        .join("  ");
      outErrLine(`${log.err.error("✗")}  ${failure.module}  ${where ? `${where}  ` : ""}${failure.message}`);
    }
    outcomes.push(...result.outcomes);
    failures.push(...result.failures);
  }

  const ok = failures.length === 0;
  outEmit({ ok, outcomes, failures });
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Wrap a handler so a workspace/ledger/fragment problem is one actionable line
 *  rather than a stack trace — these are all "fix the repo state" errors. */
function guarded<T>(handler: (argv: T) => Promise<void>): (argv: T) => Promise<void> {
  return async (argv) => {
    try {
      await handler(argv);
    } catch (err) {
      outErrLine(
        createLogger(false).err.error("error") +
          `  ${err instanceof Error ? err.message : String(err)}`,
      );
      outEmit({ ok: false });
      process.exitCode = 1;
    }
  };
}

export function releaseCommand(yargs: Argv): Argv {
  return yargs.command(
    "release <subcommand>",
    "Plan and apply module version bumps across a workspace",
    (y) =>
      y
        .option("registry", {
          type: "string",
          describe:
            "Publish destination base (oci://host/org) for modules whose workspace entry declares none. Outranked by an authored 'release.registry'; falls back to TELO_OCI_REGISTRY, then to each module's own recorded base.",
        })
        .option("base", {
          type: "string",
          default: "origin/main",
          describe:
            "Git ref the changed-files reading diffs against. Decides only whether a changelog entry is requested.",
        })
        .option("carried-by", {
          type: "string",
          describe:
            "Git ref whose fragments are already carried: a pending fragment of the same path and content at its merge base with HEAD, or written on it since, is dropped from the plan (status, check, apply).",
        })
        .command(
          "add",
          "Write a pending fragment describing a change",
          (c) =>
            c
              .option("module", {
                type: "string",
                array: true,
                demandOption: true,
                describe:
                  "Module path (modules/sql). Repeat for a change that spans several modules.",
              })
              .option("kind", {
                type: "string",
                default: "Fixed",
                describe: "Added | Changed | Deprecated | Removed | Fixed | Security",
              })
              .option("body", {
                type: "string",
                demandOption: true,
                describe: "The changelog line",
              }),
          guarded(add as (argv: any) => Promise<void>),
        )
        .command("status", "Show what would bump and why", (c) => c, guarded(status as any))
        .command(
          "order",
          "List the workspace's modules in publish order (a dependency before its dependents)",
          (c) => c,
          guarded(order as any),
        )
        .command("check", "Fail when no consistent release plan can be formed", (c) => c, guarded(check as any))
        .command(
          "floor",
          "Write the measured requires.telo floor of each module (up or down)",
          (c) =>
            c.option("module", {
              type: "string",
              array: true,
              describe: "Module path (modules/geocode). Repeat for several; omit to measure every module.",
            }),
          guarded(floor as any),
        )
        .command(
          "apply",
          "Write versions, changelogs and the ledger, and consume the fragments",
          (c) =>
            c.option("date", {
              type: "string",
              describe: "Release date for the changelog entries (YYYY-MM-DD). Defaults to today.",
            }),
          guarded(apply as any),
        )
        .command(
          "verify",
          "Reconcile the ledger against the registry",
          (c) =>
            c.option("write", {
              type: "boolean",
              default: false,
              describe: "Re-record the ledger from what the registry actually serves",
            }),
          guarded(verify as any),
        )
        .command(
          "stage",
          "Fetch and verify the files each module's sources: block declares",
          (c) =>
            c
              .option("module", {
                type: "string",
                array: true,
                describe: "Module path (modules/sqlite). Repeat to stage several; omit to stage every module.",
              })
              .option("pin", {
                type: "boolean",
                default: false,
                describe: "Fetch every file entry and write its sha256 and executable into telo.yaml before staging",
              }),
          guarded(stage as any),
        )
        .command(
          "imports <paths..>",
          "Write each import of a workspace module in its published or its relative form",
          (c) =>
            c
              .positional("paths", {
                describe: "Manifests whose imports are rewritten (a directory means its telo.yaml)",
                type: "string",
                array: true,
                demandOption: true,
              })
              .option("as", {
                type: "string",
                choices: IMPORT_FORMS,
                demandOption: true,
                describe:
                  "published: the destination, version and registry pin of the module's version in this tree; relative: the path to the module's directory",
              })
              .option("check", {
                type: "boolean",
                default: false,
                describe: "Write nothing; exit 1 listing every import whose form differs from what would be written",
              })
              .option("dry-run", {
                type: "boolean",
                default: false,
                describe: "Show what would change without writing to disk",
              }),
          guarded(releaseImportsCommand as any),
        )
        .demandCommand(
          1,
          "Specify a release subcommand (add | status | order | check | floor | apply | verify | stage | imports)",
        ),
    () => {},
  );
}
