/**
 * The release command tree — `add`, `status`, `order`, `check`, `apply`,
 * `verify`, `baseline`, `tag`, `adopt changesets` — registered onto whatever yargs instance
 * the host mounts it on: `telo release …` in the Telo CLI, the top level in
 * `telo-release`.
 */

import type { Argv } from "yargs";
import { isFragmentKind, type FragmentKind } from "../bump-level.js";
import { normalizeUnitKey, serializeFragment, type UnitKey } from "../fragment.js";
import { LEDGER_PATH } from "../ledger.js";
import { NOTHING_TO_RELEASE, renderPlanMarkdown } from "../plan-markdown.js";
import type { ReleaseDiagnostic, ReleasePlan } from "../release-plan.js";
import { adoptChangesets } from "./adopt-changesets.js";
import type { Guard, ReleaseHost } from "./host.js";
import { writeFragment, writeLedger } from "./ledger-store.js";
import {
  applyPlan,
  baselineLedger,
  candidateId,
  createTags,
  loadWorkspaceFor,
  orderRows,
  planWorkspaceRelease,
  tagsToCreate,
  verifyLedger,
  type Argv as ParsedArgv,
} from "./operations.js";
import { planPayload, renderDiagnostics, renderPlan } from "./render.js";
import type { ReleaseWorkspace } from "./workspace.js";

interface CommonArgv {
  base: string;
  carriedBy?: string;
  output?: string;
  maxLength?: string;
  [key: string]: unknown;
}

const LARGEST_LENGTH = Number.MAX_SAFE_INTEGER;

/** Why a plan command's `--max-length` cannot be read, if it cannot. */
export function maxLengthRefusal(command: string, output: unknown, maxLength: unknown, writesMarkdown = true): string | undefined {
  if (maxLength === undefined) return undefined;
  if (!writesMarkdown) return `--max-length applies only to -o markdown; ${command} writes text or json.`;
  if (output !== "markdown") return `--max-length applies only to -o markdown; ${command} writes text, json or markdown.`;
  const text = String(maxLength);
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > LARGEST_LENGTH) {
    return `--max-length takes a positive whole number of code points, not '${text}'.`;
  }
  return undefined;
}

/** `-o markdown` and `--max-length` on a command whose result is a plan;
 *  every other command keeps the host's `text` and `json`. */
function planFormats(command: string) {
  return <T>(c: Argv<T>): Argv<T> =>
    c
      .choices("output", ["markdown"])
      .option("max-length", {
        type: "string",
        describe: "With -o markdown, the most Unicode code points the document may hold; it is shortened in stated stages to fit",
      })
      .check((argv) => maxLengthRefusal(command, argv.output, argv.maxLength) ?? true) as unknown as Argv<T>;
}

/** `--max-length` on a command that never writes markdown: declared hidden so it is
 *  refused naming the formats the command can write, not as an unknown option. */
function noMarkdown(command: string) {
  return <T>(c: Argv<T>): Argv<T> =>
    c
      .option("max-length", { type: "string", hidden: true })
      .check((argv) => maxLengthRefusal(command, argv.output, argv.maxLength, false) ?? true) as unknown as Argv<T>;
}

/** The plan's markdown document under `-o markdown`; throws when no stage fits. */
function markdownOf(argv: CommonArgv, plan: ReleasePlan): string | undefined {
  if (argv.output !== "markdown") return undefined;
  return renderPlanMarkdown(plan, argv.maxLength === undefined ? undefined : Number(argv.maxLength));
}

/** A failure is one line naming what to fix, an `ok: false` envelope and exit 1. */
export function guardWith(host: ReleaseHost): Guard {
  return (handler) => async (argv) => {
    try {
      await handler(argv);
    } catch (err) {
      const out = host.output();
      out.errLine(`${out.errStyle.error("error")}  ${err instanceof Error ? err.message : String(err)}`);
      out.emit({ ok: false });
      process.exitCode = 1;
    }
  };
}

function report(host: ReleaseHost, diagnostics: readonly ReleaseDiagnostic[]): number {
  const out = host.output();
  for (const line of renderDiagnostics(diagnostics, out.errStyle)) out.errLine(line);
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
}

