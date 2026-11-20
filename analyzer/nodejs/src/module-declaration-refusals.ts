import { isBuiltinVocabularyRoot } from "./builtin-vocabulary.js";
import type { LoadedFile, ParseError } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import type { Range } from "./types.js";

/** The document kinds only a module's own `telo.yaml` declares. */
const OWNER_ONLY_KINDS = new Set(["Telo.Application", "Telo.Library", "Telo.Import", "Telo.Definition"]);

const FILE_START: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export const MODULE_DECLARATION_MISSING_MESSAGE =
  "This file declares no module: a module's telo.yaml declares exactly one Telo.Application or " +
  "Telo.Library, and a partial is checked and run through the module that includes it.";

function moduleDeclarationDuplicateMessage(kinds: readonly string[]): string {
  return (
    `This file declares ${kinds.length} module documents (${kinds.join(", ")}): a module's telo.yaml ` +
    `declares exactly one Telo.Application or Telo.Library; keep one and move each other module to a ` +
    `telo.yaml in a directory of its own.`
  );
}

/** What an import of a library holding several module documents is refused with. */
export function duplicateModuleTargetMessage(kinds: readonly string[]): string {
  return (
    `it declares ${kinds.length} module documents (${kinds.join(", ")}); a library's telo.yaml ` +
    `declares exactly one Telo.Library.`
  );
}

/** The kinds of every module document of `file`, in file order. */
export function moduleDocumentKinds(file: LoadedFile): string[] {
  return file.manifests
    .map((m) => m?.kind)
    .filter((kind): kind is string => typeof kind === "string" && isModuleKind(kind));
}

function kindRange(file: LoadedFile, index: number): Range | undefined {
  const positions = file.positions[index]?.positionIndex;
  return positions?.get("kind") ?? positions?.get("");
}

/**
 * The module-declaration rule over a module's main `telo.yaml`: exactly one
 * `Telo.Application` or `Telo.Library`. None is `MODULE_DECLARATION_MISSING` (at
 * the first document's `kind:`, the file's start for an empty file), more than
 * one `MODULE_DECLARATION_DUPLICATE` at the second module document's `kind:`.
 * The built-in vocabulary archive is no module and is refused on its own terms,
 * and a file that did not parse is judged by nothing more: its documents are
 * not what its author wrote.
 */
export function moduleDeclarationErrors(file: LoadedFile): ParseError[] {
  if (file.parseErrors.length > 0 || isBuiltinVocabularyRoot(file.manifests[0])) return [];
  const moduleIndexes: number[] = [];
  file.manifests.forEach((m, index) => {
    if (m && typeof m.kind === "string" && isModuleKind(m.kind)) moduleIndexes.push(index);
  });
  if (moduleIndexes.length === 1) return [];
  if (moduleIndexes.length === 0) {
    const first = file.manifests.findIndex((m) => m !== null && m !== undefined);
    return [
      {
        documentIndex: Math.max(first, 0),
        code: "MODULE_DECLARATION_MISSING",
        message: MODULE_DECLARATION_MISSING_MESSAGE,
        range: (first >= 0 ? kindRange(file, first) : undefined) ?? FILE_START,
      },
    ];
  }
  const second = moduleIndexes[1]!;
  const range = kindRange(file, second);
  return [
    {
      documentIndex: second,
      code: "MODULE_DECLARATION_DUPLICATE",
      message: moduleDeclarationDuplicateMessage(moduleDocumentKinds(file)),
      ...(range ? { range } : {}),
    },
  ];
}

/** `PARTIAL_KIND_FORBIDDEN` for each document of a partial whose kind only the
 *  including module's `telo.yaml` may declare, at its `kind:`. */
export function partialKindErrors(file: LoadedFile): ParseError[] {
  const errors: ParseError[] = [];
  file.manifests.forEach((m, index) => {
    const kind = m?.kind;
    if (typeof kind !== "string" || !OWNER_ONLY_KINDS.has(kind)) return;
    const range = kindRange(file, index);
    errors.push({
      documentIndex: index,
      code: "PARTIAL_KIND_FORBIDDEN",
      message:
        `A partial may not declare a '${kind}' document: Telo.Application, Telo.Library, ` +
        `Telo.Import and Telo.Definition documents are declared only in the telo.yaml that includes it.`,
      ...(range ? { range } : {}),
    });
  });
  return errors;
}

/** `PARTIAL_GLOB_UNSUPPORTED` for an `include:` glob the module's source cannot expand. */
export function partialGlobUnsupportedError(pattern: string, documentIndex: number, range?: Range): ParseError {
  return {
    documentIndex,
    code: "PARTIAL_GLOB_UNSUPPORTED",
    message:
      `'${pattern}' is a glob, and the source this module is read from cannot list files to ` +
      `expand it; name each partial by its path instead.`,
    ...(range ? { range } : {}),
  };
}

/** The reason a partial could not be read: the source failure's sentence, except for
 *  `not-a-module`, whose sentence speaks of modules and no partial is one. */
export function partialFailureReason(failure: { sourceFailure: string; location: string; message: string }): string {
  return failure.sourceFailure === "not-a-module"
    ? `${failure.location} is not a file: an include: entry names one YAML file, or a glob over several.`
    : failure.message;
}

/** `PARTIAL_NOT_FOUND` for an `include:` entry naming a partial its source could not hand over. */
export function partialNotFoundError(
  pattern: string,
  reason: string,
  documentIndex: number,
  range?: Range,
): ParseError {
  return {
    documentIndex,
    code: "PARTIAL_NOT_FOUND",
    message: `The partial '${pattern}' cannot be read: ${reason}`,
    ...(range ? { range } : {}),
  };
}

/** `file` with `errors` added to its parse errors, as a copy — the loader's cached
 *  file is shared by every graph and never written to. */
export function withLoaderErrors(file: LoadedFile, errors: readonly ParseError[]): LoadedFile {
  if (errors.length === 0) return file;
  // Copied by descriptor: a file restored from a parse cache reads its YAML
  // documents through getters, and a spread would parse them.
  const out = Object.defineProperties({}, Object.getOwnPropertyDescriptors(file)) as LoadedFile;
  Object.defineProperty(out, "parseErrors", {
    value: [...file.parseErrors, ...errors],
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return out;
}
