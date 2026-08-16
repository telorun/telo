import {
  defaultCustomTags,
  defaultRegistry,
  walkCelExpressions,
  type TemplatingEngineRegistry,
} from "@telorun/templating";
import { PackageURL } from "packageurl-js";
import { parseAllDocuments } from "yaml";
import { selectorFromQualifiers, selectorKey, type ArtifactSelector } from "./artifact-selector.js";

/**
 * One module-relative file a manifest names, and the artifact layer it belongs
 * to.
 *
 * The single answer to "why is this file in the payload", replacing two
 * derivations that happened to agree: publish used to re-parse the manifest with
 * PURL knowledge hardcoded into the CLI, and any second vocabulary — a tag that
 * embeds a file, say — would have had to be added there by hand. Here the
 * knowledge sits with whoever owns the syntax: a controller candidate is read by
 * this module, and a tagged value is read by the engine that owns its tag, via
 * `TemplatingEngine.fileClaims`. Publish maps role to layer and recognises
 * neither.
 *
 * Deliberately NOT hung off `analyze()`. That pass runs over a flattened,
 * import-inclusive manifest set, so its claims would mix in imported libraries'
 * files — whose paths are relative to *their* module and must never join this
 * artifact — and it would make packaging, today derivable offline from manifest
 * text, a product of resolving the whole import graph. This is per-module by
 * construction and needs nothing but the text.
 *
 * Browser-safe, like the rest of the analyzer: parsing and string work only, no
 * filesystem. Whether a claimed file EXISTS is a separate question, asked by the
 * Node-side caller that has a directory to look in.
 */
interface ClaimBase {
  /** Module-root-relative POSIX path — relative to the directory holding
   *  `telo.yaml`, never to the file the claim was written in. Publish inlines
   *  every `include:` partial into the published `telo.yaml`, so a
   *  per-file-relative path would change meaning in the artifact. */
  readonly path: string;
  /** Where the claim came from, for diagnostics: the PURL, or `!<tag>` and the
   *  path of the value that carried it. */
  readonly origin: string;
}

/**
 * A **discriminated union**, not one shape with optional fields: a controller
 * layer is one per selector and carries sibling patterns, and an assets layer is
 * neither. Optional fields on a single shape put the consumer one `!` away from
 * a crash inside `selectorKey` with no useful message, and let a producer emit a
 * controller claim with no selector that nothing would reject.
 */
export type ModuleFileClaim =
  | (ClaimBase & {
      readonly role: "controller";
      readonly selector: ArtifactSelector;
      /** Extra payload patterns that belong in the same layer as this claim —
       *  `.gitignore`-style globs over the selected files, matched by the
       *  caller, which is the side that knows what was selected. */
      readonly siblings: readonly string[];
      /** The source `path` was built from (`local_path=`), when the candidate
       *  names one. The release path builds the entry point rather than reading
       *  a prebuilt file, so it needs the source — and re-deriving it by parsing
       *  `origin` would put PURL knowledge back into the consumer, which is
       *  exactly what this module exists to hold. */
      readonly localPath?: string;
    })
  | (ClaimBase & { readonly role: "assets" });

/** `pkg:telo/local/<format>?path=…` — the bundled-controller delivery mode.
 *  Anything else (`pkg:npm`, `pkg:cargo`) fetches from its own ecosystem and
 *  contributes no layer. */
const BUNDLED_TYPE = "telo";
const BUNDLED_NAMESPACE = "local";

/** Qualifier naming extra files that belong in a controller's layer — what an
 *  entry point loads but the manifest cannot otherwise see (a `.wasm` beside its
 *  glue, a native library opened at runtime). */
const SIBLINGS_QUALIFIER = "siblings";

/** Normalize a `path=` / sibling value to the manifest-relative POSIX form the
 *  file selector returns, so membership is a string comparison. */
function normalizeRelative(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Bundled-controller claims from one document's `controllers:` list. */
function controllerClaims(json: unknown): ModuleFileClaim[] {
  const candidates = (json as { controllers?: unknown } | null)?.controllers;
  if (!Array.isArray(candidates)) return [];
  const claims: ModuleFileClaim[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    let parsed: PackageURL;
    try {
      parsed = PackageURL.fromString(candidate);
    } catch {
      // Not a parseable PURL — claim collection is not the place to reject it;
      // the analyzer's own validation and the controller loader both report it
      // with better context.
      continue;
    }
    if (parsed.type !== BUNDLED_TYPE || parsed.namespace !== BUNDLED_NAMESPACE) continue;
    const entry = parsed.qualifiers?.path;
    if (typeof entry !== "string" || entry === "") continue;
    const localPath = parsed.qualifiers?.local_path;
    claims.push({
      role: "controller",
      path: normalizeRelative(entry),
      selector: selectorFromQualifiers(parsed.name, parsed.qualifiers, `controller "${candidate}"`),
      siblings: String(parsed.qualifiers?.[SIBLINGS_QUALIFIER] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== ""),
      ...(typeof localPath === "string" && localPath !== ""
        ? { localPath: normalizeRelative(localPath) }
        : {}),
      origin: candidate,
    });
  }
  return claims;
}

/** Claims contributed by tagged values, asked of the engine that owns each tag.
 *  The walk reaches every tagged scalar in the document, so an engine that
 *  embeds files is discovered wherever its tag was written.
 *
 *  The layer role is assigned HERE, not by the engine: an engine reports what it
 *  embeds, and which layer that belongs in is this module's vocabulary. A file a
 *  tag embeds is read only when the resource holding it is created, so `assets`
 *  — the lazily-fetched layer — is what it is. */
function taggedClaims(json: unknown, registry: TemplatingEngineRegistry): ModuleFileClaim[] {
  const claims: ModuleFileClaim[] = [];
  walkCelExpressions(json, "", (source, path, engineName) => {
    const engine = registry.get(engineName);
    for (const claim of engine?.fileClaims?.(source) ?? []) {
      claims.push({ role: "assets", path: claim.path, origin: `!${engineName} at '${path}'` });
    }
  });
  return claims;
}

/** Identity of a claim for de-duplication: the same file claimed twice by two
 *  resources is one file in one layer. Role and selector are part of it because
 *  a file two controller candidates both claim is genuinely copied into each of
 *  their layers — dropping one would leave a platform's layer short a file it
 *  declared it needs. */
function claimKey(claim: ModuleFileClaim): string {
  const selector = claim.role === "controller" ? selectorKey(claim.selector) : "";
  return `${claim.role}\0${selector}\0${claim.path}`;
}

/**
 * Every module-relative file the manifest names, from every syntax that can name
 * one.
 *
 * `manifestText` is one module's `telo.yaml`. Publish passes the text it is
 * about to ship — i.e. after `include:` partials have been inlined — but the
 * answer does not depend on that: claims are root-relative, so collecting them
 * before or after inlining gives the same set.
 */
export function collectModuleFileClaims(
  manifestText: string,
  registry: TemplatingEngineRegistry = defaultRegistry(),
): ModuleFileClaim[] {
  const seen = new Set<string>();
  const claims: ModuleFileClaim[] = [];
  for (const doc of parseAllDocuments(manifestText, { customTags: defaultCustomTags() })) {
    const json = doc.toJSON() as unknown;
    for (const claim of [...controllerClaims(json), ...taggedClaims(json, registry)]) {
      const key = claimKey(claim);
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push(claim);
    }
  }
  return claims;
}
