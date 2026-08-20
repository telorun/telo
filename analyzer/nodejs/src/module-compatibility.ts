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
 */

import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { isModuleKind } from "./module-kinds.js";
import { evaluateRequires, readRequires, type HostVersions } from "./requires-block.js";

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
 */
export type ModuleCompatibility = "yes" | "too-new" | "unreadable" | "unknown";

/**
 * Read a module manifest's declared `requires:` and decide whether the runtime
 * described by `teloVersion` / `host` can host it.
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
  let doc: Record<string, unknown> | undefined;
  try {
    for (const parsed of parseAllDocuments(manifestText, { customTags: defaultCustomTags() })) {
      const value = parsed.toJS() as Record<string, unknown> | null;
      const kind = value?.kind;
      if (typeof kind === "string" && isModuleKind(kind)) {
        doc = value as Record<string, unknown>;
        break;
      }
    }
  } catch {
    return "unknown";
  }
  if (!doc) return "unknown";

  const { block, issues } = readRequires(doc);
  // A malformed declaration is not a licence to install: the module claims a
  // requirement it failed to state, and guessing which way it pointed is how a
  // consumer ends up on a version that cannot load. The load gate warns about
  // this same manifest, so the two halves agree.
  if (issues.some((i) => !i.unknownAxis)) return "unreadable";
  return evaluateRequires(block, teloVersion, host).satisfied ? "yes" : "too-new";
}
