/**
 * Structural traversal over a kind's JSON Schema and the step arrays it
 * declares. Nothing here analyzes: these answer "what does this schema node
 * point at" and "how do steps nest", the two questions every analyzer pass
 * asks before it can say anything.
 *
 * Its own file so the CEL scope rule (`cel-scope.ts`) and the analysis pass
 * (`analyzer.ts`) can both reach it without either importing the other — the
 * scope rule is consumed by the IDE, which must not pull the pass in behind it.
 */
import { MANIFEST_SCHEMA_URI, ManifestRootSchema } from "./manifest-schemas.js";
import type { RefSlot } from "./ref-slot.js";
import type { StepSlot } from "./step-slot.js";
import { buildDrivenSlotMap, refSlotOfEntry, type DrivenSlots } from "./reference-field-map.js";

/** Resolve a local `$ref` (only `#/$defs/<name>` form) against the root schema.
 *  Non-refs and unresolved refs pass through unchanged. */
export function resolveLocalRef(
  schema: Record<string, any> | undefined,
  root: Record<string, any>,
): Record<string, any> | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defName = ref.slice("#/$defs/".length);
    const resolved = root.$defs?.[defName];
    if (resolved && typeof resolved === "object") return resolved as Record<string, any>;
  }
  // A kernel-owned structural fragment (`telo://manifest#/$defs/InvokeStep`).
  // Resolved HERE rather than by each walker: this is the one chokepoint every
  // structural walk already goes through — the step-array walks, the call graph,
  // the zone projection, the eval-path collector — so a composer that points at a
  // shared shape stays legible to all of them at once. Nothing is inlined into
  // the stored schema, which keeps validator-cache identity stable and matches
  // what `resolveSchemaTypeRefs` does for a named user type.
  if (typeof ref === "string" && ref.startsWith(BUILTIN_FRAGMENT_PREFIX)) {
    const defName = ref.slice(BUILTIN_FRAGMENT_PREFIX.length);
    const resolved = (ManifestRootSchema.$defs as Record<string, unknown>)[defName];
    if (resolved && typeof resolved === "object") return resolved as Record<string, any>;
  }
  return schema;
}

const BUILTIN_FRAGMENT_PREFIX = `${MANIFEST_SCHEMA_URI}#/$defs/`;

/** Gather property schemas from a (possibly variant-bearing) object schema:
 *  top-level `properties` plus every `oneOf` / `anyOf` / `allOf` branch.
 *
 *  Each branch is resolved through {@link resolveLocalRef} first, so a branch
 *  that points at a shared shape — a `oneOf` arm that IS the kernel's dispatch
 *  site — contributes its properties like an inline one. Without that, pointing a
 *  composer at a shared shape would silently empty every role-driven lookup that
 *  reads this (the inputs slot, the retry policy, the eval paths), which is a
 *  failure with no diagnostic attached to it. */
export function gatherPropertySchemas(
  schema: Record<string, any>,
  root?: Record<string, any>,
): Array<[string, Record<string, any>]> {
  const out: Array<[string, Record<string, any>]> = [];
  const base = resolveLocalRef(schema, root ?? schema) ?? schema;
  if (base.properties && typeof base.properties === "object") {
    for (const [k, v] of Object.entries(base.properties as Record<string, any>)) {
      out.push([k, v as Record<string, any>]);
    }
  }
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = base[variantKey];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const variant = resolveLocalRef(raw as Record<string, any>, root ?? schema) ?? raw;
      if (variant.properties) {
        for (const [k, v] of Object.entries(variant.properties as Record<string, any>)) {
          out.push([k, v as Record<string, any>]);
        }
      }
    }
  }
  return out;
}

/**
 * Generic, role-driven walk over a step array. Calls
 * `visit(step, stepPath)` for every step — top-level and nested through the
 * `x-telo-topology-role` forms (`branch`, `branch-list`, `case-map`). This is
 * the single definition of how steps nest, shared by `buildStepContextSchema`
 * (which types `steps.<name>.result`) and `validateStepInvokeReferences` (which
 * checks invoke refs), so the topology contract lives in one place — adding a
 * role or nesting form updates both consumers at once. No resource kind is
 * hardcoded; recursion is driven entirely by the schema annotations.
 */
