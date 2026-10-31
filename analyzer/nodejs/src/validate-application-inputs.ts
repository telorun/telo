import type { ResourceManifest } from "@telorun/sdk";
import {
  APPLICATION_INPUT_BLOCKS,
  readApplicationSourceSlot,
  valueAtKeys,
  type ApplicationInputBlock,
} from "./application-source-slot.js";
import {
  type ApplicationSourceRecord,
  type ApplicationSourceRecords,
  type ChildApplicationNeed,
} from "./child-application.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { importFailureCode } from "./import-resolution-diagnostics.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import {
  fieldSupplyFindings,
  wholeForwardRefusals,
  type ForwardedNeed,
} from "./need-table.js";
import { injectedNeedOf, readNeeds, type NeedTypeShape } from "./need-type.js";
import { inputValueSchema } from "./residual-schema.js";
import { isResolvedReference } from "./resolved-reference.js";
import { isInjectedDeclaration } from "./resource-input.js";
import type { ScopeSite } from "./scope-address.js";
import { declaringScopeOf, isScopeMemberDeclaration, scopeMemberOf } from "./scope-members.js";
import { MANIFEST_READING, ScopedNameResolver } from "./scoped-name-resolver.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { declaredInputFindings } from "./validate-import-inputs.js";

const SOURCE = "telo-analyzer";

/** What a value supplied to a child application's port is held to — the kernel's. */
const PORT_SCHEMA: Record<string, unknown> = { type: "integer", minimum: 1, maximum: 65535 };

const SINGULAR: Record<ApplicationInputBlock, string> = {
  variables: "variable",
  secrets: "secret",
  ports: "port",
  needs: "need",
};

export interface ApplicationInputsScope {
  /** The author schema of `resource`'s kind, resolved in `module`'s scope. */
  authorSchemaOf(resource: ResourceManifest, module: string | undefined): Record<string, any> | undefined;
  /** `kind` canonicalized in `module`'s scope. */
  resolveKind(module: string | undefined, kind: string): string | undefined;
  /** The need type a canonical kind registers, or undefined. */
  needType(kind: string): NeedTypeShape | undefined;
  defs: DefinitionRegistry;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isDeclarationDocument = (m: { kind?: unknown }): boolean =>
  isModuleKind(m.kind as string) || m.kind === "Telo.Import" || isKindDocument(m);

/**
 * A resource running a child application — its kind's schema carries
 * `x-telo-application-source` — held to what that application declares, read
 * from the child the loader loaded at the annotated field: a source that does not
 * resolve, or does not name a `Telo.Application`, with the import-resolution
 * codes at that field; a key of a fed map naming nothing the child declares,
 * `APPLICATION_INPUT_UNDECLARED`; a literal the child's declaration refuses,
 * `SCHEMA_VIOLATION` (or a value type's own code); and a need — a whole `!ref`
 * whose referent is no need or fulfilment of the child's need type
 * (`REFERENCE_KIND_MISMATCH`) or a parent need stating less than the child's
 * (`NEED_FORWARD_INCOMPATIBLE`), a field map held to the type's fields
 * (`NEED_FIELD_UNDECLARED` / `NEED_SLOT_MISMATCH` / `SCHEMA_VIOLATION`). A supply
 * by name is a root supply, so a `supply: root` type takes a field map.
 *
 * Every resource of the entry's own modules is judged — top-level, extracted
 * inline (a step's dispatch target included, its source looked up under the
 * file its outermost holder was written in), or a member of a `with:` scope at
 * any depth. A computed source is not
 * followed; the annotation's strict half requires a literal field, so an
 * expression there is `CEL_IN_NON_EVAL_FIELD`. A set analysed with no
 * `records` holds no child, and is not judged.
 *
 * Browser-safe.
 */
export function validateApplicationInputs(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  records: ApplicationSourceRecords,
  scope: ApplicationInputsScope,
): AnalysisDiagnostic[] {
  if (Object.keys(records).length === 0) return [];
  const out: AnalysisDiagnostic[] = [];

  const moduleDocs = new Map<string, ResourceManifest>();
  const declared: ResourceManifest[] = [];
  /** Every named top-level document by declaring module and name — what an
   *  extraction's `xTeloOrigin` names its holder by. */
  const holders = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    const meta = m.metadata as { name?: unknown; module?: unknown } | undefined;
    if (typeof meta?.name !== "string") continue;
    if (!isScopeMemberDeclaration(m)) {
      holders.set(`${typeof meta.module === "string" ? meta.module : ""}\0${meta.name}`, m);
    }
    if (isModuleKind(m.kind)) {
      moduleDocs.set(meta.name, m);
      continue;
    }
    if (isDeclarationDocument(m) || isForwardedDeclaration(m)) continue;
    declared.push(m);
  }
  // What a `!ref` names, a scope member's siblings first.
  const declarations = new ScopedNameResolver(declared, MANIFEST_READING);

