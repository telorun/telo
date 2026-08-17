/**
 * `telo release` — one release system over the modules of a declared workspace.
 *
 * `add` writes a fragment; `status` explains what would bump and why; `check` is
 * the CI gate; `apply` produces the Version PR; `verify` reconciles the ledger
 * against the registry. `telo publish` still keys off version movement.
 *
 * The command reads `telo-workspace.yaml` and **nothing else does**: `run`,
 * `check`, `publish`, `install`, `upgrade`, `migrate`, `module` and the kernel
 * behave identically with or without one, which is what keeps a single-manifest
 * repo, a bare `examples/` directory and a third-party module checkout working
 * with nothing added.
 */

import {
  LEDGER_PATH,
  LOCALLY_DERIVED_LAYERS,
  TELO_SURFACE_VERSION,
  diffLayerDigests,
  isFragmentKind,
  orderByImports,
  planRelease,
  serializeFragment,
  type FragmentKind,
  type LayerDigests,
  type Ledger,
  type LedgerEntry,
  type ModuleKey,
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
import { collectEvidence, destinationFor, digestPayload } from "../release/evidence.js";
import {
  deleteFragment,
  readFragments,
  readLedger,
  writeFragment,
  writeLedger,
} from "../release/ledger-store.js";
import { planPayload, renderDiagnostics, renderPlan } from "../release/render.js";
import { loadWorkspace, requireModule, type Workspace } from "../release/workspace.js";

interface CommonArgv {
  registry?: string;
  base: string;
}

/**
 * The publish destination base.
 *
 * The ledger's recorded base wins, because the digests beside it were taken
 * against it — building against a different one produces different manifest
 * layers and would report every module as changed. A flag or the ambient
 * variable seeds it for a workspace that has published nothing yet.
 */
function resolveRegistry(workspace: Workspace, argv: CommonArgv, ledger: Ledger): string {
  const recorded = ledger.registry;
  const requested = argv.registry ?? process.env.TELO_OCI_REGISTRY;
  if (recorded && requested && recorded !== requested) {
    throw new Error(
      `${LEDGER_PATH} records its digests against '${recorded}', but '${requested}' was requested. ` +
        `Canonicalization writes the destination into every relative import, so the two produce ` +
        `different manifest bytes. Publish to the recorded base, or re-record the ledger with ` +
        `\`telo release verify --registry ${requested}\`.`,
    );
  }
  const registry = recorded ?? requested;
  if (!registry) {
    throw new Error(
      `No publish destination is known. ${LEDGER_PATH} records none (nothing has been published ` +
        `from this workspace yet), so pass --registry oci://host/org or set TELO_OCI_REGISTRY. ` +
        `It is recorded on the first \`telo release apply\`, because the digests only mean ` +
        `anything against the base they were taken at.`,
    );
  }
  return registry.replace(/\/+$/, "");
}

async function buildPlan(argv: CommonArgv, log: Logger): Promise<{
  workspace: Workspace;
  registry: string;
  plan: ReleasePlan;
}> {
  const workspace = loadWorkspace();
  const ledger = readLedger(workspace.root);
  const registry = resolveRegistry(workspace, argv, ledger);
  const fragments = readFragments(workspace.root);

  const modules = await collectEvidence(workspace, {
    registry,
    baseRef: argv.base,
    // A ticker, not a diagnostic: sixty-one of these are what a human watching a
    // two-minute build wants and what a CI log or a `-o json` consumer does not.
    onModule: (module, index, total) =>
      outProgress(log.err.dim(`  [${index + 1}/${total}] ${module.key}`)),
  });

  return { workspace, registry, plan: planRelease({ modules, ledger, fragments, registry }) };
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

  // Declared runtime requirements, verified by RUNNING the CLI at each edge of
  // each declared range. This is where an adoption of new syntax without a
  // matching bound is caught: the low-edge CLI cannot read it and says so. It is
  // self-maintaining — nothing has to be annotated, and no list can go stale.
  const requires = await checkWorkspaceRequires(workspace, TELO_SURFACE_VERSION);
  for (const c of requires.checks) {
    const label = `telo ${c.edge}`;
    const count = `${c.modules.length} module${c.modules.length === 1 ? "" : "s"}`;
    if (c.status === "passed") {
      outLine(`${log.ok("✓")}  ${label}  ${log.dim(`${count} verified`)}`);
    } else if (c.status === "unavailable") {
      // Unproven, not disproven — CI that cannot reach npm must not invent a
      // verdict, and must not silently claim one either.
      outErrLine(`${log.warn("!")}  ${label}  could not run (${c.detail ?? "unknown"})`);
    } else {
      outErrLine(
        `${log.err.error("✗")}  ${label}  rejects ${count} declaring it: ${c.modules.join(", ")}`,
      );
      if (c.detail) outErrLine(c.detail);
    }
  }

  const ok = errors === 0 && !requires.refuted;
  outEmit({ ok, ...(planPayload(plan) as object), requires: requires.checks });
  if (!ok) process.exitCode = 1;
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
  const { workspace, registry, plan } = await buildPlan(argv, log);
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

  writeLedger(workspace.root, await recordLedger(workspace.root, registry, plan));
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
 * `<base>/<sibling>@<version>` and publish then hard-fails when that ref does not
 * already resolve, so a sibling has to be pushed first. This replaced a regex
 * that read `imports:` out of the first YAML document by line shape.
 *
 * Reads the import graph only — no payloads are built, so it is cheap enough to
 * call from a release script.
 */
async function order(argv: CommonArgv): Promise<void> {
  const workspace = loadWorkspace();
  const registry = resolveRegistry(workspace, argv, readLedger(workspace.root));
  const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workspace.root, ".telo") });

  const byDir = new Map(workspace.modules.map((module) => [path.resolve(module.dir), module]));
  const evidence = [];
  for (const module of workspace.modules) {
    // Only the manifest transform runs here, which is what carries the imports.
    const imports =
      module.artifactKind === "image"
        ? []
        : (
            await builder.relativeImportsOf(
              module.manifestPath,
              destinationFor(registry, module),
            )
          )
            .map((entry) => byDir.get(path.resolve(path.dirname(entry.manifestPath)))?.key)
            .filter((key): key is ModuleKey => key !== undefined && key !== module.key);
    evidence.push({
      key: module.key,
      name: module.name,
      version: module.version,
      artifactKind: module.artifactKind,
      layers: {},
      inlines: new Map<ModuleKey, string[]>(),
      imports,
      ownFilesChanged: false,
    });
  }

  const ordered = orderByImports(evidence).map((module) => module.key);
  for (const key of ordered) outLine(key);
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
  const registry = resolveRegistry(workspace, argv, ledger);

  const drifted: Array<{ key: ModuleKey; detail: string }> = [];
  const repaired = new Map<ModuleKey, LedgerEntry>(ledger.modules);

  const reportDrift = (key: ModuleKey, detail: string): void => {
    drifted.push({ key, detail });
    outErrLine(`${log.err.warn("drift")}  ${key}: ${detail}`);
  };

  // Only the registry-artifact modules are reconciled — an image module has no
  // published artifact to read a layer index from — so the count is theirs, not
  // the workspace's, or the ticker would stall at a number it never reaches.
  const reconciled = workspace.modules.filter((module) => module.artifactKind !== "image");
  for (const [index, module] of reconciled.entries()) {
    outProgress(log.err.dim(`  [${index + 1}/${reconciled.length}] ${module.key}`));
    const recorded = ledger.modules.get(module.key);
    const published = await readPublishedDigests(
      destinationFor(registry, module),
      module.version,
      registry,
    );

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
      if (argv.write) repaired.set(module.key, { version: module.version, layers: published });
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
        layers: { ...localOnly(recorded.layers), ...published },
      });
    }
  }

  if (argv.write) {
    writeLedger(workspace.root, { registry, modules: repaired });
    outLine(`${log.ok("✓")}  ${LEDGER_PATH} re-recorded from the registry`);
  } else if (drifted.length === 0) {
    outLine(`${log.ok("✓")}  ${LEDGER_PATH} matches the registry`);
  }
  outEmit({ ok: drifted.length === 0 || argv.write, drifted });
  if (drifted.length > 0 && !argv.write) process.exitCode = 1;
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
            "Publish destination base (oci://host/org). Defaults to the ledger's recorded base, then TELO_OCI_REGISTRY.",
        })
        .option("base", {
          type: "string",
          default: "origin/main",
          describe:
            "Git ref the changed-files reading diffs against. Decides only whether a changelog entry is requested.",
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
        .demandCommand(1, "Specify a release subcommand (add | status | order | check | apply | verify)"),
    () => {},
  );
}
