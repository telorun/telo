/**
 * The shape of `telo-workspace.yaml`, declared as data.
 *
 * One declaration read by two consumers — the strict half that reports what a
 * marker got wrong, and the editor's completion list. Two hand-maintained key
 * lists drift, and the drift is silent in the worst direction: an editor
 * offering a key the checker rejects.
 *
 * Written as JSON Schema because that is what the shape *is*, and because the
 * `description` a completion item shows and the type a diagnostic names are the
 * same two facts a schema already carries. It is not compiled by AJV — the
 * strict half walks it, which is what lets a wrong value say `'registry' must be
 * the publish destination base, as a string` instead of a keyword trace.
 */

export interface WorkspaceKeySchema {
  readonly type: "string" | "boolean" | "string[]" | "entry[]";
  readonly description: string;
  /** Values worth offering at this key when nothing better is known. */
  readonly examples?: readonly string[];
  /** For `entry[]`: what one entry is — a bare string, or a mapping carrying
   *  `key` plus the other properties. */
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
}

const REGISTRY: WorkspaceKeySchema = {
  type: "string",
  description:
    "Publish destination base. A module's ref is `<registry>/<its own directory name>`. Omitted: --registry, then TELO_OCI_REGISTRY, then the base each module's own ledger entry recorded.",
  examples: ["oci://ghcr.io/telorun"],
};

const RELEASE_IGNORE: WorkspaceKeySchema = {
  type: "string[]",
  description:
    "Paths under a module whose changes are not release-relevant, so no changelog fragment is asked for. Module-relative, gitignore-style. Declaring it replaces the built-in default; [] ignores nothing.",
  examples: ["**/tests/**", "**/docs/**", "**/plans/**", "**/README.md", "**/CHANGELOG.md"],
};

/** Keys a `release.modules` entry may carry in its object form. `path` is the
 *  pattern; the rest override the block's own keys, key-wise. */
export const MODULE_ENTRY_KEYS: Readonly<Record<string, WorkspaceKeySchema>> = {
  path: {
    type: "string",
    description: "The gitignore-style pattern this entry matches modules with.",
  },
  registry: REGISTRY,
  ignore: RELEASE_IGNORE,
};

/** Keys an `env.files` entry may carry in its object form. A bare filename is
 *  an entry that is not sensitive. */
export const ENV_FILE_ENTRY_KEYS: Readonly<Record<string, WorkspaceKeySchema>> = {
  name: {
    type: "string",
    description: "The filename collected in each directory the walk visits. A / or a glob is an error.",
    examples: [".env", ".env.local"],
  },
  sensitive: {
    type: "boolean",
    description:
      "The file holds values that must not be committed or synced: secrets and sensitive need fields are written to it, and a secret read from any other file is warned about. It does not affect log redaction.",
  },
};

/**
 * Every block, and every key in it, is optional — a marker whose whole content
 * is comments is valid, and is what a runner seeds for the cache anchor alone.
 */
export const WORKSPACE_SCHEMA: Readonly<Record<string, WorkspaceBlockSchema>> = {
  release: {
    description: "How `telo release` behaves: where modules are, where they publish, and which of their paths are not release-relevant.",
    properties: {
      registry: REGISTRY,
      ignore: RELEASE_IGNORE,
      modules: {
        type: "entry[]",
        description:
          "The subtrees that may hold modules — a place to look, never a module: what makes a directory a module is its telo.yaml. Workspace-relative, gitignore-style, last match wins. A bare string is an entry with no overrides.",
        examples: ["modules/*", "apps/*"],
        entry: { key: "path", properties: MODULE_ENTRY_KEYS },
      },
    },
  },
  env: {
    description: "How `telo run` resolves a manifest's environment.",
    properties: {
      roots: {
        type: "string[]",
        description:
          "How far up the .env walk may climb. Workspace-relative, gitignore-style, matched against each ancestor directory; the nearest match stops the walk. Omitted: the walk stops at this file.",
      },
      files: {
        type: "entry[]",
        description:
          "Which files are collected in each directory, later winning within one directory. Each is a filename, or { name, sensitive } — a sensitive file holds values that must not be committed or synced. Filenames only — a / or a glob is an error. Declaring it replaces the default [.env, { name: .env.local, sensitive: true }]; [] collects none.",
        examples: [".env", ".env.local"],
        entry: { key: "name", properties: ENV_FILE_ENTRY_KEYS },
      },
    },
  },
};

export const WORKSPACE_BLOCKS: readonly string[] = Object.keys(WORKSPACE_SCHEMA);

/** Built-in when `release.ignore` is absent. Every pattern carries `**\/` — the
 *  anchoring at a module root is the defect this replaced, so anchoring some and
 *  not others would reproduce it partially. */
export const DEFAULT_RELEASE_IGNORE: readonly string[] = [
  "**/tests/**",
  "**/docs/**",
  "**/plans/**",
  "**/README.md",
  "**/CHANGELOG.md",
];

/** One `env.files` entry. A bare filename in the file normalizes to this, not
 *  sensitive. */
export interface EnvFileEntry {
  readonly name: string;
  readonly sensitive: boolean;
}

/** Built-in when `env.files` is absent — the pair the walk hardcoded before it
 *  was authorable, in the order it applied them, `.env.local` the one that
 *  holds secrets. */
export const DEFAULT_ENV_FILES: readonly EnvFileEntry[] = [
  { name: ".env", sensitive: false },
  { name: ".env.local", sensitive: true },
];
