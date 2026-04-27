import type { Environment } from "@marvec/cel-vm";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  createResolveCtx,
  resolveThrowsUnion,
  type ThrowsCodeMeta,
  type ThrowsUnion,
} from "./resolve-throws-union.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";
const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;

interface OutcomeEntry {
  when?: string;
  body?: unknown;
  headers?: Record<string, unknown>;
  status?: number;
  schema?: Record<string, unknown>;
}

interface ReturnsLocation {
  manifest: ResourceManifest;
  entries: OutcomeEntry[];
  arrayPath: string;
}

/** Walk `definition.schema` and `data` in tandem, invoking `onOutcome` each
 *  time an array schema annotated with `x-telo-outcome-list` is encountered.
 *  Keeps schema/data in lockstep so callers can resolve sibling fields. */
function collectOutcomeLists(
  manifest: ResourceManifest,
  schema: Record<string, any> | undefined,
  onReturns: (loc: ReturnsLocation) => void,
  onCatches: (
    arr: OutcomeEntry[],
    arrayPath: string,
    siblingData: Record<string, any>,
    catchesFor: string,
  ) => void,
): void {
  if (!schema) return;
  walkSchemaData(schema, manifest as Record<string, any>, "", {
    manifest,
    onReturns,
    onCatches,
  });
}

type WalkCtx = {
  manifest: ResourceManifest;
  onReturns: (loc: ReturnsLocation) => void;
  onCatches: (
    arr: OutcomeEntry[],
    arrayPath: string,
    siblingData: Record<string, any>,
    catchesFor: string,
  ) => void;
};

function walkSchemaData(
  schema: Record<string, any>,
  data: unknown,
  path: string,
  ctx: WalkCtx,
): void {
  if (!schema || typeof schema !== "object") return;

  const outcomeKind = schema["x-telo-outcome-list"] as "returns" | "catches" | undefined;
  if (outcomeKind && Array.isArray(data)) {
    // The sibling data is the parent object (not reachable here without tracking).
    // collectOutcomeListsInObject passes the parent; this branch is a fallback
    // for top-level outcome lists (never occurs in practice).
    if (outcomeKind === "returns") {
      ctx.onReturns({ manifest: ctx.manifest, entries: data as OutcomeEntry[], arrayPath: path });
    }
    return;
  }

  if (schema.properties && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const dataObj = data as Record<string, unknown>;
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      const nextPath = path ? `${path}.${key}` : key;
      const child = dataObj[key];
      const outcome = propSchema["x-telo-outcome-list"] as "returns" | "catches" | undefined;
      if (outcome) {
        const entries = Array.isArray(child) ? (child as OutcomeEntry[]) : [];
        if (outcome === "returns") {
          // Only fire for present arrays — rule 6 (missing returns) is
          // enforced by schema required fields, not here.
          if (Array.isArray(child)) {
            ctx.onReturns({ manifest: ctx.manifest, entries, arrayPath: nextPath });
          }
        } else {
          const catchesFor = propSchema["x-telo-catches-for"] as string | undefined;
          if (catchesFor) {
            // Fire even when absent so the coverage check can flag handlers
            // whose declared union is non-empty but the list is missing.
            ctx.onCatches(entries, nextPath, dataObj, catchesFor);
          }
        }
        continue;
      }
      if (child !== undefined) walkSchemaData(propSchema, child, nextPath, ctx);
    }
  }

  if (schema.items && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      walkSchemaData(schema.items, item, `${path}[${i}]`, ctx);
    }
  }
}

/** Read a referenced handler's `{kind, name}` from a sibling field. Handles
 *  both `"Alias.Kind"` strings and `{ kind, name? }` objects. */
function resolveHandlerRef(sibling: unknown): { kind: string; name?: string } | null {
  if (!sibling) return null;
  if (typeof sibling === "string") return { kind: sibling };
  if (typeof sibling === "object") {
    const obj = sibling as { kind?: string; name?: string };
    if (typeof obj.kind === "string") {
      return { kind: obj.kind, name: obj.name };
    }
  }
  return null;
}

