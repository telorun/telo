import { nearestName } from "./nearest-name.js";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { inheritedCapability, type DefResolver } from "./extends-resolution.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { templateTargetProblems } from "./template-targets.js";
import { CEL_ENGINE, isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver, ModuleScopes } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isRefSourceSpelling, refSentinelTarget } from "./ref-sentinel-target.js";
import { isRefEntry, resolveFieldEntries, satisfiesValueBranch } from "./reference-field-map.js";
import { templateBodies } from "./template-body.js";
import { isSelfForward } from "./template-self-forward.js";
import {
  DiagnosticSeverity,
  DiagnosticTag,
  type AnalysisDiagnostic,
  type DiagnosticFix,
} from "./types.js";

const SOURCE = "telo-analyzer";

/** The four slots a `Telo.Definition` names its dispatch target in.
 *
 *  WHAT THE TARGET'S CAPABILITY IS IS DELIBERATELY NOT CHECKED. The kernel tests
 *  METHOD PRESENCE at dispatch (`entry.instance?.invoke`), so a declared
 *  capability says nothing about whether a dispatch works — the same structural
 *  -versus-nominal split that keeps `use` uncross-constrained against a slot's
 *  target. A check here read `Run.Sequence`'s `capability: Telo.Runnable` and
 *  rejected `Ai.Buffered`, a shipping module whose sequence implements `invoke()`
 *  over an inputs/outputs contract and dispatches correctly. Trimming the refused
 *  set would only move that: any controller may expose a method its capability
 *  does not name, and a template body is exactly where that is done on purpose. */
const DISPATCH_SLOTS = ["invoke", "run", "provide", "mount"] as const;

/**
 * A TEMPLATE BODY IS WRITTEN LIKE EVERY OTHER MANIFEST, AND CHECKED LIKE ONE.
 *
 * A `Telo.Definition` is in both reference skip sets — its body holds
 * declarations of OTHER kinds, and its dispatch slots carry no `x-telo-ref` — so
 * no reference pass reached it, and each rule about it was added per construct:
 * `provide:` and `mount:` had a target check for the `{ kind, name }` object
 * form, `!ref` had one that switched itself off for any definition with a
 * CEL-named entry, and `invoke:` / `run:` had none. What was tagged was caught
 * and what was a plain name was resolved by the kernel alone. This pass is the
 * one reader of a body's reference surface, and it rests on one spelling:
 *
 *  - every `resources:` entry is named by a LITERAL (`TEMPLATE_ENTRY_NAME_DYNAMIC`).
 *    Each instance of a template owns its children in a child context of its
 *    own, so a per-instance suffix (`self.name + '-query'`) buys nothing — and a
 *    `!ref` is looked up verbatim, so a CEL-named sibling is one nothing can name;
 *  - a dispatch slot is `!ref <entry>` naming an entry
 *    (`TEMPLATE_DISPATCH_UNKNOWN`); the legacy spellings are deprecated rather
 *    than refused, since published artifacts carry them. What the target's
 *    CAPABILITY is stays unchecked — see `DISPATCH_SLOTS`;
 *  - a reference slot INSIDE an entry follows the rule every other slot does —
 *    `!ref` or an inline declaration, never `{ kind, name }` or a bare string
 *    (`INVALID_REFERENCE_FORM`) — and a bare `!ref` names a sibling or a
 *    resource of the defining module (`TEMPLATE_REF_UNKNOWN`). Slots are found
 *    through the nested kind's own field map, resolved in the DEFINING module's
 *    alias scope, since that is where the body's kinds are written.
 *
 * Entry-module-scoped, like every other declaration check: a published
 * dependency's template body is not the consumer's to fix. Browser-safe.
 */
