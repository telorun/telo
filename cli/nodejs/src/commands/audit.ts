import type { Argv } from "yargs";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "@telorun/analyzer";
import { ADVISORY_LOOKUP_FAILED, AdvisoryLookupError, lookupAdvisories, type ComponentAnswer, type ComponentInput, type LookupOptions } from "@telorun/osv";
import { componentLookupInput, lookupKey } from "../bill-of-materials/audit-components.js";
import { CommitHistoryReader } from "../commit-reachability/commit-history.js";
import { checkDeclaredRevisions, declaredRevisions } from "../commit-reachability/declared-revisions.js";
import { ignoredLine, judgeComponents, type Finding, type IgnoredAdvisory } from "../bill-of-materials/audit-findings.js";
import { readAuditMarker } from "../bill-of-materials/audit-ignore.js";
import { newHintContext } from "../bill-of-materials/audit-upgrade.js";
import { countLine, printClosureDiagnostics } from "../bill-of-materials/closure-report.js";
import { incompleteModules } from "../bill-of-materials/composed-document.js";
import { incompleteRecordDiagnostic } from "../bill-of-materials/incomplete-records.js";
import { buildApplicationClosure, type ClosureModule } from "../bill-of-materials/module-closure.js";
import { OSV_URL_ENV, resolveOsvEndpoint } from "../bill-of-materials/osv-endpoint.js";
import { describeOccurrenceScope } from "../bill-of-materials/platform-scope.js";
import { EXIT_REFUSED } from "../exit-status.js";
import { createLogger, type JsonDiagnostic, type Logger } from "../logger.js";
import { outEmit, outErrLine } from "../output.js";
import { ABI_OPTION, PLATFORM_OPTION, SBOM_DEFINITION, scopeOrRefuse } from "./sbom.js";

/** What a test injects: the lookup's transport and clock, the date acceptances are judged on, the environment. */
export interface AuditDeps {
  readonly lookup?: Omit<LookupOptions, "baseUrl">;
  /** `YYYY-MM-DD`; the current UTC date when omitted. */
  readonly today?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Reads the repositories a local module's `vcs:` revisions are checked against. */
  readonly revisions?: CommitHistoryReader;
}

interface Collected {
  diagnostics: JsonDiagnostic[];
  errorCount: number;
  warnCount: number;
}

type AuditArgv = {
  manifest: string;
  platform?: string;
  abi?: string;
  allowIncomplete?: boolean;
  osvUrl?: string;
};

function finish(collected: Collected, ignored: readonly IgnoredAdvisory[], log: Logger): void {
  const counts = countLine(collected, log);
  if (counts !== "") outErrLine(counts);
  outEmit({
    ok: collected.errorCount === 0,
    errorCount: collected.errorCount,
    warnCount: collected.warnCount,
    diagnostics: collected.diagnostics,
    ignored: ignored.map(({ id, reason, expires, component, chain }) => ({ id, reason, expires, component, chain })),
  });
  if (collected.errorCount > 0) process.exitCode = 1;
}

/** An error with no place in a manifest, printed without one. */
function unanchored(message: string, code: string, manifest: string, log: Logger): JsonDiagnostic {
  outErrLine(`${log.err.error("error")}  ${message}  ${log.err.dim(code)}`);
  return { file: manifest, line: 1, column: 1, severity: "error", code, message };
}

function summaryLine(args: {
  name: string;
  modules: readonly ClosureModule[];
  scope: Parameters<typeof describeOccurrenceScope>[0];
  endpoint: { url: string; isDefault: boolean };
  incomplete: number;
  answers: ReadonlyMap<string, ComponentAnswer>;
}): string {
  const { name, modules, scope, endpoint, incomplete, answers } = args;
  const inputs = modules.flatMap((node) => (node.unrecorded ? [] : node.components.flatMap((c) => componentLookupInput(c) ?? [])));
  const checked = inputs.filter((input) => answers.get(lookupKey(input))?.checked === true).length;
  const count = (n: number) => `${n} component${n === 1 ? "" : "s"}`;
  return (
    `${name}: ${modules.length} module${modules.length === 1 ? "" : "s"}, ` +
    (checked === inputs.length ? `${count(inputs.length)} checked` : `${checked} of ${count(inputs.length)} checked`) +
    `, ${describeOccurrenceScope(scope)}` +
    (endpoint.isDefault ? "" : `, OSV ${endpoint.url}`) +
    (incomplete > 0 ? `, ${incomplete} incomplete` : "")
  );
}

