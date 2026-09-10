/**
 * `telo-workspace.yaml` — the anchor.
 *
 * **Its location is the anchor, and every field lives in a block scoped to what
 * it governs.** Every path the release system names — a module key, a ledger
 * entry, a fragment's `modules:` — is relative to this file's directory, and so
 * is the `.telo` cache. `release:` is what `telo release` reads; `env:` is what
 * `telo run` reads when it resolves a manifest's environment.
 *
 * That rule is why `modules:` sits under `release:` rather than at the top
 * level. It is a release inventory, not an inventory of manifests: it exists so
 * a whole-tree scan does not read every example and every cached
 * `.telo/manifests` copy as something to version and publish, and nothing else
 * consults it — the env walk refuses to, which is why a manifest under
 * `examples/`, in no release subtree, still gets the full walk.
 *
 * The file is **optional and every block in it is optional**. A marker whose
 * whole content is comments is valid: it anchors the cache and bounds the env
 * walk, which is exactly what a runner seeds one for.
 *
 * **The reader is lenient; the diagnostics are the strict half.** It returns
 * everything it could read plus everything it found wrong, each anchored at a
 * key path, because an editor wants all of them and a command wants to exit on
 * the first. Which of them are fatal is the CALLER's policy, not the file's:
 * `telo release` refuses on any error, while `telo run` consumes `env:` alone
 * and prints the rest — aborting every app in a workspace over a release typo is
 * not a trade to make silently.
 *
 * Parsing lives here, in the browser-safe half, because the editor answers "what
 * does changing this library bump?" from the same model. Finding the file on
 * disk is the CLI's half — this side takes text. Gitignore matching is INJECTED
 * (`PatternMatch`) for the same reason: the grammar belongs to the glob package,
 * which this half does not depend on.
 */

import { parseDocument } from "yaml";
import {
  DEFAULT_ENV_FILES,
  DEFAULT_RELEASE_IGNORE,
  MODULE_ENTRY_KEYS,
  WORKSPACE_BLOCKS,
  WORKSPACE_SCHEMA,
  type WorkspaceKeySchema,
} from "./workspace-schema.js";

export const WORKSPACE_FILENAME = "telo-workspace.yaml";

export { DEFAULT_ENV_FILES, DEFAULT_RELEASE_IGNORE };

/** One `release.modules` entry. A bare string in the file normalizes to this
 *  with no overrides. */
export interface ModuleEntry {
  readonly path: string;
  readonly registry?: string;
  readonly ignore?: readonly string[];
}

export interface ReleaseSettings {
  readonly registry?: string;
  readonly ignore?: readonly string[];
  readonly modules: readonly ModuleEntry[];
}

export interface EnvSettings {
  readonly roots?: readonly string[];
  readonly files?: readonly string[];
}

export interface WorkspaceConfig {
  readonly release?: ReleaseSettings;
  readonly env?: EnvSettings;
}

export type WorkspaceDiagnosticCode =
  | "WORKSPACE_UNKNOWN_KEY"
  | "WORKSPACE_MODULES_MOVED"
  | "WORKSPACE_INVALID_VALUE"
  | "WORKSPACE_ENTRY_MATCHES_NOTHING"
  | "WORKSPACE_ENTRY_SHADOWED"
  | "WORKSPACE_MARKER_SHADOWED";

export interface WorkspaceDiagnostic {
  readonly code: WorkspaceDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** Key path from the document root (`["release", "modules", 2, "registry"]`),
   *  so a host can anchor a squiggle without re-deriving where it came from. */
  readonly path: readonly (string | number)[];
}

export interface WorkspaceRead {
  readonly config: WorkspaceConfig;
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}

export class WorkspaceConfigError extends Error {}

const EMPTY: WorkspaceConfig = {};

/**
 * Read the marker's text.
 *
 * Never throws: unreadable YAML is itself a diagnostic, because the one caller
 * that must not abort on it is the run path.
 */
export function readWorkspaceConfig(text: string, where: string): WorkspaceRead {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const report = (
    code: WorkspaceDiagnosticCode,
    message: string,
    path: (string | number)[],
    severity: "error" | "warning" = "error",
  ): void => {
    diagnostics.push({ code, severity, message, path });
  };

  let value: unknown;
  try {
    value = parseDocument(text).toJSON();
  } catch (err) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
    return { config: EMPTY, diagnostics };
  }
  if (value === null || value === undefined) return { config: EMPTY, diagnostics };
  if (typeof value !== "object" || Array.isArray(value)) {
    report("WORKSPACE_INVALID_VALUE", `${where} must be a YAML mapping.`, []);
    return { config: EMPTY, diagnostics };
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (WORKSPACE_BLOCKS.includes(key)) continue;
    if (key === "modules") {
      report(
        "WORKSPACE_MODULES_MOVED",
        `${where}: 'modules' moved under 'release:'. It is release scope — where modules live, ` +
          `for versioning and publishing — and every field of this file now sits in the block ` +
          `that governs it. Indent this list under a 'release:' key.`,
        ["modules"],
      );
      continue;
    }
    // A near-miss of a block name is the typo whose settings would otherwise go
    // silently unapplied; an unrecognized block is a version skew, so the next
    // one ships without breaking today's runs.
    const near = nearMiss(key, WORKSPACE_BLOCKS);
    if (near) {
      report("WORKSPACE_UNKNOWN_KEY", `${where}: unknown block '${key}'. Did you mean '${near}'?`, [key]);
    } else {
      report(
        "WORKSPACE_UNKNOWN_KEY",
        `${where}: unknown block '${key}', which nothing reads. This telo knows ${WORKSPACE_BLOCKS.map((b) => `'${b}'`).join(" and ")}.`,
        [key],
        "warning",
      );
    }
  }

  const release = readRelease(record.release, where, report);
  const env = readEnv(record.env, where, report);
  return {
    config: { ...(release ? { release } : {}), ...(env ? { env } : {}) },
    diagnostics,
  };
}

