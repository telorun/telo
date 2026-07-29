import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { OBSERVED_STATE_KEY } from "@telorun/sdk";
import { type DefResolver, effectiveStatusSchema } from "./extends-resolution.js";
import { parseExportEntry } from "./flatten-for-analyzer.js";
import { moduleScopedDefResolver, type ModuleScopes } from "./alias-resolver.js";
import {
  buildReferenceFieldMap,
  isRefEntry,
  isScopeEntry,
  resolveFieldValues,
} from "./reference-field-map.js";

/** The kernel capabilities whose `run()` the kernel dispatches. A ref slot that
 *  accepts one of them is a slot that can start a resource — `targets:` on an
 *  Application or a `Run.Sequence`, and a step's `invoke:` (whose schema accepts
 *  `Telo.Runnable` alongside `Telo.Invocable`, and which the kernel dispatches
 *  through `run()` when the target has no `invoke()`). Keyed on the declared
 *  capability, never on a field name or a kind, so any composer that accepts a
 *  runnable participates without the analyzer knowing about it. */
const RUN_DISPATCH_CONTRACTS = new Set(["Telo.Runnable", "Telo.Service"]);

const SYSTEM_KINDS = new Set([
  "Telo.Definition",
  "Telo.Abstract",
  "Telo.Import",
  "Telo.Application",
  "Telo.Library",
]);

/**
 * The `status:` block's own schema — a plain JSON Schema, structurally. The one
 * normative restriction (`required:` is rejected) is enforced by
 * {@link validateObservedStateDeclarations} rather than here, so the author gets
 * a message naming the rule and the fix instead of AJV's "must NOT be valid".
 *
 * Exported from the analyzer and re-used by the kernel's manifest schemas, so
 * the rule has one definition rather than two kept in sync by hand.
 */
export const OBSERVED_STATE_SCHEMA = {
  type: "object",
  additionalProperties: true,
};

/**
 * `required:` inside a `status:` block. Every declared field is mandatory once
 * the resource has run, so the list would be either redundant or a lie; a
 * genuinely sometimes-absent value is declared with a nullable type, which
 * `CEL_NULLABLE_ACCESS` already guards.
 */
export function validateObservedStateDeclarations(
  manifests: readonly ResourceManifest[],
): Array<{ kind: string; name: string; filePath?: string; message: string }> {
  const out: Array<{ kind: string; name: string; filePath?: string; message: string }> = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
    const status = (m as { status?: Record<string, any> }).status;
    if (!status || typeof status !== "object" || !Array.isArray(status.required)) continue;
    const name = (m.metadata?.name as string | undefined) ?? "<unnamed>";
    out.push({
      kind: m.kind as string,
      name,
      filePath: (m.metadata as { source?: string } | undefined)?.source,
      message:
        `${m.kind}/${name}: 'status:' must not declare 'required:' — every field a kind declares ` +
        `it reports is mandatory once the resource has run, so the list is either redundant or a ` +
        `lie. Declare a sometimes-absent field with a nullable type instead ` +
        `(e.g. type: [string, "null"]); CEL_NULLABLE_ACCESS then forces the reader to guard it.`,
    });
  }
  return out;
}

/** A CEL access into a resource's observed-state segment. */
export interface ObservedStateRead {
  /** Import alias, when the read crosses a module boundary
   *  (`resources.<Alias>.<name>.status`). */
  alias?: string;
  /** Resource name. */
  name: string;
  /** The field read under `.status`, when the chain names one. */
  field?: string;
}

/**
 * Recognise an observed-state read in a member-access chain. Purely syntactic —
 * it inspects the chain, not the topology — so the availability rule it feeds
 * applies to every kind, declared or not.
 *
 * `resources.<name>.status.<field>` and the two-level cross-module form
 * `resources.<Alias>.<name>.status.<field>` are both observed-state reads.
 */
export function observedStateRead(chain: readonly string[]): ObservedStateRead | undefined {
  if (chain[0] !== "resources") return undefined;
  if (chain[2] === OBSERVED_STATE_KEY) return { name: chain[1]!, field: chain[3] };
  if (chain[3] === OBSERVED_STATE_KEY) {
    return { alias: chain[1], name: chain[2]!, field: chain[4] };
  }
  return undefined;
}

/**
 * The names of every resource some slot can start: referenced from a ref slot
 * that accepts a `Telo.Runnable` / `Telo.Service`, or named as a step's
 * `invoke:` target. A resource in none of them can never `run()`, so it can
 * never report observed state.
 *
 * Deliberately an over-approximation — a name reachable through any of these
 * routes counts as runnable — because the cost of a false "can never run" is a
 * valid manifest rejected, while the cost of a miss is only that the reader
 * finds out at runtime instead, with a message that names the same fix.
 */