  const judge = (
    node: ResourceManifest,
    module: string | undefined,
    prefix: string,
    anchor: { resource: { kind: string; name: string }; filePath: string | undefined },
    /** The file the source is resolved against. */
    file: string | undefined,
  ): void => {
    const schema = scope.authorSchemaOf(node, module);
    const slot = schema ? readApplicationSourceSlot(schema) : undefined;
    if (!slot) return;
    const source = (node as Record<string, unknown>)[slot.field];
    if (typeof source !== "string") return;
    const record = file ? records[file]?.[source] : undefined;
    if (!record) return;
    const extracted = (node.metadata as { xTeloOrigin?: unknown } | undefined)?.xTeloOrigin !== undefined;
    const label = extracted ? `the inline ${node.kind}` : `${node.kind}/${String(node.metadata?.name)}`;
    const at = (path: string) => (prefix ? `${prefix}.${path}` : path);
    const report = (code: string, message: string, path: string, fix?: unknown) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message,
        data: { ...anchor, path: at(path), ...(fix ? { fix } : {}) },
      });

    if ("failure" in record) {
      reportFailure(record, label, slot.field, source, report);
      return;
    }
    const child = record.application;
    const declarer = `the application at '${source}'`;
    for (const block of APPLICATION_INPUT_BLOCKS) {
      const keys = slot.feeds[block];
      if (!keys) continue;
      const written = valueAtKeys(node, keys);
      if (!isPlainObject(written)) continue;
      const mapPath = keys.join(".");
      const declared =
        block === "needs" ? new Map(child.needs.map((n) => [n.name, n])) : new Map(Object.entries(child[block]));
      const accepted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(written)) {
        if (declared.has(key)) {
          accepted[key] = value;
          continue;
        }
        const names = [...declared.keys()];
        report(
          "APPLICATION_INPUT_UNDECLARED",
          `${label}: '${mapPath}.${key}' names no ${SINGULAR[block]} ${declarer} declares — ` +
            (names.length > 0 ? `it declares ${names.map((n) => `'${n}'`).join(", ")}.` : `it declares none.`),
          `${mapPath}.${key}`,
        );
      }
      if (block === "needs") {
        for (const [key, value] of Object.entries(accepted)) {
          judgeNeed(child.needs.find((n) => n.name === key)!, key, value, `${mapPath}.${key}`);
        }
        continue;
      }
      if (Object.keys(accepted).length === 0) continue;
      const properties: Record<string, unknown> = {};
      for (const name of Object.keys(accepted)) {
        properties[name] =
          block === "ports" ? PORT_SCHEMA : inputValueSchema(child[block][name] as Record<string, unknown>);
      }
      const blockSchema = nestedSchema(keys, { type: "object", properties });
      const nestedValue = nestedValueOf(keys, accepted);
      for (const finding of declaredInputFindings(nestedValue, blockSchema, scope.defs, {
        subject: label,
        declarer,
      })) {
        report(finding.code, finding.message, finding.path, finding.fix);
      }
    }

    function judgeNeed(need: ChildApplicationNeed, key: string, value: unknown, path: string): void {
      const shape = need.shape ?? (need.type?.startsWith("Telo.") ? scope.needType(need.type) : undefined);
      if (isResolvedReference(value)) {
        const written = value.alias ? `${value.alias}.${value.name}` : value.name;
        const supplied = suppliedBy(value, module, declaringScopeOf(node));
        if (!supplied || !need.type) return;
        if (!supplied.type || !scope.needType(supplied.type)) {
          report(
            "REFERENCE_KIND_MISMATCH",
            `${label}: need '${key}' is need type '${need.type}', and '${written}' is ` +
              `'${supplied.kind}', which is no need or fulfilment. A need is supplied by a need or ` +
              `fulfilment of its own type, or a map of its fields.`,
            path,
          );
          return;
        }
        if (supplied.type !== need.type) {
          report(
            "REFERENCE_KIND_MISMATCH",
            `${label}: need '${key}' is need type '${need.type}', and '${written}' is ` +
              `'${supplied.kind}' (resolved: '${supplied.type}'). A need is supplied by a need or ` +
              `fulfilment of its own type.`,
            path,
          );
          return;
        }
        // An optional referent is refused at every reference slot already
        // (`NEED_OPTIONAL_REFERENCED`), so only what a need states is compared.
        if (!supplied.need || supplied.need.optional) return;
        for (const message of wholeForwardRefusals(label, key, declarer, written, need, supplied.need, shape)) {
          report("NEED_FORWARD_INCOMPATIBLE", message, path);
        }
        return;
      }
      if (!isPlainObject(value) || !shape || !need.type) return;
      for (const finding of fieldSupplyFindings(value, shape, `${label}: need '${key}'`, need.type, path)) {
        report(finding.code, finding.message, finding.path);
      }
    }
  };

  /** What a whole `!ref` names: a need of the holder's module (with what it
   *  states), a fulfilment it declares, or an instance an import exports. */
  const suppliedBy = (
    ref: { kind: string; name: string; alias?: string },
    module: string | undefined,
    within: ScopeSite | undefined,
  ): { kind: string; type?: string; need?: ForwardedNeed } | undefined => {
    if (ref.alias !== undefined && ref.alias !== "Self") {
      return { kind: ref.kind, type: scope.resolveKind(module, ref.kind) ?? ref.kind };
    }
    const declaration = declarations.resolve(ref.name, module, within);
    if (!declaration) return undefined;
    const kind = declaration.kind as string;
    const type = scope.resolveKind(module, kind);
    if (isInjectedDeclaration(declaration) && injectedNeedOf(declaration)) {
      const doc = module !== undefined ? moduleDocs.get(module) : undefined;
      const declared = readNeeds(doc).find((n) => n.name === ref.name);
      return declared ? { kind, ...(type ? { type } : {}), need: { ...declared, ...(type ? { type } : {}) } } : undefined;
    }
    return { kind, ...(type ? { type } : {}) };
  };

  /** The file `m` was written in: its own, or for an extraction its outermost
   *  holder's, followed through `xTeloOrigin`. */
  const declaringFile = (m: ResourceManifest, module: string | undefined): string | undefined => {
    let current: ResourceManifest | undefined = m;
    const seen = new Set<ResourceManifest>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const meta = current.metadata as { source?: unknown; xTeloOrigin?: { parentName?: unknown } } | undefined;
      if (typeof meta?.source === "string") return meta.source;
      const parent = meta?.xTeloOrigin?.parentName;
      current = typeof parent === "string" ? holders.get(`${module ?? ""}\0${parent}`) : undefined;
    }
    return undefined;
  };

  for (const m of manifests) {
    if (!m.kind || isDeclarationDocument(m) || isForwardedDeclaration(m) || isInjectedDeclaration(m)) continue;
    const meta = m.metadata as { name?: unknown; module?: unknown; source?: string } | undefined;
    if (typeof meta?.name !== "string") continue;
    const module = typeof meta.module === "string" ? meta.module : undefined;
    if (module !== undefined && !rootModules.has(module)) continue;
    // A scope member's source is resolved against the file its outermost holder
    // is written in; it is reported at itself, which the analysis moves there.
    let root: ResourceManifest = m;
    for (let member = scopeMemberOf(root); member; member = scopeMemberOf(root)) root = member.holder;
    const file = declaringFile(root, module);
    judge(m, module, "", { resource: { kind: m.kind, name: meta.name }, filePath: root === m ? file : meta.source }, file);
  }
  return out;
}

