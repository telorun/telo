import type { ASTNode, Environment } from "@marcbachmann/cel-js";
import { isTaggedSentinel } from "@telorun/templating";
import {
  AMBIENT_CONTRACT_ERROR_CODES,
  isAmbientContractErrorCode,
  type ResourceDefinition,
  type ResourceManifest,
} from "@telorun/sdk";
import { scopeResolverForModule, type AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  createResolveCtx,
  resolveScopeUnion,
  resolveThrowsUnion,
  type ThrowsCodeMeta,
  type ThrowsUnion,
} from "./resolve-throws-union.js";
import {
  buildEnclosers,
  collectScopedManifests,
  enclosingCoverage,
  type ProvenCoverage,
  type ScopedManifest,
} from "./catch-scope.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { extractAccessChains, validateChainAgainstSchema } from "./validate-cel-context.js";
import { isStepSlot } from "./step-slot.js";

const SOURCE = "telo-analyzer";
const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;

interface OutcomeEntry {
  /** Inline `"${{ … }}"` string or a `!cel` TaggedSentinel. */
  when?: unknown;
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
          // The EMPTY pointer names the resource the list is written on, the
          // spelling `x-telo-schema-projection-from` already uses for the same
          // "this declaration, not one it references" meaning — so the test is
          // presence, never truthiness.
          if (catchesFor !== undefined) {
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
  whenExpr: unknown,
  env: Environment,
): { proven: boolean; codes: Set<string> } {
  // The `when:` value is either a `!cel` TaggedSentinel (carrying the raw CEL
  // source) or an inline `"${{ … }}"` string — both forms are load-equivalent.
  const source =
    isTaggedSentinel(whenExpr) && whenExpr.engine === "cel"
      ? whenExpr.source
      : typeof whenExpr === "string"
        ? whenExpr.match(/\$\{\{\s*([^}]+?)\s*\}\}/)?.[1]
        : undefined;
  if (!source) return { proven: false, codes: new Set() };
  let ast: ASTNode;
  try {
    ast = env.parse(source.trim()).ast;
  } catch {
    return { proven: false, codes: new Set() };
  }
  const codes = new Set<string>();
  const proven = extractFromNode(ast, codes);
  return { proven, codes };
}

function extractFromNode(node: ASTNode, codes: Set<string>): boolean {
  if (node.op === "||") {
    const [l, r] = node.args as [ASTNode, ASTNode];
    return extractFromNode(l, codes) && extractFromNode(r, codes);
  }
  if (node.op === "==") {
    const [l, r] = node.args as [ASTNode, ASTNode];
    const lit = readErrorCodeEq(l, r) ?? readErrorCodeEq(r, l);
    if (lit === null) return false;
    codes.add(lit);
    return true;
  }
  if (node.op === "in") {
    const [l, r] = node.args as [ASTNode, ASTNode];
    if (!isErrorCodeRef(l) || r.op !== "list") return false;
    for (const item of r.args as ASTNode[]) {
      if (item.op !== "value" || typeof item.args !== "string") return false;
      codes.add(item.args);
    }
    return true;
  }
  return false;
}

function readErrorCodeEq(ref: ASTNode, lit: ASTNode): string | null {
  if (!isErrorCodeRef(ref)) return null;
  if (lit.op !== "value" || typeof lit.args !== "string") return null;
  return lit.args;
}

function isErrorCodeRef(node: ASTNode): boolean {
  if (node.op !== ".") return false;
  const [obj, field] = node.args as [ASTNode, string];
  if (field !== "code") return false;
  return obj.op === "id" && obj.args === "error";
}

/** Rule 7: within an outcome list, a no-`when:` entry must be the last entry. */
function checkCatchAllPlacement(
  entries: OutcomeEntry[],
  resource: { kind: string; name: string },
  channel: "returns" | "catches",
  filePath: string | undefined,
  arrayPath: string,
  routing: { kind: string; name: string } = resource,
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
        data: { resource: routing, filePath, path: `${arrayPath}[${i}]` },
      });
    }
  }
  return diagnostics;
}

