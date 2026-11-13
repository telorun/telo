/**
 * The `docker` ecosystem's evidence half — the only reader of a build context.
 *
 * Its layer is the context the image is built from (`context`, the anchor
 * directory by default) less what the ignore file excludes —
 * `<Dockerfile>.dockerignore` beside the Dockerfile, else the context's
 * `.dockerignore` — read with Docker's root-anchored rules, named relative to
 * the context. The Dockerfile and its ignore file are always in it, so editing
 * either moves the digest even when the context leaves them out. The base image
 * and the planner's own bookkeeping (`.changes/`) are outside it. An image keeps no version and has no read-back; it publishes to
 * `<registry>/<name>`.
 */

import { GLOB_PRUNE_DIRS, selectByPatterns } from "@telorun/glob";
import * as fs from "node:fs";
import * as path from "node:path";
import { DOCKERFILE } from "../../adapters/docker.js";
import type { AnchorRef, EvidenceAdapter, EvidenceSession } from "../evidence.js";
import { digestFileSet, isBookkeeping, listFiles, readFileSetEntry, type FileSetEntry } from "../files-digest.js";
import type { ReleaseWorkspace } from "../workspace.js";
import { dockerignorePatterns } from "./dockerignore-patterns.js";

/** The workspace-relative context directory of a docker anchor. */
export function dockerContext(ref: AnchorRef): string {
  const context = ref.anchor.settings.context;
  return typeof context === "string" ? (context === "." ? "" : context) : ref.anchor.dir;
}

export function dockerDestination(ref: AnchorRef): string | undefined {
  const registry = ref.anchor.settings.registry;
  if (typeof registry !== "string") return undefined;
  const name = typeof ref.anchor.settings.name === "string"
    ? ref.anchor.settings.name
    : path.posix.basename(ref.anchor.dir || ".") === "." ? undefined : path.posix.basename(ref.anchor.dir);
  return name === undefined ? undefined : `${registry.replace(/\/+$/, "")}/${name}`;
}

/** The image's file set: context-relative names, workspace-relative sources. */
export function dockerFileSet(root: string, ref: AnchorRef): { entries: FileSetEntry[]; sources: string[] } {
  const context = dockerContext(ref);
  const contextDir = path.join(root, context);
  const dockerfile = joined(ref.anchor.dir, DOCKERFILE);
  const candidates = [`${dockerfile}.dockerignore`, joined(context, ".dockerignore")];
  const ignoreFile = candidates.find((file) => fs.existsSync(path.join(root, file)));
  const ignored = ignoreFile
    ? dockerignorePatterns(fs.readFileSync(path.join(root, ignoreFile), "utf8"), ignoreFile)
    : [];
  const selected = new Set(
    selectByPatterns(listFiles(contextDir, GLOB_PRUNE_DIRS), ["**"], { applyDefaultIgnore: false, exclude: ignored }),
  );
  const sources = new Map<string, string>();
  for (const file of selected) {
    const source = joined(context, file);
    if (!isBookkeeping(source)) sources.set(file, source);
  }
  for (const always of [dockerfile, ignoreFile]) {
    if (!always) continue;
    sources.set(path.posix.relative(context === "" ? "." : context, always), always);
  }
  const names = [...sources.keys()].sort();
  return {
    entries: names.map((name) => readFileSetEntry(root, sources.get(name)!, name)),
    sources: names.map((name) => sources.get(name)!),
  };
}

export const dockerEvidence: EvidenceAdapter = {
  ecosystem: "docker",
  needsDestination: true,
  async open(workspace: ReleaseWorkspace): Promise<EvidenceSession> {
    return {
      async collect(ref) {
        const { entries, sources } = dockerFileSet(workspace.root, ref);
        return { layer: digestFileSet(entries), files: sources };
      },
      async imports() {
        return [];
      },
      destination: dockerDestination,
    };
  },
};

function joined(dir: string, relative: string): string {
  return dir === "" ? relative : `${dir}/${relative}`;
}
