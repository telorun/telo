/**
 * Can this runtime host that module version? One question, one answer, one
 * implementation — the CLI's `upgrade` and every IDE's upgrade affordance all
 * ask it of a candidate version's `telo.yaml` text.
 *
 * It lives beside {@link readRequires} because the `requires:` grammar has
 * exactly one reader by rule, and the moment a second host learned to filter
 * candidates by compatibility that rule needed a shared verdict, not a second
 * parser. Browser-safe: text in, verdict out, no transport and no filesystem —
 * fetching the candidate manifest is the caller's job, since only the caller
 * knows which transport (or cache) addresses it.
 *
 * **A selection verdict is not a function of the candidate alone**: a newer
 * version's `restrictions:` entry may speak for it (`runtime-range.ts`), so
 * {@link selectionCompatibility} takes the manifests of the published versions
 * newer than the candidate too.
 */

import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { isModuleKind } from "./module-kinds.js";
import type { HostVersions } from "./requires-block.js";
import {
  evaluateRange,
  readModuleRequirements,
  selectionRange,
  type ModuleRequirements,
  type RequirementKey,
  type RequirementSource,
} from "./runtime-range.js";

/**
 * How a candidate version answered the compatibility question.
 *
 * `unknown` — the manifest could not be read or names no module document — is
 * never treated as incompatible, since an unreachable registry must not
 * silently freeze a consumer's imports.
 *
 * The two rejecting answers are kept APART because they call for different
 * actions and the user is told which one applies: `too-new` is fixed by
 * upgrading telo, `unreadable` cannot be fixed by the consumer at all.
 * Collapsing them into one "no" and then printing "requires a newer telo" would
 * assert a cause the check never established, and point at a runtime upgrade
 * that will not help.
 *
 * A candidate restricted to an OLDER runtime also answers `too-new` here, which
 * holds it back as before; {@link selectionCompatibility} tells the two apart.
 */
export type ModuleCompatibility = "yes" | "too-new" | "unreadable" | "unknown";

/** One published version's manifest, as a selection reads it. */
export interface ModuleVersionManifest {
  /** The version the manifest was published as. */
  version: string;
  text: string;
}

/** A published version read for selection: its requirements, or `unknown`
 *  when its manifest could not be read or names no module document. */
export interface ModuleVersionRequirements {
  version: string;
  requirements: ModuleRequirements | "unknown";
}

/** How a candidate answered selection, with what held it back. */
export type SelectionVerdict =
  | { compatibility: "yes" | "unreadable" | "unknown" }
  | {
      /** `too-new`: the runtime is below a floor; `too-old`: above a ceiling. */
      compatibility: "too-new" | "too-old";
      key: RequirementKey;
      /** The bound the runtime failed, as written (`<0.122.0`, `>=unreleased`). */
      bound: string;
      running: string;
      /** The version's own `requires:`, or the entry — and the version declaring
       *  it, which may be newer than the candidate — with its reason. */
      source: RequirementSource;
    };

/** Read one manifest text for selection. Parse it once per version when several
 *  candidates are judged against the same newer versions. */
export function readModuleVersion(manifest: ModuleVersionManifest): ModuleVersionRequirements {
  const doc = moduleDoc(manifest.text);
  return {
    version: manifest.version,
    requirements: doc ? readModuleRequirements(doc, manifest.version) : "unknown",
  };
}

/**
 * Decide whether the runtime described by `teloVersion` / `host` can be offered
 * `candidate`, given the published versions `newer` than it (any others in the
 * list are ignored). A newer version that could not be read speaks for nothing.
 *
 * `teloVersion` carries `+unreleased` for a build of the pending release, which
 * is what meets `>=unreleased`. A host that reports no version for an axis skips
 * it, which is exactly the editor case.
 */
export function selectionCompatibility(
  candidate: ModuleVersionManifest | ModuleVersionRequirements,
  newer: readonly (ModuleVersionManifest | ModuleVersionRequirements)[],
  teloVersion: string | undefined,
  host: HostVersions = {},
): SelectionVerdict {
  const own = asRequirements(candidate).requirements;
  if (own === "unknown") return { compatibility: "unknown" };
  // A malformed declaration is not a licence to install: the module claims a
  // requirement it failed to state, and guessing which way it pointed is how a
  // consumer ends up on a version that cannot load. The load gate warns about
  // this same manifest, so the two halves agree. A published ceiling on
  // `requires.telo` is read, and honoured.
  const malformed = [...own.requires.issues, ...own.restrictions.issues].some(
    (i) => !i.unknownAxis && !i.ceiling,
  );
  if (malformed) return { compatibility: "unreadable" };
  const speaking = newer
    .map((m) => asRequirements(m).requirements)
    .filter((r): r is ModuleRequirements => r !== "unknown");
  const verdict = evaluateRange(selectionRange(own, speaking), teloVersion, host);
  if (verdict.satisfied) return { compatibility: "yes" };
  return {
    compatibility: verdict.direction === "newer" ? "too-new" : "too-old",
    key: verdict.key,
    bound: verdict.bound,
    running: verdict.running,
    source: verdict.source,
  };
}

/**
 * Read a module manifest's declared `requires:` and own `restrictions:` and
 * decide whether the runtime described by `teloVersion` / `host` can host it —
 * {@link selectionCompatibility} with no newer version to speak for it.
 *
 * A module that declares nothing is compatible — the bootstrap rule, permanent
 * for everything published before the mechanism existed. A host that reports no
 * version for an axis skips it rather than guessing, which is exactly the
 * editor case: an IDE is not the machine that will run the manifest, so it
 * speaks for the telo surface and for nothing else.
 */
export function manifestCompatibility(
  manifestText: string,
  teloVersion: string | undefined,
  host: HostVersions = {},
): ModuleCompatibility {
  const doc = moduleDoc(manifestText);
  if (!doc) return "unknown";
  const verdict = selectionCompatibility(
    { version: "", requirements: readModuleRequirements(doc) },
    [],
    teloVersion,
    host,
  );
  return verdict.compatibility === "too-old" ? "too-new" : verdict.compatibility;
}

function asRequirements(
  manifest: ModuleVersionManifest | ModuleVersionRequirements,
): ModuleVersionRequirements {
  return "requirements" in manifest ? manifest : readModuleVersion(manifest);
}

function moduleDoc(text: string): Record<string, unknown> | undefined {
  try {
    for (const parsed of parseAllDocuments(text, { customTags: defaultCustomTags() })) {
      const value = parsed.toJS() as Record<string, unknown> | null;
      const kind = value?.kind;
      if (typeof kind === "string" && isModuleKind(kind)) return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
