import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { DefResolver } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { visitManifest } from "./manifest-visitor.js";
import { definitionInScope } from "./module-alias-scope.js";
import { isRefSourceSpelling } from "./ref-sentinel-target.js";
import { isValueAtSlot } from "./reference-field-map.js";
import {
  carriesReferenceMarker,
  declaresNameField,
  isLegacyReferenceForm,
  RESOLVED_REFERENCE_MARKER,
} from "./resolved-reference.js";
import { isKindDocument } from "./kind-declaration.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { templateBodyEntries } from "./template-body.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";
const CODE = "INVALID_REFERENCE_FORM";

/**
 * Reference-form validation — the single enforcement point for "a reference is
 * written `!ref <name>` (or `!ref <Alias>.<name>`), nothing else".
 *
 * Runs on the RAW manifest set, BEFORE inline-resource extraction and `!ref`
 * sentinel resolution: only there is every object at a slot one an author
 * wrote. It judges the entry's own modules; a dependency's are not the
 * consumer's to fix, and the kernel refuses only an author-written `__ref` key
 * there, when an import loads the library (`StaticAnalyzer.referenceForms`).
 *
 * Whether a value is a reference or an inline declaration is never decided
 * here — that is the resolved-reference marker's (`resolved-reference.ts`).
 * What this pass refuses are the spellings an author may have meant as a
 * reference:
 *   - an object holding a string `name` whose kind's schema declares no
 *     top-level `name` property — the legacy `{ kind, name }` reference form,
 *     repaired to `!ref <name>`. Normalization still reads it as the reference
 *     it means, since published artifacts carry it; for a kind that declares
 *     `name`, the same object is an inline declaration and is checked against
 *     the kind's schema;
 *   - an object holding the `__ref` key, which only resolution writes;
 *   - a bare string (the removed name / dotted-FQN reference).
 *
 * **A value-or-reference union slot is the one exception**, and it is decided by
 * the value rather than by a new spelling: where the reference constraint is a
 * *branch* of a union (`type:` on a column, holding either a storage class or a
 * `!ref` to a declared enum), a SCALAR is a value and is left to that branch,
 * while an object is still checked unless a branch describes it. The rule
 * guards a REMOVED spelling — a bare string is simply not a reference in Telo —
 * so admitting one takes nothing away: what it costs is the answer when an
 * author meant a reference and wrote a bare name, which against a closed branch
 * AJV reports as an unknown value.
 *
 * A template body's entries are judged too, against the definition declaring
 * them, for their object forms (a string form there is `validateTemplateBody`'s).
 */
