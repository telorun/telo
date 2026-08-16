/**
 * A module's **exported code** — the `exports.code:` block on a `Telo.Library`
 * doc, which names the entry point a *sibling module's* controller bundle
 * resolves this module's bare specifier to.
 *
 * ```yaml
 * exports:
 *   kinds:
 *     - Store
 *   code:
 *     - specifier: "@telorun/kv-store"
 *       format: js
 *       path: ./nodejs/kv-store.mjs
 *       source: ./nodejs/src/index.ts
 * ```
 *
 * ## Why it sits under `exports:`
 *
 * A library already declares what crosses its boundary — the kinds importers may
 * name, the resource instances they may `!ref`. This is the same statement about
 * its *code*, and it gates the same way: a specifier nobody declares resolves to
 * nothing. Putting it beside them keeps one block for "reachable from outside"
 * rather than a second top-level key whose name (`library:` on a `Telo.Library`)
 * meant a different thing from the kind one line above it.
 *
 * ## Why it is not a package URL
 *
 * `controllers:` names a PURL because it must be able to say `pkg:npm/…` or
 * `pkg:cargo/…` — an ecosystem fetch. This entry never fetches: it names a file
 * the module already ships, so `pkg:telo/local/` would be three constant segments
 * before the first real datum. What is left after removing them is exactly these
 * fields, and as data they are visually editable, where a query string is one
 * opaque text box.
 *
 * The **model** is unchanged: `format` plus the optional platform axes build the
 * same `ArtifactSelector` a controller candidate does, so layer matching, platform
 * fallthrough and lazy materialization are inherited whole.
 *
 * ## Why the specifier is declared here
 *
 * A bundle imports the bare specifier `@telorun/sql`; the consumer's manifest
 * declares the dependency as `Sql: ../sql`. Something has to connect the two, and
 * it is the *library* that says so, once, rather than each of its consumers:
 *
 * - the specifier is a property of the library — its name in a host language's
 *   ecosystem — not of the relationship, so N consumers cannot disagree about it
 *   and adding a consumer restates nothing;
 * - it sits beside the format, which keeps runtime **derived, never declared**:
 *   the entry says `format: js`, and a Rust entry carries `specifier:
 *   telorun-sql` with no runtime-keyed map anywhere.
 *
 * **One specifier, one entry point.** Subpaths are deliberately not
 * representable: reproducing npm's `exports` map inside the artifact would pull a
 * package manager's resolution semantics into Telo, which is what the "only
 * workspace modules are de-inlined" rule refuses on `kysely`'s behalf.
 *
 * `Telo.Application` has no `exports:` block at all — an application is a root
 * with no importer, so nothing could resolve a specifier to it.
 *
 * Browser-safe: string work only. Whether the named file EXISTS is a separate
 * question, asked by the Node-side caller that has a directory.
 */

import {
  ArtifactSelectorError,
  PLATFORM_AXES,
  selectorFromQualifiers,
  type ArtifactSelector,
} from "./artifact-selector.js";

/** Every key an entry may carry: the two locators, plus the selector axes. */
const KNOWN_KEYS = new Set<string>(["specifier", "path", "source", "format", ...PLATFORM_AXES]);

export interface LibraryCandidate {
  /** The bare specifier a sibling's controller bundle imports this library by. */
  readonly specifier: string;
  /** Module-root-relative path of the built entry point. */
  readonly path: string;
  /** Module-root-relative TypeScript source it is built from (`source:`), when
   *  the entry names one. Present only while the module is a working copy; a
   *  published artifact ships no `src/`. */
  readonly localPath?: string;
  readonly selector: ArtifactSelector;
  /** Where the entry was written, for diagnostics. */
  readonly origin: string;
}

/** Why an `exports.code` entry could not be read. Returned rather than thrown so
 *  the analyzer can report every entry of a block, and so a reader on the load
 *  path can carry on with the entries that are well-formed. */
export interface LibraryCandidateProblem {
  readonly origin: string;
  readonly detail: string;
}

export interface LibraryCandidates {
  readonly candidates: LibraryCandidate[];
  readonly problems: LibraryCandidateProblem[];
}

/** Normalize a `path` / `source` value to the manifest-relative POSIX form the
 *  file selector returns, so membership is a string comparison. */
function normalizeRelative(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

function requiredString(
  entry: Record<string, unknown>,
  key: string,
): { value: string } | { detail: string } {
  const raw = entry[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { detail: `'${key}' is required and must be a non-empty string.` };
  }
  return { value: raw.trim() };
}

/**
 * Read the `exports.code:` block off an owner document's JSON projection.
 *
 * Everything malformed is a problem rather than a silent skip: an entry that
 * cannot be read names no entry point, so a consumer's bundle falls back to
 * *inlining* the library — the duplicated module scope this whole mechanism
 * exists to remove — and it does so on someone else's machine.
 */
export function readLibraryCandidates(ownerJson: unknown): LibraryCandidates {
  const declared = (ownerJson as { exports?: { code?: unknown } } | null)?.exports?.code;
  const candidates: LibraryCandidate[] = [];
  const problems: LibraryCandidateProblem[] = [];
  if (declared === undefined) return { candidates, problems };
  if (!Array.isArray(declared)) {
    return {
      candidates,
      problems: [{ origin: "exports.code", detail: "expected a list of entries." }],
    };
  }

  declared.forEach((raw, index) => {
    const origin = `exports.code[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push({ origin, detail: "expected an object." });
      return;
    }
    const entry = raw as Record<string, unknown>;

    const unknown = Object.keys(entry).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length > 0) {
      // Reported, never ignored: an unrecognized platform axis would leave the
      // entry platform-neutral and offer a single-platform file to every host.
      problems.push({
        origin,
        detail:
          `unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((k) => `'${k}'`).join(", ")}. ` +
          `Known: ${[...KNOWN_KEYS].join(", ")}.`,
      });
      return;
    }

    const specifier = requiredString(entry, "specifier");
    if ("detail" in specifier) {
      problems.push({ origin, detail: specifier.detail });
      return;
    }
    const file = requiredString(entry, "path");
    if ("detail" in file) {
      problems.push({ origin: `${origin} ('${specifier.value}')`, detail: file.detail });
      return;
    }
    // Explicit rather than inferred from the file extension: a `.mjs` can be
    // wasm glue, and an inference rule is something every other runtime's reader
    // would have to copy exactly.
    const format = requiredString(entry, "format");
    if ("detail" in format) {
      problems.push({ origin: `${origin} ('${specifier.value}')`, detail: format.detail });
      return;
    }

    let selector: ArtifactSelector;
    try {
      selector = selectorFromQualifiers(format.value, entry, `${origin} ('${specifier.value}')`);
    } catch (err) {
      problems.push({
        origin: `${origin} ('${specifier.value}')`,
        detail: err instanceof ArtifactSelectorError ? err.message : String(err),
      });
      return;
    }

    const source = entry.source;
    if (source !== undefined && (typeof source !== "string" || source.trim() === "")) {
      problems.push({
        origin: `${origin} ('${specifier.value}')`,
        detail: "'source' must be a non-empty string when present.",
      });
      return;
    }

    candidates.push({
      specifier: specifier.value,
      path: normalizeRelative(file.value),
      ...(typeof source === "string" ? { localPath: normalizeRelative(source.trim()) } : {}),
      selector,
      origin: `${origin} ('${specifier.value}')`,
    });
  });

  return { candidates, problems };
}
