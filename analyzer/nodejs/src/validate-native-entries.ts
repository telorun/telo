import type { ResourceManifest } from "@telorun/sdk";

import { describeSelector, selectorContradictions, selectorKey } from "./artifact-selector.js";
import { moduleDocumentClaims } from "./module-file-claims.js";
import { describeClaim, nativeClaimConflicts } from "./module-named-files.js";
import { readNativeEntries, type NativeEntry } from "./native-entries.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * The strict half of `native-entries.ts`: what `telo check` reports about a
 * module doc's `native:` block.
 *
 * Every rule is decidable from the manifest and would otherwise surface only on
 * a consumer's host, as a native file that never matches or a layer that
 * overwrites another's file. Shape errors (a missing key, an unknown one) are
 * left to the owner doc's JSON Schema, which reports them in the same pass.
 *
 * Entry-module-scoped: a dependency's block is not the consumer's to fix.
 */
export function validateNativeEntries(
  manifests: ResourceManifest[],
  entryModules?: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : undefined;
    const owned =
      entryModules === undefined ||
      (typeof metadata.module === "string"
        ? entryModules.has(metadata.module)
        : name === undefined || entryModules.has(name));
    if (!owned) continue;

    const label = `${manifest.kind}/${name ?? "(unnamed)"}`;
    const report = (code: string, path: string, message: string) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message: `${label}: ${message}`,
        data: {
          resource: { kind: manifest.kind, name },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path,
        },
      });

    const { entries, problems } = readNativeEntries(manifest);
    for (const problem of problems) {
      if (problem.kind === "shape") continue;
      report(
        problem.kind === "escape" ? "NATIVE_PATH_ESCAPES_MODULE" : "NATIVE_ENTRY_INVALID",
        problem.path,
        problem.message,
      );
    }
    if (entries.length === 0) continue;

    const moduleName = typeof metadata.module === "string" ? metadata.module : name;
    for (const { entry, claim } of nativeClaimConflicts(
      entries,
      moduleDocumentClaims(manifests, moduleName),
    )) {
      report(
        "NATIVE_PATH_CLAIMED",
        `native[${entry.index}].path`,
        `${entry.origin}: path '${entry.path}' is also named by ${describeClaim(claim)}. A native ` +
          `file ships only in its platform's native layer and a file extracts from exactly one ` +
          `layer, so publish refuses it — give the native entry its own file, or drop the other ` +
          `declaration.`,
      );
    }

    const bySelector = new Map<string, NativeEntry>();
    const byPath = new Map<string, NativeEntry>();
    for (const entry of entries) {
      const at = `native[${entry.index}]`;
      if (entry.selector.format === "node" && entry.selector.abi === undefined) {
        report(
          "NATIVE_NODE_ABI_MISSING",
          at,
          `${entry.origin}: a 'node' addon is built against one Node ABI and must state it — ` +
            `add abi: node-<NODE_MODULE_VERSION>, e.g. 'node-137'. Without it the file matches ` +
            `every Node release and fails to load on all but one.`,
        );
      }
      for (const contradiction of selectorContradictions(entry.selector)) {
        report(
          `NATIVE_${contradiction.rule}`,
          `${at}.${contradiction.axis}`,
          `${entry.origin}: ${contradiction.detail}`,
        );
      }

      const key = `${entry.name}\0${selectorKey(entry.selector)}`;
      const twin = bySelector.get(key);
      if (twin) {
        report(
          "NATIVE_ENTRY_DUPLICATE",
          at,
          `${entry.origin}: ${twin.origin} already declares '${entry.name}' for ` +
            `${describeSelector(entry.selector)}. A name has one entry per platform tuple, or ` +
            `a lookup by name could resolve to either file.`,
        );
      } else {
        bySelector.set(key, entry);
      }

      const sharer = byPath.get(entry.path);
      if (sharer && selectorKey(sharer.selector) !== selectorKey(entry.selector)) {
        report(
          "NATIVE_PATH_SHARED",
          `${at}.path`,
          `${entry.origin}: path '${entry.path}' is also declared by ${sharer.origin} for ` +
            `${describeSelector(sharer.selector)}. Every layer of a module extracts into one ` +
            `directory, so each platform tuple needs its own path — e.g. ` +
            `'native/<os>-<arch>/…'.`,
        );
      } else if (!sharer) {
        byPath.set(entry.path, entry);
      }

      const through = [...byPath.values()].find(
        (other) =>
          other !== entry &&
          (entry.path.startsWith(`${other.path}/`) || other.path.startsWith(`${entry.path}/`)),
      );
      if (through) {
        const relation = entry.path.startsWith(`${through.path}/`)
          ? `runs through '${through.path}' as a directory`
          : `is a directory that '${through.path}' runs through`;
        report(
          "NATIVE_PATH_NESTED",
          `${at}.path`,
          `${entry.origin}: path '${entry.path}' ${relation}, and ${through.origin} declares ` +
            `'${through.path}'. Every layer of a module extracts into one directory, so a path ` +
            `cannot be both a file and a directory — give each entry its own path.`,
        );
      }
    }
  }
  return out;
}
