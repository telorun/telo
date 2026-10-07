/**
 * A module's **browser entries** — the `exports.browser:` block on a
 * `Telo.Library` doc, which names the ES modules the module ships for a browser
 * to import.
 *
 * ```yaml
 * exports:
 *   browser:
 *     - specifier: "@acme/badges"
 *       path: ./browser/badges.js
 *       source: ./browser/src/badges.tsx
 *       abi: ui-1
 *       external: [react, react/jsx-runtime]
 *       exports: [StatusPill]
 * ```
 *
 * ## Why it sits beside `exports.code:` and is not one
 *
 * Both say "this file is reachable from outside the module", as data, on the
 * module doc — which is where layer partitioning reads its claims. They differ in
 * who imports the file: an `exports.code:` entry is resolved by a sibling
 * module's controller bundle inside the kernel's own process, so it is keyed by a
 * kernel-hosted `format` and the platform axes. A browser entry is never imported
 * by a kernel. It is served, so its format is constant (`esm`, never written) and
 * the only axis it states is `abi` — the contract between the entry and whatever
 * page loads it. An `os` / `arch` / `libc` on one is refused rather than ignored.
 *
 * ## What each field is for
 *
 * - `specifier` — the import-map key a page imports the entry by, and the name a
 *   resource refers to it by. One entry per specifier.
 * - `path` — the built file, module-root-relative.
 * - `source` — what `path` is built from. Required in a source checkout, where
 *   the kernel builds the entry on first use; a published artifact ships `path`.
 *   Neither may be absolute or point above the module root.
 * - `abi` — `<family>-<version>`, the host contract the entry was written
 *   against. A host compares it with its own and decides what a mismatch means.
 * - `external` — bare specifiers the HOST supplies (through its import map), so
 *   they are not bundled. Entries of one module declaring the identical set are
 *   built together and share their common code.
 * - `exports` — the export names a resource may name, checked wherever a kind's
 *   field carries `x-telo-browser-export`.
 *
 * Browser-safe: string work only.
 */

import {
  ArtifactSelectorError,
  PLATFORM_AXES,
  normalizeAxisValue,
  type ArtifactSelector,
} from "./artifact-selector.js";

/** The format every browser entry has. Implied, so it is never written. */
export const BROWSER_FORMAT = "esm";

const KNOWN_KEYS = new Set<string>(["specifier", "path", "source", "abi", "external", "exports"]);

export interface BrowserEntry {
  /** The import-map key, and the name resources refer to the entry by. */
  readonly specifier: string;
  /** Module-root-relative path of the built file. */
  readonly path: string;
  /** Module-root-relative source it is built from, when the entry names one. */
  readonly localPath?: string;
  readonly abi?: string;
  /** Bare specifiers the host supplies, sorted. */
  readonly external: readonly string[];
  /** Export names a resource may name. */
  readonly exports: readonly string[];
  /** `format: esm` plus the entry's `abi` — the layer it ships in. */
  readonly selector: ArtifactSelector;
  /** Where the entry was written, for diagnostics. */
  readonly origin: string;
  /** Its position in the `exports.browser:` list. */
  readonly index: number;
}

export interface BrowserEntryProblem {
  readonly origin: string;
  readonly detail: string;
  /** The entry's position in the list, when the problem is one entry's. */
  readonly index?: number;
}

export interface BrowserEntries {
  readonly entries: BrowserEntry[];
  readonly problems: BrowserEntryProblem[];
}

function normalizeRelative(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Why a written `path` / `source` is not a file inside the module, decided from
 *  the text alone: the module root is the directory every path is measured from. */
function outsideModule(key: string, raw: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    return (
      `'${key}' is '${raw}', which is not relative to the module root. A browser entry ships ` +
      `inside the module, so name the file relative to the directory holding telo.yaml.`
    );
  }
  let depth = 0;
  for (const segment of raw.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") continue;
    depth += segment === ".." ? -1 : 1;
    if (depth < 0) {
      return (
        `'${key}' is '${raw}', which points above the module root. A browser entry ships ` +
        `inside the module, so the file must be inside the directory holding telo.yaml.`
      );
    }
  }
  return undefined;
}

