import { isAbsoluteHostPath, type ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel, plainChainOf, producedTypeOf } from "@telorun/templating";
import { holdsHostPath } from "./host-path-slot.js";
import type { KernelGlobalsIndex } from "./kernel-globals.js";
import { navigateSchemaToExprPath } from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * What an import supplies for a library's host-path input, checked where it is
 * written.
 *
 * A library's value comes from its importer's manifest, never from the host, so
 * the library resolves nothing: whatever reaches a host-path input must already
 * be absolute. A value read from the importer's own variable declared as
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
    if (manifest.kind !== "Telo.Import") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.module === "string" && !rootModules.has(metadata.module)) continue;
    const inputs = metadata.hostPathInputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;

    const where = {
      resource: { kind: manifest.kind, name: String(metadata.name ?? "") },
      filePath: typeof metadata.source === "string" ? metadata.source : undefined,
    };
    for (const [input, constants] of Object.entries(inputs as Record<string, string[]>)) {
      const [block, name] = input.split(".") as ["variables" | "secrets", string];
      const supplied = (manifest as Record<string, any>)[block]?.[name];
      // A literal is the importer's text, handed to a library that resolves
      // nothing: it must already be absolute, or be one of the constants the
      // input accepts beside a path.
      if (
        typeof supplied === "string" &&
        !constants.includes(supplied) &&
        !isAbsoluteHostPath(supplied)
      ) {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "HOST_PATH_RELATIVE",
          source: SOURCE,
          message:
            `Telo.Import/${String(metadata.name ?? "")}: '${supplied}' is passed to ` +
            `'${input}', a Telo.HostPath in the imported library, which resolves nothing it ` +
            `is given. Write a file that ships with this module as !module-path <path>, or ` +
            `pass a variable of this application declared x-telo-type: Telo.HostPath, which ` +
            `resolves a relative value against the working directory.`,
          data: { ...where, path: input, fix: { replacement: supplied, tag: "module-path" } },
        });
        continue;
      }
      if (isTaggedSentinel(supplied) && producedTypeOf(supplied.engine)?.type === "string") {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "HOST_PATH_UNTYPED_SOURCE",
          source: SOURCE,
          message:
            `Telo.Import/${String(metadata.name ?? "")}: '${input}' is a Telo.HostPath in the ` +
            `imported library, but !${supplied.engine} produces a plain string, which reaches the ` +
            `library unresolved. Pass a variable declared 'x-telo-type: Telo.HostPath' or a ` +
            `!module-path.`,
          data: { ...where, path: input },
        });
        continue;
      }
      const chain = plainChainOf(supplied);
      if (!chain) continue;
      const source = navigateSchemaToExprPath(kernelGlobals.forResource(manifest), chain);
      if (!source || holdsHostPath(source)) continue;
      if (source.type === undefined && source["x-telo-type"] === undefined) continue;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_UNTYPED_SOURCE",
        source: SOURCE,
        message:
          `Telo.Import/${String(metadata.name ?? "")}: '${input}' is a Telo.HostPath in the ` +
          `imported library, but '${chain}' is declared '${source["x-telo-type"] ?? source.type}', ` +
          `so a relative path reaches the library unresolved and is refused there. Declare ` +
          `'${chain}' with 'x-telo-type: Telo.HostPath' — a variable resolves a relative value ` +
          `against the working directory.`,
        data: { ...where, path: input },
      });
    }
  }
  return out;
}