export function validateReferenceForms(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): AnalysisDiagnostic[] {
  if (!aliases) return [];
  const diagnostics: AnalysisDiagnostic[] = [];

  const localResources = resources.filter((r) => !isForwardedDeclaration(r));
  const resolveDef: DefResolver = (kind, from) =>
    definitionInScope<ResourceDefinition>(registry, kind, from?.metadata, aliases, aliasesByModule);
  const objectForm = (value: unknown, holder: ResourceManifest["metadata"]) =>
    authoredObjectForm(value, (kind) => {
      const definition = definitionInScope<ResourceDefinition>(
        registry,
        kind,
        holder,
        aliases,
        aliasesByModule,
      );
      return definition ? declaresNameField(definition, resolveDef) : undefined;
    });

  // The step targets of the resource being visited: nested discovery reaches
  // them beside plain data, and only these — with the reach's own sites — are
  // places inline extraction acts on.
  let stepTargets = new Set<string>();

  visitManifest(
    localResources,
    registry,
    {
      onResourceEnter: (e) => {
        stepTargets = new Set();
        const schema = e.definition
          ? (registry.effectiveSchemaOf(e.definition) as Record<string, any> | undefined)
          : undefined;
        if (!schema) return;
        for (const body of stepBodiesOf(e.source as Record<string, unknown>, schema)) {
          forEachStep(body, schema, (_step, stepPath) => stepTargets.add(`${stepPath}.${body.invokeField}`));
        }
      },
      onRef: (e) => {
        const value = e.value;
        // `!ref` and `!cel` sentinels are the supported shapes.
        if (isTaggedSentinel(value)) return;

        // A SCALAR at a slot whose own node unions a value branch is a value, and
        // the value branch is what judges it. Reporting a mistyped storage class
        // as a malformed reference — "write it as '!ref txt'" — instructs the
        // author to convert a typo into a reference, and AJV has already said
        // what the value must be one of. An object is still judged below unless
        // a branch genuinely describes that shape.
        if (isValueAtSlot(value, e.refs, registry)) return;

        const r = e.source;
        const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
        const resourceData = { kind: r.kind, name: r.metadata!.name as string };
        const filePath = (r.metadata as { source?: string } | undefined)?.source;
        const path = e.concretePath;

        if (typeof value === "string") {
          // A bare string at a ref slot is the removed string / dotted-FQN form.
          const hint = refHint(value);
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: CODE,
            source: SOURCE,
            message: `${resourceLabel}: string reference at '${path}' → '${value}' is not supported; write it as '!ref ${hint}'`,
            data: {
              resource: resourceData,
              filePath,
              path,
              // Only where the hint IS the value: a dotted FQN's last segment is
              // a guess, and a repair must be applicable without review.
              ...(hint === value && isRefSourceSpelling(value)
                ? { fix: { replacement: value, tag: "ref" } }
                : {}),
            },
          });
          return;
        }

        const form = objectForm(value, r.metadata);
        if (form) {
          const refusal: AnalysisDiagnostic = {
            severity: DiagnosticSeverity.Error,
            code: CODE,
            source: SOURCE,
            message: `${resourceLabel}: ${formMessage(form, path)}`,
            data: { resource: resourceData, filePath, path },
          };
          if (!e.nested || stepTargets.has(path)) {
            refusedSites.set(refusal, {
              module: moduleOf(r.metadata),
              holder: resourceData.name,
              path,
              form: form.form,
            });
          }
          diagnostics.push(refusal);
        }
      },
    },
    {
      aliases,
      aliasesByModule,
      skip: isKindDocument,
      expand: true,
      discoverNestedRefs: true,
      authoredReferenceForms: true,
    },
  );

  for (const definition of localResources) {
    const entries = templateBodyEntries(definition);
    if (entries.length === 0) continue;
    const meta = definition.metadata as { name?: string; module?: string; source?: string };
    for (const entry of entries) {
      // A body entry's kind and every kind inside it are written through the
      // DEFINING module's aliases.
      const view = {
        ...entry.manifest,
        metadata: { ...(entry.manifest.metadata ?? {}), module: meta.module },
      } as ResourceManifest;
      for (const site of registry.referenceSites(view, aliases, aliasesByModule, entry.manifest)) {
        if (site.refs.length === 0 || site.data == null) continue;
        if (isTaggedSentinel(site.data) || typeof site.data === "string") continue;
        if (isValueAtSlot(site.data, site.refs, registry)) continue;
        const form = objectForm(site.data, view.metadata);
        if (!form) continue;
        const refusal: AnalysisDiagnostic = {
          severity: DiagnosticSeverity.Error,
          code: CODE,
          source: SOURCE,
          message: `${definition.kind}/${meta.name}: ${formMessage(form, site.path, `the ${entry.kind} entry`)}`,
          data: {
            resource: { kind: definition.kind, name: meta.name },
            filePath: meta.source,
            path: `${entry.prefix}.${site.path}`,
          },
        };
        const entryName = (entry.manifest.metadata as { name?: unknown } | undefined)?.name;
        if (typeof entryName === "string") {
          refusedSites.set(refusal, { module: meta.module, holder: entryName, path: site.path, form: form.form });
        }
        diagnostics.push(refusal);
      }
    }
  }

  return diagnostics;
}

/** An author-written object spelled as a reference. */
interface AuthoredObjectForm {
  form: "object" | "marker";
  /** The name it holds — the `!ref` repair names it. */
  name?: string;
}

/**
 * The reference spelling an author wrote at a reference slot, or undefined for
 * an inline declaration: the `__ref` key, or the legacy `{ kind, name }` form
 * (`isLegacyReferenceForm`). A kind that does not resolve is left to the
 * declaration's own `UNDEFINED_KIND` — a `name` beside a misspelled kind is no
 * evidence of a reference.
 */
export function authoredObjectForm(
  value: unknown,
  kindDeclaresName: (kind: string) => boolean | undefined,
): AuthoredObjectForm | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || isTaggedSentinel(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  if (carriesReferenceMarker(obj)) return { form: "marker", ...(name !== undefined ? { name } : {}) };
  return isLegacyReferenceForm(obj, kindDeclaresName) ? { form: "object", name: obj.name } : undefined;
}

/** The refusal sentence, after the resource label. `on` names a template body
 *  entry the slot sits in. */
export function formMessage(form: AuthoredObjectForm, path: string, on?: string): string {
  const where = on ? `'${path}' on ${on}` : `'${path}'`;
  if (form.form === "marker") {
    return (
      `'${RESOLVED_REFERENCE_MARKER}' at ${where} is not supported — it marks a reference the ` +
      `loader resolved; write a reference as '!ref ${form.name ?? "<name>"}'`
    );
  }
  return `object reference '{ kind, name }' at ${where} is not supported; write it as '!ref ${form.name}'`;
}

/** Where each object-form refusal at a place normalization acts on — a
 *  reference site or a step target — was written: the module declaring the
 *  holder, the declaration holding it and its path there, which extraction
 *  records as an extracted declaration's origin. An object in plain data is
 *  refused statically and left alone otherwise: normalization never reaches it. */
const refusedSites = new WeakMap<
  AnalysisDiagnostic,
  { module: string | undefined; holder: string; path: string; form: AuthoredObjectForm["form"] }
