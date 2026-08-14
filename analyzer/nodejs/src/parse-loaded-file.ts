import type { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { buildCelEnvironment } from "./cel-environment.js";
import type { LoadedFile, ParseError } from "./loaded-types.js";
import { migrateManifests, NO_MIGRATIONS } from "./migrations/driver.js";
import type { MigrationEntry } from "./migrations/types.js";
import { buildDocumentPositions } from "./position-metadata.js";
import { precompileDoc } from "./precompile.js";
import { documentToAst } from "./yaml-ast.js";

export interface ParseOptions {
  /** When true, runs `precompileDoc` per document and stamps compiled CEL
   *  on the manifests — same flag `LoadOptions.compile` carries today. */
  compile?: boolean;
  /** CEL environment for precompile. Defaults to `buildCelEnvironment()`. */
  celEnv?: Environment;
  /** When true, the migration phase runs over the parsed documents — legacy
   *  spellings rewritten to the current ones before anything else reads the
   *  tree. Off by default so a round-trip consumer (the editor) keeps the
   *  author's vocabulary; see `LoadOptions.migrate`. */
  migrate?: boolean;
  /** Migration set. Defaults to the analyzer's own `CORE_MIGRATIONS`. */
  migrations?: readonly MigrationEntry[];
}

/** Append an actionable hint to raw yaml-parser messages that are otherwise
 *  cryptic. The parser reports `BLOCK_AS_IMPLICIT_KEY` ("Nested mappings are
 *  not allowed in compact mappings") when a plain (unquoted) scalar contains
 *  `: ` (colon-space) — the parser reads the colon as a nested key. Telling the
 *  author to quote the value turns an opaque error into a one-step fix. */
function augmentParseMessage(err: import("yaml").YAMLError): string {
  if (err.code === "BLOCK_AS_IMPLICIT_KEY") {
    return `${err.message}\n\nHint: a plain (unquoted) value cannot contain ': ' (colon followed by a space) — the parser reads it as a nested mapping. Wrap the value in quotes, e.g. \`description: "… \`encoding: base64\` …"\`.`;
  }
  return err.message;
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

/** Pure: text in, structured load result out. No I/O, no caches. */
export function parseLoadedFile(
  source: string,
  requestedUrl: string,
  text: string,
  options?: ParseOptions,
): LoadedFile {
  const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const astDocuments = documents.map((doc) => documentToAst(doc, text));
  const positions = buildDocumentPositions(text, astDocuments);

  const parseErrors: ParseError[] = [];
  documents.forEach((doc, documentIndex) => {
    for (const err of doc.errors) {
      parseErrors.push({
        documentIndex,
        message: augmentParseMessage(err),
        range: rangeFromLinePos(err.linePos),
      });
    }
  });

  const manifests: Array<ResourceManifest | null> = documents.map((doc) => {
    const raw = doc.toJSON();
    return raw === null || raw === undefined ? null : (raw as ResourceManifest);
  });

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

  let env: Environment | undefined;
  if (options?.compile) {
    for (let i = 0; i < manifests.length; i++) {
      const raw = manifests[i];
      if (raw === null) continue;
      env ??= options.celEnv ?? buildCelEnvironment();
      try {
        manifests[i] = precompileDoc(raw, env) as ResourceManifest;
      } catch (error) {
        throw new Error(
          `Failed to compile manifest in ${source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    source,
    requestedUrl,
    text,
    documents,
    astDocuments,
    manifests,
    positions,
    parseErrors,
    migrations,
  };
}