export function collectRunReachableNames(
  manifests: readonly ResourceManifest[],
  defs: { resolve(kind: string): ResourceDefinition | undefined },
  aliases?: { resolveKind(kind: string): string | undefined },
): Set<string> {
  const names = new Set<string>();
  const resolve: DefResolver = (kind) =>
    defs.resolve(aliases?.resolveKind(kind) ?? kind) ?? defs.resolve(kind);

  for (const manifest of manifests) {
    const def = resolve(manifest.kind as string);
    const schema = def?.schema as Record<string, any> | undefined;
    if (!schema) continue;

    for (const [path, entry] of buildReferenceFieldMap(schema)) {
      if (!isRefEntry(entry)) continue;
      if (!entry.refs.some((ref) => RUN_DISPATCH_CONTRACTS.has(ref))) continue;
      for (const value of resolveFieldValues(manifest, path)) collectRefName(value, names);
    }

    // Step arrays nest through `if` / `while` / `switch` / `try`, and the step
    // `invoke:` slot sits behind a local `$ref` the field map does not follow.
    // Match the declared invoke key at any depth instead of re-deriving the
    // nesting rules — over-approximating in the safe direction.
    const invokeKey = stepInvokeKey(schema);
    if (invokeKey) collectKeyedRefs(manifest, invokeKey, names);
  }

  return names;
}

/** The property name a kind's `x-telo-step-context` declares as its dispatch
 *  slot (`invoke`), or undefined when the kind has no step array. */
function stepInvokeKey(schema: Record<string, any>): string | undefined {
  for (const fieldSchema of Object.values(
    (schema.properties ?? {}) as Record<string, any>,
  )) {
    const stepCtx = fieldSchema?.["x-telo-step-context"] as
      | Record<string, string>
      | undefined;
    if (stepCtx?.invoke) return stepCtx.invoke;
  }
  return undefined;
}

/** Collect ref names at every `key` property anywhere in `node`. */
function collectKeyedRefs(node: unknown, key: string, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectKeyedRefs(item, key, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [k, value] of Object.entries(node as Record<string, unknown>)) {
    if (k === key) collectRefName(value, out);
    collectKeyedRefs(value, key, out);
  }
}

/** Record the resource name a slot value points at — a resolved `{kind, name}`
 *  ref, an unresolved `!ref` sentinel, or a `{ ref }` / `{ invoke }` wrapper. */
function collectRefName(value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefName(item, out);
    return;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.name === "string") out.add(v.name);
  if (typeof v.source === "string") {
    const dot = v.source.lastIndexOf(".");
    out.add(dot >= 0 ? v.source.slice(dot + 1) : v.source);
  }
  for (const wrapper of ["ref", "invoke"]) {
    if (v[wrapper] !== undefined) collectRefName(v[wrapper], out);
  }
}

/** What a resource name resolves to for CEL purposes. `status` is present only
 *  when the kind declares one; `scoped` marks a resource declared inside an
 *  `x-telo-scope` slot, which resolves only within that scope's regions. */
export interface AnalyzedResource {
  kind: string;
  status?: Record<string, any>;
  scoped?: boolean;
}

/**
 * Index every resource a CEL `resources.…` read can name: the module's own
 * top-level resources, the ones declared inside `x-telo-scope` slots (a
 * `Run.Sequence`'s `with:`), and each import's exported instances — keyed
 * `<Alias>.<name>`, the two-level shape those publish under.
 *
 * Scope slots are found through the declaring kind's schema annotation, not by
 * field name, so any composer with a scope participates.
 */
export function buildObservedStateIndex(
  manifests: readonly ResourceManifest[],
  defs: { resolve(kind: string): ResourceDefinition | undefined },
  aliases?: { resolveKind(kind: string): string | undefined; moduleForAlias?(alias: string): string | undefined },
  scopes?: ModuleScopes,
): Map<string, AnalyzedResource> {
  const out = new Map<string, AnalyzedResource>();
  const resolve = moduleScopedDefResolver(defs, aliases, scopes);

  /** `module` is the resource's DECLARING module: an exported instance is
   *  written with that library's aliases (`kind: Self.Listener`), which the
   *  consumer's table cannot resolve. */
  const record = (kind: string, key: string, scoped: boolean, module?: string): void => {
    const status = effectiveStatusSchema(resolve.in(kind, module), resolve);
    out.set(key, { kind, ...(status ? { status } : {}), ...(scoped ? { scoped } : {}) });
  };

  for (const manifest of manifests) {
    const kind = manifest.kind as string | undefined;
    const name = manifest.metadata?.name as string | undefined;
    if (!kind || SYSTEM_KINDS.has(kind)) continue;
    if (name) record(kind, name, false, manifest.metadata?.module as string | undefined);

    const schema = resolve(kind)?.schema as Record<string, any> | undefined;
    if (!schema) continue;
    for (const [path, entry] of buildReferenceFieldMap(schema)) {
      if (!isScopeEntry(entry)) continue;
      for (const value of resolveFieldValues(manifest, path)) {
        for (const scopedEntry of Array.isArray(value) ? value : [value]) {
          const scopedKind = (scopedEntry as ResourceManifest)?.kind;
          const scopedName = (scopedEntry as ResourceManifest)?.metadata?.name;
          if (typeof scopedKind === "string" && typeof scopedName === "string") {
            record(scopedKind, scopedName, true);
          }
        }
      }
    }
  }

  for (const [alias, name, kind, module] of importedExports(manifests, aliases)) {
    record(kind, `${alias}.${name}`, false, module);
  }
  return out;
}

