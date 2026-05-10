import type { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { buildCelEnvironment } from "./cel-environment.js";
import type { LoadedFile, ParseError } from "./loaded-types.js";
import { buildDocumentPositions } from "./position-metadata.js";
import { precompileDoc } from "./precompile.js";

export interface ParseOptions {
  /** When true, runs `precompileDoc` per document and stamps compiled CEL
   *  on the manifests — same flag `LoadOptions.compile` carries today. */
  compile?: boolean;
  /** CEL environment for precompile. Defaults to `buildCelEnvironment()`. */
  celEnv?: Environment;
}

/** Pure: text in, structured load result out. No I/O, no caches. */
export function parseLoadedFile(
  source: string,
  requestedUrl: string,
  text: string,
  options?: ParseOptions,
): LoadedFile {
  const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const positions = buildDocumentPositions(text, documents);

  const parseErrors: ParseError[] = [];
  documents.forEach((doc, documentIndex) => {
    for (const err of doc.errors) {
      parseErrors.push({
        documentIndex,
        message: err.message,
      });
    }
  });

  const manifests: Array<ResourceManifest | null> = [];
  let env: Environment | undefined;
  for (const doc of documents) {
    const raw = doc.toJSON();
    if (raw === null || raw === undefined) {
      manifests.push(null);
      continue;
    }
    if (options?.compile) {
      env ??= options.celEnv ?? buildCelEnvironment();
      try {
        const compiled = precompileDoc(raw, env);
        manifests.push(compiled as ResourceManifest);
      } catch (error) {
        throw new Error(
          `Failed to compile manifest in ${source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      manifests.push(raw as ResourceManifest);
    }
  }

  return {
    source,
    requestedUrl,
    text,
    documents,
    manifests,
    positions,
    parseErrors,
  };
}