/** Parse a `when:` CEL expression and extract the set of `error.code` literals
 *  it covers. Recognised forms (per the plan's "coverage-proving" list):
 *  - `error.code == 'FOO'`
 *  - a disjunction of the above (`||`)
 *  - `error.code in ['FOO', 'BAR']`
 *  Parenthesised nestings of `||` over equality/in are flattened.
 *  Any non-matching sub-expression forfeits coverage for the whole `when:`. */
function extractCoveredCodes(
  _whenExpr: string,
  _env: Environment,
): { proven: boolean; codes: Set<string> } {
  // cel-vm has no public AST; throws-coverage proof from `when:` clauses is
  // disabled on this branch. Returning `proven: false` is the conservative
  // outcome — every entry is treated as non-coverage-proving, so coverage
  // checks that depend on this fall back to whatever the catch-all path yields.
  return { proven: false, codes: new Set() };
}

/** Rule 7: within an outcome list, a no-`when:` entry must be the last entry. */
function checkCatchAllPlacement(
  entries: OutcomeEntry[],
  resource: { kind: string; name: string },
  channel: "returns" | "catches",
  filePath: string | undefined,
  arrayPath: string,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const e = entries[i];
    if (!e?.when) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "CATCHALL_NOT_LAST",
        source: SOURCE,
        message: `${channel}: catch-all entry (no \`when:\`) at index ${i} must be last — entries after it are unreachable.`,
        data: { resource, filePath, path: `${arrayPath}[${i}]` },
      });
    }
  }
  return diagnostics;
}

/** Rule 1 + Rule 4: check declared-union coverage and reject undeclared codes
 *  in coverage-proving `when:` clauses. Phase 2 accepts inherit/passthrough
 *  handler unions too — when the resolved union is unbounded, a catch-all is
 *  required (rule 4 extension). */
function checkCatchesCoverage(
  entries: OutcomeEntry[],
  union: ThrowsUnion,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  arrayPath: string,
  env: Environment,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const declaredCodes = new Set(union.codes.keys());
  const covered = new Set<string>();
  let hasCatchAll = false;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (!e.when) {
      hasCatchAll = true;
      continue;
    }
    const { proven, codes } = extractCoveredCodes(e.when, env);
    if (proven) {
      for (const c of codes) {
        if (!declaredCodes.has(c)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "UNDECLARED_THROW_CODE",
            source: SOURCE,
            message: `catches[${i}] references code '${c}' which is not in the handler's declared throw union {${[...declaredCodes].sort().join(", ") || "∅"}}${union.unbounded ? " (union is unbounded — a catch-all is required)" : ""}.`,
            data: { resource, filePath, path: `${arrayPath}[${i}].when` },
          });
        } else {
          covered.add(c);
        }
      }
    }
  }

  // Unbounded union (passthrough or transitive): authors can't enumerate the
  // codes, so a catch-all is mandatory.
  if (union.unbounded && !hasCatchAll) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "UNBOUNDED_UNION_NEEDS_CATCHALL",
      source: SOURCE,
      message: `The handler's throw union is unbounded (inherit/passthrough resolution couldn't enumerate all codes). The catches: list must include a catch-all entry (no \`when:\`).`,
      data: { resource, filePath, path: arrayPath },
    });
  }

  if (!hasCatchAll) {
    for (const code of declaredCodes) {
      if (!covered.has(code)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNCOVERED_THROW_CODE",
          source: SOURCE,
          message: `Code '${code}' is declared by the handler but not covered by any catches: entry (no matching \`when:\` and no catch-all).`,
          data: { resource, filePath, path: arrayPath },
        });
      }
    }
  }

  return diagnostics;
}

/** Rule 2: for each `error.data.<field>` chain in a catches entry's expressions,
 *  type-check against the data schema declared for the matched code(s). When the
 *  matching `when:` disjunctively covers multiple codes, use the intersection
 *  of their data schemas so only fields present on every code narrow through. */
