import { readValueTypeSlot } from "@telorun/sdk";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { parseAllDocuments } from "yaml";
import { TELO_FORMATS } from "./telo-format.js";
import { readProvidesZone, readRequiresZone, readViolatesZone } from "./zone-slot.js";

/**
 * The `Telo.Builtins` document — the built-in vocabulary of one telo release as
 * a YAML stream, normative in `kernel/specs/builtin-vocabulary.md`. The first
 * document is the root (`kind: Telo.Builtins`, `metadata.name: Telo`, the
 * release's `metadata.version`, `license: MIT`) carrying the shared fragments as
 * `$defs` and the closed vocabularies a definition names (`valueTypes`,
 * `zoneAttributes`, `formats`), and the error codes the runtime raises itself with
 * their texts (`errorCodes`); every later document is one built-in kind in its
 * authored form.
 *
 * It is READ, never declared, run or imported, which is why its kind is
 * registered nowhere: the loader refuses it as an entry, an import of it is an
 * unusable target, and a document of that kind in a module file is an undefined
 * kind — each with the sentence this file words.
 */

export const BUILTIN_VOCABULARY_KIND = "Telo.Builtins";

/** True when a file's first document is the built-in vocabulary's root. */
export function isBuiltinVocabularyRoot(manifest: unknown): boolean {
  return (
    manifest !== null &&
    typeof manifest === "object" &&
    (manifest as { kind?: unknown }).kind === BUILTIN_VOCABULARY_KIND
  );
}

/** What a `Telo.Builtins` document is, said wherever one is refused as anything
 *  else — an entry, or a document inside a module file. */
export const BUILTIN_VOCABULARY_NOT_A_MODULE =
  `${BUILTIN_VOCABULARY_KIND} is the published built-in vocabulary of a telo release; ` +
  `it is read, never declared, run or imported.`;

/** The refusal of an import whose target is the built-in vocabulary. `version`
 *  is the archive's own `metadata.version`. */
export function builtinVocabularyImportMessage(source: string, version: unknown): string {
  const release = typeof version === "string" && version !== "" ? `telo ${version}` : "a telo release";
  return (
    `'${source}' is the built-in vocabulary of ${release}; its kinds need no import — ` +
    `remove this \`imports:\` entry and write them as \`Telo.<Kind>\`.`
  );
}

/** The root's sections, keyed by name. `layers` is the index `telo publish`
 *  appends, present in a published archive and never in a rendered one. */
const ROOT_KEYS = new Set([
  "kind",
  "metadata",
  "$defs",
  "valueTypes",
  "zoneAttributes",
  "formats",
  "errorCodes",
  "layers",
]);
const DOCUMENT_KINDS = new Set(["Telo.Abstract", "Telo.Definition", "Telo.NeedType"]);
const FRAGMENT_REF = "telo://manifest#/$defs/";
/** A key the analyzer reserves for a fragment it hoists into a schema. */
const HOISTED_KEY_PREFIX = "telo:";

export interface BuiltinVocabulary {
  /** The release the archive is the vocabulary of, `metadata.version`. */
  readonly version: string;
  readonly root: Record<string, unknown>;
  /** Every built-in kind document, in archive order. */
  readonly documents: ReadonlyArray<Record<string, unknown>>;
  readonly defs: Readonly<Record<string, unknown>>;
  readonly valueTypes: Readonly<Record<string, unknown>>;
  readonly zoneAttributes: Readonly<Record<string, unknown>>;
  readonly formats: Readonly<Record<string, unknown>>;
  readonly errorCodes: Readonly<Record<string, unknown>>;
}

export type BuiltinVocabularyReading =
  | { readonly vocabulary: BuiltinVocabulary; readonly problems: readonly [] }
  | { readonly vocabulary?: undefined; readonly problems: readonly string[] };

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The JSON Schema formats a validator knows, which resolve without the archive. */
const JSON_SCHEMA_FORMATS: ReadonlySet<string> = new Set(Object.keys(fullFormats));

/**
 * Read an archive and say everything wrong with it. The one reader of the
 * document: `telo publish` refuses an archive with any problem, and the tests
 * that hold the rendered archive to its spec read it here.
 *
 * A problem is a sentence naming where it is. Closure is checked over every kind
 * document and every fragment: each `telo://manifest#/$defs/<Name>` reference
 * resolves in `$defs`, each `x-telo-type` (and each type argument naming one) in
 * `valueTypes`, each zone attribute in `zoneAttributes`, each Telo `format:` in
 * `formats` — so a reader of one release's archive never needs another source.
 */