/** Print, and stop where anything is an error: a machine reads these answers. */
function refuseOnErrors(host: ReleaseHost, diagnostics: readonly ReleaseDiagnostic[]): boolean {
  if (report(host, diagnostics) === 0) return false;
  host.output().emit({ ok: false, diagnostics: [...diagnostics] });
  process.exitCode = 1;
  return true;
}

async function plan(host: ReleaseHost, argv: CommonArgv, candidate?: string) {
  const out = host.output();
  const workspace = loadWorkspaceFor(host);
  return planWorkspaceRelease(host, workspace, argv as ParsedArgv, {
    baseRef: argv.base,
    ...(argv.carriedBy ? { carriedBy: argv.carriedBy } : {}),
    ...(candidate ? { candidate } : {}),
    onUnit: (unit, index, total) => out.progress(out.errStyle.dim(`  [${index + 1}/${total}] ${unit.key}`)),
  });
}

/** `<kind>-<slug>.yaml`: the pending directory sorts by kind, and a second
 *  fragment for the same change is a visible duplicate. */
export function fragmentFilename(kinds: Iterable<FragmentKind>, body: string): string {
  const kind = [...kinds][0] ?? "Fixed";
  const slug =
    body.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-") || "change";
  return `${kind.toLowerCase()}-${slug}.yaml`;
}

/** The unit `key` names, with a message listing what does exist. */
export function requireUnit(workspace: ReleaseWorkspace, key: string): UnitKey {
  const normalized = normalizeUnitKey(key) || ".";
  if (workspace.units.some((unit) => unit.key === normalized)) return normalized;
  const near = workspace.units.filter(
    (unit) => unit.key.endsWith(`/${normalized}`) || normalized.startsWith(`${unit.key}/`),
  );
  throw new Error(
    `'${key}' is not a unit in this workspace.` +
      (near.length > 0
        ? ` A unit is named by its workspace-relative directory — did you mean ${near.map((u) => `'${u.key}'`).join(" or ")}?`
        : ` Units are named by workspace-relative directory: ${workspace.units.slice(0, 8).map((u) => u.key).join(", ")}${workspace.units.length > 8 ? ", …" : ""}.`),
  );
}