function checkTypedErrorData(
  entries: OutcomeEntry[],
  union: ThrowsUnion,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  arrayPath: string,
  env: Environment,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  // If the union is unbounded we can't narrow data schemas reliably — skip
  // typed-data checks for those entries. The catch-all path still provides
  // runtime access to error.data as an opaque value.
  if (union.unbounded || union.codes.size === 0) return diagnostics;

  const dataByCode: Record<string, Record<string, any> | undefined> = {};
  for (const [code, meta] of union.codes) {
    dataByCode[code] = (meta as ThrowsCodeMeta).data;
  }
  const allCodes = Object.keys(dataByCode);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const covered = e.when
      ? extractCoveredCodes(e.when, env)
      : { proven: false, codes: new Set<string>() };
    // Codes applicable to this entry:
    //  - coverage-proving `when:` → exactly those codes
    //  - catch-all (no `when:`) or non-proven expr → all declared codes
    const applicable = covered.proven
      ? [...covered.codes].filter((c) => c in dataByCode)
      : allCodes;
    if (applicable.length === 0) continue;
    const schemas = applicable.map((c) => dataByCode[c]).filter(Boolean) as Record<string, any>[];
    if (schemas.length === 0) continue;
    const dataSchema = intersectDataSchemas(schemas);
    // Walk CEL expressions inside this entry's body / headers — only
    // string-valued fields can contain CEL templates.
    collectCelStrings(e.body, `${arrayPath}[${i}].body`).forEach((entry) => {
      diagnostics.push(
        ...checkCelChainAgainstDataSchema(entry, dataSchema, resource, filePath, env),
      );
    });
    if (e.headers) {
      collectCelStrings(e.headers, `${arrayPath}[${i}].headers`).forEach((entry) => {
        diagnostics.push(
          ...checkCelChainAgainstDataSchema(entry, dataSchema, resource, filePath, env),
        );
      });
    }
  }
  return diagnostics;
}

/** Intersection of JSON Schemas (object type, explicit properties only). Only
 *  retains properties present in every input; picks the most-specific of the
 *  sub-schemas when they agree on `type`, else widens to `{}`. */
function intersectDataSchemas(schemas: Record<string, any>[]): Record<string, any> {
  if (schemas.length === 1) return schemas[0];
  const commonProps: Record<string, Record<string, any>> = {};
  const firstProps = (schemas[0].properties ?? {}) as Record<string, Record<string, any>>;
  for (const propName of Object.keys(firstProps)) {
    const sub = schemas.map((s) => (s.properties ?? {})[propName]);
    if (sub.some((p) => p === undefined)) continue;
    commonProps[propName] = intersectPropertySchemas(sub);
  }
  return {
    type: "object",
    properties: commonProps,
    additionalProperties: false,
  };
}

function intersectPropertySchemas(schemas: Record<string, any>[]): Record<string, any> {
  const types = new Set(schemas.map((s) => s?.type).filter(Boolean));
  if (types.size === 1) {
    const type = [...types][0];
    if (type === "object") return intersectDataSchemas(schemas);
    return { type };
  }
  return {};
}

interface CelString {
  expr: string;
  path: string;
}

function collectCelStrings(value: unknown, path: string): CelString[] {
  const out: CelString[] = [];
  if (typeof value === "string") {
    for (const m of value.matchAll(TEMPLATE_REGEX)) {
      out.push({ expr: m[1].trim(), path });
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      out.push(...collectCelStrings(v, `${path}[${i}]`));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(...collectCelStrings(v, path ? `${path}.${k}` : k));
    }
  }
  return out;
}

function checkCelChainAgainstDataSchema(
  _entry: CelString,
  _dataSchema: Record<string, any>,
  _resource: { kind: string; name: string },
  _filePath: string | undefined,
  _env: Environment,
): AnalysisDiagnostic[] {
  // cel-vm has no public AST, so we cannot extract `error.data.*` access chains
  // from `when:` expressions on this branch. Disable the chain-vs-data-schema
  // check until a parser-based replacement lands.
  return [];
}

/** Rule 8 extension: `inherit: true` only makes sense on a definition whose
 *  schema contains at least one `x-telo-step-context` array — the annotation
 *  that drives the resolver's generic step traversal. A definition with
 *  `inherit: true` and no such array has no invocables to inherit from. */
function validateThrowsDeclarations(manifests: ResourceManifest[]): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const throws = (m as Record<string, any>).throws;
    if (!throws) continue;
    const name = (m.metadata?.name as string | undefined) ?? "<unnamed>";
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    if (throws.inherit === true) {
      const schema = (m as Record<string, any>).schema as Record<string, any> | undefined;
      if (!schemaHasStepContext(schema)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "INHERIT_WITHOUT_STEP_CONTEXT",
          source: SOURCE,
          message: `Telo.Definition '${name}' declares throws.inherit: true but its schema has no field annotated with x-telo-step-context. inherit is only meaningful on definitions that drive invocables via step arrays.`,
          data: { resource: { kind: m.kind, name }, filePath, path: "throws.inherit" },
        });
      }
    }
  }
  return diagnostics;
}