export function readBuiltinVocabulary(text: string): BuiltinVocabularyReading {
  const problems: string[] = [];
  const parsed = parseAllDocuments(text);
  for (const [i, doc] of parsed.entries()) {
    for (const error of doc.errors) problems.push(`document ${i + 1} does not parse: ${error.message}`);
  }
  if (problems.length > 0) return { problems };

  const [root, ...rest] = parsed.map((doc) => doc.toJSON() as unknown);
  if (!isMap(root) || root.kind !== BUILTIN_VOCABULARY_KIND) {
    return { problems: [`the first document is not \`kind: ${BUILTIN_VOCABULARY_KIND}\`.`] };
  }
  const metadata = isMap(root.metadata) ? root.metadata : {};
  if (metadata.name !== "Telo") {
    problems.push(`the root's \`metadata.name\` is not \`Telo\` — the vocabulary is the module every \`Telo.<Kind>\` names.`);
  }
  const version = metadata.version;
  if (typeof version !== "string" || version === "") {
    problems.push("the root declares no `metadata.version`: an archive is the vocabulary of one release.");
  }
  if (metadata.license !== "MIT") {
    problems.push("the root does not declare `metadata.license: MIT`.");
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) problems.push(`the root declares '${key}', which is no section of the archive.`);
  }

  const section = (name: string): Record<string, unknown> => {
    const value = root[name];
    if (value === undefined) return {};
    if (!isMap(value)) {
      problems.push(`the root's '${name}' is not a map.`);
      return {};
    }
    return value;
  };
  const defs = section("$defs");
  const valueTypes = section("valueTypes");
  const zoneAttributes = section("zoneAttributes");
  const formats = section("formats");
  const errorCodes = section("errorCodes");
  for (const name of Object.keys(defs)) {
    if (name.startsWith(HOISTED_KEY_PREFIX)) {
      problems.push(
        `\`$defs\` holds '${name}': a '${HOISTED_KEY_PREFIX}' key is a hoisted copy, and the archive ` +
          `carries every fragment once, by its own name.`,
      );
    }
  }

  const documents: Record<string, unknown>[] = [];
  rest.forEach((doc, i) => {
    const where = `document ${i + 2}`;
    if (!isMap(doc)) {
      problems.push(`${where} is not a mapping.`);
      return;
    }
    const kind = doc.kind;
    const name = isMap(doc.metadata) ? doc.metadata.name : undefined;
    const label = typeof name === "string" ? `${where} ('${name}')` : where;
    if (typeof kind !== "string" || !DOCUMENT_KINDS.has(kind)) {
      problems.push(`${label} is \`kind: ${String(kind)}\`; the archive holds only ${[...DOCUMENT_KINDS].join(", ")} documents.`);
    }
    if (typeof name !== "string" || name === "") problems.push(`${where} declares no \`metadata.name\`.`);
    if (Object.hasOwn(doc, "controllers")) {
      problems.push(`${label} declares \`controllers:\` — the kernel implements every built-in.`);
    }
    documents.push(doc);
  });

  const closure = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => closure(item, `${where}[${i}]`));
      return;
    }
    if (!isMap(node)) return;
    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith(FRAGMENT_REF)) {
      const fragment = ref.slice(FRAGMENT_REF.length).split("/")[0]!;
      if (!Object.hasOwn(defs, fragment)) {
        problems.push(`${where}: '${ref}' names no fragment in \`$defs\`.`);
      }
    }
    const slot = readValueTypeSlot(node);
    if (slot) {
      if (!Object.hasOwn(valueTypes, slot.name)) {
        problems.push(`${where}: \`x-telo-type: ${slot.name}\` names no entry of \`valueTypes\`.`);
      }
      for (const [parameter, argument] of Object.entries(slot.args)) {
        closure(argument, `${where}.x-telo-type.${parameter}`);
      }
    }
    const attributes = [
      ...Object.keys(readProvidesZone(node)?.attributes ?? {}),
      ...(readRequiresZone(node)?.attributes ?? []),
      ...Object.keys(readViolatesZone(node)),
    ];
    for (const attribute of attributes) {
      if (!Object.hasOwn(zoneAttributes, attribute)) {
        problems.push(`${where}: zone attribute '${attribute}' names no entry of \`zoneAttributes\`.`);
      }
    }
    const format = node.format;
    if (typeof format === "string") {
      const resolves = TELO_FORMATS.has(format)
        ? Object.hasOwn(formats, format)
        : JSON_SCHEMA_FORMATS.has(format);
      if (!resolves) problems.push(`${where}: \`format: ${format}\` names no entry of \`formats\`.`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-telo-type") continue;
      closure(value, `${where}.${key}`);
    }
  };
  for (const [name, body] of Object.entries(defs)) closure(body, `$defs.${name}`);
  for (const [code, entry] of Object.entries(errorCodes)) {
    if (!isMap(entry) || entry.code !== code) {
      problems.push(`\`errorCodes.${code}\` is not an entry declaring \`code: ${code}\`.`);
      continue;
    }
    closure(entry, `errorCodes.${code}`);
  }
  documents.forEach((doc, i) => {
    const name = isMap(doc.metadata) ? doc.metadata.name : undefined;
    closure(doc, typeof name === "string" ? `Telo.${name}` : `document ${i + 2}`);
  });

  if (problems.length > 0) return { problems };
  return {
    vocabulary: {
      version: version as string,
      root,
      documents,
      defs,
      valueTypes,
      zoneAttributes,
      formats,
      errorCodes,
    },
    problems: [],
  };
}
