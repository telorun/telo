import type { ResourceManifest } from "@telorun/sdk";
import { parseCanonicalTypeSchemaId, VALUE_TYPES } from "@telorun/sdk";
import { SCHEMA_NESTING_EXCEEDED, schemaNestingExceededMessage, VALUE_DEPTH_EXCEEDED } from "./schema-validation.js";
import { nestsPastValueDepth, type OwnValuePositions } from "./value-depth.js";
import { isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { alsoAccepts } from "./host-path-slot.js";
import { importInputsSchema, libraryDocOf } from "./import-inputs.js";
import { importAnchoredDiagnostic } from "./reaching-import.js";
import type { ModuleDocuments } from "./module-documents.js";
import { navigatePath } from "./peer-binding.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import { navigateSchemaToExprPath } from "./schema-compat.js";
import { quotingIssue, type QuotedPlace } from "./quoted-place.js";
import { valueTypeRefusalCode } from "./schema-error-report.js";
import type { StandIns } from "./stand-in-findings.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * What an import writes under `variables:` / `secrets:`, held to the entries the library
 * declares — the static twin of the import controller, which decodes, builds and
 * validates the same supply when the import initializes.
 *
 * A literal is decoded through its type's plain encoding first, exactly as the kernel
 * reads it, and an expression stands in as its slot's placeholder (its type is the CEL
 * join's). Each finding takes the code the same readers choose at a resource's own field:
 * a type admitting text its own (`URL_INVALID`), a relative literal at a host path
 * `HOST_PATH_RELATIVE` with its `!module-path` repair, anything else `SCHEMA_VIOLATION`.
 * A tag at a host path is the import host-path pass's `HOST_PATH_UNTYPED_SOURCE`, so it is
 * not reported here.
 *
 * Entry-module-scoped: an import inside a dependency is its author's to fix.
 */
export function validateImportInputs(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  documents: readonly ModuleDocuments[],
  defs: DefinitionRegistry,
  aliasesByModule?: ReadonlyMap<string, Pick<AliasResolver, "moduleForAlias">>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Import") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.module === "string" && !rootModules.has(metadata.module)) continue;
    const written = {
      variables: (manifest as Record<string, unknown>).variables ?? {},
      secrets: (manifest as Record<string, unknown>).secrets ?? {},
    };
    if (isEmptyBlock(written.variables) && isEmptyBlock(written.secrets)) continue;
    const schema = importInputsSchema(manifest, documents, aliasesByModule);
    if (!schema) continue;

    const alias = String(metadata.name ?? "");
    const resource = { kind: manifest.kind, name: alias };
    const filePath = typeof metadata.source === "string" ? metadata.source : undefined;
    const library = libraryDocOf(manifest, documents);
    if (library) {
      out.push(
        ...unresolvedEntryShapes(written, schema, library.library, defs).map((missing) =>
          importAnchoredDiagnostic(
            "SCHEMA_TYPE_REF_UNRESOLVED",
            library.documentSet.module,
            { alias, ...(filePath ? { filePath } : {}), path: missing.supplied ? missing.entry : "", resource },
            `${missing.entry}: schema $ref '${missing.ref}' resolves to module '${missing.module}', which declares no ` +
              `Telo.Type named '${missing.type}' in the configuration this import runs in.`,
            missing.writtenAt,
          ),
        ),
      );
    }
    const entries = (["variables", "secrets"] as const).flatMap((block) =>
      Object.keys(written[block] as Record<string, unknown>).map((key) => [block, key]),
    );
    for (const finding of declaredInputFindings(
      written,
      schema,
      defs,
      { subject: `Telo.Import/${alias}`, declarer: "the imported library" },
      entries,
    )) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: finding.code,
        source: SOURCE,
        message: finding.message,
        data: {
          resource,
          filePath,
          path: finding.path,
          ...(finding.fix ? { fix: finding.fix } : {}),
          ...(finding.quotedPlace ? { quotedPlace: finding.quotedPlace } : {}),
        },
      });
    }
  }
  return out;
}

/** An entry the import validates a value against — one it supplies, or one
 *  declaring a `default:` — whose type names a shape nothing declares where
 *  the import's own key holds: its first such reference. */
interface UnresolvedEntryShape {
  entry: string;
  supplied: boolean;
  ref: string;
  module: string;
  type: string;
  /** Where the library's own check reports it; none for a reference inside a
   *  shape the entry reaches. */
  writtenAt: { resource: { kind: string; name: string }; filePath?: string; path: string } | null;
}