function schemaHasStepContext(schema: Record<string, any> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  if ("x-telo-step-context" in schema) return true;
  const props = schema.properties;
  if (props && typeof props === "object") {
    for (const v of Object.values(props as Record<string, any>)) {
      if (schemaHasStepContext(v)) return true;
    }
  }
  if (schema.items && schemaHasStepContext(schema.items)) return true;
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = schema[key];
    if (Array.isArray(arr)) {
      for (const sub of arr) if (schemaHasStepContext(sub)) return true;
    }
  }
  if (schema.$defs && typeof schema.$defs === "object") {
    for (const v of Object.values(schema.$defs as Record<string, any>)) {
      if (schemaHasStepContext(v)) return true;
    }
  }
  return false;
}

/** Entry point — invoked once per analyze() run. */
export function validateThrowsCoverage(
  manifests: ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  env: Environment,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  diagnostics.push(...validateThrowsDeclarations(manifests));

  const resolveCtx = createResolveCtx(manifests, defs, aliases);

  for (const manifest of manifests) {
    if (!manifest.kind || !manifest.metadata?.name) continue;
    if (manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract") continue;
    const resolvedKind = aliases.resolveKind(manifest.kind);
    const definition =
      defs.resolve(manifest.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined);
    if (!definition?.schema) continue;
    const resource = { kind: manifest.kind, name: manifest.metadata.name as string };
    const filePath = (manifest.metadata as { source?: string } | undefined)?.source;

    collectOutcomeLists(
      manifest,
      definition.schema,
      (ret) => {
        diagnostics.push(
          ...checkCatchAllPlacement(ret.entries, resource, "returns", filePath, ret.arrayPath),
        );
      },
      (entries, arrayPath, siblingData, catchesFor) => {
        diagnostics.push(
          ...checkCatchAllPlacement(entries, resource, "catches", filePath, arrayPath),
        );
        const handlerRef = resolveHandlerRef(siblingData[catchesFor]);
        const union = handlerRefUnion(handlerRef, manifests, resolveCtx);
        diagnostics.push(
          ...checkCatchesCoverage(entries, union, resource, filePath, arrayPath, env),
        );
        diagnostics.push(
          ...checkTypedErrorData(entries, union, resource, filePath, arrayPath, env),
        );
      },
    );
  }
  return diagnostics;
}

/** Resolve a handler ref's effective throw union. Prefers the named manifest
 *  (so `inherit: true` handlers expose their transitive union); falls back to
 *  the definition's own codes when no name is given. */
function handlerRefUnion(
  handlerRef: { kind: string; name?: string } | null,
  manifests: ResourceManifest[],
  ctx: ReturnType<typeof createResolveCtx>,
): ThrowsUnion {
  if (!handlerRef) return { codes: new Map(), unbounded: false };
  if (handlerRef.name) {
    const resolvedKind = ctx.aliases.resolveKind(handlerRef.kind);
    const targetManifest = manifests.find(
      (m) =>
        m.metadata?.name === handlerRef.name &&
        (m.kind === handlerRef.kind ||
          m.kind === resolvedKind ||
          ctx.aliases.resolveKind(m.kind) === handlerRef.kind),
    );
    if (targetManifest) return resolveThrowsUnion(targetManifest, ctx);
  }
  const resolved = ctx.aliases.resolveKind(handlerRef.kind);
  const def =
    ctx.defs.resolve(handlerRef.kind) ?? (resolved ? ctx.defs.resolve(resolved) : undefined);
  if (!def?.throws) return { codes: new Map(), unbounded: false };
  const codes = new Map<string, ThrowsCodeMeta>();
  for (const [c, meta] of Object.entries(def.throws.codes ?? {})) {
    codes.set(c, { data: (meta as { data?: Record<string, any> }).data });
  }
  const unbounded = def.throws.passthrough === true || def.throws.inherit === true;
  return { codes, unbounded };
}