type Report = (
  code: WorkspaceDiagnosticCode,
  message: string,
  path: (string | number)[],
  severity?: "error" | "warning",
) => void;

function readRelease(raw: unknown, where: string, report: Report): ReleaseSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: 'release' must be a mapping.`, ["release"]);
    return undefined;
  }
  const block = raw as Record<string, unknown>;
  const read = readBlock(block, WORKSPACE_SCHEMA.release.properties, where, ["release"], report);
  return {
    ...(read.registry !== undefined ? { registry: read.registry as string } : {}),
    ...(read.ignore !== undefined ? { ignore: read.ignore as readonly string[] } : {}),
    modules: (read.modules as readonly ModuleEntry[]) ?? [],
  };
}

/**
 * Read one block against its declared shape.
 *
 * The declared `type` is what DISPATCHES, so a new key is one entry in the
 * schema and no change here. Reading the key names from the data while
 * hand-writing every type check beside it would leave the half nothing reads
 * free to drift from the half that decides — with the data half being the one no
 * test would catch.
 */
function readBlock(
  block: Record<string, unknown>,
  properties: Readonly<Record<string, WorkspaceKeySchema>>,
  where: string,
  at: (string | number)[],
  report: Report,
): Record<string, unknown> {
  reportUnknownKeys(block, properties, where, at, report);
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const value =
      schema.type === "string"
        ? readString(block[name], where, [...at, name], report)
        : schema.type === "string[]"
          ? readStringList(block[name], where, [...at, name], report)
          : readModuleEntries(block[name], where, report);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function readModuleEntries(raw: unknown, where: string, report: Report): readonly ModuleEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: 'release.modules' must be a list of path patterns, e.g. [modules/*, apps/*].`,
      ["release", "modules"],
    );
    return [];
  }
  if (raw.length === 0) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: 'release.modules' is empty, so no directory can ever be discovered as a module. ` +
        `List the subtrees that hold them, e.g. [modules/*, apps/*].`,
      ["release", "modules"],
    );
    return [];
  }

  const entries: ModuleEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const at = ["release", "modules", index];
    if (typeof item === "string") {
      entries.push({ path: item });
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${where}: 'release.modules' entry ${index} must be a pattern string, or a mapping ` +
          `carrying 'path:' plus the keys it overrides.`,
        at,
      );
      continue;
    }
    const entry = item as Record<string, unknown>;
    const read = readBlock(entry, MODULE_ENTRY_KEYS, where, at, report);
    const path = read.path as string | undefined;
    if (path === undefined) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${where}: 'release.modules' entry ${index} declares no 'path:', so it matches nothing.`,
        at,
      );
      continue;
    }
    entries.push({
      path,
      ...(read.registry !== undefined ? { registry: read.registry as string } : {}),
      ...(read.ignore !== undefined ? { ignore: read.ignore as readonly string[] } : {}),
    });
  }
  return entries;
}

function readEnv(raw: unknown, where: string, report: Report): EnvSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: 'env' must be a mapping.`, ["env"]);
    return undefined;
  }
  const block = raw as Record<string, unknown>;
  const read = readBlock(block, WORKSPACE_SCHEMA.env.properties, where, ["env"], report);
  const roots = read.roots as readonly string[] | undefined;
  const files = read.files as readonly string[] | undefined;
  if (files) {
    for (const [index, name] of files.entries()) {
      // A path would let one entry reach outside the bound `roots:` exists to
      // state, so the list is filenames and the refusal is structural.
      if (name.includes("/") || name.includes("\\") || name.includes("*")) {
        report(
          "WORKSPACE_INVALID_VALUE",
          `${where}: 'env.files' entry '${name}' is a path or a glob. It names a file collected in ` +
            `each directory the walk visits, so it must be a bare filename — the walk's reach is ` +
            `'env.roots'.`,
          ["env", "files", index],
        );
      }
    }
  }
  return {
    ...(roots !== undefined ? { roots } : {}),
    ...(files !== undefined ? { files } : {}),
  };
}

function reportUnknownKeys(
  block: Record<string, unknown>,
  known: Readonly<Record<string, unknown>>,
  where: string,
  at: (string | number)[],
  report: Report,
): void {
  const names = Object.keys(known);
  for (const key of Object.keys(block)) {
    if (names.includes(key)) continue;
    const near = nearMiss(key, names);
    report(
      "WORKSPACE_UNKNOWN_KEY",
      `${where}: unknown key '${[...at, key].join(".")}'.` +
        (near ? ` Did you mean '${near}'?` : ` Known keys: ${names.map((n) => `'${n}'`).join(", ")}.`),
      [...at, key],
    );
  }
}

function readString(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: Report,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' must be a string.`, at);
    return undefined;
  }
  if (raw === "") {
    // Reported rather than read as an absence: an empty value would fall
    // through to the next rung of the cascade and publish somewhere the author
    // did not name, which is the one thing a declared destination must not do.
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' is empty.`, at);
    return undefined;
  }
  return raw;
}

function readStringList(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: Report,
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' must be a list of strings.`, at);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string") {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' entry ${index} must be a string.`, [
        ...at,
        index,
      ]);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** One edit apart, case-insensitively — enough to separate a typo from a key
 *  this reader is simply too old to know. */
function nearMiss(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  return known.find((name) => name !== key && editDistanceAtMostOne(lower, name.toLowerCase()));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// ---------------------------------------------------------------------------
// Diagnostics as a caller's policy
// ---------------------------------------------------------------------------

/** The diagnostics anchored inside one top-level block, plus the ones anchored
 *  at the document itself (unreadable YAML, a non-mapping root) — those are
 *  every block's problem. */
export function diagnosticsFor(
  diagnostics: readonly WorkspaceDiagnostic[],
  block: string,
): readonly WorkspaceDiagnostic[] {
  return diagnostics.filter((d) => d.path.length === 0 || d.path[0] === block);
}

export function hasError(diagnostics: readonly WorkspaceDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/**
 * The release settings, or a throw naming what is missing.
 *
 * `telo release` is the one caller for which any error is fatal, and for which
 * an absent block is itself one: a marker with no `release:` anchors a cache and
 * declares no release scope, which is exactly the state a runner's seeded marker
 * is in.
 */
export function requireReleaseSettings(
  read: WorkspaceRead,
  where: string,
): ReleaseSettings {
  const first = read.diagnostics.find((d) => d.severity === "error");
  if (first) throw new WorkspaceConfigError(first.message);
  if (!read.config.release || read.config.release.modules.length === 0) {
    throw new WorkspaceConfigError(
      `${where} declares no 'release.modules', so no directory can be discovered as a module. ` +
        `List the subtrees that hold them:\n\n  release:\n    modules:\n      - modules/*\n      - apps/*\n`,
    );
  }
  return read.config.release;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Gitignore-style matching over one authored list.
 *
 * Injected rather than imported: the grammar is the glob package's, and this
 * half is browser-safe. Returns the index of the LAST pattern matching `path`,
 * or `-1` — which is what makes a decision attributable to the entry that made
 * it (the `buildImportUpgrades` environment precedent).
 */
export type PatternMatch = (path: string, patterns: readonly string[]) => number;

export interface ModuleSettings {
  /** Index into `release.modules` of the entry that decided this module. */
  readonly entry: number;
  readonly registry?: string;
  readonly ignore: readonly string[];
}

/**
 * Which entry claims `key`, and what it therefore settles.
 *
 * **The last matching entry supplies them** — the rule the list already has,
 * since it is one gitignore-style list evaluated last-match-wins. A negation
 * entry is an exclusion and therefore supplies nothing: a module the last match
 * excludes is not a module of this workspace at all, which is why this returns
 * `undefined` rather than a settings object for it.
 *
 * The cascade is key-wise and each key's value replaces whole, so an entry
 * naming only `registry:` keeps the block's `ignore:`.
 */
export function settingsForModule(
  release: ReleaseSettings,
  key: string,
  match: PatternMatch,
): ModuleSettings | undefined {
  const index = decidingIndex(key, release.modules.map((entry) => entry.path), match);
  if (index < 0) return undefined;
  const entry = release.modules[index]!;
  return {
    entry: index,
    ...(entry.registry ?? release.registry
      ? { registry: entry.registry ?? release.registry }
      : {}),
    ignore: entry.ignore ?? release.ignore ?? DEFAULT_RELEASE_IGNORE,
  };
}

/** Whether `path` is matched by an authored pattern list, negations honoured.
 *  `env.roots` and a resolved `ignore` list are both read through this. */
export function matchesPatterns(
  path: string,
  patterns: readonly string[],
  match: PatternMatch,
): boolean {
  return decidingIndex(path, patterns, match) >= 0;
}

/**
 * The index of the entry that CLAIMS `path`, or `-1`.
 *
 * The one place last-match-wins and the negation reading live: every pattern
 * list in this file rests on that rule, and two derivations of it would be two
 * answers to what a marker means.
 */
function decidingIndex(
  path: string,
  patterns: readonly string[],
  match: PatternMatch,
): number {
  const index = match(path, patterns);
  return index >= 0 && patterns[index]!.startsWith("!") ? -1 : index;
}