function unresolvedEntryShapes(
  written: Record<string, unknown>,
  schema: Record<string, any>,
  library: ResourceManifest,
  defs: DefinitionRegistry,
): UnresolvedEntryShape[] {
  const out: UnresolvedEntryShape[] = [];
  const libraryMeta = (library.metadata ?? {}) as { name?: string; source?: string };
  for (const block of ["variables", "secrets"] as const) {
    const declared = (library as Record<string, any>)[block];
    if (!declared || typeof declared !== "object") continue;
    for (const [name, entry] of Object.entries(declared as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const supplied = (written[block] as Record<string, unknown> | undefined)?.[name] !== undefined;
      if (!supplied && !Object.hasOwn(entry, "default")) continue;
      const canonical = schema.properties?.[block]?.properties?.[name];
      const reached = new Set<string>();
      let found: UnresolvedEntryShape | undefined;
      const visit = (node: unknown, authored: unknown, keys: readonly (string | number)[] | undefined): void => {
        if (found || !node || typeof node !== "object") return;
        const at = (key: string | number) =>
          authored && typeof authored === "object" ? (authored as Record<string | number, unknown>)[key] : undefined;
        if (Array.isArray(node)) {
          node.forEach((child, index) => visit(child, at(index), keys && [...keys, index]));
          return;
        }
        const ref = (node as { $ref?: unknown }).$ref;
        const id = typeof ref === "string" ? ref.split("#")[0]! : "";
        const named = parseCanonicalTypeSchemaId(id);
        if (named && !reached.has(id)) {
          reached.add(id);
          const shape = defs.schemaForId(id);
          if (!shape) {
            const authoredRef = at("$ref");
            found = {
              entry: `${block}.${name}`,
              supplied,
              ref: typeof authoredRef === "string" ? authoredRef : String(ref),
              module: named.moduleName,
              type: named.typeName,
              writtenAt:
                keys && typeof libraryMeta.name === "string"
                  ? {
                      resource: { kind: "Telo.Library", name: libraryMeta.name },
                      ...(libraryMeta.source ? { filePath: libraryMeta.source } : {}),
                      path: pathText([...keys, "$ref"]),
                    }
                  : null,
            };
            return;
          }
          visit(shape, undefined, undefined);
        }
        for (const [key, child] of Object.entries(node)) {
          if (key === "default" || key === "const" || key === "enum" || key === "examples") continue;
          visit(child, at(key), keys && [...keys, key]);
        }
      };
      visit(canonical, entry, [block, name]);
      if (found) out.push(found);
    }
  }
  return out;
}

/** `["variables", "a", 0, "$ref"]` → `variables.a[0].$ref`. */
/** The value at `keys` of `root`, or `undefined`. */
function valueAtKeys(root: unknown, keys: readonly (string | number)[]): unknown {
  let at = root;
  for (const key of keys) at = at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

function pathText(keys: readonly (string | number)[]): string {
  let out = "";
  for (const key of keys) out = typeof key === "number" ? `${out}[${key}]` : out === "" ? key : `${out}.${key}`;
  return out;
}

/** One refusal of a supplied input, before it is anchored. */
export interface DeclaredInputFinding {
  code: string;
  message: string;
  /** Dotted path within `written`. */
  path: string;
  fix?: { replacement: string; tag: "module-path" };
  /** The places its message quotes, so a placement renders it where it moves. */
  quotedPlace?: QuotedPlace[];
}

/**
 * What is wrong with `written` — maps of supplied inputs keyed by block — against
 * `schema`, the declarations of whoever receives them. A literal is decoded
 * through its type's plain encoding first, and an expression stands in as its
 * slot's placeholder. `subject` begins each message and `declarer` names the
 * module the declarations are read from.
 */
export function declaredInputFindings(
  written: Record<string, unknown>,
  schema: Record<string, any>,
  defs: DefinitionRegistry,
  wording: { subject: string; declarer: string },
  /** Where each supplied value sits in `written`: each is a value of its own,
   *  its depth judged from its own root and a leaf of the block's. */
  entries: OwnValuePositions,
): DeclaredInputFinding[] {
  const out: DeclaredInputFinding[] = [];
  const { subject, declarer } = wording;
  for (const keys of entries) {
    if (!nestsPastValueDepth(valueAtKeys(written, keys))) continue;
    const path = pathText(keys);
    out.push({ code: SCHEMA_NESTING_EXCEEDED, message: schemaNestingExceededMessage(subject, `'${path}'`, VALUE_DEPTH_EXCEEDED), path });
  }
  if (out.length > 0) return out;
  const standIns: StandIns = new Map();
  const substituted = substituteDecodedCelFields(written, schema, undefined, {
    standIns,
    external: (ref) => defs.schemaForId(ref),
  });
  const outcome = defs.validateResourceConfig(substituted, schema, standIns, entries);
  if (!outcome.finished) {
    out.push({ code: SCHEMA_NESTING_EXCEEDED, message: schemaNestingExceededMessage(subject, "what it supplies", outcome), path: "" });
    return out;
  }
  for (const issue of outcome.issues) {
    const textRefusal = valueTypeRefusalCode(issue);
    if (textRefusal !== undefined) {
      const quoted = quotingIssue(`${subject}: `, issue, issue.path);
      out.push({ code: textRefusal, message: quoted.message, path: issue.path, ...(quoted.quotedPlace ? { quotedPlace: quoted.quotedPlace } : {}) });
      continue;
    }
    if (issue.valueType && VALUE_TYPES.get(issue.valueType)?.fromHost !== undefined) {
      const value = navigatePath(written, issue.path);
      if (isTaggedSentinel(value)) continue;
      const quoted = quotingIssue(
        `${subject}: `,
        issue,
        issue.path,
        `. ${capitalized(declarer)} resolves nothing it is given.${alsoAccepts(navigateSchemaToExprPath(schema, issue.path))}`,
      );
      out.push({
        code: "HOST_PATH_RELATIVE",
        message: quoted.message,
        ...(quoted.quotedPlace ? { quotedPlace: quoted.quotedPlace } : {}),
        path: issue.path,
        ...(typeof value === "string" ? { fix: { replacement: value, tag: "module-path" as const } } : {}),
      });
      continue;
    }
    const quoted = quotingIssue(`${subject}: `, issue, issue.path, ` — ${declarer} declares it so.`);
    out.push({
      code: "SCHEMA_VIOLATION",
      message: quoted.message,
      path: issue.path,
      ...(quoted.quotedPlace ? { quotedPlace: quoted.quotedPlace } : {}),
    });
  }
  return out;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function isEmptyBlock(value: unknown): boolean {
  return !value || typeof value !== "object" || Object.keys(value).length === 0;
}