/** Read one list's {@link ProvenCoverage} — the codes its coverage-proving
 *  `when:` clauses name, and whether it ends in a catch-all. */
function provenCoverage(entries: OutcomeEntry[], env: Environment): ProvenCoverage {
  const codes = new Set<string>();
  let hasCatchAll = false;
  for (const e of entries) {
    if (!e) continue;
    if (!e.when) {
      hasCatchAll = true;
      continue;
    }
    const { proven, codes: entryCodes } = extractCoveredCodes(e.when, env);
    if (!proven) continue;
    for (const c of entryCodes) codes.add(c);
  }
  return { codes, hasCatchAll };
}

/** Rule 4: a coverage-proving `when:` may only name a code the list's own
 *  denominator can produce. Runs for EVERY list, scope lists included — the
 *  denominator differs (a handler's union, or the enclosing resource's own), the
 *  typo check does not. */
function checkUndeclaredCodes(
  entries: OutcomeEntry[],
  union: ThrowsUnion,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  arrayPath: string,
  env: Environment,
  denominator: string,
  routing: { kind: string; name: string } = resource,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const declaredCodes = new Set(union.codes.keys());

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e?.when) continue;
    const { proven, codes } = extractCoveredCodes(e.when, env);
    if (!proven) continue;
    for (const c of codes) {
      // An ambient kernel code (contract violations) is raised by the kernel,
      // not declared by the kind, so naming it is legal and still typo-checked
      // — but it is NOT part of the declared union, so it never counts toward
      // coverage. Folding these into every union would make every bounded
      // catches: block in the standard library incomplete overnight.
      if (isAmbientContractErrorCode(c)) continue;
      if (declaredCodes.has(c)) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "UNDECLARED_THROW_CODE",
        source: SOURCE,
        message: `catches[${i}] references code '${c}' which is not in ${denominator} {${[...declaredCodes].sort().join(", ") || "∅"}} (ambient kernel codes ${AMBIENT_CONTRACT_ERROR_CODES.join(", ")} may also be named)${union.unbounded ? "; the union is unbounded, so a catch-all is required" : ""}.`,
        data: { resource: routing, filePath, path: `${arrayPath}[${i}].when` },
      });
    }
  }

  return diagnostics;
}

/** Rule 1 + the unbounded-union rule, asked ONCE per dispatch site over every
 *  list that can render its throws — the site's own, its resource's scope list,
 *  and every scope enclosing that resource.
 *
 *  Asking it per list is what would make this a false check rather than a
 *  missing one: a route that declares no `catches:` under a router that renders
 *  everything is completely covered, and reporting it fires on precisely the
 *  manifests scope lists exist to enable. */