/**
 * Every `<alias, exported name, kind>` an import makes readable as
 * `resources.<Alias>.<name>`. The importer's `Telo.Import` docs give the
 * aliases; the exported instances are the ones already stamped
 * `metadata.forwardedExport` by `selectModuleManifestsForAnalysis` — the module
 * doc that declared `exports.resources` is dropped for non-root modules, so the
 * stamp, not the declaration, is what survives into the consumer's manifest
 * list. A module doc is still consulted when one IS present (a single-library
 * analysis, the editor's projection).
 */
function* importedExports(
  manifests: readonly ResourceManifest[],
  aliases?: { moduleForAlias?(alias: string): string | undefined },
): Generator<[alias: string, name: string, kind: string, module: string]> {
  if (!aliases?.moduleForAlias) return;

  const declaredByModule = new Map<string, Set<string>>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Library") continue;
    const libName = (m.metadata?.name ?? m.metadata?.module) as string | undefined;
    const declared = (m as { exports?: { resources?: unknown[] } }).exports?.resources;
    if (!libName || !Array.isArray(declared)) continue;
    declaredByModule.set(
      libName,
      new Set(
        declared
          .filter((e): e is string => typeof e === "string")
          .map((e) => parseExportEntry(e).name),
      ),
    );
  }

  const exportsByModule = new Map<string, Map<string, string>>();
  for (const m of manifests) {
    const module = m.metadata?.module as string | undefined;
    const name = m.metadata?.name as string | undefined;
    if (!module || !name || SYSTEM_KINDS.has(m.kind as string)) continue;
    const forwarded = (m.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport;
    if (!forwarded && !declaredByModule.get(module)?.has(name)) continue;
    let byName = exportsByModule.get(module);
    if (!byName) exportsByModule.set(module, (byName = new Map()));
    byName.set(name, m.kind as string);
  }

  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const alias = m.metadata?.name as string | undefined;
    if (!alias) continue;
    const targetModule = aliases.moduleForAlias(alias);
    const exported = targetModule && exportsByModule.get(targetModule);
    if (!exported) continue;
    for (const [name, kind] of exported) yield [alias, name, kind, targetModule];
  }
}

/** The `resources` node of a CEL context schema: one entry per resource, each
 *  open except for a typed, closed `status` node on kinds that declare one.
 *  `open` keeps the map itself permissive, so unknown resource names and every
 *  flat field pass exactly as they do today. */
export function buildObservedStateResourcesSchema(
  index: ReadonlyMap<string, AnalyzedResource>,
  open: boolean,
): Record<string, any> {
  const properties: Record<string, any> = {};
  for (const [key, { status }] of index) {
    if (!status) continue;
    applyObservedStateNode(properties, key, status);
  }
  return open
    ? { type: "object", additionalProperties: true, properties }
    : { type: "object", properties };
}

/**
 * Write the typed `status` node for one index key into a `resources` property
 * map. A dotted key (`Alias.name`) is an import's exported instance, which
 * publishes two levels deep — the alias node stays open so every other name
 * under it keeps resolving as it does today.
 */
export function applyObservedStateNode(
  properties: Record<string, any>,
  key: string,
  status: Record<string, any>,
): void {
  const dot = key.indexOf(".");
  const leaf = {
    type: "object",
    additionalProperties: true,
    properties: { [OBSERVED_STATE_KEY]: { ...status, additionalProperties: false } },
  };
  if (dot < 0) {
    properties[key] = leaf;
    return;
  }
  const alias = key.slice(0, dot);
  const name = key.slice(dot + 1);
  const aliasNode = (properties[alias] ??= {
    type: "object",
    additionalProperties: true,
    properties: {},
  });
  (aliasNode.properties ??= {})[name] = leaf;
}
