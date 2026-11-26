import type { HostEntryKind, ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel, plainChainOf, producedTypeOf } from "@telorun/templating";
import type { TaggedSentinel } from "@telorun/templating";
import { foundEntryOf, foundHeadOf } from "./module-file-existence.js";
import {
  describeHostEntry,
  holdsHostPath,
  hostEntryAt,
  hostMediaTypeAt,
  hostMediaTypeMismatchAt,
  type HostPathInput,
} from "./host-path-slot.js";
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
 * be absolute. A literal is the import-inputs pass's, which holds every supplied
 * literal to the library's declaration. A value read from the importer's own variable declared as
 * something else (`type: string`) carries relative text through unresolved and
 * is refused inside the library at creation — in a file the importer did not
 * write. `HOST_PATH_UNTYPED_SOURCE` says so at the import instead. A
 * `!module-path` is a host path, anchored at the importing module; it is held to
 * the entry and media type the input declares, from what the loader found at
 * its claim. Which of the
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
        ...hostPathInputFindings(manifest, input, declared, (manifest as Record<string, any>)[block]?.[name], (chain) => {
          const schema = navigateSchemaToExprPath(kernelGlobals.forResource(manifest), chain);
          return schema ? { schema } : undefined;
        },
        ),
      );
    }
  }
  return out;
}

/** A library input as the library names it — `variable 'root'`, never as a
 *  place of the import, where a choice may hold its value elsewhere. */
function libraryInput(input: string): string {
  const dot = input.indexOf(".");
  const block = input.slice(0, dot);
  return `${block === "secrets" ? "secret" : "variable"} '${input.slice(dot + 1)}'`;
}

/** What a supplied chain reads: the schema node it is read from and, where its
 *  site's environment types it, its CEL type. */
export interface HostPathSource {
  readonly schema?: Record<string, any>;
  readonly celType?: string;
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
  source: (chain: string) => HostPathSource | undefined,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  const where = {
    resource: { kind: manifest.kind, name: String(metadata.name ?? "") },
    filePath: typeof metadata.source === "string" ? metadata.source : undefined,
  };
  // A literal is held to the library's declaration by the import-inputs
  // pass (`validate-import-inputs.ts`), which reports a relative one. A tag is
  // judged by the value it produces: a host path (`!module-path`) is held to
  // what the loader found at its claim, anything else is a plain string.
  const produced = isTaggedSentinel(supplied) ? producedTypeOf(supplied.engine) : undefined;
  if (isTaggedSentinel(supplied) && holdsHostPath(produced)) {
    return foundFileFindings(supplied, input, declared, metadata, where);
  }
  if (isTaggedSentinel(supplied) && produced?.type === "string") {
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_UNTYPED_SOURCE",
      source: SOURCE,
      message:
        `Telo.Import/${String(metadata.name ?? "")}: the imported library's ${libraryInput(input)} is a ` +
        `Telo.HostPath, but !${supplied.engine} produces a plain string, which reaches the ` +
        `library unresolved. Pass a variable declared 'x-telo-type: Telo.HostPath' or a ` +
        `!module-path.`,
      data: { ...where, path: input },
    });
    return out;
  }
  const chain = plainChainOf(supplied);
  if (!chain) return out;
  const read = source(chain);
  if (!read) return out;
  const typed = read.schema ?? {};
  if (read.celType === "Telo.HostPath" || holdsHostPath(typed)) {
    const named = hostEntryAt(typed);
    if (declared.entry !== undefined && named !== undefined && named !== declared.entry) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_ENTRY_MISMATCH",
        source: SOURCE,
        message:
          `Telo.Import/${String(metadata.name ?? "")}: the imported library's ${libraryInput(input)} is the path of ` +
          `${describeHostEntry(declared.entry)}, but \`${chain}\` is ` +
          `declared to name ${describeHostEntry(named)} (entry: ${named}).`,
        data: { ...where, path: input },
      });
      return out;
    }
    const media = hostMediaTypeAt(typed);
    if (declared.mediaType !== undefined && media !== undefined && media !== declared.mediaType) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_CONTENT_MISMATCH",
        source: SOURCE,
        message:
          `Telo.Import/${String(metadata.name ?? "")}: the imported library's ${libraryInput(input)} is the path of a file of ` +
          `${declared.mediaType}, but \`${chain}\` is declared to hold ` +
          `${media} (mediaType: ${media}).`,
        data: { ...where, path: input },
      });
    }
    return out;
  }
  const declaredAs = typed["x-telo-type"] ?? typed.type ?? read.celType;
  if (declaredAs === undefined || declaredAs === "dyn") return out;
  out.push({
    severity: DiagnosticSeverity.Error,
    code: "HOST_PATH_UNTYPED_SOURCE",
    source: SOURCE,
    message:
      `Telo.Import/${String(metadata.name ?? "")}: the imported library's ${libraryInput(input)} is a ` +
      `Telo.HostPath, but \`${chain}\` is declared '${declaredAs}', ` +
      `so a relative path reaches the library unresolved and is refused there. Declare ` +
      `\`${chain}\` with 'x-telo-type: Telo.HostPath' — a variable resolves a relative value ` +
      `against the working directory.`,
    data: { ...where, path: input },
  });
  return out;
}

