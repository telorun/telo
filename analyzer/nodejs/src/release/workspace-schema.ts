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
  readonly type: "string" | "string[]" | "entry[]";
  readonly description: string;
  /** Values worth offering at this key when nothing better is known. */
  readonly examples?: readonly string[];
}

export interface WorkspaceBlockSchema {
  readonly description: string;
  readonly properties: Readonly<Record<string, WorkspaceKeySchema>>;
}

/**
 * Every block, and every key in it, is optional — a marker whose whole content
 * is comments is valid, and is what a runner seeds for the cache anchor alone.
 */
export const WORKSPACE_SCHEMA: Readonly<Record<string, WorkspaceBlockSchema>> = {
  release: {
    description: "How `telo release` behaves: where modules are, where they publish, and which of their paths are not release-relevant.",
    properties: {
      registry: {
        type: "string",
        description:
          "Publish destination base. A module's ref is `<registry>/<its own directory name>`. Omitted: --registry, then TELO_OCI_REGISTRY, then the base each module's own ledger entry recorded.",
        examples: ["oci://ghcr.io/telorun"],
      },
      ignore: {
        type: "string[]",
        description:
          "Paths under a module whose changes are not release-relevant, so no changelog fragment is asked for. Module-relative, gitignore-style. Declaring it replaces the built-in default; [] ignores nothing.",
        examples: ["**/tests/**", "**/docs/**", "**/plans/**", "**/README.md", "**/CHANGELOG.md"],
      },
      modules: {
        type: "entry[]",
        description:
          "The subtrees that may hold modules — a place to look, never a module: what makes a directory a module is its telo.yaml. Workspace-relative, gitignore-style, last match wins. A bare string is an entry with no overrides.",
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
        type: "string[]",
        description:
          "Which files are collected in each directory, later winning within one directory. Filenames only — a / or a glob is an error. Declaring it replaces the default; [] collects none.",
        examples: [".env", ".env.local"],
      },
    },
  },
};

/** Keys a `release.modules` entry may carry in its object form. `path` is the
 *  pattern; the rest override the block's own keys, key-wise. */
export const MODULE_ENTRY_KEYS: Readonly<Record<string, WorkspaceKeySchema>> = {
  path: {
    type: "string",
    description: "The gitignore-style pattern this entry matches modules with.",
  },
  registry: WORKSPACE_SCHEMA.release.properties.registry,
  ignore: WORKSPACE_SCHEMA.release.properties.ignore,
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

/** Built-in when `env.files` is absent — the pair the walk hardcoded before it
 *  was authorable, in the order it applied them. */
export const DEFAULT_ENV_FILES: readonly string[] = [".env", ".env.local"];