function reportFailure(
  record: Extract<ApplicationSourceRecord, { failure: unknown }>,
  label: string,
  field: string,
  source: string,
  report: (code: string, message: string, path: string) => void,
): void {
  const code = importFailureCode(record.failure);
  const message =
    code === "INVALID_IMPORT_SOURCE"
      ? `${label}: '${field}: ${source}' is not a recognized application source. Expected ` +
        `'oci://host/repo@tag', 'https://…', or a relative path.`
      : code === "INVALID_IMPORT_TARGET"
        ? `${label}: cannot run '${source}': ${record.failure.message}`
        : `${label}: cannot resolve the application at '${source}': ${record.failure.message}`;
  report(code, message, field);
}

/** `inner` beneath the property chain `keys`, as a schema. */
function nestedSchema(keys: readonly string[], inner: Record<string, unknown>): Record<string, any> {
  return keys.reduceRight<Record<string, any>>(
    (schema, key) => ({ type: "object", properties: { [key]: schema } }),
    inner,
  );
}

/** `inner` beneath the property chain `keys`, as a value. */
function nestedValueOf(keys: readonly string[], inner: unknown): Record<string, unknown> {
  return keys.reduceRight<unknown>((value, key) => ({ [key]: value }), inner) as Record<string, unknown>;
}

