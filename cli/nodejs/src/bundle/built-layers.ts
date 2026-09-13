/**
 * The layers a payload build produces, before anything is framed: what may be
 * pushed, the index entry of a layer known by pins, and the entry rules a runtime
 * enforces at extraction, checked here first.
 */

import {
  describeSelector,
  type ArtifactSelector,
  type LayerRole,
} from "@telorun/analyzer";
import {
  computeFilesIntegrity,
  describeLayerViolations,
  findLayerViolations,
  isPayloadLink,
  isPinnedFile,
  type LayerEntry,
  type LayerViolation,
  type PayloadLayer,
} from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";

/** A layer built from a working copy: what publish pushes and what the release
 *  ledger digests. Mutable-shaped because the transport's own `PayloadLayer` is,
 *  and the two are handed straight across. */
export interface BuiltLayer {
  role: LayerRole;
  selector?: ArtifactSelector;
  /** A pinned entry appears only when the builder reads staged files from their
   *  pins, which publish never does. */
  files: LayerEntry[];
}

/** The layers a transport can push: every entry carries its bytes. Throws for a
 *  payload built from pins, which has none to push. */
export function pushableLayers(layers: readonly BuiltLayer[]): PayloadLayer[] {
  for (const layer of layers) {
    const pinned = layer.files.find(isPinnedFile);
    if (pinned) {
      throw new Error(
        `'${pinned.name}' is known only by its sources: pin, so its layer cannot be pushed — ` +
          `build the payload from staged files (\`stagedFiles: "disk"\`) to publish it.`,
      );
    }
  }
  return layers as PayloadLayer[];
}

/**
 * The `blob` that stands in for a layer holding pinned entries, which has no
 * framed bytes to address: `sha256:` plus the hex form of the layer's integrity
 * digest — a digest over its pinned entries, deterministic across trees and
 * forks. It addresses nothing a registry holds, so only a digest of the manifest
 * that carries it may ever see it; publish frames the staged bytes instead.
 */
export async function pinnedLayerBlob(files: readonly LayerEntry[]): Promise<string> {
  const integrity = await computeFilesIntegrity(files);
  return `sha256:${Buffer.from(integrity.slice("sha256-".length), "base64url").toString("hex")}`;
}

/**
 * Refuse a payload with a layer extraction would refuse — a symbolic link that
 * does not name a file of its own layer, an entry path that is repeated or runs
 * through another entry — caught before anything is framed. A link to a
 * directory gets its own reason, since the link rule would call it dangling.
 */
export function assertLayerEntries(manifestDir: string, layers: readonly BuiltLayer[]): void {
  const problems: string[] = [];
  for (const layer of layers) {
    const elsewhere = new Set(
      layers.filter((other) => other !== layer).flatMap((other) => other.files.map((f) => f.name)),
    );
    const directoryLinks = layer.files.flatMap((file): LayerViolation[] =>
      isPayloadLink(file) && linksToDirectory(path.resolve(manifestDir, file.name))
        ? [
            {
              path: file.name,
              target: file.link,
              reason: "points at a directory; only a link to a file can ship",
            },
          ]
        : [],
    );
    const pointsAtDirectory = new Set(directoryLinks.map((v) => v.path));
    const violations = [
      ...directoryLinks,
      ...findLayerViolations(layer.files, elsewhere).filter(
        (v) => v.target === undefined || !pointsAtDirectory.has(v.path),
      ),
    ];
    if (violations.length === 0) continue;
    const label = layer.selector ? `${layer.role} (${describeSelector(layer.selector)})` : layer.role;
    problems.push(`the ${label} layer:\n${describeLayerViolations(violations)}`);
  }
  if (problems.length === 0) return;
  throw new Error(
    `Module '${path.basename(manifestDir)}' ships entries a runtime would refuse to extract, in ` +
      `${problems.join("\nand ")}\n` +
      `A link ships as a link, and a runtime extracts only the layers it needs, so its target ` +
      `must be a file in the same layer and inside the module directory. Claim the target ` +
      `through the same declaration as the link, point the link at a file that ships beside it, ` +
      `or ship the file itself in place of the link.`,
  );
}

/** Whether the symbolic link at `abs` resolves to a directory. A link that
 *  resolves to nothing is the link rule's to report. */
function linksToDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    throw err;
  }
}
