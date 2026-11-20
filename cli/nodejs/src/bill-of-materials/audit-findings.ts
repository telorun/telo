/**
 * What `telo audit` says about a closure's components once OSV has answered:
 * one `COMPONENT_VULNERABLE` per advisory no `audit.ignore` entry accepts, one
 * `COMPONENT_UNCHECKED` per component no database matches by version, and the
 * list of advisories an entry accepted.
 */

import { componentRef, DiagnosticSeverity, type AnalysisDiagnostic, type CycloneDxComponent } from "@telorun/analyzer";
import { vcsRepository, type Advisory, type ComponentAnswer, type ComponentInput } from "@telorun/osv";
import { upgradeHint, type HintContext, type UpgradeFact } from "./audit-upgrade.js";
import { componentLookupInput, lookupKey } from "./audit-components.js";
import type { IgnoreEntry } from "./audit-ignore.js";
import { namedAlong } from "./incomplete-records.js";
import type { ClosureAnchor, ClosureModule } from "./module-closure.js";

export const COMPONENT_VULNERABLE = "COMPONENT_VULNERABLE";
export const COMPONENT_UNCHECKED = "COMPONENT_UNCHECKED";

export interface ChainLink {
  readonly alias: string;
  readonly source: string;
}

/** The fields `-o json` adds to a `COMPONENT_VULNERABLE`. */
export interface VulnerableExtra {
  readonly advisory: Advisory;
  readonly chain: readonly ChainLink[];
  readonly upgrade: UpgradeFact | null;
}

export interface Finding {
  readonly anchor: ClosureAnchor;
  readonly diagnostic: AnalysisDiagnostic;
  readonly extra?: VulnerableExtra;
}

export interface IgnoredAdvisory {
  readonly id: string;
  readonly reason: string;
  readonly expires: string;
  readonly component: string;
  readonly chain: readonly ChainLink[];
  /** For the summary line: the advisory's aliases and the carrying module. */
  readonly aliases: readonly string[];
  readonly module: string;
  readonly componentLabel: string;
}

export interface Findings {
  readonly findings: Finding[];
  readonly ignored: IgnoredAdvisory[];
}

const chainOf = (node: ClosureModule): ChainLink[] => node.chain.map(({ alias, source }) => ({ alias, source }));

const componentLabel = (component: CycloneDxComponent): string =>
  `${component.name}${component.version ? ` ${component.version}` : ""}`;

/** The entry accepting `advisory`: a live one when any matches, else the first expired. */
function matching(advisory: Advisory, entries: readonly IgnoreEntry[], today: string): { entry: IgnoreEntry; live: boolean } | undefined {
  const names = new Set([advisory.id, ...advisory.aliases]);
  const matches = entries.filter((entry) => names.has(entry.id));
  const live = matches.find((entry) => entry.expires >= today);
  if (live) return { entry: live, live: true };
  return matches[0] ? { entry: matches[0], live: false } : undefined;
}

function severityText(advisory: Advisory): string[] {
  return advisory.severity.map((s) => s.score);
}

function describeAdvisory(advisory: Advisory): string {
  const meta = [...advisory.aliases, ...severityText(advisory)];
  const summary = advisory.summary.trim();
  return (
    `${advisory.id}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}` +
    (summary === "" ? "." : `: ${summary.endsWith(".") ? summary : `${summary}.`}`)
  );
}

function fixedText(advisory: Advisory, component: CycloneDxComponent, input: ComponentInput): string {
  if (advisory.matchedBy === "revision" && input.vcs) {
    return advisory.fixed.length > 0
      ? `Fixed by commit ${advisory.fixed.join(", ")} of ${vcsRepository(input.vcs!.url)}.`
      : `No fixing commit of ${vcsRepository(input.vcs!.url)} is known.`;
  }
  return advisory.fixed.length > 0
    ? `Fixed in ${component.name} ${advisory.fixed.join(", ")}.`
    : "No fixed version is known.";
}

function vulnerableMessage(node: ClosureModule, component: CycloneDxComponent, input: ComponentInput, advisory: Advisory): string {
  const joiner = node.local || node.chain.length <= 1 ? " " : ", which ";
  return (
    `${namedAlong(node)}${joiner}ships ${componentLabel(component)}, which has ${describeAdvisory(advisory)} ` +
    fixedText(advisory, component, input)
  );
}

/** Where a local module declares a staged component: `sources.<name>` for the
 *  source itself, `sources.<name>.contains[<i>]` for what it contains. */
function declarationOf(node: ClosureModule, input: ComponentInput): string | undefined {
  for (const source of node.sources) {
    if (source.purl === input.purl && source.version === input.version) return `sources.${source.name}`;
    const index = source.contains.findIndex((item) => item.purl === input.purl && item.version === input.version);
    if (index !== -1) return `sources.${source.name}.contains[${index}]`;
  }
  return undefined;
}

