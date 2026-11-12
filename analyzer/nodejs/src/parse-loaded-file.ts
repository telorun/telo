import type { CelEnvironment } from "@telorun/cel";
import { RuntimeError, type ResourceManifest } from "@telorun/sdk";
import { defaultCustomTags, siteEnvironment, type CelProgramSite } from "@telorun/templating";
import { parseAllDocuments, visit, type Document } from "yaml";
import { buildCelEnvironment } from "./cel-environment.js";
import type { LoadedFile, ParseError } from "./loaded-types.js";
import { migrateManifests, NO_MIGRATIONS } from "./migrations/driver.js";
import type { MigrationEntry } from "./migrations/types.js";
import { loaderExpansionRefusals } from "./loader-expansion-refusals.js";
import { buildDocumentPositions, buildLineOffsets, offsetToPosition } from "./position-metadata.js";
import { expandManifestFragments } from "./manifest-schemas.js";
import { moduleCallNamesOfFile } from "./module-call-names.js";
import { precompileDoc } from "./precompile.js";
import { documentToAst } from "./yaml-ast.js";
import type { CachedYamlParse } from "./yaml-parse-cache.js";

export interface ParseOptions {
  /** When true, runs `precompileDoc` per document and stamps compiled CEL
   *  on the manifests — same flag `LoadOptions.compile` carries today. */
  compile?: boolean;
  /** CEL environment for precompile. Defaults to `buildCelEnvironment()`. */
  celEnv?: CelEnvironment;
  /** When true, the migration phase runs over the parsed documents — legacy
   *  spellings rewritten to the current ones before anything else reads the
   *  tree. Off by default so a round-trip consumer (the editor) keeps the
   *  author's vocabulary; see `LoadOptions.migrate`. */
  migrate?: boolean;
  /** Migration set. Defaults to the analyzer's own `CORE_MIGRATIONS`. */
  migrations?: readonly MigrationEntry[];
  /** The INCLUDING module's CEL call names, for a partial.
   *
   *  A file that carries its own module doc derives its names from it (they are
   *  known from the file itself, before any import resolves); a partial carries
   *  none, and its expressions belong to the module that included it — so the
   *  owner's set is passed down by whoever resolved the `include:` list. */
  moduleNames?: ReadonlySet<string>;
}

/** What each YAML error says: one closed set of kinds, one sentence each, worded by Telo
 *  rather than by a parser so that every engine reports a malformed file in the same
 *  words (the Rust loader's `parse_error_message`). Each loader classifies its own
 *  parser's errors into a kind; one it cannot place is `unreadable`. */
export const PARSE_ERROR_MESSAGES = {
  duplicateKey:
    "This key is already written earlier in the same mapping; a mapping holds each key once, so remove or rename one of the two.",
  unresolvedAlias:
    "This alias names no anchor written before it in the document; write the anchor (`&name`) on an earlier value, or write the value out in place of the alias.",
  aliasLimit:
    "The aliases in this document expand into more copies of their values than a manifest may hold; write the repeated values out, or alias them fewer times.",
  unclosedQuote: "A quoted value is never closed; end it with the quote character it opens with.",
  unclosedFlowCollection:
    "A bracketed list or map ('[…]' or '{…}') is not closed, or a line inside it is not indented past the key holding it; close it with the matching ']' or '}', and indent its continuation lines.",
  tabIndentation: "A tab indents this line; YAML indents with spaces only.",
  plainValueColon:
    "A plain (unquoted) value cannot contain ': ' (a colon followed by a space), which the parser reads as a nested mapping; wrap the value in quotes, e.g. `description: \"… encoding: base64 …\"`.",
  badIndentation:
    "This line is not indented to match the entries beside it; align it with its siblings, or indent it under the key it belongs to.",
  invalidEscape:
    "A double-quoted value holds an escape sequence YAML does not define; write the backslash itself as `\\\\`, or use single quotes, inside which a backslash is literal.",
  reservedCharacter: "A plain value cannot start with '@' or '`', which YAML reserves; wrap the value in quotes.",
  unreadable: "This is not valid YAML; check the indentation, quoting and brackets at this position.",
} as const;

export type ParseErrorKind = keyof typeof PARSE_ERROR_MESSAGES;

/** The kind of one of the `yaml` package's errors, read from its code and, where one code
 *  covers several causes, its message. */