function checkCoverage(
  union: ThrowsUnion,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  arrayPath: string,
  handler: { kind: string; name?: string } | null,
  covered: ProvenCoverage,
  routing: { kind: string; name: string } = resource,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  if (covered.hasCatchAll) return diagnostics;

  // Unbounded union (passthrough or transitive): authors can't enumerate the
  // codes, so a catch-all is mandatory — at this list or any enclosing scope.
  if (union.unbounded) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "UNBOUNDED_UNION_NEEDS_CATCHALL",
      source: SOURCE,
      message: `The handler's throw union is unbounded (inherit/passthrough resolution couldn't enumerate all codes). A catch-all entry (no \`when:\`) is required — on this catches: list or on an enclosing one.`,
      data: { resource: routing, filePath, path: arrayPath },
    });
  }

  // One diagnostic per site, not per code: every uncovered code sits at the
  // same dispatch site, and one catch-all answers all of them at once. A
  // diagnostic each repeated the same location and the same fix N times.
  const uncovered = [...union.codes.keys()].filter((c) => !covered.codes.has(c)).sort();
  if (uncovered.length > 0) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "UNCOVERED_THROW_CODE",
      source: SOURCE,
      message:
        `handler ${handler?.name ? `\`!ref ${handler.name}\`` : `\`${handler?.kind ?? "?"}\``} can throw ${uncovered.length} code${uncovered.length === 1 ? "" : "s"} that no catches: entry handles — at this list or any enclosing scope: ${uncovered.map((c) => `'${c}'`).join(", ")}. ` +
        `Give each a matching \`when:\` (e.g. \`when: !cel "error.code == '${uncovered[0]}'"\`), or add a catch-all entry — one with no \`when:\`, placed last.`,
      data: { resource: routing, filePath, path: arrayPath, uncovered },
    });
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
  routing: { kind: string; name: string } = resource,
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
    // The WHOLE entry, not an enumerated `body` / `headers` pair. An HTTP catch
    // entry keeps its body at `content[<mime>].body`, so reading `e.body` walked
    // a field that shape never has and this check was inert for every catch list
    // in the standard library. Walking the entry also covers `when:` and the
    // per-MIME header overrides, which are equally places `error.data` is read.
    collectCelStrings(e, `${arrayPath}[${i}]`).forEach((entry) => {
      diagnostics.push(
        ...checkCelChainAgainstDataSchema(entry, dataSchema, resource, filePath, env, routing),
      );
    });
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
  // A `!cel` sentinel and a `${{ … }}` string are load-equivalent, and the
  // formatter normalizes to the tag — so recognising only the string form left
  // this check answering about a spelling no manifest in the repository uses,
  // while walking the sentinel as a plain object found nothing.
  if (isTaggedSentinel(value)) {
    if (value.engine === "cel") out.push({ expr: value.source.trim(), path });
    return out;
  }
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
  entry: CelString,
  dataSchema: Record<string, any>,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  env: Environment,
  routing: { kind: string; name: string } = resource,
): AnalysisDiagnostic[] {
  let ast: ASTNode;
  try {
    ast = env.parse(entry.expr).ast;
  } catch {
    return [];
  }
  const chains = extractAccessChains(ast);
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const chain of chains) {
    // Only interested in chains that start with error.data.*
    if (chain[0] !== "error" || chain[1] !== "data" || chain.length <= 2) continue;
    const subChain = chain.slice(2); // strip "error", "data"
    const err = validateChainAgainstSchema(subChain, dataSchema);
    if (err) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "CEL_UNKNOWN_FIELD",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: CEL at '${entry.path}': error.data.${err}`,
        data: { resource: routing, filePath, path: entry.path },
      });
    }
  }
  return diagnostics;
}

/** Rule 8 extension: `inherit: true` only makes sense on a definition whose
 *  schema declares at least one STEP BODY — an array whose items point at the
 *  shared grammar, or, for a module published before that fragment existed, one
 *  carrying the legacy `x-telo-step-context` annotation. That is what drives the
 *  resolver's generic step traversal; a definition with `inherit: true` and no
 *  such array has no invocables to inherit from. */
/** The capabilities whose lifecycle includes a dispatch a caller can catch. On
 *  every other one a thrown error is a boot-time failure, not a structured
 *  runtime error for a downstream caller — a provider resolves configuration, a
 *  type has no instance, a sink is written to directly, and a service or mount
 *  is STARTED rather than called (what a router renders is not what a router
 *  throws).
 *
 *  The strict half of the kernel's `ResourceDefinitionSchema` rule 8, and it has
 *  to exist here for the reason every `x-telo-*` accessor has a strict half: the
 *  kernel refuses at `create()`, which is a boot failure on a manifest that
 *  passed `telo check` — the static/runtime disagreement this repository treats
 *  as a defect. The two must agree; a change to either belongs in both.
 *
 *  **Reported for a DEPENDENCY's definition too**, unlike `X_TELO_REF_UNRESOLVED`
 *  and `DEPRECATED_KIND`, which are entry-module-scoped. Those report something a
 *  consumer can live with — a slot that cannot be checked, a kind that still
 *  works — so silence costs them nothing and the noise is not theirs to fix.
 *  This one reports a definition the kernel REFUSES, so the manifest importing it
 *  cannot start at all: withholding that would replace a `telo check` error with
 *  an identical boot failure and no earlier warning. The action is a consumer's
 *  to take (pin another version, report upstream) even though the edit is not.
 *  Matches the neighbouring `INHERIT_WITHOUT_STEP_CONTEXT`, which is fatal the
 *  same way. */
const THROWS_CAPABLE_CAPABILITIES = new Set(["Telo.Invocable", "Telo.Runnable"]);

function validateThrowsDeclarations(manifests: ResourceManifest[]): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const throws = (m as Record<string, any>).throws;
    if (!throws) continue;
    const name = (m.metadata?.name as string | undefined) ?? "<unnamed>";
    const filePath = (m.metadata as { source?: string } | undefined)?.source;

    // Only a DECLARED capability is judged. One inherited through `extends` is
    // resolved elsewhere, and an unknown one is third-party extensibility the
    // kernel's schema deliberately leaves open.
    const capability = (m as Record<string, any>).capability as string | undefined;
    if (typeof capability === "string" && !THROWS_CAPABLE_CAPABILITIES.has(capability)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "THROWS_ON_NON_DISPATCH_CAPABILITY",
        source: SOURCE,
        message:
          `Telo.Definition '${name}' declares throws: but its capability is '${capability}'. ` +
          `A throw union describes what a CALLER can catch, so it is only meaningful on ` +
          `${[...THROWS_CAPABLE_CAPABILITIES].join(" or ")}; on '${capability}' a thrown error is a ` +
          `boot-time failure with no caller to render it. The kernel refuses this definition at ` +
          `create(), so a manifest carrying it cannot start.`,
        data: { resource: { kind: m.kind, name }, filePath, path: "throws" },
      });
      continue;
    }
    if (throws.inherit === true) {
      const schema = (m as Record<string, any>).schema as Record<string, any> | undefined;
      if (!schemaDrivesInvocables(schema)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "INHERIT_WITHOUT_STEP_CONTEXT",
          source: SOURCE,
          message:
            `Telo.Definition '${name}' declares throws.inherit: true but its schema declares no step ` +
            `body. inherit is only meaningful on a definition that drives invocables through steps — ` +
            `give an array field 'items: { $ref: "telo://manifest#/$defs/Step" }' (the legacy ` +
            `x-telo-step-context annotation is also recognised).`,
          data: { resource: { kind: m.kind, name }, filePath, path: "throws.inherit" },
        });
      }
    }
  }
  return diagnostics;
}

function schemaDrivesInvocables(schema: Record<string, any> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (isStepSlot(schema)) return true;
  const props = schema.properties;
  if (props && typeof props === "object") {
    for (const v of Object.values(props as Record<string, any>)) {
      if (schemaDrivesInvocables(v)) return true;
    }
  }
  if (schema.items && schemaDrivesInvocables(schema.items)) return true;
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = schema[key];
    if (Array.isArray(arr)) {
      for (const sub of arr) if (schemaDrivesInvocables(sub)) return true;
    }
  }
  if (schema.$defs && typeof schema.$defs === "object") {
    for (const v of Object.values(schema.$defs as Record<string, any>)) {
      if (schemaDrivesInvocables(v)) return true;
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
  aliasesByModule: Map<string, AliasResolver> = new Map(),
  rootModules: Set<string> = new Set(),
  /** Each imported library's full document set, so the walk can follow an
   *  exported entry point into the siblings it invokes — which a consumer's
   *  flat set does not carry. */
  moduleManifests: Map<string, ResourceManifest[]> = new Map(),
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  diagnostics.push(...validateThrowsDeclarations(manifests));

  // A `with:`-scoped declaration is a resource like any other — it has a kind, a
  // name, and, for a scoped `Http.Server`, a catch list that renders what its
  // mounts throw. It is simply not in the flat set, so every check here used to
  // skip it: its own entries went unchecked AND its coverage reached nothing it
  // encloses. Standing a server up around a test is exactly that shape, so the
  // sanctioned pattern was the one the pass could not see.
  //
  // Discovered through the shared visitor rather than a second scope walk, and
  // folded into the pool every name is resolved against — a scoped mount whose
  // target the resolver cannot find reads as an empty union, which reports every
  // entry of that server's list as naming a code nothing throws.
  const scoped = collectScopedManifests(manifests, defs, aliases, aliasesByModule, rootModules);
  const allManifests = [...manifests, ...scoped.map((s) => s.manifest)];
  const resolveCtx = createResolveCtx(
    allManifests,
    defs,
    aliases,
    aliasesByModule,
    rootModules,
    moduleManifests,
  );

  // The alias resolver for a manifest's own lexical scope — an imported library's
  // resolver when it owns the manifest, else undefined (fall back to root aliases).
  const scopeResolverFor = (m: ResourceManifest): AliasResolver | undefined =>
    scopeResolverForModule(
      (m.metadata as { module?: string } | undefined)?.module,
      rootModules,
      aliasesByModule,
    );

  // Pass 1 — read every outcome list, and record which resources each scope
  // list encloses. A scope list has to be known before any site it covers is
  // judged, so collection and judgement cannot be one loop.
  const sites: CatchSite[] = [];
  const scopeOf = new Map<ResourceManifest, ProvenCoverage>();
  const scopedBy = new Map<ResourceManifest, ScopedManifest>();
  for (const s of scoped) scopedBy.set(s.manifest, s);

  const definitionFor = (manifest: ResourceManifest) => {
    // A scoped declaration's kind is written in the alias scope of the module
    // that declared the ENCLOSING resource; it carries no `metadata.module` of
    // its own to find one by.
    const anchor = scopedBy.get(manifest)?.owner ?? manifest;
    const scopeResolver = scopeResolverFor(anchor);
    const resolvedKind =
      scopeResolver?.resolveKind(manifest.kind) ?? aliases.resolveKind(manifest.kind);
    return defs.resolve(manifest.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined);
  };

  const enclosers = buildEnclosers(
    allManifests,
    definitionFor,
    (m) => ((scopedBy.get(m)?.owner ?? m).metadata as { module?: string } | undefined)?.module,
    resolveCtx,
  );

  for (const manifest of allManifests) {
    if (!manifest.kind || !manifest.metadata?.name) continue;
    if (manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract") continue;
    // A scoped declaration is reported against the document it is WRITTEN in —
    // its owner's — at its own position inside that owner's scope array, because
    // position lookup finds a TOP-LEVEL doc by (kind, name) and a scoped
    // resource is not one. The message still names the scoped resource, so the
    // reader is not sent to a resource that has no `catches:` at all.
    const enclosing = scopedBy.get(manifest);
    const anchor = enclosing?.owner ?? manifest;
    const pathPrefix = enclosing ? `${enclosing.path}.` : "";
    const scopeResolver = scopeResolverFor(anchor);
    const definition = definitionFor(manifest);
    if (!definition?.schema) continue;
    const resource = { kind: manifest.kind, name: manifest.metadata.name as string };
    const routing = enclosing
      ? { kind: anchor.kind, name: anchor.metadata!.name as string }
      : resource;
    const filePath = (anchor.metadata as { source?: string } | undefined)?.source;

    collectOutcomeLists(
      manifest,
      definition.schema,
      (ret) => {
        diagnostics.push(
          ...checkCatchAllPlacement(
            ret.entries,
            resource,
            "returns",
            filePath,
            `${pathPrefix}${ret.arrayPath}`,
            routing,
          ),
        );
      },
      (entries, arrayPath, siblingData, catchesFor) => {
        const site: CatchSite = {
          manifest,
          definition,
          resource,
          routing,
          filePath,
          entries,
          arrayPath: `${pathPrefix}${arrayPath}`,
          scopeResolver,
          handlerRef: catchesFor === "" ? null : resolveHandlerRef(siblingData[catchesFor]),
          isScope: catchesFor === "",
        };
        sites.push(site);
        if (site.isScope) scopeOf.set(manifest, provenCoverage(entries, env));
      },
    );
  }

  const coverageMemo = new Map<ResourceManifest, ProvenCoverage>();
  const scopeCoverageFor = (manifest: ResourceManifest): ProvenCoverage =>
    enclosingCoverage(manifest, scopeOf, enclosers, coverageMemo);

  // Pass 2 — judge each list against its own denominator, and each dispatch site
  // against everything that can render its throws.
  for (const site of sites) {
    diagnostics.push(
      ...checkCatchAllPlacement(
        site.entries,
        site.resource,
        "catches",
        site.filePath,
        site.arrayPath,
        site.routing,
      ),
    );
    const union = site.isScope
      ? resolveScopeUnion(site.manifest, site.definition, resolveCtx)
      : handlerRefUnion(site.handlerRef, allManifests, resolveCtx, site.scopeResolver);
    diagnostics.push(
      ...checkUndeclaredCodes(
        site.entries,
        union,
        site.resource,
        site.filePath,
        site.arrayPath,
        env,
        site.isScope
          ? "the throw union of everything this resource drives"
          : "the handler's declared throw union",
        site.routing,
      ),
    );
    diagnostics.push(
      ...checkTypedErrorData(
        site.entries,
        union,
        site.resource,
        site.filePath,
        site.arrayPath,
        env,
        site.routing,
      ),
    );
    if (site.isScope) continue;

    const own = provenCoverage(site.entries, env);
    const scope = scopeCoverageFor(site.manifest);
    const covered: ProvenCoverage = {
      codes: new Set([...own.codes, ...scope.codes]),
      hasCatchAll: own.hasCatchAll || scope.hasCatchAll,
    };
    diagnostics.push(
      ...checkCoverage(
        union,
        site.resource,
        site.filePath,
        site.arrayPath,
        site.handlerRef,
        covered,
        site.routing,
      ),
    );
  }

  return diagnostics;
}

/** One `catches:` list in one manifest, with everything needed to judge it. */
interface CatchSite {
  manifest: ResourceManifest;
  definition: ResourceDefinition;
  /** Named in the MESSAGE — the resource whose list this is. */
  resource: { kind: string; name: string };
  /** Named in `data.resource`, which is how position lookup finds a document:
   *  it searches TOP-LEVEL docs by (kind, name), so a scoped resource routes
   *  through its owner while the message still names the scoped one. */
  routing: { kind: string; name: string };
  filePath: string | undefined;
  entries: OutcomeEntry[];
  arrayPath: string;
  scopeResolver: AliasResolver | undefined;
  /** The handler this list renders throws for; null for a scope list. */
  handlerRef: { kind: string; name?: string } | null;
  /** `x-telo-catches-for: ""` — the list covers everything its resource drives
   *  and owes coverage of nothing on its own. */
  isScope: boolean;
}

/** Resolve a handler ref's effective throw union. Prefers the named manifest
 *  (so `inherit: true` handlers expose their transitive union); falls back to
 *  the definition's own codes when no name is given. */
function handlerRefUnion(
  handlerRef: { kind: string; name?: string } | null,
  manifests: ResourceManifest[],
  ctx: ReturnType<typeof createResolveCtx>,
  scopeResolver: AliasResolver | undefined,
): ThrowsUnion {
  if (!handlerRef) return { codes: new Map(), unbounded: false };
  if (handlerRef.name) {
    const resolvedKind = scopeResolver?.resolveKind(handlerRef.kind) ?? ctx.aliases.resolveKind(handlerRef.kind);
    const targetManifest = manifests.find(
      (m) =>
        m.metadata?.name === handlerRef.name &&
        (m.kind === handlerRef.kind ||
          m.kind === resolvedKind ||
          scopeResolver?.resolveKind(m.kind) === handlerRef.kind ||
          ctx.aliases.resolveKind(m.kind) === handlerRef.kind),
    );
    if (targetManifest) return resolveThrowsUnion(targetManifest, ctx);
  }
  // No named target — fall back to the handler kind's own declared codes,
  // resolving the kind in the owner's lexical scope first, then root aliases.
  const resolved = scopeResolver?.resolveKind(handlerRef.kind) ?? ctx.aliases.resolveKind(handlerRef.kind);
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
