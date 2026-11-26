/**
 * References to named shapes, each judged where it is written: a `telo://`
 * `$ref` in a schema-bearing field of any declaration, a `!ref` in a named
 * shape's `schema`, and a kind's or an instance's contract naming a type — by
 * `!ref` at any depth of a kind's contract, or by name at its root.
 *
 * Each is one relation instance (`namedShapeReferences`): it reads the shape
 * it names by name, in its writer's alias scope, and nothing of its content —
 * a reference is judged by whether some declaration answers its name there.
 *
 * Diagnostics, by the form written:
 *  - SCHEMA_TYPE_REF_UNKNOWN_ALIAS — a `$ref` whose authority is neither
 *    `Self` nor an import of the module;
 *  - SCHEMA_TYPE_REF_UNRESOLVED — a `$ref` naming a type its module does not
 *    declare, or a `!ref` in a named shape's `schema` naming nothing;
 *  - REFERENCE_KIND_MISMATCH — a contract, a callable signature or a named
 *    shape's `schema` naming a declaration that holds no named shape;
 *  - CONTRACT_TYPE_NOT_FOUND — a contract, or the callable signature of a
 *    kind or of a function instance, naming a type nothing in scope declares,
 *    so every call through it would fail at dispatch.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseCanonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isEntryOwned } from "./entry-ownership.js";
import { DATA_KEYWORDS, NAME_MAP_KEYWORDS } from "./manifest-schemas.js";
import { isModuleKind } from "./module-kinds.js";
import { instanceDeclaresSignature, isCallableKind } from "./callable-signature.js";
import { inheritedCapability, type DefResolver } from "./extends-resolution.js";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { authoredSchemaRef } from "./resolve-schema-type-refs.js";
import { schemaReferenceParts } from "./schema-reference.js";
import type { ScopeSite } from "./scope-address.js";
import { scopeReadAt } from "./scoped-name-resolver.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { withQuotedPath } from "./quoted-place.js";

const SOURCE = "telo-analyzer";
type Keys = readonly (string | number)[];

// A callable's signature is schema-bearing too: `params[].schema` and
// `returns.schema` hold the same node an `inputType:` does.
const SCHEMA_FIELDS = ["schema", "inputType", "outputType", "params", "returns"] as const;
const CONTRACT_FIELDS = ["inputType", "outputType"] as const;

/** One reference to a named shape, as written. */
export interface NamedShapeReferenceSite {
  readonly keys: Keys;
  /** `schemaRef`: a `$ref`; `shapeRef`: a `!ref` in a named shape's schema;
   *  `contractRef`: a `!ref` in a kind's contract; `signatureRef`: a `!ref` in
   *  the `params[].schema` / `returns.schema` of a kind or of an instance whose
   *  callable kind declares that half; `contractName`: a contract root naming a
   *  type. */
  readonly form: "schemaRef" | "shapeRef" | "contractRef" | "signatureRef" | "contractName";
  /** The type's name as written. */
  readonly name: string;
  /** Where the site's text is written, as the diagnostic names it. */
  readonly path: string;
  /** A `$ref`'s text as written, however a reading has rewritten it since. */
  readonly ref?: string;
}

/** What a site's judge reads of the declarations. */
export interface NamedShapeReferenceScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  /** The declaration `name` resolves to read in `module`, inside `within`. */
  resolve(name: string, module: string | undefined, within: ScopeSite | undefined): ResourceManifest | undefined;
  /** The module-level declaration of `name` by `module` itself, an imported
   *  library's own documents included. */
  inModule(name: string, module: string): ResourceManifest | undefined;
}

const isKindDocument = (m: ResourceManifest) => m.kind === "Telo.Definition" || m.kind === "Telo.Abstract";

/** Whether `m`'s kind is a named shape's. */
function declaresShape(
  m: ResourceManifest,
  scope: Pick<NamedShapeReferenceScope, "defs" | "aliases" | "aliasesByModule">,
): boolean {
  if (typeof m.kind !== "string") return false;
  return (
    inheritedCapability(definitionInScope(scope.defs, m.kind, m.metadata, scope.aliases, scope.aliasesByModule), (k) =>
      scope.defs.resolve(k),
    ) === "Telo.Type"
  );
}

/** The type a schema `$ref` names, as written: `telo://<authority>/<Type>`. */
function schemaRefTarget(ref: string): { authority: string; typeName: string } | undefined {
  const { shape } = schemaReferenceParts(ref);
  const authored = parseTeloTypeRef(shape);
  return authored ? { authority: authored.authority, typeName: authored.typeName } : undefined;
}

