/**
 * The shape of `telo-workspace.yaml`, declared as data: the `release:` block
 * `@telorun/release` declares — with the keys each ecosystem a Telo host serves
 * reads on a unit entry — and the `env:` block `telo run` reads.
 *
 * One declaration read by the lenient reader and by the editor's completion, so
 * the editor never offers a key the checker rejects.
 */

import {
  releaseBlockSchema,
  type EcosystemAdapter,
  type WorkspaceBlockSchema,
  type WorkspaceKeySchema,
} from "@telorun/release";
import { TELO_RELEASE_ADAPTERS } from "./telo-adapter.js";

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

export const ENV_BLOCK_SCHEMA: WorkspaceBlockSchema = {
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
};

/**
 * Every block, and every key in it, is optional — a marker whose whole content
 * is comments is valid, and is what a runner seeds for the cache anchor alone.
 */
export function workspaceSchema(
  adapters: readonly EcosystemAdapter[],
): Readonly<Record<string, WorkspaceBlockSchema>> {
  return { release: releaseBlockSchema(adapters), env: ENV_BLOCK_SCHEMA };
}

/** The marker as a Telo host reads it. */
export const WORKSPACE_SCHEMA = workspaceSchema(TELO_RELEASE_ADAPTERS);

export const WORKSPACE_BLOCKS: readonly string[] = Object.keys(WORKSPACE_SCHEMA);

/** One `env.files` entry. A bare filename in the file normalizes to this, not
 *  sensitive. */
export interface EnvFileEntry {
  readonly name: string;
  readonly sensitive: boolean;
}

/** Built-in when `env.files` is absent, `.env.local` the one holding secrets. */
export const DEFAULT_ENV_FILES: readonly EnvFileEntry[] = [
  { name: ".env", sensitive: false },
  { name: ".env.local", sensitive: true },
];