function uncheckedMessage(
  node: ClosureModule,
  component: CycloneDxComponent,
  input: ComponentInput,
  entry: string,
  document: string,
  sentVcs: boolean,
): string {
  const joiner = node.local || node.chain.length <= 1 ? " " : ", which ";
  const purl = componentRef(input.purl, input.version);
  const identity = [purl, ...(component.cpe ? [component.cpe] : [])].join(", ");
  const scanner = `Check it with a scanner that matches by CPE: telo sbom ${entry} > ${document} && grype sbom:${document}`;
  if (input.vcs && !sentVcs) {
    return (
      `${namedAlong(node)}${joiner}ships ${componentLabel(component)} (${identity}), built from ${input.vcs.url} at ` +
      `${input.vcs.revision.slice(0, 12)}; its revision is not proven in that repository's history, so it was looked up ` +
      `by its package URL alone, which no advisory database matches by version. ${scanner}`
    );
  }
  if (input.vcs) {
    return (
      `${namedAlong(node)}${joiner}ships ${componentLabel(component)} (${identity}), built from ${input.vcs.url} at ` +
      `${input.vcs.revision.slice(0, 12)}; OSV records no advisory against that repository, so an empty answer for this ` +
      `revision is no verdict. ${scanner}`
    );
  }
  const declaration = node.local ? declarationOf(node, input) : undefined;
  const declare = declaration
    ? ` Declare \`vcs:\` on ${declaration} — the repository and commit it is built from — so it can be checked by revision.`
    : "";
  return (
    `${namedAlong(node)}${joiner}ships ${componentLabel(component)} (${identity}), which no advisory database matches by version.${declare} ` +
    scanner
  );
}

export async function judgeComponents(args: {
  readonly modules: readonly ClosureModule[];
  readonly answers: ReadonlyMap<string, ComponentAnswer>;
  readonly ignore: readonly IgnoreEntry[];
  readonly markerFile: string;
  readonly today: string;
  readonly manifest: string;
  readonly hints: HintContext;
}): Promise<Findings> {
  const { modules, answers, ignore, markerFile, today, manifest, hints } = args;
  const document = `${modules[0]!.subject.name.toLowerCase()}.cdx.json`;
  const findings: Finding[] = [];
  const ignored: IgnoredAdvisory[] = [];

  for (const node of modules) {
    if (node.unrecorded) continue;
    for (const component of node.components) {
      const input = componentLookupInput(component);
      if (!input) continue;
      const answer = answers.get(lookupKey(input));
      if (!answer) continue;
      if (!answer.checked) {
        findings.push({
          anchor: node.anchor,
          diagnostic: {
            severity: DiagnosticSeverity.Warning,
            code: COMPONENT_UNCHECKED,
            source: "telo-audit",
            message: uncheckedMessage(node, component, input, manifest, document, answer.vcs !== undefined),
            data: node.anchor.data,
          },
        });
        continue;
      }
      for (const advisory of answer.advisories) {
        const accepted = matching(advisory, ignore, today);
        if (accepted?.live) {
          ignored.push({
            id: advisory.id,
            reason: accepted.entry.reason,
            expires: accepted.entry.expires,
            component: advisory.component,
            chain: chainOf(node),
            aliases: advisory.aliases,
            module: node.chain[0]?.alias ?? node.subject.name,
            componentLabel: componentLabel(component),
          });
          continue;
        }
        const hint = await upgradeHint(node, component, advisory, hints);
        const expired = accepted
          ? ` The audit.ignore entry accepting it (${markerFile}:${accepted.entry.place.line}:${accepted.entry.place.column}) expired on ${accepted.entry.expires}.`
          : "";
        findings.push({
          anchor: node.anchor,
          diagnostic: {
            severity: DiagnosticSeverity.Error,
            code: COMPONENT_VULNERABLE,
            source: "telo-audit",
            message: `${vulnerableMessage(node, component, input, advisory)} ${hint.text}${expired}`,
            data: node.anchor.data,
          },
          extra: { advisory, chain: chainOf(node), upgrade: hint.upgrade },
        });
      }
    }
  }
  return { findings, ignored };
}

/** `ignored GHSA-… (CVE-…) in Http, @fastify/static 10.1.0, until 2026-12-31: <reason>` */
export function ignoredLine(item: IgnoredAdvisory): string {
  const aliases = item.aliases.length > 0 ? ` (${item.aliases.join(", ")})` : "";
  return `ignored ${item.id}${aliases} in ${item.module}, ${item.componentLabel}, until ${item.expires}: ${item.reason}`;
}