function parseErrorKind(err: import("yaml").YAMLError): ParseErrorKind {
  const message = err.message;
  switch (err.code) {
    case "DUPLICATE_KEY":
      return "duplicateKey";
    case "TAB_AS_INDENT":
      return "tabIndentation";
    case "BAD_DQ_ESCAPE":
      return "invalidEscape";
    case "BLOCK_AS_IMPLICIT_KEY":
      return message.startsWith("Nested mappings are not allowed in compact mappings")
        ? "plainValueColon"
        : "unreadable";
    case "MISSING_CHAR":
      if (message.startsWith("Missing closing")) return "unclosedQuote";
      if (/^Flow (sequence|map) must end with/.test(message)) return "unclosedFlowCollection";
      return "unreadable";
    case "BAD_INDENT":
      if (/^Flow (sequence|map) in block collection must be sufficiently indented/.test(message)) {
        return "unclosedFlowCollection";
      }
      if (/^All (mapping|sequence) items must start at the same column/.test(message)) return "badIndentation";
      return "unreadable";
    case "BAD_SCALAR_START":
      return message.includes("reserved character") ? "reservedCharacter" : "unreadable";
    default:
      return "unreadable";
  }
}

/** The kind of a failure `doc.toJSON()` throws, which is how `yaml` refuses an alias:
 *  undefined for anything else, which is not the parser's to report. */
function aliasFailureKind(error: unknown): "unresolvedAlias" | "aliasLimit" | undefined {
  if (!(error instanceof ReferenceError)) return undefined;
  if (error.message.startsWith("Unresolved alias")) return "unresolvedAlias";
  if (error.message.startsWith("Excessive alias count")) return "aliasLimit";
  return undefined;
}

/** The first alias of `doc`, in conversion order, naming no anchor before it. */
function unresolvedAliasRange(doc: Document, text: string): import("./types.js").Range | undefined {
  let range: import("./types.js").Range | undefined;
  visit(doc, {
    Alias(_key, node) {
      if (node.resolve(doc) || !node.range) return;
      const lineOffsets = buildLineOffsets(text);
      range = {
        start: offsetToPosition(node.range[0], lineOffsets),
        end: offsetToPosition(node.range[1], lineOffsets),
      };
      return visit.BREAK;
    },
  });
  return range;
}

/** The yaml lib reports 1-based `{line, col}` pairs; convert to a 0-based
 *  analyzer `Range`. Returns undefined when the error carried no position. */
function rangeFromLinePos(
  linePos: import("yaml").YAMLError["linePos"],
): import("./types.js").Range | undefined {
  const start = linePos?.[0];
  if (!start) return undefined;
  const end = linePos?.[1] ?? start;
  return {
    start: { line: start.line - 1, character: start.col - 1 },
    end: { line: end.line - 1, character: end.col - 1 },
  };
}

/**
 * The YAML half of a parse — the expensive half, and the same for every load
 * variant of one text. `manifests` is a pristine snapshot that nothing may
 * mutate: every variant clones it, because migration, precompile and desugaring
 * each rewrite the tree they are given.
 */
export interface ParsedYaml {
  readonly documents: LoadedFile["documents"];
  readonly astDocuments: LoadedFile["astDocuments"];
  readonly positions: LoadedFile["positions"];
  readonly parseErrors: readonly ParseError[];
  readonly manifests: ReadonlyArray<ResourceManifest | null>;
}

export function parseYamlText(text: string): ParsedYaml {
  const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const astDocuments = documents.map((doc) => documentToAst(doc, text));
  const positions = buildDocumentPositions(text, astDocuments);

  const parseErrors: ParseError[] = [];
  documents.forEach((doc, documentIndex) => {
    for (const err of doc.errors) {
      parseErrors.push({
        documentIndex,
        message: PARSE_ERROR_MESSAGES[parseErrorKind(err)],
        range: rangeFromLinePos(err.linePos),
      });
    }
  });

  const manifests = documents.map((doc, documentIndex) => {
    let raw: unknown;
    try {
      raw = doc.toJSON();
    } catch (error) {
      const kind = aliasFailureKind(error);
      if (!kind) throw error;
      const range = kind === "unresolvedAlias" ? unresolvedAliasRange(doc, text) : undefined;
      parseErrors.push({ documentIndex, message: PARSE_ERROR_MESSAGES[kind], ...(range ? { range } : {}) });
      return null;
    }
    return raw === null || raw === undefined ? null : (raw as ResourceManifest);
  });
  parseErrors.push(...loaderExpansionRefusals(text, documents, manifests, positions));
  return { documents, astDocuments, positions, parseErrors, manifests };
}

const restoredParses = new WeakSet<ParsedYaml>();

