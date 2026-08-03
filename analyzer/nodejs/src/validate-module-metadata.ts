import type { ResourceManifest } from "@telorun/sdk";

import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { distance } from "./levenshtein.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Static validation of the `metadata:` block on module docs (`Telo.Application` /
 * `Telo.Library`) and of `metadata.deprecated` wherever it appears.
 *
 * These fields are descriptive — nothing in the kernel branches on them — but they
 * are the module's public face: a hub indexes them, and a consumer reads them
 * before deciding to import. That is exactly why they need checking. A field the
 * runtime ignores has no failure mode that would ever surface it, so a mistyped
 * `licence:` or `deprecatd:` is invisible forever, and the module ships claiming
 * nothing while its author believes otherwise.
 *
 * The vocabulary stays **open** — `metadata` accepts any key, because a publisher
 * may carry their own — so an unknown key is only reported when it is a near-miss
 * of a known one. That catches the typo without closing the set.
 *
 * **Everything here is a WARNING, and fatal only at `telo publish`** (see
 * {@link PUBLISH_BLOCKING_CODES}). Refusing to *run* a manifest over a field no
 * runtime reads gets the cost backwards: `version: 1.0` is a YAML float rather
 * than a string, which is a real mistake worth reporting, but stopping the app
 * from starting over it is worse than the mistake. Publication is the moment
 * these fields become consequential — they are projected onto the artifact's
 * annotations and indexed by the hub — so that is where they block.
 */

/**
 * Codes that must not block running a manifest but MUST block publishing one.
 *
 * Kept as a set rather than a severity because the two audiences differ: a
 * developer running a manifest wants to know, a publisher must be stopped. If a
 * later check earns the same treatment, add its code here rather than inventing
 * a third severity level.
 */
export const PUBLISH_BLOCKING_CODES: ReadonlySet<string> = new Set([
  "METADATA_INVALID_TYPE",
  "METADATA_UNKNOWN_FIELD",
  "INVALID_DEPRECATION",
  "DEPRECATION_REPLACEMENT_UNRESOLVED",
]);

type FieldType = "string" | "string[]" | "object";

/** Conventional module-doc metadata, and the type each carries. Descriptive only;
 *  `name` is the sole field anything resolves against. */
const MODULE_METADATA_TYPES: Record<string, FieldType> = {
  name: "string",
  module: "string",
  version: "string",
  description: "string",
  repository: "string",
  homepage: "string",
  documentation: "string",
  license: "string",
  namespace: "string",
  categories: "string[]",
  deprecated: "object",
};

/** What a kind doc's `metadata:` may carry.
 *
 *  Deliberately narrower than a module's: `version`, `license` and the rest
 *  belong to the module, and a kind restating them means nothing. `categories`
 *  is legal and *replaces* the module's for that kind; `description` is hub
 *  search text. Both have exactly the failure mode this file exists for — a
 *  `descriptoin:` on a kind doc is read by nothing and reported by nothing, so
 *  it ships silently — which is why kind docs are checked rather than exempt. */
const KIND_METADATA_TYPES: Record<string, FieldType> = {
  name: "string",
  module: "string",
  description: "string",
  categories: "string[]",
  deprecated: "object",
};

