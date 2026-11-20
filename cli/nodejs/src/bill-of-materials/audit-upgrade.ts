/**
 * The upgrade hint of a `COMPONENT_VULNERABLE`: what `telo upgrade` would do to
 * the DIRECT import reaching the carrying module, and whether that removes the
 * advisory. The candidate is the version `telo upgrade` selects (its
 * newest-first walk and prerelease rule); its closure is read from the registry
 * — `sbom` layers only — and checked in a batch of its own. A hint never
 * changes the exit status.
 */

import type { CycloneDxComponent } from "@telorun/analyzer";
import { defaultTransportRegistry } from "@telorun/kernel";
import { lookupAdvisories, type Advisory, type ComponentAnswer, type LookupOptions } from "@telorun/osv";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import semver from "semver";
import { chooseVersion, upgradeRuntime } from "../commands/upgrade.js";
import type { Logger } from "../logger.js";
import { componentLookupInput, lookupKey } from "./audit-components.js";
import { buildApplicationClosure, type ApplicationClosure, type ClosureModule, type ImportLink } from "./module-closure.js";
import type { OccurrenceScope } from "./platform-scope.js";

export interface UpgradeFact {
  readonly alias: string;
  readonly version: string;
  readonly resolves: boolean | null;
}

export interface UpgradeHint {
  readonly upgrade: UpgradeFact | null;
  readonly text: string;
}

const ACCEPT = "or accept the advisory in telo-workspace.yaml";

/** What a direct import's candidate version turned out to be. */
type Candidate =
  | { readonly kind: "none"; readonly current: string }
  | { readonly kind: "unknown"; readonly version: string; readonly reason: string }
  | {
      readonly kind: "closure";
      readonly version: string;
      readonly closure: ApplicationClosure;
      readonly answers: ReadonlyMap<string, ComponentAnswer>;
    };

export interface HintContext {
  readonly scope: OccurrenceScope;
  readonly lookup: LookupOptions;
  readonly log: Logger;
  /** One candidate per direct import, however many advisories it carries. */
  readonly candidates: Map<string, Promise<Candidate>>;
}