export function validateTemplateBody(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const scopes: ModuleScopes = { aliasesByModule, rootModules };

  // A definition forwarded from an imported library is that library's to fix;
  // the imports name them (the `validate-extends` rule).
  const importedModules = new Set<string>();
  // Every named instance, by declaring module — what a body's bare `!ref` may
  // reach beside its siblings. A manifest with no stamp belongs to the entry.
  const instancesByModule = new Map<string | undefined, Set<string>>();
  for (const m of manifests) {
    const name = m.metadata?.name;
    if (typeof name !== "string") continue;
    if (m.kind === "Telo.Import") {
      const resolved = (m.metadata as { resolvedModuleName?: string }).resolvedModuleName;
      if (resolved) importedModules.add(resolved);
      continue;
    }
    if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") continue;
    if (m.kind === "Telo.Library" || m.kind === "Telo.Application") continue;
    const mod = (m.metadata as { module?: string } | undefined)?.module;
    let set = instancesByModule.get(mod);
    if (!set) instancesByModule.set(mod, (set = new Set()));
    set.add(name);
  }

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const meta = m.metadata as { name?: string; module?: string; source?: string } | undefined;
    const name = meta?.name;
    if (!name) continue;
    if (meta?.module && importedModules.has(meta.module)) continue;

    const bodies = (m as Record<string, unknown>).resources;
    const resourceRef = { kind: m.kind, name };
    const filePath = meta?.source;
    const label = `${m.kind}/${name}`;
    const report = (code: string, path: string, message: string, fix?: DiagnosticFix) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message: `${label}: ${message}`,
        data: {
          resource: resourceRef,
          filePath,
          path,
          ...(fix ? { fix } : {}),
        },
      });

    /** A spelling the kernel still READS. Warning-grade because refusing it
     *  would break every app pinning a version that carries it, and tagged so an
     *  editor strikes it through rather than merely colouring it — the
     *  `DEPRECATED_KIND` shape, for the same reason. */
    const deprecate = (code: string, path: string, message: string) =>
      out.push({
        severity: DiagnosticSeverity.Warning,
        code,
        source: SOURCE,
        message: `${label}: ${message}`,
        tags: [DiagnosticTag.Deprecated],
        data: { resource: resourceRef, filePath, path },
      });

    const entries = Array.isArray(bodies) ? bodies : [];
    // Entries extraction produced from an inline declaration: the slot it came
    // from now names it as `{ kind, name }`, which the author never wrote.
    const extracted = new Set(
      entries
        .filter((entry) => (entry as { metadata?: { xTeloOrigin?: unknown } })?.metadata?.xTeloOrigin)
        .map((entry) => (entry as { metadata: { name: string } }).metadata.name),
    );
    const siblings: string[] = [];
    let anyDynamic = false;
    entries.forEach((entry, i) => {
      const entryName = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (typeof entryName === "string" && !entryName.includes("${{")) {
        // The kernel registers every entry into one child context by name, and
        // refuses the second with ERR_DUPLICATE_RESOURCE.
        if (siblings.includes(entryName)) {
          report(
            "DUPLICATE_RESOURCE_NAME",
            `resources[${i}].metadata.name`,
            `two 'resources:' entries are named '${entryName}'. Every entry of a template body ` +
              `is created in one scope, by name — rename one of them.`,
          );
        }
        siblings.push(entryName);
        return;
      }
      if (entryName === undefined) return;
      anyDynamic = true;
      deprecate(
        "DEPRECATED_TEMPLATE_ENTRY_NAME",
        `resources[${i}].metadata.name`,
        `a 'resources:' entry named by ${describeDynamic(entryName)} is deprecated — name it ` +
          `with a literal and dispatch to it with '!ref'. Each instance of a template owns its ` +
          `children in a child context of its own, so a per-instance suffix buys nothing, and a ` +
          `'!ref' is looked up verbatim, so nothing can name a computed entry. While one is ` +
          `present the target checks below are switched off for this kind.`,
      );
    });

    // Siblings PLUS the declaring module's own resources, because that is what
    // the runtime resolves at a reference slot: a body's `!ref` is stamped
    // `{kind, name}` with an empty kind for a non-sibling, and Phase-5 injection
    // dispatches by NAME and recovers the kind from the instance it finds — so
    // `client: !ref moduleClient` in a body reaches the module-level client and
    // works. (A step's `invoke:` is a different path that does NOT: see the
    // `resources` note in `validate-template-body`'s own tests.)
    const reachable = new Set([
      ...siblings,
      ...(instancesByModule.get(meta?.module) ?? []),
    ]);
    // What a message lists and suggests: the names the author wrote.
    const written = siblings.filter((name) => !extracted.has(name));

    // --- dispatch slots ---
    for (const slot of DISPATCH_SLOTS) {
      const value = (m as Record<string, unknown>)[slot];
      if (value == null) continue;
      if (!isRefSentinel(value)) {
        deprecate(
          "DEPRECATED_TEMPLATE_DISPATCH_FORM",
          slot,
          `'${slot}:' written as ${describeDispatchValue(value)} is deprecated — ` +
            `write '!ref <entry>', the spelling every other reference uses. ` +
            `Available: ${written.join(", ") || "(none)"}.`,
        );
        continue;
      }
      const source = value.source;
      const target = source.startsWith("Self.") ? source.slice("Self.".length) : source;
      if (siblings.includes(target)) continue;
      // A dynamic sibling has already been reported, and might be the one
      // meant — a second diagnostic about the same line would be noise.
      if (anyDynamic) continue;
      const suggestion = nearestName(target, written);
      report(
        "TEMPLATE_DISPATCH_UNKNOWN",
        slot,
        `'${slot}: !ref ${source}' names no entry in 'resources:'. ` +
          `Available: ${written.join(", ") || "(none)"}.` +
          (suggestion ? ` Did you mean '${suggestion}'?` : ""),
        suggestion ? { replacement: suggestion } : undefined,
      );
    }

    // --- targets: the entries a run starts ---
    const resolveDef: DefResolver = (k) =>
      registry.resolve(aliases.resolveKind(k) ?? k) ?? registry.resolve(k);
    const capability = inheritedCapability(m as ResourceDefinition, resolveDef);
    for (const problem of templateTargetProblems(m as Record<string, unknown>, capability, nearestName)) {
      report(
        problem.code,
        problem.path,
        problem.message,
        problem.suggestion ? { replacement: problem.suggestion } : undefined,
      );
    }

    // --- reference slots inside each entry ---
    for (const body of templateBodies(m, registry, aliases, scopes)) {
      const kind = body.manifest.kind;
      const entryName = body.manifest.metadata?.name;
      // An extracted entry's name is generated; the diagnostic's anchor already
      // points at the declaration the author wrote.
      const label =
        typeof entryName === "string" && extracted.has(entryName)
          ? `the inline ${kind}`
          : `the ${kind} entry '${entryName ?? body.prefix}'`;
      // A step's dispatch target is resolved at dispatch, outside the field map,
      // so its `!ref` is checked here: a typo would otherwise first fail on the
      // call that reaches it.
      if (body.definition) {
        const kindSchema = registry.effectiveSchemaOf(body.definition) as Record<string, any> | undefined;
        for (const steps of kindSchema ? stepBodiesOf(body.manifest as Record<string, unknown>, kindSchema) : []) {
          forEachStep(steps, kindSchema!, (step, stepPath) => {
            const value = step[steps.invokeField];
            if (!isRefSentinel(value)) return;
            const target = refSentinelTarget(value);
            if (!target || (target.alias && target.alias !== "Self")) return;
            if (reachable.has(target.name) || anyDynamic) return;
            const suggestion = nearestName(
              target.name,
              [...reachable].filter((name) => !extracted.has(name)),
            );
            report(
              "TEMPLATE_REF_UNKNOWN",
              `${body.prefix}.${stepPath}.${steps.invokeField}`,
              `'${stepPath}.${steps.invokeField}: !ref ${value.source}' on ${label} names ` +
                `no sibling 'resources:' entry and no resource of this module. ` +
                `Siblings: ${written.filter((s) => s !== body.manifest.metadata?.name).join(", ") || "(none)"}.` +
                (suggestion ? ` Did you mean '${suggestion}'?` : ""),
              suggestion ? { replacement: suggestion } : undefined,
            );
          });
        }
      }

      // Each entry is a resource of its kind, validated as the kernel validates it
      // when the template creates it.
      if (body.definition) {
        const schema = entrySchemaFor(body.definition, registry);
        if (Object.keys(schema).length > 0) {
          const issues = registry.validateResourceConfig(
            substituteDecodedCelFields(body.manifest, schema, undefined, {
              external: (ref) => registry.schemaForId(ref),
            }),
            schema,
          );
          for (const issue of issues) {
            report(
              "SCHEMA_VIOLATION",
              issue.path ? `${body.prefix}.${issue.path}` : body.prefix,
              `${label}: ${issue.message}`,
            );
          }
        }
      }
      const fieldMap = registry.expandedFieldMapForResource(
        { ...body.manifest, metadata: { ...(body.manifest.metadata ?? {}), module: meta?.module } },
        aliases,
        aliasesByModule,
      );
      if (!fieldMap) continue;
      const computed = new Set<string>();
      for (const [fieldPath, entry] of fieldMap) {
        if (!isRefEntry(entry)) continue;
        for (const site of computedReferenceSites(body.manifest, fieldPath)) {
          if (computed.has(site.path)) continue;
          computed.add(site.path);
          report(
            "TEMPLATE_REF_COMPUTED",
            `${body.prefix}.${site.path}`,
            `'${site.path}: !cel "${site.source}"' on ${label} computes a value that ` +
              `holds the reference slot '${fieldPath}'. CEL values are data, so the reference ` +
              `cannot survive the expression. Forward it verbatim with a bare 'self.<path>' ` +
              `(the whole value, shaped as the slot expects), or write the slot itself as '!ref'.`,
          );
        }
        for (const site of resolveFieldEntries(body.manifest, fieldPath)) {
          const value = site.value;
          if (value == null) continue;
          const path = `${body.prefix}.${site.path}`;
          if (isTaggedSentinel(value)) {
            const target = refSentinelTarget(value);
            if (!target) continue;
            const { alias, name: refName } = target;
            if (alias && alias !== "Self") continue;
            if (reachable.has(refName)) continue;
            const suggestion = nearestName(
              refName,
              [...reachable].filter((name) => !extracted.has(name)),
            );
            report(
              "TEMPLATE_REF_UNKNOWN",
              path,
              `'${site.path}: !ref ${value.source}' on ${label} names no sibling ` +
                `'resources:' entry and no resource of this module. ` +
                `Siblings: ${written.filter((s) => s !== body.manifest.metadata?.name).join(", ") || "(none)"}.` +
                (suggestion ? ` Did you mean '${suggestion}'?` : ""),
              suggestion ? { replacement: suggestion } : undefined,
            );
            continue;
          }
          const hasValueBranch = (entry.valueBranches?.length ?? 0) > 0;
          if (hasValueBranch && typeof value !== "object") continue;
          if (satisfiesValueBranch(value, entry.valueBranches, registry)) continue;
          if (typeof value === "string") {
            if (value.includes("${{")) continue;
            report(
              "INVALID_REFERENCE_FORM",
              path,
              `string reference at '${site.path}' on the ${kind} entry → '${value}' is not ` +
                `supported; write it as '!ref ${value}'`,
              isRefSourceSpelling(value) ? { replacement: value, tag: "ref" } : undefined,
            );
            continue;
          }
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const obj = value as Record<string, unknown>;
            if (typeof obj.name === "string" && extracted.has(obj.name)) continue;
            if (typeof obj.kind === "string" && obj.name !== undefined) {
              report(
                "INVALID_REFERENCE_FORM",
                path,
                `object reference '{ kind, name }' at '${site.path}' on the ${kind} entry is ` +
                  `not supported; write it as '!ref ${describeRefName(obj.name)}'`,
              );
            }
          }
        }
      }
    }
  }

  return out;
}

