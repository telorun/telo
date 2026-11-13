/**
 * The shape of the `release:` block of `telo-workspace.yaml`, declared as data.
 *
 * One declaration read by two consumers — the lenient reader that reports what
 * a marker got wrong, and an editor's completion list — so the editor never
 * offers a key the checker rejects. It is not compiled by a schema validator:
 * the reader walks it, which is what lets a wrong value name the key and the fix
 * instead of a keyword trace. Each registered adapter declares the keys its own
 * ecosystem reads in an anchor's settings and under `release.ecosystems` (`keys`).
 */

import type { EcosystemAdapter } from "./adapter.js";

export interface WorkspaceKeySchema {
  /**
   * How the value is read. The four plain types are a string, a boolean, a list
   * of strings, and a list of entries — each a bare string or a mapping
   * carrying `entry.key`. The rest name a value of the release block with a
   * shape of its own.
   */
  readonly type:
    | "string"
    | "boolean"
    | "string[]"
    | "entry[]"
    | "directory"
    | "ecosystems"
    | "ecosystem"
    | "version-location"
    | "payload"
    | "version-files"
    | "bump-level"
    | "groups";
  readonly description: string;
  /** Values worth offering at this key when nothing better is known. */
  readonly examples?: readonly string[];
  /** For `entry[]`: what one entry is. */
  readonly entry?: WorkspaceEntrySchema;
}

/** One entry of an `entry[]` list: a bare string stands for `key` alone. */
export interface WorkspaceEntrySchema {
  readonly key: string;
  readonly properties: Readonly<Record<string, WorkspaceKeySchema>>;
}

export interface WorkspaceBlockSchema {
  readonly description: string;
  readonly properties: Readonly<Record<string, WorkspaceKeySchema>>;
  /** Per ecosystem the host serves, the keys it reads in an anchor's settings
   *  and under `release.ecosystems.<ecosystem>`. */
  readonly ecosystems?: Readonly<Record<string, Readonly<Record<string, WorkspaceKeySchema>>>>;
}

const IGNORE: WorkspaceKeySchema = {
  type: "string[]",
  description:
    "Paths under a unit whose changes ask for no changelog fragment. Unit-relative, gitignore-style. Declaring it replaces the built-in default; [] ignores nothing.",
  examples: ["**/tests/**", "**/docs/**", "**/plans/**", "**/README.md", "**/CHANGELOG.md"],
};

const MAX_BUMP: WorkspaceKeySchema = {
  type: "bump-level",
  description:
    "The highest bump a release may make — patch, minor or major (the default). A plan needing more is refused.",
  examples: ["patch", "minor", "major"],
};

/** Keys every `release.units` entry may carry, whatever its ecosystems. */
export const UNIT_ENTRY_KEYS: Readonly<Record<string, WorkspaceKeySchema>> = {
  path: {
    type: "string",
    description:
      "The unit's directory, or a gitignore-style pattern of them, workspace-relative. Last match wins; a leading ! excludes. A unit's key is its path.",
  },
  ecosystem: {
    type: "ecosystem",
    description:
      "The ecosystems the unit ships through: a name, a list of names, or a map of name to the anchor directory inside the unit holding that ecosystem's package — a directory, a list of them, or a map of directory to that anchor's settings. A name alone anchors at the unit's own directory. Absent: the unit declares its own version and payload.",
    examples: ["npm", "cargo", "docker", "helm"],
  },
  version: {
    type: "version-location",
    description:
      "Where the unit's version lives: a unit-relative file a handler reads (package.json, Cargo.toml, a plain version file), or { file, pointer } into JSON, YAML or TOML. Required unless exactly one anchor's ecosystem keeps a version.",
  },
  payload: {
    type: "payload",
    description:
      "A declared file set beside the ecosystems' own: unit-relative patterns, or { command } printing unit-relative paths. Required when no anchor contributes a layer.",
  },
  metafile: {
    type: "string",
    description:
      "A bundler metafile, unit-relative, whose inputs from other units are inline edges.",
  },
  versionFiles: {
    type: "version-files",
    description:
      "Further files carrying the unit's version, written with it: unit-relative patterns, or { path, pointer }.",
  },
  ignore: IGNORE,
  maxBump: MAX_BUMP,
};

/** The release block's own keys. */
export const RELEASE_BLOCK_KEYS: Readonly<Record<string, WorkspaceKeySchema>> = {
  units: {
    type: "entry[]",
    description:
      "The release units: each a directory with one version, one changelog and one fragment target, however many packages it ships. A bare string is an entry with no ecosystem keys.",
    examples: ["packages/*"],
    entry: { key: "path", properties: UNIT_ENTRY_KEYS },
  },
  ecosystems: {
    type: "ecosystems",
    description:
      "Per ecosystem, the settings every anchor of it takes unless the anchor's own settings name the key: { <ecosystem>: { <key>: <value> } }.",
  },
  groups: {
    type: "groups",
    description:
      "Named groups of unit keys sharing one version: every member releases at the highest level any member needs.",
  },
  ignore: IGNORE,
  maxBump: MAX_BUMP,
};

/**
 * The release block as one host sees it: the core keys, plus each registered
 * ecosystem's settings keys — read in an anchor's settings and under
 * `release.ecosystems.<ecosystem>`, never flat on an entry.
 */
export function releaseBlockSchema(adapters: readonly EcosystemAdapter[]): WorkspaceBlockSchema {
  const ecosystems: Record<string, Readonly<Record<string, WorkspaceKeySchema>>> = {};
  for (const adapter of adapters) ecosystems[adapter.ecosystem] = adapter.keys ?? {};
  return {
    description:
      "How releases are planned: the units, per-ecosystem settings, the groups sharing a version, and the highest bump allowed.",
    properties: RELEASE_BLOCK_KEYS,
    ecosystems,
  };
}

/** Built-in when `release.ignore` is absent. Every pattern carries `**\/`, so it
 *  holds at any depth beneath a unit. */
export const DEFAULT_RELEASE_IGNORE: readonly string[] = [
  "**/tests/**",
  "**/docs/**",
  "**/plans/**",
  "**/README.md",
  "**/CHANGELOG.md",
];