export function walkStepArray(
  steps: unknown[],
  stepItemSchema: Record<string, any> | undefined,
  rootSchema: Record<string, any>,
  basePath: string,
  visit: (step: Record<string, any>, stepPath: string) => void,
): void {
  const dispatchRole = (
    data: unknown,
    role: string,
    itemsSchema: Record<string, any> | undefined,
    path: string,
  ): void => {
    if (role === "branch" && Array.isArray(data)) {
      walkStepArray(data, stepItemSchema, rootSchema, path, visit);
    } else if (role === "case-map" && data && typeof data === "object" && !Array.isArray(data)) {
      for (const [caseKey, arr] of Object.entries(data as Record<string, unknown>)) {
        if (Array.isArray(arr)) walkStepArray(arr, stepItemSchema, rootSchema, `${path}.${caseKey}`, visit);
      }
    } else if (role === "branch-list" && Array.isArray(data)) {
      const entrySchema = resolveLocalRef(itemsSchema, rootSchema);
      if (!entrySchema) return;
      data.forEach((entry, i) => {
        if (!entry || typeof entry !== "object") return;
        for (const [subKey, subSchema] of gatherPropertySchemas(entrySchema)) {
          const subRole = subSchema["x-telo-topology-role"];
          if (typeof subRole !== "string") continue;
          dispatchRole(
            (entry as Record<string, any>)[subKey],
            subRole,
            subSchema.items as Record<string, any> | undefined,
            `${path}[${i}].${subKey}`,
          );
        }
      });
    }
  };

  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") return;
    const s = step as Record<string, any>;
    const stepPath = `${basePath}[${i}]`;
    visit(s, stepPath);
    if (!stepItemSchema) return;
    for (const [propKey, propSchema] of gatherPropertySchemas(stepItemSchema)) {
      const role = propSchema["x-telo-topology-role"];
      if (typeof role !== "string") continue;
      dispatchRole(
        s[propKey],
        role,
        propSchema.items as Record<string, any> | undefined,
        `${stepPath}.${propKey}`,
      );
    }
  });
}
/** A slot a kind's schema declares through which its resources drive another.
 *  `path` is the field-map form (`routes[].handler`, `content.{}.encoder`);
 *  `slots` holds every slot any branch declares there. */
export type DeclaredSlot =
  | { kind: "step"; slots: StepSlot[]; path: string }
  | { kind: "ref"; slots: RefSlot[]; path: string };

/** A reference slot at a site, with the declaration it came from — which is
 *  what a case-map selector's schema default is read against. */
export interface DrivenRef {
  slot: RefSlot;
  fieldPath: string;
}

/** The slots at one concrete site of one resource (`routes[0].handler`): every
 *  slot any branch or recursion route declares there. A consumer reads them as
 *  a union — a branch that does not apply to this resource can only add what
 *  counts, never remove it. */
export type DrivenSlot =
  | { kind: "step"; slots: StepSlot[]; data: unknown[]; path: string }
  | { kind: "ref"; slots: DrivenRef[]; data: unknown; path: string };

/**
 * Every slot a kind's schema declares through which its resources drive
 * another — the schema-only mode of {@link forEachDrivenSlot}, read off the
 * same {@link buildDrivenSlotMap}.
 */
export function forEachDeclaredSlot(schema: unknown, visit: (slot: DeclaredSlot) => void): void {
  if (!schema || typeof schema !== "object") return;
  for (const [path, at] of buildDrivenSlotMap(schema as Record<string, any>).paths) {
    if (at.steps.length > 0) visit({ kind: "step", slots: at.steps, path });
    if (at.refs.length > 0) visit({ kind: "ref", slots: at.refs.map(refSlotOfEntry), path });
  }
}

/**
 * Every slot of one resource through which it drives another, schema and data in
 * tandem.
 *
 * One traversal for every throws question — a kind's `inherit` union, a scope
 * list's denominator, catch-scope enclosure, and whether `inherit` is legal —
 * because they ask the same structural question and two copies would eventually
 * disagree about where the walk stops. The slots are the driven-slot map's, so
 * the reach is the reference field map's plus local `$ref`; a step slot is a
 * stop (that traversal owns everything below it, `try`/`catch` subtraction
 * included) and so is a reference slot (a resolved ref is a leaf).
 *
 * Each concrete site is visited once, with every slot that reaches it. A
 * map-value (`additionalProperties`) slot applies only to keys its schema does
 * not declare, and never to the resource envelope at the root, as JSON Schema
 * applies it. A recursive schema's back-edge is followed as deep as the data
 * goes, guarded against data that aliases one of its own ancestors. A schema
 * whose map holds no step or reference slot is not walked at all.
 */
