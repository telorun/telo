/**
 * The strict half of `requires-block.ts` and `restrictions.ts` — the
 * accessor/validator split `zone-slot.ts` / `validate-zone-slots.ts`
 * established, and for the same reason: a reader must not throw on a malformed
 * block (every consumer would have to guard), while a malformed block must not
 * pass silently either.
 *
 * The gate judges the module's LOAD range (`runtime-range.ts`: its own
 * `requires` narrowed by its own entries covering it) against this runtime, and
 * says which way the runtime is off, because the two call for opposite actions:
 *
 *  - **`MODULE_REQUIRES_NEWER_RUNTIME`** — the runtime is below a floor: the
 *    module is fine and *this runtime* is too old. Raised per module before that
 *    module's own validation, so the version message wins over the vocabulary
 *    errors it would otherwise be buried in (`ZONE_ANNOTATION_INVALID`, an
 *    `additionalProperties` violation against a kernel-owned schema, an unknown
 *    `use` token). Those errors are true but blame the module author for a
 *    version skew.
 *  - **`MODULE_REQUIRES_OLDER_RUNTIME`** — the runtime is above a ceiling: a
 *    `restrictions:` entry, or a published manifest's upper bound. It advises an
 *    older runtime or another version of the module.
 *
 * Both carry an entry's reason when an entry is what refused.
 *
 *  - **`REQUIRES_INVALID`** / **`RESTRICTIONS_INVALID`** — the declaration itself
 *    is malformed, or (for an entry) leaves the declaring version usable by no
 *    runtime. Severity turns on ownership rather than presence: an ERROR on the
 *    entry's own modules, whose author can fix it, and a WARNING on a
 *    dependency, whose author is the only one who can. It is not silent on a
 *    dependency, because a malformed range or entry is dropped and the gate then
 *    reads the module as satisfied — so it loads while stating a requirement it
 *    failed to state, and `telo upgrade` (which refuses such a version) would be
 *    holding it back for a reason the load path never mentions. An upper bound
 *    on `requires.telo` is `REQUIRES_INVALID` only in the entry's own source; a
 *    dependency's is honoured.
 *
 * **Unknown axes are suppressed while the gate is failing.** An older runtime
 * not recognising a newer host axis is a *consequence* of the version skew — the
 * axis exists, this runtime is simply too old to know it — so reporting it
 * beside the gate diagnostic would manufacture a second defect from one cause.
 * Once the gate passes, an unrecognized axis is a real error: a runtime at or
 * above the declared generation is expected to know every axis that generation
 * defines.
 */

import type { ResourceManifest } from "@telorun/sdk";

import type { HostVersions, RequiresIssue } from "./requires-block.js";
import { restrictionCovers } from "./restrictions.js";
import {
  REQUIREMENT_KEYS,
  evaluateRange,
  floorOf,
  loadRange,
  rangeOf,
  rangesOverlap,
  readModuleRequirements,
  type ModuleRequirements,
  type RangeVerdict,
  type RequirementKey,
} from "./runtime-range.js";
import { TELO_RUNNING_SURFACE } from "./telo-version.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import type { VersionRange } from "./version-range.js";

const SOURCE = "telo-analyzer";

export interface ValidateRequiresOptions {
  /** Versions the running host can speak for. Absent in a browser, where there
   *  is no host to report; supplied by the kernel and CLI. */
  hostVersions?: HostVersions;
  /** Module names owned by the entry, when the caller can distinguish them.
   *  `REQUIRES_INVALID` / `RESTRICTIONS_INVALID` are errors only on these; the
   *  gate is not limited, because a dependency this runtime cannot read still
   *  stops the consumer dead. */
  entryModules?: ReadonlySet<string>;
}

/** The codes of the gate: a module this runtime is outside the range of. Each
 *  suppresses every other diagnostic from that module's files. */
export const RUNTIME_GATE_CODES: ReadonlySet<string> = new Set([
  "MODULE_REQUIRES_NEWER_RUNTIME",
  "MODULE_REQUIRES_OLDER_RUNTIME",
]);

