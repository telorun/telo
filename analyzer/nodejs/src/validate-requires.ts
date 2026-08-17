/**
 * The strict half of `requires-block.ts` — the accessor/validator split
 * `zone-slot.ts` / `validate-zone-slots.ts` established, and for the same reason:
 * the reader must not throw on a malformed block (every consumer would have to
 * guard), while a malformed block must not pass silently either.
 *
 * Two distinct outputs, and conflating them was the whole failure this mechanism
 * addresses:
 *
 *  - **`MODULE_REQUIRES_NEWER_RUNTIME`** — the module is fine and *this runtime*
 *    is too old. Raised per module before that module's own validation, so the
 *    version message wins over the vocabulary errors it would otherwise be buried
 *    in (`ZONE_ANNOTATION_INVALID`, an `additionalProperties` violation against a
 *    kernel-owned schema, an unknown `use` token). Those errors are true but
 *    blame the module author for a version skew.
 *  - **`REQUIRES_INVALID`** — the declaration itself is malformed. Severity turns
 *    on ownership rather than presence: an ERROR on the entry's own modules,
 *    whose author can fix it, and a WARNING on a dependency, whose author is the
 *    only one who can. It is not silent on a dependency, because `readRequires`
 *    drops an unparseable range and the gate then reads the module as satisfied —
 *    so it loads while stating a requirement it failed to state, and `telo
 *    upgrade` (which refuses such a version) would be holding it back for a
 *    reason the load path never mentions.
 *
 * **Unknown axes are suppressed while the `telo` requirement is unmet.** An older
 * runtime not recognising a newer host axis is a *consequence* of the version
 * skew — the axis exists, this runtime is simply too old to know it — so
 * reporting it beside the gate diagnostic would manufacture a second defect from
 * one cause. Once `telo` is satisfied, an unrecognized axis is a real error: a
 * runtime at or above the declared generation is expected to know every axis that
 * generation defines.
 */

import type { ResourceManifest } from "@telorun/sdk";

import { evaluateRequires, readRequires, type HostVersions } from "./requires-block.js";
import { TELO_SURFACE_VERSION } from "./telo-version.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

export interface ValidateRequiresOptions {
  /** The surface generation the analyzing runtime implements. Defaults to this
   *  build's own — see `AnalysisOptions.teloVersion`. */
  teloVersion?: string;
  /** Versions the running host can speak for. Absent in a browser, where there
   *  is no host to report; supplied by the kernel and CLI. */
  hostVersions?: HostVersions;
  /** Module names owned by the entry, when the caller can distinguish them.
   *  `REQUIRES_INVALID` is limited to these; the gate is not, because a
   *  dependency this runtime cannot read still stops the consumer dead. */
  entryModules?: ReadonlySet<string>;
}

export function validateRequires(
  manifests: ResourceManifest[],
  options: ValidateRequiresOptions = {},
): AnalysisDiagnostic[] {
  const running = options.teloVersion ?? TELO_SURFACE_VERSION;
  const out: AnalysisDiagnostic[] = [];

  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") continue;

    const doc = manifest as unknown as Record<string, unknown>;
    const { declared, block, issues } = readRequires(doc);
    if (!declared) continue;

    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : undefined;
    const filePath = typeof metadata.source === "string" ? metadata.source : undefined;
    const label = `${manifest.kind}/${name ?? "(unnamed)"}`;
    const resource = { kind: manifest.kind, name };

    const verdict = evaluateRequires(block, running, options.hostVersions);

    if (!verdict.satisfied) {
      const axis = verdict.axis === "telo" ? "telo" : `host.${verdict.axis}`;
      const remedy =
        verdict.axis === "telo"
          ? `Upgrade telo, or pin ${name ?? "this module"} to a version whose range accepts ` +
            `${verdict.running}.`
          : `Upgrade ${verdict.axis}, or pin ${name ?? "this module"} to a version whose range ` +
            `accepts ${verdict.running}.`;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "MODULE_REQUIRES_NEWER_RUNTIME",
        source: SOURCE,
        message:
          `${label} requires ${axis} '${verdict.declared.raw}'; this runtime reports ` +
          `${verdict.running}. ${remedy}`,
        data: { resource, filePath, path: `requires.${axis}` },
      });
    }

    const owned =
      options.entryModules === undefined ||
      (typeof metadata.module === "string"
        ? options.entryModules.has(metadata.module)
        : name === undefined || options.entryModules.has(name));

    for (const issue of issues) {
      // See the header: an unknown axis is a symptom while the gate is failing.
      if (issue.unknownAxis && !verdict.satisfied) continue;

      // A DEPENDENCY's malformed block is not the consumer's to fix, but it must
      // not be silent either. `readRequires` drops an unparseable range from the
      // block, so the gate reads it as satisfied and the module loads while
      // stating a requirement it failed to state — and `telo upgrade`, which
      // refuses to select such a version, would then be holding a version back
      // for a reason nothing on the load path ever mentions. A warning is what
      // makes those two halves agree about the manifest without handing the
      // consumer an error only its publisher can fix.
      out.push({
        severity: owned ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        code: "REQUIRES_INVALID",
        source: SOURCE,
        message: owned
          ? `${label}: ${issue.message}` + (issue.hint ? ` Write '${issue.hint}' instead.` : "")
          : `${label}: ${issue.message} Its declared requirement cannot be read, so it is not ` +
            `enforced here and \`telo upgrade\` will not select this version. Only the module's ` +
            `publisher can fix it.`,
        data: { resource, filePath, path: issue.path },
      });
    }
  }

  return out;
}