/**
 * The schema an expression under a fed map is joined against — each map key
 * typed by the child's declaration of it — for a resource of an annotated kind
 * whose child the loader loaded; undefined otherwise. What the CEL slot-fit
 * check reads beside the kind's own schema, which types those maps as open.
 */
export function applicationInputsSlotSchema(
  resource: ResourceManifest,
  authorSchema: Record<string, any>,
  records: ApplicationSourceRecords,
  needType: (kind: string) => NeedTypeShape | undefined,
): Record<string, any> | undefined {
  const slot = readApplicationSourceSlot(authorSchema);
  if (!slot) return undefined;
  const source = (resource as Record<string, unknown>)[slot.field];
  const filePath = (resource.metadata as { source?: unknown } | undefined)?.source;
  if (typeof source !== "string" || typeof filePath !== "string") return undefined;
  const record = records[filePath]?.[source];
  if (!record || !("application" in record)) return undefined;
  const child = record.application;
  let schema: Record<string, any> = { type: "object", properties: {} };
  for (const block of APPLICATION_INPUT_BLOCKS) {
    const keys = slot.feeds[block];
    if (!keys) continue;
    const properties: Record<string, unknown> = {};
    if (block === "needs") {
      for (const need of child.needs) {
        const shape = need.shape ?? (need.type?.startsWith("Telo.") ? needType(need.type) : undefined);
        if (shape) properties[need.name] = { type: "object", properties: shape.fields };
      }
    } else {
      for (const [name, entry] of Object.entries(child[block])) {
        properties[name] = block === "ports" ? PORT_SCHEMA : inputValueSchema(entry);
      }
    }
    schema = mergeNested(schema, keys, { type: "object", properties });
  }
  return schema;
}

/** `schema` with `inner` placed beneath the property chain `keys`. */
function mergeNested(
  schema: Record<string, any>,
  keys: readonly string[],
  inner: Record<string, unknown>,
): Record<string, any> {
  const [key, ...rest] = keys;
  const properties = { ...(schema.properties ?? {}) };
  properties[key!] =
    rest.length === 0 ? inner : mergeNested(properties[key!] ?? { type: "object", properties: {} }, rest, inner);
  return { ...schema, type: "object", properties };
}