export function validateRequires(
  manifests: ResourceManifest[],
  options: ValidateRequiresOptions = {},
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") continue;

    const doc = manifest as unknown as Record<string, unknown>;
    const module = readModuleRequirements(doc);
    if (!module.requires.declared && !module.restrictions.declared) continue;

    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : undefined;
    const filePath = typeof metadata.source === "string" ? metadata.source : undefined;
    const label = `${manifest.kind}/${name ?? "(unnamed)"}`;
    const resource = { kind: manifest.kind, name };
    const at = (path: string) => ({ resource, filePath, path });

    const owned =
      options.entryModules === undefined ||
      (typeof metadata.module === "string"
        ? options.entryModules.has(metadata.module)
        : name === undefined || options.entryModules.has(name));

    // A ceiling on the module's own `requires.telo` is refused in source and
    // honoured in a published manifest, as a restriction of that version.
    const ownCeiling = !(owned && module.requires.issues.some((i) => i.ceiling));
    const unusable = owned ? unusableEntries(module, ownCeiling) : [];
    const enforced: ModuleRequirements = {
      ...module,
      restrictions: {
        ...module.restrictions,
        entries: module.restrictions.entries.filter((e) => !unusable.some((u) => u.index === e.index)),
      },
    };

    const verdict = evaluateRange(loadRange(enforced, { ownCeiling }), TELO_RUNNING_SURFACE, options.hostVersions);
    if (!verdict.satisfied) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: verdict.direction === "newer" ? "MODULE_REQUIRES_NEWER_RUNTIME" : "MODULE_REQUIRES_OLDER_RUNTIME",
        source: SOURCE,
        message: gateMessage(verdict, name, filePath),
        data: at(sourcePath(verdict)),
      });
    }

    const report = (code: string, issue: RequiresIssue, unenforced: string) => {
      // See the header: an unknown axis is a symptom while the gate is failing.
      if (issue.unknownAxis && !verdict.satisfied) return;
      out.push({
        severity: owned ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        code,
        source: SOURCE,
        message: owned
          ? issue.message + (issue.hint ? ` Write '${issue.hint}' instead.` : "")
          : `${label}: ${issue.message} ${unenforced} Only the module's publisher can fix it.`,
        data: at(issue.path),
      });
    };

    for (const issue of module.requires.issues) {
      // A DEPENDENCY's malformed block is not the consumer's to fix, but it must
      // not be silent either. `readRequires` drops an unparseable range from the
      // block, so the gate reads it as satisfied and the module loads while
      // stating a requirement it failed to state — and `telo upgrade`, which
      // refuses to select such a version, would then be holding a version back
      // for a reason nothing on the load path ever mentions. A warning is what
      // makes those two halves agree about the manifest without handing the
      // consumer an error only its publisher can fix.
      if (issue.ceiling && !owned) continue;
      report(
        "REQUIRES_INVALID",
        issue,
        "Its declared requirement cannot be read, so it is not enforced here and `telo upgrade` " +
          "will not select this version.",
      );
    }
    const entryIssues = [...module.restrictions.issues, ...unusable.map((u) => u.issue)];
    for (const issue of entryIssues.sort((a, b) => entryOrder(a.path) - entryOrder(b.path))) {
      report(
        "RESTRICTIONS_INVALID",
        issue,
        "The entry cannot be read, so it is not enforced here and `telo upgrade` will not select " +
          "this version.",
      );
    }
  }

  return out;
}

/**
 * The entries covering the declaring version that leave it usable by no
 * runtime, each judged against the module's own `requires` and the covering
 * entries before it. A refused entry is not enforced: the module is reported
 * as malformed rather than gated on every runtime.
 */
function unusableEntries(
  module: ModuleRequirements,
  ownCeiling: boolean,
): Array<{ index: number; issue: RequiresIssue }> {
  const applying = new Map<RequirementKey, Array<{ label: string; range: VersionRange }>>();
  for (const key of REQUIREMENT_KEYS) {
    let own = rangeOf(module.requires.block, key);
    if (own && key === "telo" && !ownCeiling) own = floorOf(own);
    applying.set(key, own ? [{ label: `${keyPath("requires", key)} `, range: own }] : []);
  }

  const out: Array<{ index: number; issue: RequiresIssue }> = [];
  for (const entry of module.restrictions.entries) {
    if (!restrictionCovers(entry, module.version, module.version)) continue;
    const path = `restrictions[${entry.index}]`;
    const conflict = REQUIREMENT_KEYS.find((key) => {
      const range = rangeOf(entry.requires, key);
      return range !== undefined && !rangesOverlap([...applying.get(key)!.map((a) => a.range), range]);
    });
    if (conflict) {
      const range = rangeOf(entry.requires, conflict)!;
      const parts = [...applying.get(conflict)!, { label: "", range }].map((p) => `${p.label}'${p.range.raw}'`);
      out.push({
        index: entry.index,
        issue: {
          path,
          message:
            `${path} leaves ${module.version ?? "this version"} usable by no ` +
            `${runtimeName(conflict)}: ${joinAnd(parts)} do not overlap. Deprecate the module instead.`,
        },
      });
      continue;
    }
    for (const key of REQUIREMENT_KEYS) {
      const range = rangeOf(entry.requires, key);
      if (range) applying.get(key)!.push({ label: `${path} `, range });
    }
  }
  return out;
}

function gateMessage(
  verdict: Extract<RangeVerdict, { satisfied: false }>,
  name: string | undefined,
  source: string | undefined,
): string {
  const reason =
    verdict.source.from === "restriction" ? `Reason: ${sentence(verdict.source.reason)} ` : "";
  const axis = verdict.key === "telo" ? "telo" : `host.${verdict.key}`;
  if (verdict.direction === "newer") {
    return (
      `${name ?? "This module"} requires ${axis} '${verdict.bound}'; this runtime reports ` +
      `${verdict.running}. ${reason}Upgrade ${runtimeName(verdict.key)}.`
    );
  }
  const limit = verdict.comparator!;
  return (
    `${source ?? name ?? "This module"} is restricted to ${axis} '${verdict.bound}'; this runtime ` +
    `reports ${verdict.running}. ${reason}Use ${runtimeName(verdict.key)} ` +
    `${limit.operator === "<=" ? "at or below" : "below"} ${limit.raw}, or another version of ` +
    `${name ?? "this module"}.`
  );
}

function sourcePath(verdict: Extract<RangeVerdict, { satisfied: false }>): string {
  return verdict.source.from === "restriction"
    ? keyPath(`restrictions[${verdict.source.index}].requires`, verdict.key)
    : keyPath("requires", verdict.key);
}

/** The list position an issue's path names, so entries report in list order. */
function entryOrder(path: string): number {
  const match = /^restrictions\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : -1;
}

function keyPath(prefix: string, key: RequirementKey): string {
  return key === "telo" ? `${prefix}.telo` : `${prefix}.host.${key}`;
}

function runtimeName(key: RequirementKey): string {
  return key === "telo" ? "telo" : "Node.js";
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