export async function audit(argv: AuditArgv, deps: AuditDeps = {}): Promise<void> {
  const log = createLogger(false);
  const env = deps.env ?? process.env;
  const endpoint = resolveOsvEndpoint(argv.osvUrl, env);
  if (!endpoint.ok) {
    outErrLine(endpoint.message);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const scope = scopeOrRefuse(argv, log);
  if (!scope) return;
  const allowIncomplete = argv.allowIncomplete === true;
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const collected: Collected = { diagnostics: [], errorCount: 0, warnCount: 0 };
  const absorb = (counts: Collected): void => {
    collected.diagnostics.push(...counts.diagnostics);
    collected.errorCount += counts.errorCount;
    collected.warnCount += counts.warnCount;
  };

  const marker = readAuditMarker(argv.manifest);
  if (marker && marker.problems.length > 0) {
    for (const problem of marker.problems) {
      outErrLine(
        `${marker.file}:${problem.place.line}:${problem.place.column}  ${log.err.error("error")}  ${problem.message}  ${log.err.dim(problem.code)}`,
      );
      collected.diagnostics.push({
        file: marker.file,
        line: problem.place.line,
        column: problem.place.column,
        severity: "error",
        code: problem.code,
        message: problem.message,
      });
      collected.errorCount++;
    }
    finish(collected, [], log);
    return;
  }

  const outcome = await buildApplicationClosure({ manifest: argv.manifest, scope, log });
  if (!outcome.ok) {
    absorb(printClosureDiagnostics(outcome.refusals, log));
    finish(collected, [], log);
    return;
  }
  const { closure } = outcome;

  const unrecorded = incompleteModules(closure);
  if (unrecorded.length > 0) {
    absorb(
      printClosureDiagnostics(
        unrecorded.map((node) => ({
          graph: node.anchor.graph,
          entryPath: node.anchor.entryPath,
          diagnostics: [incompleteRecordDiagnostic(node, allowIncomplete)],
        })),
        log,
      ),
    );
    if (!allowIncomplete) {
      finish(collected, [], log);
      return;
    }
  }

  // A local module's revisions were never checked by a publisher: the audit is
  // their deriver. One that fails is looked up by its purl alone.
  const revisions = deps.revisions ?? new CommitHistoryReader();
  const refused = new Set<string>();
  for (const node of closure.modules) {
    if (!node.local || node.unrecorded) continue;
    const findings = await checkDeclaredRevisions(declaredRevisions(node.sources), revisions);
    if (findings.length === 0) continue;
    for (const finding of findings) refused.add(`${finding.revision.vcs.url}\0${finding.revision.vcs.revision}`);
    absorb(
      printClosureDiagnostics(
        [
          {
            graph: node.anchor.graph,
            entryPath: node.anchor.entryPath,
            diagnostics: findings.map((finding) => ({
              severity: DiagnosticSeverity.Error,
              code: finding.code,
              source: "telo-audit",
              message: finding.message,
              data: { ...node.anchor.data, path: finding.path },
            })),
          },
        ],
        log,
      ),
    );
  }

  const lookup: LookupOptions = { ...deps.lookup, baseUrl: endpoint.url };
  const asked = new Map<string, ComponentInput>();
  const unique = new Map<string, ComponentInput>();
  for (const node of closure.modules) {
    if (node.unrecorded) continue;
    for (const component of node.components) {
      const input = componentLookupInput(component);
      if (!input) continue;
      const { vcs, ...rest } = input;
      const sent = vcs && refused.has(`${vcs.url}\0${vcs.revision}`) ? rest : input;
      asked.set(lookupKey(input), sent);
      unique.set(lookupKey(sent), sent);
    }
  }
  let answers: ComponentAnswer[];
  try {
    answers = await lookupAdvisories([...unique.values()], lookup);
  } catch (err) {
    if (!(err instanceof AdvisoryLookupError)) throw err;
    collected.diagnostics.push(
      unanchored(
        `${err.message} Check the address (--osv-url, ${OSV_URL_ENV}) or the network, and run again.`,
        ADVISORY_LOOKUP_FAILED,
        argv.manifest,
        log,
      ),
    );
    collected.errorCount++;
    finish(collected, [], log);
    return;
  }

  const byLookup = new Map(answers.map((answer) => [lookupKey(answer), answer]));
  const answered = new Map([...asked].map(([key, sent]) => [key, byLookup.get(lookupKey(sent))!]));
  const { findings, ignored } = await judgeComponents({
    modules: closure.modules,
    answers: answered,
    ignore: marker?.ignore ?? [],
    markerFile: marker?.file ?? "telo-workspace.yaml",
    today,
    manifest: argv.manifest,
    hints: newHintContext(scope, lookup, log),
  });
  const printed = printClosureDiagnostics(
    findings.map((finding: Finding) => ({
      graph: finding.anchor.graph,
      entryPath: finding.anchor.entryPath,
      diagnostics: [finding.diagnostic as AnalysisDiagnostic],
    })),
    log,
  );
  // One diagnostic per group, so the printed list is in `findings` order.
  collected.diagnostics.push(
    ...printed.diagnostics.map((diagnostic, index) => {
      const extra = findings[index]?.extra;
      return extra ? { ...diagnostic, advisory: extra.advisory, chain: extra.chain, upgrade: extra.upgrade } : diagnostic;
    }),
  );
  collected.errorCount += printed.errorCount;
  collected.warnCount += printed.warnCount;

  outErrLine(
    summaryLine({
      name: closure.entry.subject.name,
      modules: closure.modules,
      scope,
      endpoint,
      incomplete: unrecorded.length,
      answers: answered,
    }),
  );
  for (const item of ignored) outErrLine(ignoredLine(item));
  finish(collected, ignored, log);
}

export function auditCommand(yargs: Argv): Argv {
  return yargs.command(
    "audit <manifest>",
    `Check an application's whole module closure against known vulnerabilities (OSV), reporting each advisory at the ` +
      `import carrying it with the upgrade that would remove it. ${SBOM_DEFINITION} ` +
      "Advisories can be accepted until a date in the workspace marker's audit: block.",
    (y) =>
      y
        .positional("manifest", {
          describe: "Path to a YAML manifest, a directory containing telo.yaml, a packaged executable, or an HTTP(S) URL",
          type: "string",
          demandOption: true,
        })
        .option("platform", PLATFORM_OPTION)
        .option("abi", ABI_OPTION)
        .option("allow-incomplete", {
          type: "boolean",
          default: false,
          describe: "Judge the rest of the closure past each module with no complete record, reporting it as a warning, instead of refusing",
        })
        .option("osv-url", {
          type: "string",
          requiresArg: true,
          describe: "The OSV endpoint; overrides TELO_OSV_URL, which overrides https://api.osv.dev. Must be an http or https URL.",
        }),
    async (argv) => {
      await audit(argv as never);
    },
  );
}
