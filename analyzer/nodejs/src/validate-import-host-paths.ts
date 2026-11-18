import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel, plainChainOf, producedTypeOf } from "@telorun/templating";
import {
  describeHostEntry,
  holdsHostPath,
  hostEntryAt,
  hostMediaTypeAt,
  type HostPathInput,
} from "./host-path-slot.js";
import type { KernelGlobalsIndex } from "./kernel-globals.js";
import { withQuotedPath } from "./quoted-place.js";
import { navigateSchemaToExprPath } from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * What an import supplies for a library's host-path input, checked where it is
 * written.
 *
 * A library's value comes from its importer's manifest, never from the host, so
 * the library resolves nothing: whatever reaches a host-path input must already
 * be absolute. A literal is the import-inputs pass's, which holds every supplied
 * literal to the library's declaration. A value read from the importer's own variable declared as
 * something else (`type: string`) carries relative text through unresolved and
 * is refused inside the library at creation — in a file the importer did not
 * write. `HOST_PATH_UNTYPED_SOURCE` says so at the import instead. Which of the
 * library's inputs hold host paths is stamped on the import by the flattener
 * (`metadata.hostPathInputs`), since the library doc itself is dropped.
 *
 * Entry-module-scoped: an import inside a dependency is its author's to fix.
 */
export function validateImportHostPaths(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  kernelGlobals: KernelGlobalsIndex,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    for (const [input, declared] of hostPathInputsOf(manifest, rootModules)) {
      const [block, name] = input.split(".") as ["variables" | "secrets", string];
      out.push(
        ...hostPathInputFindings(manifest, input, declared, (manifest as Record<string, any>)[block]?.[name], (chain) =>
          navigateSchemaToExprPath(kernelGlobals.forResource(manifest), chain),
        ),
      );
    }
  }
  return out;
}

/** The host-path inputs of the library an entry-module import supplies. */
export function hostPathInputsOf(manifest: ResourceManifest, rootModules: ReadonlySet<string>): [string, HostPathInput][] {
  if (manifest.kind !== "Telo.Import") return [];
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.module === "string" && !rootModules.has(metadata.module)) return [];
  const inputs = metadata.hostPathInputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return [];
  return Object.entries(inputs as Record<string, HostPathInput>);
}

/**
 * What one supplied host-path input says of itself: `source` types the chain a
 * plain `!cel` value reads — where a configuration decides it, in that
 * configuration.
 */
export function hostPathInputFindings(
  manifest: ResourceManifest,
  input: string,
  declared: HostPathInput,
  supplied: unknown,
  source: (chain: string) => Record<string, any> | undefined,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  const where = {
    resource: { kind: manifest.kind, name: String(metadata.name ?? "") },
    filePath: typeof metadata.source === "string" ? metadata.source : undefined,
  };
  // A literal is held to the library's declaration by the import-inputs
  // pass (`validate-import-inputs.ts`), which reports a relative one.
  if (isTaggedSentinel(supplied) && producedTypeOf(supplied.engine)?.type === "string") {
    out.push(withQuotedPath({
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_UNTYPED_SOURCE",
      source: SOURCE,
      message:
        `Telo.Import/${String(metadata.name ?? "")}: '${input}' is a Telo.HostPath in the ` +
        `imported library, but !${supplied.engine} produces a plain string, which reaches the ` +
        `library unresolved. Pass a variable declared 'x-telo-type: Telo.HostPath' or a ` +
        `!module-path.`,
      data: { ...where, path: input },
    }, input));
    return out;
  }
  const chain = plainChainOf(supplied);
  if (!chain) return out;
  const typed = source(chain);
  if (!typed) return out;
  if (holdsHostPath(typed)) {
    const named = hostEntryAt(typed);
    if (declared.entry !== undefined && named !== undefined && named !== declared.entry) {
      out.push(withQuotedPath({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_ENTRY_MISMATCH",
        source: SOURCE,
        message:
          `Telo.Import/${String(metadata.name ?? "")}: '${input}' is the path of ` +
          `${describeHostEntry(declared.entry)} in the imported library, but '${chain}' is ` +
          `declared to name ${describeHostEntry(named)} (entry: ${named}).`,
        data: { ...where, path: input },
      }, input));
      return out;
    }
    const media = hostMediaTypeAt(typed);
    if (declared.mediaType !== undefined && media !== undefined && media !== declared.mediaType) {
      out.push(withQuotedPath({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_CONTENT_MISMATCH",
        source: SOURCE,
        message:
          `Telo.Import/${String(metadata.name ?? "")}: '${input}' is the path of a file of ` +
          `${declared.mediaType} in the imported library, but '${chain}' is declared to hold ` +
          `${media} (mediaType: ${media}).`,
        data: { ...where, path: input },
      }, input));
    }
    return out;
  }
  if (typed.type === undefined && typed["x-telo-type"] === undefined) return out;
  out.push(withQuotedPath({
    severity: DiagnosticSeverity.Error,
    code: "HOST_PATH_UNTYPED_SOURCE",
    source: SOURCE,
    message:
      `Telo.Import/${String(metadata.name ?? "")}: '${input}' is a Telo.HostPath in the ` +
      `imported library, but '${chain}' is declared '${typed["x-telo-type"] ?? typed.type}', ` +
      `so a relative path reaches the library unresolved and is refused there. Declare ` +
      `'${chain}' with 'x-telo-type: Telo.HostPath' — a variable resolves a relative value ` +
      `against the working directory.`,
    data: { ...where, path: input },
  }, input));
  return out;
}