>();

const moduleOf = (metadata: unknown): string | undefined => {
  const module = (metadata as { module?: unknown } | undefined)?.module;
  return typeof module === "string" ? module : undefined;
};

/** A declaration's identity across modules: a name is unique only within the
 *  module declaring it. */
const declarationKey = (module: string | undefined, name: string): string => `${module ?? ""}\0${name}`;

/** The refusals of an author-written `__ref` key at a place normalization acts
 *  on, among `diagnostics` — the one spelling the kernel refuses in a
 *  dependency: only resolution writes the marker, so no published library can
 *  have meant one. */
export function markerFormRefusals(diagnostics: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[] {
  return diagnostics.filter((d) => refusedSites.get(d)?.form === "marker");
}

/**
 * Drops what normalization reports about a refused object beside its refusal.
 *
 * Normalization reads a refused `{ kind, name }` as the reference it means, so
 * whatever is reported about it is reported about that reference, as before the
 * marker; an object carrying the `__ref` key is read as a reference too, and
 * one holding a marker other than `true` is extracted as a declaration of its
 * kind. Either is the same defect said a second time, in words that point away
 * from the repair; the `INVALID_REFERENCE_FORM` naming `!ref <name>` is the one
 * report. Dropped are, for a `__ref` key, the diagnostics at the slot itself and
 * those about a declaration extracted out of it — found through
 * `metadata.xTeloOrigin` before diagnostics are unfolded to the position the
 * author wrote; any other finding about the holder stands. Holders and
 * extractions are told apart by declaring module as well as name.
 */
export function withoutRefusedFormConsequences(
  diagnostics: AnalysisDiagnostic[],
  manifests: readonly ResourceManifest[],
): AnalysisDiagnostic[] {
  const marked = new Set<string>();
  for (const d of diagnostics) {
    const site = refusedSites.get(d);
    if (site?.form !== "marker") continue;
    marked.add(`${declarationKey(site.module, site.holder)}\0${site.path}`);
  }
  if (marked.size === 0) return diagnostics;
  const byKey = new Map<string, ResourceManifest>();
  const byName = new Map<string, ResourceManifest[]>();
  for (const m of manifests) {
    const name = m.metadata?.name;
    if (typeof name !== "string") continue;
    byKey.set(declarationKey(moduleOf(m.metadata), name), m);
    byName.set(name, [...(byName.get(name) ?? []), m]);
  }
  // The declaration a diagnostic is about: a name reported by kind and file,
  // since several modules may each declare it. Ambiguous is none — a finding is
  // dropped only when it is certainly about a refused object.
  const declarationOf = (data: {
    resource?: { kind?: unknown; name?: unknown };
    filePath?: unknown;
  }): ResourceManifest | undefined => {
    const name = data.resource?.name;
    if (typeof name !== "string") return undefined;
    let candidates = (byName.get(name) ?? []).filter(
      (m) => typeof data.resource?.kind !== "string" || m.kind === data.resource.kind,
    );
    if (candidates.length > 1 && typeof data.filePath === "string") {
      candidates = candidates.filter((m) => (m.metadata as { source?: unknown }).source === data.filePath);
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const extractedFromRefused = (start: ResourceManifest | undefined): boolean => {
    const seen = new Set<string>();
    for (let current = start; current; ) {
      const origin = (current.metadata as { xTeloOrigin?: { parentName?: unknown; pathFromParent?: unknown } })
        .xTeloOrigin;
      if (typeof origin?.parentName !== "string" || typeof origin.pathFromParent !== "string") return false;
      // An extraction carries the module of the declaration it came out of.
      const parent = declarationKey(moduleOf(current.metadata), origin.parentName);
      if (marked.has(`${parent}\0${origin.pathFromParent}`)) return true;
      if (seen.has(parent)) return false;
      seen.add(parent);
      current = byKey.get(parent);
    }
    return false;
  };
  return diagnostics.filter((d) => {
    if (refusedSites.has(d)) return true;
    const data = d.data as
      | { resource?: { kind?: unknown; name?: unknown }; path?: unknown; filePath?: unknown }
      | undefined;
    const holder = data ? declarationOf(data) : undefined;
    if (!holder) return true;
    const key = declarationKey(moduleOf(holder.metadata), holder.metadata!.name as string);
    if (typeof data?.path === "string" && marked.has(`${key}\0${data.path}`)) return false;
    return !extractedFromRefused(holder);
  });
}

/** Best-effort name for the `!ref` suggestion in a string-ref diagnostic: a
 *  dotted-FQN (`Http.Api.UsersApi`) keeps its last segment, an alias-qualified
 *  name (`Console.writeLine`) is left intact, a bare name passes through. */
function refHint(value: string): string {
  const dotCount = (value.match(/\./g) ?? []).length;
  if (dotCount >= 2) return value.slice(value.lastIndexOf(".") + 1);
  return value;
}