/** A parse restored from a {@link YamlParseCache}: the cached manifests and
 *  positions, and the `yaml` documents parsed from `text` only if something
 *  reads them. */
export function restoredYaml(text: string, cached: CachedYamlParse): ParsedYaml {
  let full: ParsedYaml | undefined;
  const parse = () => (full ??= parseYamlText(text));
  const restored: ParsedYaml = {
    get documents() {
      return parse().documents;
    },
    get astDocuments() {
      return parse().astDocuments;
    },
    positions: cached.positions as LoadedFile["positions"],
    parseErrors: [],
    manifests: cached.manifests,
  };
  restoredParses.add(restored);
  return restored;
}

/** Pure: text in, structured load result out. No I/O, no caches — a caller
 *  holding `parsed` for this exact `text` passes it to skip the YAML parse. */
export function parseLoadedFile(
  source: string,
  requestedUrl: string,
  text: string,
  options?: ParseOptions,
  shared?: ParsedYaml,
): LoadedFile {
  const parsed = shared ?? parseYamlText(text);
  const { positions } = parsed;
  const parseErrors = [...parsed.parseErrors];
  const manifests = (
    shared ? structuredClone(parsed.manifests) : parsed.manifests
  ) as Array<ResourceManifest | null>;

  // The migration phase, immediately after parse. It runs BEFORE precompile so
  // matchers see the values the author wrote rather than `CompiledValue`
  // wrappers, and — through the loader — before `desugarLoadedFile`, so a rule
  // only ever matches author-written nodes: a synthetic Telo.Import manifest
  // has no YAML document to edit, records a path the file never had, and
  // carries its `variables` / `secrets` by reference from the module doc, so a
  // match inside one would apply twice.
  const migrations = options?.migrate
    ? migrateManifests({ source, manifests, entries: options.migrations })
    : NO_MIGRATIONS;

  // Shared structural fragments (`telo://manifest#/$defs/InvokeStep`) are
  // expanded for EVERY consumer, deliberately ungated.
  //
  // They are not authoring sugar the way `imports:` or a `!ref` tag is — they are
  // the analyzer's own closed set, and nothing downstream is equipped to meet one
  // unresolved: the editor's schema resolver handles document-local `#/` refs
  // only and THROWS on anything else, so a gated expansion took every canvas that
  // renders a `Run` step down. Round-tripping is unaffected because a save writes
  // the YAML documents the editor holds separately (`saveModuleFromDocuments`),
  // never a manifest object — so unlike `migrate`, no expansion here can reach an
  // author's file.
  for (const manifest of manifests) {
    if (manifest) expandManifestFragments(manifest);
  }

  let env: CelEnvironment | undefined;
  let celProgramSites: CelProgramSite[] | undefined;
  if (options?.compile) {
    // Resolution needs the declaring module's names, and they are read from the
    // documents as they stand here — after migration and fragment expansion,
    // before desugaring, which is where the author's `imports:` map still is.
    const moduleNames = moduleCallNamesOfFile(manifests, options.moduleNames);
    celProgramSites = [];
    for (let i = 0; i < manifests.length; i++) {
      const raw = manifests[i];
      if (raw === null) continue;
      // One environment for the whole file, so every expression in it can be
      // emitted into one module.
      env ??= siteEnvironment(options.celEnv ?? buildCelEnvironment(), moduleNames);
      try {
        manifests[i] = precompileDoc(raw, env, moduleNames, "", celProgramSites) as ResourceManifest;
      } catch (error) {
        const message = `Failed to compile manifest in ${source}: ${error instanceof Error ? error.message : String(error)}`;
        if (error instanceof RuntimeError) throw new RuntimeError(error.code, message);
        throw new Error(message);
      }
    }
  }

  if (restoredParses.has(parsed)) {
    // Read through, so a restored parse stays unparsed unless its documents
    // are asked for.
    return Object.defineProperties(
      {
        source,
        requestedUrl,
        text,
        manifests,
        positions,
        parseErrors,
        migrations,
        ...(celProgramSites ? { celProgramSites } : {}),
      },
      {
        documents: { get: () => parsed.documents, enumerable: true },
        astDocuments: { get: () => parsed.astDocuments, enumerable: true },
      },
    ) as LoadedFile;
  }
  return {
    source,
    requestedUrl,
    text,
    documents: parsed.documents,
    astDocuments: parsed.astDocuments,
    manifests,
    positions,
    parseErrors,
    migrations,
    ...(celProgramSites ? { celProgramSites } : {}),
  };
}