export function releaseCommands(yargs: Argv, host: ReleaseHost): Argv {
  const guarded = guardWith(host);
  const common = (y: Argv) =>
    (host.globalOptions ? host.globalOptions(y) : y)
      .option("base", {
        type: "string",
        default: "origin/main",
        describe: "Git ref the changed-files reading diffs against. Decides only whether a changelog entry is requested.",
      })
      .option("carried-by", {
        type: "string",
        describe:
          "Git ref whose fragments are already carried: a pending fragment of the same path and content at its merge base with HEAD, or written on it since, is dropped from the plan (status, check, apply).",
      });

  const withCommon = common(yargs)
    .command(
      "add",
      "Write a pending fragment describing a change",
      (c) =>
        noMarkdown("add")(c)
          .option("unit", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Unit directory (packages/core, or kernel for a component with several packages). Repeat for a change spanning several units.",
          })
          .option("kind", { type: "string", default: "Fixed", describe: "Added | Changed | Deprecated | Removed | Fixed | Security" })
          .option("body", { type: "string", demandOption: true, describe: "The changelog line" }),
      guarded(async (argv: { unit: string[]; kind: string; body: string }) => {
        const out = host.output();
        if (!isFragmentKind(argv.kind)) {
          throw new Error(`'${argv.kind}' is not a release kind. Use Added, Changed, Deprecated, Removed, Fixed or Security.`);
        }
        const workspace = loadWorkspaceFor(host);
        const units = new Map<UnitKey, FragmentKind>();
        for (const key of argv.unit) units.set(requireUnit(workspace, key), argv.kind);
        const source = writeFragment(workspace.root, fragmentFilename(units.values(), argv.body), serializeFragment(units, argv.body));
        out.line(`${out.style.ok("✓")}  ${source}`);
        out.emit({ ok: true, fragment: source, units: [...units.keys()] });
      }),
    )
    .command(
      "status",
      "Show what would bump, from what to what, and why",
      (c) => planFormats("status")(c),
      guarded(async (argv: CommonArgv) => {
        const out = host.output();
        const run = await plan(host, argv);
        for (const line of renderPlan(run.plan, out.style)) out.line(line);
        report(host, run.plan.diagnostics);
        const document = markdownOf(argv, run.plan);
        out.emit({ ok: true, ...planPayload(run.plan) });
        if (document !== undefined) out.document(document);
      }),
    )
    .command(
      "order",
      "List the units in publish order, one row per unit and package",
      (c) => noMarkdown("order")(c),
      guarded(async (argv: CommonArgv) => {
        const out = host.output();
        const workspace = loadWorkspaceFor(host);
        const { rows, diagnostics } = await orderRows(host, workspace, argv as ParsedArgv);
        if (refuseOnErrors(host, diagnostics)) return;
        report(host, diagnostics);
        for (const row of rows) {
          out.line([row.key, row.ecosystem ?? "", row.path, row.version, row.destination ?? ""].join("\t"));
        }
        out.emit({ ok: true, order: rows });
      }),
    )
    .command(
      "check",
      "The pull-request gate: fail when no consistent release plan can be formed",
      (c) => planFormats("check")(c),
      guarded(async (argv: CommonArgv) => {
        const out = host.output();
        const run = await plan(host, argv);
        for (const line of renderPlan(run.plan, out.style)) out.line(line);
        const errors = report(host, run.plan.diagnostics);
        const extra = host.check ? await host.check(run.workspace, run.plan, argv as ParsedArgv) : { ok: true, payload: {} };
        const ok = errors === 0 && extra.ok;
        const document = ok ? markdownOf(argv, run.plan) : undefined;
        out.emit({ ok, ...planPayload(run.plan), ...extra.payload });
        if (document !== undefined) out.document(document);
        if (!ok) process.exitCode = 1;
      }),
    )
    .command(
      "apply",
      "Write versions, changelogs and the ledger, and consume the fragments",
      (c) =>
        planFormats("apply")(c)
          .option("candidate", {
            type: "string",
            describe: "Version each planned unit as a candidate, <final>-<id>.<k> (id default rc); consumes no fragment",
          })
          .option("date", { type: "string", describe: "Release date for the changelog entries (YYYY-MM-DD). Defaults to today." }),
      guarded(async (argv: CommonArgv & { candidate?: string; date?: string }) => {
        const out = host.output();
        const candidate = candidateId(argv.candidate);
        const run = await plan(host, argv, candidate);
        if (report(host, run.plan.diagnostics) > 0) {
          out.emit({ ok: false, ...planPayload(run.plan) });
          process.exitCode = 1;
          return;
        }
        // Before anything is written: a document no stage fits refuses the apply.
        const document = markdownOf(argv, run.plan);
        if (run.plan.units.length === 0) {
          out.line(NOTHING_TO_RELEASE);
          out.emit({ ok: true, units: [], written: [] });
          if (document !== undefined) out.document(document);
          return;
        }
        const { applied, written } = await applyPlan(host, run, argv as ParsedArgv, argv.date ?? new Date().toISOString().slice(0, 10));
        for (const unit of applied) out.line(`${out.style.ok("✓")}  ${unit.key}  ${unit.from} → ${unit.to}`);
        for (const file of written) out.line(`   ${out.style.dim(file)}`);
        out.emit({ ok: true, ...planPayload(run.plan), written });
        if (document !== undefined) out.document(document);
      }),
    )
    .command(
      "verify",
      "Reconcile the ledger against the registries, per layer",
      (c) => noMarkdown("verify")(c).option("write", { type: "boolean", default: false, describe: "Re-record the ledger from what the registries serve" }),
      guarded(async (argv: CommonArgv & { write: boolean }) => {
        const out = host.output();
        const workspace = loadWorkspaceFor(host);
        const { findings, ledger, diagnostics } = await verifyLedger(host, workspace, argv as ParsedArgv, (text) =>
          out.progress(out.errStyle.dim(text)),
        );
        if (refuseOnErrors(host, diagnostics)) return;
        for (const finding of findings) {
          const label = finding.kind === "drift" ? out.errStyle.warn("drift") : out.errStyle.dim("unverifiable");
          out.errLine(`${label}  ${finding.key} ${finding.layer}: ${finding.detail}`);
        }
        const drifted = findings.filter((finding) => finding.kind === "drift");
        if (argv.write) {
          writeLedger(workspace.root, ledger);
          out.line(`${out.style.ok("✓")}  ${LEDGER_PATH} re-recorded from the registries`);
        } else if (drifted.length === 0) {
          out.line(`${out.style.ok("✓")}  ${LEDGER_PATH} matches the registries`);
        }
        out.emit({ ok: drifted.length === 0 || argv.write, drifted, unverifiable: findings.filter((f) => f.kind === "unverifiable") });
        if (drifted.length > 0 && !argv.write) process.exitCode = 1;
      }),
    )
    .command(
      "baseline",
      "Record the current state of every unit with no ledger entry, without bumping anything",
      (c) =>
        noMarkdown("baseline")(c)
          .option("unit", {
            type: "string",
            array: true,
            describe: "Record this unit only (repeatable). A unit that already has an entry is an error: use verify --write.",
          })
          .option("dry-run", { type: "boolean", default: false, describe: "List what would be recorded without writing the ledger" }),
      guarded(async (argv: { unit?: string[]; dryRun: boolean }) => {
        const out = host.output();
        const workspace = loadWorkspaceFor(host);
        const only = argv.unit?.map((key) => requireUnit(workspace, key));
        const result = await baselineLedger(host, workspace, argv as unknown as ParsedArgv, only, (text) =>
          out.progress(out.errStyle.dim(text)),
        );
        if (refuseOnErrors(host, result.diagnostics)) return;
        if (!argv.dryRun && result.recorded.length > 0) writeLedger(workspace.root, result.ledger);
        for (const { key, version } of result.recorded) {
          out.line(`${out.style.ok("✓")}  ${key}  ${version}${argv.dryRun ? out.style.dim("  (would record)") : ""}`);
        }
        for (const key of result.skipped) out.line(out.style.dim(`   ${key}  skipped: it already has a ledger entry`));
        for (const { key, reason } of result.unrecorded) out.errLine(`${out.errStyle.warn("unrecorded")}  ${key}: ${reason}`);
        if (result.recorded.length === 0) out.line(`Nothing to record — no unit lacks a ${LEDGER_PATH} entry that can be recorded.`);
        out.emit({ ok: true, recorded: result.recorded, skipped: result.skipped, unrecorded: result.unrecorded, dryRun: argv.dryRun });
      }),
    )
    .command(
      "tag",
      "Tag each unit the last apply moved, by its tag format, on HEAD",
      (c) => noMarkdown("tag")(c).option("dry-run", { type: "boolean", default: false, describe: "List the tags without creating them" }),
      guarded(async (argv: { dryRun: boolean }) => {
        const out = host.output();
        const workspace = loadWorkspaceFor(host);
        const tags = tagsToCreate(host, workspace);
        if (!argv.dryRun) createTags(workspace, tags);
        for (const { tag, exists } of tags) out.line(`${out.style.ok("✓")}  ${tag}${exists ? out.style.dim("  (already on HEAD)") : ""}`);
        if (tags.length === 0) out.line("Nothing to tag — the last commit moved no unit's version.");
        out.emit({ ok: true, tags: tags.map((t) => t.tag), dryRun: argv.dryRun });
      }),
    )
    .command(
      "adopt <tool>",
      "Import a changesets setup once: units, groups, pending fragments and the npm ledger",
      (c) =>
        noMarkdown("adopt")(c).positional("tool", { type: "string", choices: ["changesets"], demandOption: true, describe: "The tool to adopt from" }),
      guarded(async (argv: CommonArgv & { tool: string }) => {
        const out = host.output();
        const result = await adoptChangesets(host, process.cwd(), argv as ParsedArgv);
        for (const file of result.written) out.line(`${out.style.ok("✓")}  ${file}`);
        for (const file of result.deleted) out.line(`${out.style.ok("✓")}  deleted ${file}`);
        for (const left of result.leftBehind) out.errLine(`${out.errStyle.warn("rewrite")}  ${left}`);
        out.emit({ ok: true, ...result });
      }),
    );
  const all = host.subcommands ? host.subcommands(withCommon, guarded) : withCommon;
  return all.demandCommand(1, "Specify a release subcommand");
}