/** Whether `keys` (from the document root) names a schema node: one beneath no
 *  data keyword and no annotation, where a `!ref` is a reference to a shape. */
function atSchemaPosition(keys: Keys): boolean {
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== "string" || NAME_MAP_KEYWORDS.has(String(keys[i - 1]))) continue;
    if (DATA_KEYWORDS.has(key) || key.startsWith("x-")) return false;
  }
  return true;
}

/** The name a contract root references, when it is a reference at all. */
function contractName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isResolvedReference(value) ? value.name : undefined;
}

/** The references to named shapes `m` writes, when it is the entry's to report. */
export function namedShapeReferenceSites(
  m: ResourceManifest,
  rootModules: ReadonlySet<string>,
  scope: Pick<NamedShapeReferenceScope, "defs" | "aliases" | "aliasesByModule">,
): NamedShapeReferenceSite[] {
  if (!m.metadata?.name || !isEntryOwned(m, rootModules)) return [];
  const out: NamedShapeReferenceSite[] = [];
  const md = m as unknown as Record<string, unknown>;
  const walk = (value: unknown, keys: Keys, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...keys, i], `${path}[${i}]`));
      return;
    }
    const obj = value as Record<string, unknown>;
    // A `$ref` stamped beside a resolved reference is the resolution's, judged
    // as the reference.
    const ref = typeof obj.$ref === "string" && !isResolvedReference(obj) ? (authoredSchemaRef(obj) ?? obj.$ref) : undefined;
    const written = ref === undefined ? undefined : schemaRefTarget(ref);
    if (written) out.push({ keys: [...keys, "$ref"], form: "schemaRef", name: written.typeName, path: `${path}.$ref`, ref: ref! });
    for (const key of Object.keys(obj)) walk(obj[key], [...keys, key], `${path}.${key}`);
  };
  for (const field of SCHEMA_FIELDS) walk(md[field], [field], field);
  // A module document's `variables:` / `secrets:` entries are schemas too.
  if (isModuleKind(m.kind)) {
    for (const field of ["variables", "secrets"]) {
      const block = md[field];
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      for (const [key, entry] of Object.entries(block)) walk(entry, [field, key], `${field}.${key}`);
    }
  }

  /** Every `!ref` beneath `value`, written or resolved. */
  const refs = (value: unknown, keys: Keys, path: string, form: "shapeRef" | "contractRef" | "signatureRef"): void => {
    if (isRefSentinel(value)) {
      const target = refSentinelTarget(value);
      out.push({ keys, form, name: target?.name ?? value.source, path });
      return;
    }
    if (isResolvedReference(value)) {
      out.push({ keys, form, name: value.name, path });
      return;
    }
    // A signature's resolved `!ref` is rewritten outright to the canonical id
    // in a reading that resolved it; the site is the same.
    const canonical = form === "signatureRef" ? canonicalRefNode(value) : undefined;
    if (canonical) {
      out.push({ keys, form, name: canonical.typeName, path });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => refs(item, [...keys, index], `${path}[${index}]`, form));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) refs(child, [...keys, key], `${path}.${key}`, form);
  };
  /** A callable signature's shapes, at any depth of each `schema` of `halves`. */
  const signatureRefs = (halves: ReadonlySet<"params" | "returns">): void => {
    if (halves.has("params") && Array.isArray(md.params)) {
      md.params.forEach((param, index) => {
        if (param && typeof param === "object") {
          refs((param as Record<string, unknown>).schema, ["params", index, "schema"], `params[${index}].schema`, "signatureRef");
        }
      });
    }
    if (halves.has("returns") && md.returns && typeof md.returns === "object") {
      refs((md.returns as Record<string, unknown>).schema, ["returns", "schema"], "returns.schema", "signatureRef");
    }
  };
  if (isKindDocument(m)) {
    for (const field of CONTRACT_FIELDS) {
      const value = md[field];
      // A root naming a type by name, or a `!ref` at any depth.
      if (typeof value === "string") out.push({ keys: [field], form: "contractName", name: value, path: field });
      else refs(value, [field], field, "contractRef");
    }
    signatureRefs(new Set(["params", "returns"]));
  } else {
    if (declaresShape(m, scope)) refs(md.schema, ["schema"], "schema", "shapeRef");
    // An instance's contract root is a reference slot of its own: what is
    // judged here is the type it names.
    if (typeof m.kind === "string" && definitionInScope(scope.defs, m.kind, m.metadata, scope.aliases, scope.aliasesByModule)) {
      // Written as a reference, the site is one whether or not a resolution has
      // answered it: one that did not is the reference check's to report.
      for (const field of CONTRACT_FIELDS) {
        const value = md[field];
        const name = contractName(value) ?? (isRefSentinel(value) ? refSentinelTarget(value)?.name : undefined);
        if (name !== undefined) out.push({ keys: [field], form: "contractName", name, path: field });
      }
    }
    signatureRefs(instanceSignatureHalves(m, scope));
  }
  return out;
}

