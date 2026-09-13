/**
 * A module's **native files** — the `native:` block on a `Telo.Library` or
 * `Telo.Application` doc, naming each platform-specific file the runtime does
 * not import as a controller (a sidecar addon, a `dlopen`'d library, a
 * per-platform data blob) once per platform tuple.
 *
 * ```yaml
 * native:
 *   - name: better-sqlite3
 *     format: node
 *     os: linux
 *     arch: amd64
 *     libc: gnu
 *     abi: node-137
 *     path: ./native/linux-amd64-gnu-node-137/better_sqlite3.node
 * ```
 *
 * Declared on the module doc rather than on a controller candidate, so the
 * platform matrix is written once whatever the kind count, and the
 * platform-neutral bundle ships once. Publish places each entry's file in the
 * `native` layer of its selector (spec §1.2).
 *
 * `format` plus the platform axes build the same `ArtifactSelector` a
 * controller candidate does, through the one selector normalizer. The declared
 * `path` is the in-layer path — never flattened — because every layer of a
 * module extracts into one directory, so paths must be disjoint per tuple.
 *
 * The single reader: the strict half is `validate-native-entries.ts`, and
 * publish consumes the entries this returns. Browser-safe: string work only.
 */

import {
  ArtifactSelectorError,
  PLATFORM_AXES,
  selectorFromQualifiers,
  type ArtifactSelector,
} from "./artifact-selector.js";

/** Every key an entry may carry. */
const KNOWN_KEYS = new Set<string>(["name", "format", "path", ...PLATFORM_AXES]);

/** Axes an entry must state: a native file is built for one platform. */
const REQUIRED_AXES = ["os", "arch"] as const;

/** The selector value grammar, applied to `name` as written. */
const NAME_TOKEN = /^[a-z0-9][a-z0-9_.-]*$/;

const GLOB_CHARS = /[*?[\]{}]/;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface NativeEntry {
  /** The logical name controller code asks for. */
  readonly name: string;
  readonly selector: ArtifactSelector;
  /** Module-root-relative POSIX path, normalized. */
  readonly path: string;
  /** Position in the `native:` list. */
  readonly index: number;
  /** Human-facing label for diagnostics: `native[0] ('better-sqlite3')`. */
  readonly origin: string;
}

/**
 * Why an entry could not be read.
 *
 * - `shape` — a missing, non-string or unknown key; the owner doc's JSON Schema
 *   reports these in the same analysis pass.
 * - `invalid` — a value the schema accepts and the grammar rejects: an empty
 *   required string, a `name` or selector value outside the token grammar, an
 *   `abi` outside its value form, a path that names no single file.
 * - `escape` — a `path` pointing outside the module directory.
 */
export interface NativeEntryProblem {
  readonly kind: "shape" | "invalid" | "escape";
  readonly index?: number;
  readonly origin: string;
  /** Dotted/bracketed path from the module doc root, for `data.path`. */
  readonly path: string;
  /** What is wrong, prefixed with `origin`. */
  readonly message: string;
}

export interface NativeEntries {
  readonly entries: NativeEntry[];
  readonly problems: NativeEntryProblem[];
}

export type PathVerdict = { path: string } | { kind: "invalid" | "escape"; detail: string };

/** Normalize a module-relative path, deciding confinement from the written
 *  path alone: the module root is the one directory every path is measured
 *  from, so `..` below depth zero is an escape wherever the module sits. */
export function normalizeNativePath(raw: string): PathVerdict {
  if (URI_SCHEME.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    return {
      kind: "escape",
      detail: `path '${raw}' is not relative to the module root. A native file ships inside the module artifact, so name it relative to the directory holding telo.yaml.`,
    };
  }
  if (GLOB_CHARS.test(raw)) {
    return {
      kind: "invalid",
      detail: `path '${raw}' looks like a pattern. A native entry names exactly one file.`,
    };
  }
  const out: string[] = [];
  for (const segment of raw.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    if (out.length === 0) {
      return {
        kind: "escape",
        detail: `path '${raw}' points above the module root. A native file must ship inside the module directory.`,
      };
    }
    out.pop();
  }
  if (out.length === 0) {
    return { kind: "invalid", detail: `path '${raw}' resolves to the module root, not to a file.` };
  }
  return { path: out.join("/") };
}

/**
 * Read the `native:` block off an owner document's JSON projection.
 *
 * An entry with any problem is left out of `entries`, never read partially: a
 * half-read entry would name a layer the author did not declare.
 */
export function readNativeEntries(ownerJson: unknown): NativeEntries {
  const declared = (ownerJson as { native?: unknown } | null)?.native;
  const entries: NativeEntry[] = [];
  const problems: NativeEntryProblem[] = [];
  if (declared === undefined) return { entries, problems };
  if (!Array.isArray(declared)) {
    problems.push({
      kind: "shape",
      origin: "native",
      path: "native",
      message: "native: expected a list of entries.",
    });
    return { entries, problems };
  }

  declared.forEach((raw, index) => {
    const at = `native[${index}]`;
    const shape = (detail: string) =>
      problems.push({ kind: "shape", index, origin: at, path: at, message: `${at}: ${detail}` });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      shape("expected an object.");
      return;
    }
    const entry = raw as Record<string, unknown>;

    const unknown = Object.keys(entry).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length > 0) {
      shape(
        `unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((k) => `'${k}'`).join(", ")}. ` +
          `Known: ${[...KNOWN_KEYS].join(", ")}.`,
      );
      return;
    }
    const requiredKeys = ["name", "format", ...REQUIRED_AXES, "path"];
    const missing = requiredKeys.filter((key) => typeof entry[key] !== "string");
    if (missing.length > 0) {
      shape(`${missing.map((k) => `'${k}'`).join(", ")} must be strings.`);
      return;
    }
    // A blank string satisfies the schema's `type: string`, so it is reported here.
    const blank = requiredKeys.filter((key) => (entry[key] as string).trim() === "");
    if (blank.length > 0) {
      for (const key of blank) {
        problems.push({
          kind: "invalid",
          index,
          origin: at,
          path: `${at}.${key}`,
          message: `${at}: '${key}' must not be empty.`,
        });
      }
      return;
    }

    const name = entry.name as string;
    const origin = `${at} ('${name}')`;
    if (!NAME_TOKEN.test(name)) {
      problems.push({
        kind: "invalid",
        index,
        origin,
        path: `${at}.name`,
        message:
          `${origin}: name '${name}' is not a canonical token. Use lowercase letters, digits, ` +
          `'.', '-' or '_', starting with a letter or digit.`,
      });
      return;
    }

    let selector: ArtifactSelector;
    try {
      selector = selectorFromQualifiers(entry.format, entry, origin);
    } catch (err) {
      if (!(err instanceof ArtifactSelectorError)) throw err;
      problems.push({ kind: "invalid", index, origin, path: at, message: err.message });
      return;
    }

    const verdict = normalizeNativePath((entry.path as string).trim());
    if (!("path" in verdict)) {
      problems.push({
        kind: verdict.kind,
        index,
        origin,
        path: `${at}.path`,
        message: `${origin}: ${verdict.detail}`,
      });
      return;
    }

    entries.push({ name, selector, path: verdict.path, index, origin });
  });

  return { entries, problems };
}