/**
 * A module file an import hands a library's host-path input, held to what the
 * input says it names. Nothing when the loader stamped nothing, which a source
 * that cannot answer leaves.
 */
function foundFileFindings(
  supplied: TaggedSentinel,
  input: string,
  declared: HostPathInput,
  metadata: Record<string, unknown>,
  where: { resource: { kind: string; name: string }; filePath: string | undefined },
): AnalysisDiagnostic[] {
  const mismatch = moduleFileMismatch(supplied, declared);
  if (!mismatch) return [];
  return [{
    severity: DiagnosticSeverity.Error,
    code: mismatch.code,
    source: SOURCE,
    message: `Telo.Import/${String(metadata.name ?? "")}: the imported library's ${libraryInput(input)} ${mismatch.text}`,
    data: { ...where, path: input },
  }];
}

/**
 * What a `!module-path` handed to a host path that declares an `entry` /
 * `mediaType` contradicts, from what the loader found at its claim: the entry
 * against `entry`, a file's leading bytes against `mediaType`. `text` follows
 * the subject naming the host path (`is the path of a file, but …`).
 */
export function moduleFileMismatch(
  supplied: TaggedSentinel,
  declared: { readonly entry?: HostEntryKind; readonly mediaType?: string },
): { code: "HOST_PATH_ENTRY_MISMATCH" | "HOST_PATH_CONTENT_MISMATCH"; text: string } | undefined {
  const found = foundEntryOf(supplied);
  if (found === undefined) return undefined;
  const written = `\`!${supplied.engine} ${supplied.source.trim()}\``;
  if (declared.entry !== undefined && declared.entry !== found) {
    return {
      code: "HOST_PATH_ENTRY_MISMATCH",
      text: `is the path of ${describeHostEntry(declared.entry)}, but ${written} names ${describeHostEntry(found)}.`,
    };
  }
  if (declared.mediaType === undefined) return undefined;
  const head = foundHeadOf(supplied);
  const mismatch =
    found === "directory"
      ? ("directory" as const)
      : head
        ? hostMediaTypeMismatchAt(
            { type: "string", "x-telo-type": { name: "Telo.HostPath", mediaType: declared.mediaType } },
            head,
          )
        : undefined;
  if (!mismatch) return undefined;
  const held =
    mismatch === "directory"
      ? "names a directory"
      : mismatch.found !== undefined
        ? `holds ${mismatch.found}`
        : "carries no known media type's signature";
  return {
    code: "HOST_PATH_CONTENT_MISMATCH",
    text: `is the path of a file of ${declared.mediaType}, but ${written} ${held}.`,
  };
}