/** The shape a node holding nothing but a canonical `$ref` names. */
function canonicalRefNode(value: unknown): { typeName: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "$ref") return undefined;
  const parsed = parseCanonicalTypeSchemaId((value as { $ref?: unknown }).$ref);
  return parsed ? { typeName: parsed.typeName } : undefined;
}

/** The halves of a signature an instance declares: those its callable kind's
 *  schema lists, which make `params` / `returns` a signature rather than the
 *  kind's own configuration. */
function instanceSignatureHalves(
  m: ResourceManifest,
  scope: Pick<NamedShapeReferenceScope, "defs" | "aliases" | "aliasesByModule">,
): ReadonlySet<"params" | "returns"> {
  const md = m as unknown as Record<string, unknown>;
  const halves = new Set<"params" | "returns">();
  if ((md.params === undefined && md.returns === undefined) || typeof m.kind !== "string") return halves;
  const resolve: DefResolver = (kind, from) => definitionInScope(scope.defs, kind, from?.metadata, scope.aliases, scope.aliasesByModule);
  const definition = definitionInScope(scope.defs, m.kind, m.metadata, scope.aliases, scope.aliasesByModule);
  if (!isCallableKind(definition, resolve)) return halves;
  for (const half of ["params", "returns"] as const) {
    if (md[half] !== undefined && instanceDeclaresSignature(definition, resolve, half)) halves.add(half);
  }
  return halves;
}

/** A contract, signature or named shape naming a declaration that holds no
 *  named shape — the kernel's `ERR_REFERENCE_KIND_MISMATCH` says the same of a
 *  contract and a signature. */
function notShapeMessage(label: string, at: string, source: string, found: ResourceManifest): string {
  return (
    `${label}: '${at}' names '${source}', a ${String(found.kind)}, which is not a named shape, so it ` +
    `constrains nothing. Reference a \`Telo.JsonSchema\` or another named shape, or write the schema inline.`
  );
}

/** A callable signature's `!ref` naming nothing in scope — the kernel's
 *  registration refusal says the same. */
export function signatureShapeNotFoundMessage(at: string, source: string): string {
  return (
    `'${at}' names the shape '${source}' with \`!ref\`, and nothing by that name is ` +
    `declared in scope — a \`Telo.JsonSchema\` of this module, or one an import lists in its ` +
    `\`exports.resources\`. A shape that resolves to nothing constrains nothing, so every ` +
    `argument would pass. Declare the shape, or correct the name.`
  );
}