function stringList(
  entry: Record<string, unknown>,
  key: string,
): { value: string[] } | { detail: string } {
  const raw = entry[key];
  if (raw === undefined) return { value: [] };
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.trim() === "")) {
    return { detail: `'${key}' must be a list of non-empty strings.` };
  }
  return { value: (raw as string[]).map((item) => item.trim()) };
}

/**
 * Read the `exports.browser:` block off an owner document's JSON projection.
 * Everything malformed is a problem rather than a silent skip, and an entry with
 * a problem is not an entry: a resource naming its specifier is told the
 * specifier is unknown, beside the report of why.
 */
export function readBrowserEntries(ownerJson: unknown): BrowserEntries {
  const declared = (ownerJson as { exports?: { browser?: unknown } } | null)?.exports?.browser;
  const entries: BrowserEntry[] = [];
  const problems: BrowserEntryProblem[] = [];
  if (declared === undefined) return { entries, problems };
  if (!Array.isArray(declared)) {
    return { entries, problems: [{ origin: "exports.browser", detail: "expected a list of entries." }] };
  }

  const seen = new Set<string>();
  declared.forEach((raw, index) => {
    const at = `exports.browser[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push({ origin: at, detail: "expected an object.", index });
      return;
    }
    const entry = raw as Record<string, unknown>;
    const named = typeof entry.specifier === "string" && entry.specifier.trim() !== "";
    const origin = named ? `${at} ('${(entry.specifier as string).trim()}')` : at;
    const refuse = (detail: string) => problems.push({ origin, detail, index });

    const platform = Object.keys(entry).filter(
      (key) => key === "format" || ((PLATFORM_AXES as readonly string[]).includes(key) && key !== "abi"),
    );
    if (platform.length > 0) {
      refuse(
        `${platform.map((k) => `'${k}'`).join(", ")} cannot be stated. A browser entry is an ES ` +
          `module served to a page: its format is always '${BROWSER_FORMAT}' and it is the same ` +
          `file on every platform. The only axis it states is 'abi'.`,
      );
      return;
    }
    const unknown = Object.keys(entry).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length > 0) {
      refuse(
        `unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((k) => `'${k}'`).join(", ")}. ` +
          `Known: ${[...KNOWN_KEYS].join(", ")}.`,
      );
      return;
    }
    if (!named) {
      refuse("'specifier' is required and must be a non-empty string.");
      return;
    }
    const specifier = (entry.specifier as string).trim();
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      refuse("'path' is required and must be a non-empty string.");
      return;
    }
    if (entry.source !== undefined && (typeof entry.source !== "string" || entry.source.trim() === "")) {
      refuse("'source' must be a non-empty string when present.");
      return;
    }
    const outside =
      outsideModule("path", entry.path.trim()) ??
      (typeof entry.source === "string" ? outsideModule("source", entry.source.trim()) : undefined);
    if (outside !== undefined) {
      refuse(outside);
      return;
    }
    let abi: string | undefined;
    if (entry.abi !== undefined) {
      try {
        abi = normalizeAxisValue("abi", entry.abi, origin);
      } catch (err) {
        if (!(err instanceof ArtifactSelectorError)) throw err;
        refuse(err.message.slice(origin.length + 2));
        return;
      }
    }
    const external = stringList(entry, "external");
    if ("detail" in external) {
      refuse(external.detail);
      return;
    }
    const names = stringList(entry, "exports");
    if ("detail" in names) {
      refuse(names.detail);
      return;
    }
    if (seen.has(specifier)) {
      refuse(
        `a second entry declares the specifier '${specifier}'. A specifier is one import-map ` +
          `key, so it names one entry.`,
      );
      return;
    }
    seen.add(specifier);

    entries.push({
      specifier,
      path: normalizeRelative(entry.path.trim()),
      ...(typeof entry.source === "string" ? { localPath: normalizeRelative(entry.source.trim()) } : {}),
      ...(abi !== undefined ? { abi } : {}),
      external: [...new Set(external.value)].sort(),
      exports: [...new Set(names.value)],
      selector: { format: BROWSER_FORMAT, ...(abi !== undefined ? { abi } : {}) },
      origin,
      index,
    });
  });

  return { entries, problems };
}