/** Alias-qualified kind — `Self.Migrations`, `Cache.Store`, `Telo.JsonSchema`. */
const ALIAS_KIND_RE = /^[A-Z][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/;

/** The built-in namespace, resolvable without an import — mirrors `validate-extends`. */
const TELO_BUILTIN_ALIAS = "Telo";

function typeOf(value: unknown): "string" | "string[]" | "object" | "other" {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? "string[]" : "other";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

export function validateModuleMetadata(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  // Docs forwarded from imported libraries carry `metadata.module` set to that
  // library's name. Their `replacedBy` aliases — `Self`, or any alias private to
  // that library — belong to the library's OWN scope, which the consumer's
  // resolver knows nothing about, so re-checking them here reports a false
  // DEPRECATION_REPLACEMENT_UNRESOLVED against a manifest the consumer does not
  // own. They are validated when that library is analyzed as a root, which is
  // its author's concern. Same rule, and the same reason, as `validate-extends`.
  const importedModules = new Set<string>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const resolved = (m.metadata as { resolvedModuleName?: string } | undefined)
      ?.resolvedModuleName;
    if (resolved) importedModules.add(resolved);
  }

  for (const manifest of manifests) {
    const isModuleDoc = manifest.kind === "Telo.Application" || manifest.kind === "Telo.Library";
    const isKindDoc = manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract";
    if (!isModuleDoc && !isKindDoc) continue;

    const metadata = manifest.metadata as Record<string, unknown> | undefined;
    if (!metadata) continue;

    const ownModule = (metadata as { module?: string }).module;
    if (ownModule && importedModules.has(ownModule)) continue;

    const name = typeof metadata.name === "string" ? metadata.name : undefined;
    const filePath = typeof metadata.source === "string" ? metadata.source : undefined;
    const ctx = {
      label: `${manifest.kind}/${name ?? "(unnamed)"}`,
      resource: { kind: manifest.kind, name },
      filePath,
    };

    validateFieldTypes(
      metadata,
      isModuleDoc ? MODULE_METADATA_TYPES : KIND_METADATA_TYPES,
      ctx,
      out,
    );
    validateDeprecation(metadata, isModuleDoc, ctx, registry, aliases, out);
  }
  return out;
}

interface DocContext {
  label: string;
  resource: { kind: string; name: string | undefined };
  filePath: string | undefined;
}

/** How far a key may be from a known one and still be called a typo.
 *
 *  Scaled, not absolute: at a flat 2, `date:` (a perfectly ordinary key an
 *  author might carry) is two edits from `name` and gets told it is a
 *  misspelling of it. The vocabulary is open, so a false accusation on a short
 *  key is worse than missing a typo on one. */
function typoThreshold(key: string, known: string): number {
  return Math.max(1, Math.floor(Math.min(key.length, known.length) / 3));
}

function validateFieldTypes(
  metadata: Record<string, unknown>,
  allowed: Record<string, FieldType>,
  ctx: DocContext,
  out: AnalysisDiagnostic[],
): void {
  const known = Object.keys(allowed);
  for (const [key, value] of Object.entries(metadata)) {
    // Stamped by the loader, not authored — never a typo to report on.
    if (key === "source") continue;

    // Listed as known so a typo still gets suggested against it, but its shape
    // belongs to `validateDeprecation`, which can say what is actually wrong.
    // Type-checking it here too would report one mistake twice.
    if (key === "deprecated") continue;

    const expected = allowed[key];
    if (expected === undefined) {
      const near = known.find((k) => distance(key, k) <= typoThreshold(key, k));
      if (near) {
        out.push({
          severity: DiagnosticSeverity.Warning,
          code: "METADATA_UNKNOWN_FIELD",
          source: SOURCE,
          message:
            `${ctx.label}: 'metadata.${key}' is not a known field — did you mean '${near}'? ` +
            `Nothing reads an unrecognized key, so this declares nothing.`,
          data: { resource: ctx.resource, filePath: ctx.filePath, path: `metadata.${key}` },
        });
      }
      continue;
    }

    if (typeOf(value) !== expected) {
      out.push({
        severity: DiagnosticSeverity.Warning,
        code: "METADATA_INVALID_TYPE",
        source: SOURCE,
        message: `${ctx.label}: 'metadata.${key}' must be ${describeType(expected)}.`,
        data: { resource: ctx.resource, filePath: ctx.filePath, path: `metadata.${key}` },
      });
    }
  }
}

function describeType(t: "string" | "string[]" | "object"): string {
  if (t === "string[]") return "an array of strings";
  if (t === "object") return "an object";
  return "a string";
}

/**
 * `metadata.deprecated: { reason, replacedBy? }`.
 *
 * `replacedBy` is deliberately resolvable rather than free text, and its form
 * follows the level: a module doc names another **module ref** (the `imports:`
 * source grammar), a kind doc names an **alias-qualified kind** resolved through
 * this file's own imports — the same grammar `kind:` / `extends:` use, so the
 * replacement is a link a consumer can follow rather than a sentence they have to
 * interpret.
 *
 * A kind whose replacement lives in a module this one does not import cannot be
 * named; that case deprecates at module level with a module ref instead. Accepted
 * over inventing a second grammar for it.
 */
function validateDeprecation(
  metadata: Record<string, unknown>,
  isModuleDoc: boolean,
  ctx: DocContext,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  out: AnalysisDiagnostic[],
): void {
  const deprecated = metadata.deprecated;
  if (deprecated === undefined) return;

  const at = "metadata.deprecated";
  const push = (
    code: string,
    message: string,
    path = at,
    severity = DiagnosticSeverity.Warning,
  ): void => {
    out.push({
      severity,
      code,
      source: SOURCE,
      message: `${ctx.label}: ${message}`,
      data: { resource: ctx.resource, filePath: ctx.filePath, path },
    });
  };

  if (typeOf(deprecated) !== "object") {
    push(
      "INVALID_DEPRECATION",
      `'${at}' must be an object with a 'reason' (and an optional 'replacedBy'). ` +
        `A bare 'true' says a thing is deprecated without saying what to do instead.`,
    );
    return;
  }

  const block = deprecated as Record<string, unknown>;
  const allowed = new Set(["reason", "replacedBy"]);
  for (const key of Object.keys(block)) {
    if (!allowed.has(key)) {
      push("INVALID_DEPRECATION", `'${at}.${key}' is not a recognized key (reason, replacedBy).`, `${at}.${key}`);
    }
  }

  if (typeof block.reason !== "string" || block.reason.trim() === "") {
    push(
      "INVALID_DEPRECATION",
      `'${at}.reason' is required and must be a non-empty string — it is what a consumer reads to know what to do instead.`,
      `${at}.reason`,
    );
  }

  const replacedBy = block.replacedBy;
  if (replacedBy === undefined) return;
  const path = `${at}.replacedBy`;
  if (typeof replacedBy !== "string" || replacedBy.trim() === "") {
    push("INVALID_DEPRECATION", `'${path}' must be a non-empty string.`, path);
    return;
  }

  if (isModuleDoc) {
    // A module is replaced by another module, addressed the way an import is.
    // Catching alias form here is worth a dedicated message: it is the natural
    // mistake, and it would otherwise be stored as an unresolvable ref.
    if (ALIAS_KIND_RE.test(replacedBy)) {
      push(
        "INVALID_DEPRECATION",
        `'${path}: ${replacedBy}' looks like a kind reference, but a module doc's replacement is a ` +
          `module ref (e.g. 'oci://ghcr.io/acme/thing'). Deprecate the kind itself to point at another kind.`,
        path,
      );
    }
    return;
  }

  // Kind level: resolve through this file's imports, exactly as `extends` does.
  if (!ALIAS_KIND_RE.test(replacedBy)) {
    push(
      "INVALID_DEPRECATION",
      `'${path}: ${replacedBy}' must be an alias-qualified kind ("<Alias>.<Kind>", ` +
        `e.g. 'Self.Migrations'), resolved via this file's imports.`,
      path,
    );
    return;
  }

  const prefix = replacedBy.slice(0, replacedBy.indexOf("."));
  if (prefix !== TELO_BUILTIN_ALIAS && !aliases.hasAlias(prefix)) {
    push(
      "DEPRECATION_REPLACEMENT_UNRESOLVED",
      `'${path}: ${replacedBy}' — alias '${prefix}' is not an import in this file's scope. ` +
        `Declare the import or correct the alias.`,
      path,
    );
    return;
  }

  const canonical = aliases.resolveKind(replacedBy);
  if (!canonical || !registry.resolve(canonical)) {
    push(
      "DEPRECATION_REPLACEMENT_UNRESOLVED",
      `'${path}: ${replacedBy}' does not resolve to a known kind. A replacement a consumer ` +
        `cannot follow is no better than none.`,
      path,
    );
  }
}