/** What the site at `keys` of `m` refuses, judged against what `scope` declares. */
export function namedShapeReferenceFinding(
  m: ResourceManifest,
  site: NamedShapeReferenceSite,
  value: unknown,
  scope: NamedShapeReferenceScope,
): AnalysisDiagnostic | undefined {
  const name = m.metadata?.name as string;
  // A module document declares the module its own name names.
  const ownModule =
    (m.metadata as { module?: string } | undefined)?.module ?? (isModuleKind(m.kind) ? (m.metadata?.name as string | undefined) : undefined);
  const filePath = (m.metadata as { source?: string } | undefined)?.source;
  const resource = { kind: m.kind, name };
  const label = `${m.kind}/${name}`;
  const within = scopeReadAt(m);
  const error = (code: string, message: string, path: string): AnalysisDiagnostic => ({
    severity: DiagnosticSeverity.Error,
    code,
    source: SOURCE,
    message,
    data: { resource, filePath, path },
  });
  const moduleScope = moduleAliasScope(m.metadata, scope.aliases, scope.aliasesByModule);

  if (site.form === "schemaRef") {
    if (typeof value !== "string") return undefined;
    const ref = site.ref ?? value;
    const parsed = schemaRefTarget(ref);
    if (!parsed) return undefined;
    const module = parsed.authority === "Self" ? ownModule : moduleScope.moduleForAlias(parsed.authority);
    if (!module) {
      return error(
        "SCHEMA_TYPE_REF_UNKNOWN_ALIAS",
        `${label}: schema $ref '${ref}' — '${parsed.authority}' is not 'Self' or a ` +
          `Telo.Import in this module. Declare the import or correct the authority.`,
        site.path,
      );
    }
    if (scope.defs.claimsSchemaId(canonicalTypeSchemaId(module, parsed.typeName))) return undefined;
    const declared = scope.inModule(parsed.typeName, module);
    if (declared && declaresShape(declared, scope)) return undefined;
    return error(
      "SCHEMA_TYPE_REF_UNRESOLVED",
      `${label}: schema $ref '${ref}' resolves to module '${module}', which declares ` +
        `no Telo.Type named '${parsed.typeName}'.`,
      site.path,
    );
  }

  if (site.form === "shapeRef" || site.form === "contractRef" || site.form === "signatureRef") {
    // A reference is read by its name, whether or not an earlier resolution
    // answered it: that resolution may have read another configuration.
    const target = isRefSentinel(value)
      ? refSentinelTarget(value)
      : isResolvedReference(value)
        ? { name: value.name, ...(typeof (value as { alias?: unknown }).alias === "string" ? { alias: (value as { alias: string }).alias } : {}) }
        : undefined;
    if (!isRefSentinel(value) && !target) return undefined;
    const source = isRefSentinel(value) ? value.source : target!.alias ? `${target!.alias}.${target!.name}` : target!.name;
    if (target) {
      const module = target.alias === undefined || target.alias === "Self" ? ownModule : moduleScope.moduleForAlias(target.alias);
      const found =
        target.alias === undefined || target.alias === "Self"
          ? scope.resolve(target.name, module, within)
          : module !== undefined
            ? scope.inModule(target.name, module)
            : undefined;
      if (found && (declaresShape(found, scope) || (site.form === "shapeRef" && !atSchemaPosition(site.keys)))) return undefined;
      if (found) {
        const refused = error("REFERENCE_KIND_MISMATCH", notShapeMessage(label, site.path, source, found), site.path);
        return site.form === "contractRef" ? refused : withQuotedPath(refused, site.path);
      }
    }
    if (site.form === "signatureRef") {
      return withQuotedPath(error("CONTRACT_TYPE_NOT_FOUND", signatureShapeNotFoundMessage(site.path, source), site.path), site.path);
    }
    return site.form === "shapeRef"
      ? error(
          "SCHEMA_TYPE_REF_UNRESOLVED",
          `${label}: '${site.path}' names the type '${source}' with \`!ref\`, and nothing by ` +
            `that name is declared in scope, so nothing beneath it is validated. Declare a ` +
            `\`Telo.JsonSchema\` with that name, or correct the reference.`,
          site.path,
        )
      : error(
          "CONTRACT_TYPE_NOT_FOUND",
          `${label}: '${site.path}' names the type '${source}' with \`!ref\`, ` +
            `and nothing by that name is declared in scope. The contract cannot be enforced, so ` +
            `every call through it would fail at dispatch. Declare a \`Telo.JsonSchema\` with that ` +
            `name, or correct the reference.`,
          site.path,
        );
  }

  const named = contractName(value);
  if (named === undefined) return undefined;
  const alias = isResolvedReference(value) ? (value as { alias?: unknown }).alias : undefined;
  const module = typeof alias === "string" && alias !== "Self" ? moduleScope.moduleForAlias(alias) : ownModule;
  const found =
    typeof alias === "string" && alias !== "Self"
      ? module !== undefined
        ? scope.inModule(named, module)
        : undefined
      : scope.resolve(named, module, within);
  if (found && (!isKindDocument(m) || declaresShape(found, scope))) return undefined;
  if (found) return error("REFERENCE_KIND_MISMATCH", notShapeMessage(label, site.path, named, found), site.path);
  return error(
    "CONTRACT_TYPE_NOT_FOUND",
    `${label}: \`${site.path}\` names the type '${named}', which is not declared ` +
      `in scope. The contract cannot be enforced, so every call through it would fail at dispatch. ` +
      `Declare a \`Telo.JsonSchema\` with that name, or inline the shape.`,
    site.path,
  );
}