export function forEachDrivenSlot(
  schema: unknown,
  data: unknown,
  visit: (slot: DrivenSlot) => void,
): void {
  if (!schema || typeof schema !== "object" || data === undefined || data === null) return;
  const driven = buildDrivenSlotMap(schema as Record<string, any>);
  if (!driven.drives) return;
  const sites = new Map<
    string,
    { data: unknown; steps: StepSlot[]; refs: DrivenRef[]; from: Set<object> }
  >();
  const onData = new Set<unknown>([data]);

  const walk = (prefix: string, value: unknown, base: string): void => {
    for (const [fieldPath, at] of driven.paths) {
      const rel = relativeFieldPath(fieldPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(value, rel, prefix, driven)) {
        const path = joinConcrete(base, found.path);
        if (at.steps.length > 0 || at.refs.length > 0) {
          let site = sites.get(path);
          if (!site) {
            site = { data: found.value, steps: [], refs: [], from: new Set() };
            sites.set(path, site);
          }
          for (const step of at.steps) {
            if (site.from.has(step)) continue;
            site.from.add(step);
            site.steps.push(step);
          }
          for (const entry of at.refs) {
            if (site.from.has(entry)) continue;
            site.from.add(entry);
            site.refs.push({ slot: refSlotOfEntry(entry), fieldPath });
          }
        }
        if (at.recurse.length === 0) continue;
        if (!found.value || typeof found.value !== "object" || onData.has(found.value)) continue;
        onData.add(found.value);
        for (const to of at.recurse) walk(to, found.value, path);
        onData.delete(found.value);
      }
    }
  };
  walk("", data, "");

  for (const [path, site] of sites) {
    if (site.steps.length > 0 && Array.isArray(site.data)) {
      visit({ kind: "step", slots: site.steps, data: site.data, path });
    } else if (site.refs.length > 0) {
      visit({ kind: "ref", slots: site.refs, data: site.data, path });
    }
  }
}

interface Site {
  value: unknown;
  path: string;
}

/** The values at `rel` below `value`, where `rel` is relative to the field path
 *  `prefix`. A `{}` segment skips the keys the driven map records as declared
 *  for that map path; each `[]` iterates one array level. */
function resolveSites(value: unknown, rel: string, prefix: string, driven: DrivenSlots): Site[] {
  let sites: Site[] = [{ value, path: "" }];
  let field = prefix;
  for (const part of rel.split(".")) {
    const next: Site[] = [];
    if (part === "{}") {
      field = joinKey(field, "{}");
      const declared = driven.declaredKeys.get(field);
      for (const site of sites) {
        if (!site.value || typeof site.value !== "object" || Array.isArray(site.value)) continue;
        for (const [key, entry] of Object.entries(site.value as Record<string, unknown>)) {
          if (entry == null || declared?.has(key)) continue;
          next.push({ value: entry, path: joinKey(site.path, key) });
        }
      }
    } else {
      const key = part.replace(/(\[\])+$/, "");
      const depth = (part.length - key.length) / 2;
      field = key ? joinKey(field, part) : `${field}${part}`;
      for (const site of sites) {
        let level: Site[];
        if (key) {
          if (!site.value || typeof site.value !== "object") continue;
          const entry = (site.value as Record<string, unknown>)[key];
          if (entry == null) continue;
          level = [{ value: entry, path: joinKey(site.path, key) }];
        } else {
          level = [site];
        }
        for (let d = 0; d < depth; d++) {
          const items: Site[] = [];
          for (const holder of level) {
            if (!Array.isArray(holder.value)) continue;
            holder.value.forEach((item, i) => {
              if (item != null) items.push({ value: item, path: `${holder.path}[${i}]` });
            });
          }
          level = items;
        }
        next.push(...level);
      }
    }
    sites = next;
  }
  return sites;
}

const joinKey = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** `fieldPath` relative to `prefix`, or undefined when it is not strictly
 *  below it. A result starting `[]` iterates the value at `prefix` itself. */
function relativeFieldPath(fieldPath: string, prefix: string): string | undefined {
  if (prefix === "") return fieldPath;
  if (fieldPath.startsWith(`${prefix}.`)) return fieldPath.slice(prefix.length + 1);
  if (fieldPath.startsWith(`${prefix}[]`)) return fieldPath.slice(prefix.length);
  return undefined;
}

function joinConcrete(base: string, rel: string): string {
  if (!base) return rel;
  return rel.startsWith("[") ? `${base}${rel}` : `${base}.${rel}`;
}