/** An entry kind's author-facing schema with `kind` / `metadata` admitted.
 *  Keyed on the registry's memoized schema object, so each kind yields one
 *  object and the registry's compiled validator is reused. */
const entrySchemas = new WeakMap<object, Record<string, any>>();
function entrySchemaFor(
  definition: ResourceDefinition,
  registry: DefinitionRegistry,
): Record<string, any> {
  const author = (registry.effectiveSchemaOf(definition) ?? {}) as Record<string, any>;
  if (author.additionalProperties !== false) return author;
  const cached = entrySchemas.get(author);
  if (cached) return cached;
  const schema = {
    ...author,
    properties: { kind: { type: "string" }, metadata: { type: "object" }, ...author.properties },
  };
  entrySchemas.set(author, schema);
  return schema;
}

/**
 * The `!cel` nodes along a reference field path — the slot itself or any
 * container above it — that are not a bare `self.<path>` forward. The walk stops
 * at the first expression on each branch, since nothing below it is written.
 */
function computedReferenceSites(
  manifest: unknown,
  fieldPath: string,
): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const visit = (value: unknown, parts: string[], path: string): void => {
    if (isTaggedSentinel(value)) {
      if (value.engine === CEL_ENGINE && !isSelfForward(value.source)) {
        out.push({ path, source: value.source });
      }
      return;
    }
    if (parts.length === 0 || !value || typeof value !== "object") return;
    const [part, ...rest] = parts as [string, ...string[]];
    const join = (key: string) => (path ? `${path}.${key}` : key);
    if (part === "{}") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, rest, join(k));
      return;
    }
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const child = (value as Record<string, unknown>)[key];
    if (isArray && Array.isArray(child)) {
      child.forEach((item, i) => visit(item, rest, `${join(key)}[${i}]`));
      return;
    }
    visit(child, rest, join(key));
  };
  visit(manifest, fieldPath.split("."), "");
  return out;
}

function describeDynamic(name: unknown): string {
  if (isTaggedSentinel(name)) return `the expression '${name.source}'`;
  if (typeof name === "string") return `the template '${name}'`;
  return `a ${typeof name}`;
}

function describeDispatchValue(value: unknown): string {
  if (isTaggedSentinel(value)) return `a '!${value.engine}' expression`;
  if (typeof value === "string") return `the string '${value}'`;
  if (value && typeof value === "object" && "name" in value) return "the '{ kind, name }' object form";
  return `a ${typeof value}`;
}

function describeRefName(name: unknown): string {
  if (typeof name === "string") return name;
  if (isTaggedSentinel(name)) return "<entry>";
  return String(name);
}
