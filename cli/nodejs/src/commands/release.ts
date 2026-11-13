/**
 * `telo release` — the release command tree of `@telorun/release` (`add`,
 * `status`, `order`, `check`, `apply`, `verify`, `tag`, `adopt`) over every unit
 * of a declared workspace, with the `telo` ecosystem registered beside the
 * shipped ones, plus Telo's own subcommands: `floor` writes each module's
 * measured `requires.telo`, `stage` fetches the files `sources:` declares, and
 * `imports` writes a consumer's imports of workspace modules in their published
 * or relative form.
 *
 * It is the only reader of the marker's `release:` block in this CLI. `telo
 * run` reads its `env:` block, and every other command behaves identically with
 * or without one.
 */

import { releaseCommands, type Guard } from "@telorun/release/node";
import type { Argv } from "yargs";
import { createArchiveReader } from "@telorun/kernel";
import { createLogger } from "../logger.js";
import { outEmit, outErrLine, outLine } from "../output.js";
import { RegistryUnreachableError, floorText, sameFloor } from "../release/floor-measurement.js";
import { floorLine, measureAndWriteFloors } from "../release/floor-workspace.js";
import { stageModule, stageTargetsOf, type StageFailure, type StageOutcome } from "../release/stage.js";
import { teloReleaseHost } from "../release/telo-host.js";
import { loadWorkspace, requireModule } from "../release/workspace.js";
import { IMPORT_FORMS, releaseImportsCommand } from "./release-imports.js";

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
async function floor(argv: { module?: string[] }): Promise<void> {
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
// stage
// ---------------------------------------------------------------------------

/**
 * Fetch, verify and (with `--pin`) pin the files every module's `sources:`
 * block declares, and those of every library nested inside each module. A file
 * already on disk matching its pin is not fetched at all.
 */
async function stage(argv: { module?: string[]; pin: boolean }): Promise<void> {
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

function teloSubcommands(y: Argv, guarded: Guard): Argv {
  return y
    .command(
      "floor",
      "Write the measured requires.telo floor of each module (up or down)",
      (c) =>
        c.option("module", {
          type: "string",
          array: true,
          describe: "Module path (modules/geocode). Repeat for several; omit to measure every module.",
        }),
      guarded(floor as (argv: unknown) => Promise<void>),
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
      guarded(stage as (argv: unknown) => Promise<void>),
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
          guarded(releaseImportsCommand as (argv: unknown) => Promise<void>),
        )
    ;
}

export function releaseCommand(yargs: Argv): Argv {
  return yargs.command(
    "release <subcommand>",
    "Plan, apply and verify the versions of every unit of a workspace",
    (y) => releaseCommands(y, teloReleaseHost({ subcommands: teloSubcommands })),
    () => {},
  );
}