export function newHintContext(scope: OccurrenceScope, lookup: LookupOptions, log: Logger): HintContext {
  return { scope, lookup, log, candidates: new Map() };
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readCandidate(link: ImportLink, context: HintContext): Promise<Candidate> {
  const transport = defaultTransportRegistry().forRef(link.source);
  const rawVersion = transport?.refVersion(link.source) ?? null;
  const current = rawVersion !== null ? semver.valid(rawVersion) : null;
  if (!transport || rawVersion === null || current === null) {
    return {
      kind: "unknown",
      version: rawVersion ?? link.source,
      reason: `${link.alias} (${link.source}) is not pinned to a published version, so there is nothing to upgrade along.`,
    };
  }
  let published: string[] | null;
  try {
    published = await transport.listVersions(link.source);
  } catch (err) {
    return { kind: "unknown", version: current, reason: `the registry did not answer: ${reasonOf(err)}` };
  }
  const versions = (published ?? []).map((v) => semver.valid(v)).filter((v): v is string => v !== null);
  if (versions.length === 0) {
    return { kind: "unknown", version: current, reason: `the registry lists no versions of ${link.source}.` };
  }
  const choice = await chooseVersion({
    transport,
    source: link.source,
    published: versions,
    currentVersion: current,
    includePrerelease: false,
    runtime: upgradeRuntime(),
  });
  if (choice.kind === "current-is-newest") return { kind: "none", current };
  const { best, pinVerdict } = choice.walk;
  if (pinVerdict || best === null || (choice.currentPublished && semver.lte(best, current))) {
    return { kind: "none", current };
  }

  let pinned: string;
  try {
    const base = transport.withVersion(link.source, best);
    pinned = `${base}#${await transport.manifestHash(base)}`;
  } catch (err) {
    return { kind: "unknown", version: best, reason: `the registry did not answer for ${best}: ${reasonOf(err)}` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-audit-hint-"));
  try {
    const manifest = path.join(dir, "telo.yaml");
    fs.writeFileSync(
      manifest,
      `kind: Telo.Application\nmetadata:\n  name: UpgradeHint\nimports:\n  ${link.alias}: ${pinned}\n`,
    );
    const outcome = await buildApplicationClosure({ manifest, scope: context.scope, log: context.log, check: false });
    if (!outcome.ok) {
      const first = outcome.refusals.flatMap((r) => r.diagnostics)[0];
      return {
        kind: "unknown",
        version: best,
        reason: `its closure could not be read: ${first?.message ?? "the import was refused"}`,
      };
    }
    const unrecorded = outcome.closure.modules.find((node) => node.unrecorded);
    if (unrecorded) {
      return {
        kind: "unknown",
        version: best,
        reason: `${unrecorded.subject.name} (${unrecorded.ref}) in ${link.alias} ${best} has no complete software bill of materials.`,
      };
    }
    const inputs = outcome.closure.modules.flatMap((node) => node.components.flatMap((c) => componentLookupInput(c) ?? []));
    const answers = await lookupAdvisories(inputs, context.lookup);
    return {
      kind: "closure",
      version: best,
      closure: outcome.closure,
      answers: new Map(answers.map((answer) => [lookupKey(answer), answer])),
    };
  } catch (err) {
    return { kind: "unknown", version: best, reason: `its advisories could not be checked: ${reasonOf(err)}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The candidate-closure module still carrying `advisory` for `component`'s package. */
function stillCarrying(
  candidate: Extract<Candidate, { kind: "closure" }>,
  component: CycloneDxComponent,
  advisory: Advisory,
): { node: ClosureModule; component: CycloneDxComponent } | undefined {
  const wanted = componentLookupInput(component)?.purl;
  for (const node of candidate.closure.modules.slice(1)) {
    for (const c of node.components) {
      const input = componentLookupInput(c);
      if (!input || input.purl !== wanted) continue;
      const answer = candidate.answers.get(lookupKey(input));
      if (answer?.advisories.some((a) => a.id === advisory.id)) return { node, component: c };
    }
  }
  return undefined;
}

/** A local module's component is raised where the module declares it. */
export function localHint(node: ClosureModule, component: CycloneDxComponent): UpgradeHint {
  const layers = (component.properties ?? []).filter((p) => p.name === "telo:layer").map((p) => p.value);
  const staged = layers.some((value) => /^role=(native|assets)(;|$)/.test(value));
  const revision = componentLookupInput(component)?.vcs ? ", with its vcs.revision the commit that release is built from" : "";
  const text = staged
    ? `Raise sources.<name>.version of the sources: entry staging ${component.name} in ${node.subject.name}'s telo.yaml to a fixed release${revision}.`
    : `Raise the dependency ${component.name} in ${node.subject.name}'s package.json to a fixed version.`;
  return { upgrade: null, text };
}

export async function upgradeHint(
  node: ClosureModule,
  component: CycloneDxComponent,
  advisory: Advisory,
  context: HintContext,
): Promise<UpgradeHint> {
  if (node.local) return localHint(node, component);
  const direct = node.chain[0]!;
  const key = `${direct.alias}|${direct.source}`;
  let pending = context.candidates.get(key);
  if (!pending) {
    pending = readCandidate(direct, context);
    context.candidates.set(key, pending);
  }
  const candidate = await pending;
  const moves = `\`telo upgrade\` moves ${direct.alias}`;
  switch (candidate.kind) {
    case "none":
      return {
        upgrade: { alias: direct.alias, version: candidate.current, resolves: false },
        text:
          `${direct.alias} ${candidate.current} is the newest version \`telo upgrade\` would select, and it carries it: ` +
          `ask ${direct.alias}'s publisher for a fixed version, ${ACCEPT}.`,
      };
    case "unknown":
      return {
        upgrade: { alias: direct.alias, version: candidate.version, resolves: null },
        text: `Whether \`telo upgrade\` would remove it cannot be told: ${candidate.reason}`,
      };
    case "closure": {
      const carrier = stillCarrying(candidate, component, advisory);
      if (!carrier) {
        return {
          upgrade: { alias: direct.alias, version: candidate.version, resolves: true },
          text: `${moves} to ${candidate.version}, which no longer carries it.`,
        };
      }
      const isDirect = carrier.node === candidate.closure.modules[1];
      const named = carrier.node.subject.name;
      return {
        upgrade: { alias: direct.alias, version: candidate.version, resolves: false },
        text: isDirect
          ? `${moves} to ${candidate.version}, which still ships ${carrier.component.name} ${carrier.component.version ?? ""}: ` +
            `ask ${direct.alias}'s publisher for a version over a fixed one, ${ACCEPT}.`
          : `${moves} to ${candidate.version}, which still pins ${named} ${carrier.node.subject.version ?? ""}: ` +
            `ask ${direct.alias}'s publisher for a version over a fixed ${named}, ${ACCEPT}.`,
      };
    }
  }
}
