/**
 * `CEL_SCHEMA_UNJUDGED`: a node of a schema a CEL binding is typed from that
 * the type checker cannot read in full, reported once where the node is
 * written, saying what the CEL reads beneath it lose.
 *
 * The engine lists each such node per registration (`schemaReports()`); this
 * finds the node in the schema handed for that registration and reads where
 * it was written from its provenance (`schema-provenance.ts`) — one lookup,
 * no document walked. A node of Telo's own vocabulary is not reported (the
 * built-in vocabulary converts with no report, which a test holds), nor is a
 * dependency's, which its own check reports. A node with no provenance, a
 * type name the resolver gave that the environment does not register, and an
 * unresolved reference no reference finding reports are internal errors.
 * Browser-safe.
 */
import type { CelEnvironment, UnjudgedSchemaNode } from "@telorun/cel";
import type { ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel } from "@telorun/templating";
import { isModuleKind } from "./module-kinds.js";
import { BUILT_IN, placePath, schemaPlaceOf, type WrittenSchemaPlace } from "./schema-provenance.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

type Schema = Record<string, any>;

const handed = new WeakMap<CelEnvironment, Map<string, Schema>>();

/** Record the schema `name` was registered from on `env`: a binding by its
 *  name, a namespaced result as `<namespace>.<name>`. */
export function recordHandedSchema(env: CelEnvironment, name: string, schema: Schema): void {
  let byName = handed.get(env);
  if (!byName) handed.set(env, (byName = new Map()));
  byName.set(name, schema);
}

/** One placed finding and the written node it is reported at. */
export interface UnjudgedFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly place: WrittenSchemaPlace;
}

/** The codes reporting a reference that names no shape. */
const REFERENCE_CODES: ReadonlySet<string> = new Set([
  "CONTRACT_TYPE_NOT_FOUND",
  "SCHEMA_TYPE_REF_UNRESOLVED",
  "SCHEMA_TYPE_REF_UNKNOWN_ALIAS",
  "REFERENCE_KIND_MISMATCH",
]);

/** An unresolved reference an engine registration met: a reference finding's
 *  to report, held to the analysis's whole set by
 *  {@link assertReferencesReported}. */
export interface UnresolvedSchemaReference {
  readonly place: WrittenSchemaPlace;
  readonly registration: string;
}

/**
 * One finding per unjudged node the environments' registrations hold, at the
 * place it is written in one of the entry's own modules, and every unresolved
 * reference met (into `unresolved`).
 */
export function unjudgedSchemaFindings(
  environments: Iterable<CelEnvironment>,
  rootModules: ReadonlySet<string>,
  unresolved: UnresolvedSchemaReference[],
): UnjudgedFinding[] {
  const out = new Map<string, UnjudgedFinding>();
  // One provenance lookup per node, however many registrations report it.
  const placed = new Map<object, ReturnType<typeof schemaPlaceOf>>();
  for (const env of environments) {
    for (const report of env.schemaReports()) {
      for (const node of report.unjudged) {
        if (node.reason === "named-type-unregistered") {
          throw new Error(
            `internal: the CEL schema resolver named the type '${node.typeName}' for '${report.name}' at '${node.pointer}', which the environment does not register`,
          );
        }
        const schema = handed.get(env)?.get(report.name);
        if (!schema) throw new Error(`internal: no schema was recorded for the CEL registration '${report.name}'`);
        const pointer = node.throughReference ?? node.pointer;
        const target = nodeAt(schema, pointer);
        if (!target) {
          throw new Error(`internal: the CEL registration '${report.name}' names no schema node at '${pointer}'`);
        }
        // A reference leaving the registration's document is the reference
        // codes'; a dangling one within a document is the schema's own.
        const ref = target.$ref;
        const leaves = node.throughReference === undefined && typeof ref === "string" && !ref.startsWith("#");
        if (node.reason === "reference-unresolved" && !leaves) continue;
        let place = placed.get(target);
        if (!placed.has(target)) placed.set(target, (place = schemaPlaceOf(target)));
        if (!place) {
          throw new Error(
            `internal: the schema node at '${pointer}' of the CEL registration '${report.name}' has no recorded provenance`,
          );
        }
        if (place === BUILT_IN || !declaredInEntry(place.manifest, rootModules)) continue;
        if (node.reason === "reference-unresolved") {
          unresolved.push({ place, registration: report.name });
          continue;
        }
        const diagnostic = findingAt(place, node);
        const key = `${(diagnostic.data as { filePath?: string }).filePath}\0${place.manifest.kind}\0${String(place.manifest.metadata?.name)}\0${placePath(place.keys)}\0${diagnostic.message}`;
        if (!out.has(key)) out.set(key, { diagnostic, place });
      }
    }
  }
  return [...out.values()];
}

/** Whether `manifest` is declared in one of the entry's own modules. */
function declaredInEntry(manifest: ResourceManifest, rootModules: ReadonlySet<string>): boolean {
  if (isModuleKind(manifest.kind)) return rootModules.has(String(manifest.metadata?.name));
  const module = (manifest.metadata as { module?: unknown } | undefined)?.module;
  return typeof module !== "string" || rootModules.has(module);
}

/** Every unresolved reference is one a reference finding of `reported` — the
 *  analysis's whole set — reports at its place or beneath it; any other is an
 *  internal error. */
export function assertReferencesReported(
  unresolved: readonly UnresolvedSchemaReference[],
  reported: readonly AnalysisDiagnostic[],
): void {
  if (unresolved.length === 0) return;
  const findings = referenceFindingPlaces(reported);
  for (const { place, registration } of unresolved) {
    if (coversPlace(findings, place)) continue;
    throw new Error(
      `internal: the reference at '${placePath(place.keys)}' of ${place.manifest.kind}/${String(place.manifest.metadata?.name)} was left unresolved for '${registration}', and no reference finding reports it`,
    );
  }
}

function referenceFindingPlaces(reported: readonly AnalysisDiagnostic[]): Set<string> {
  const places = new Set<string>();
  for (const d of reported) {
    if (!REFERENCE_CODES.has(String(d.code))) continue;
    const data = d.data as { filePath?: string; path?: string; resource?: { kind?: string; name?: string } } | undefined;
    places.add(`${data?.filePath}\0${data?.resource?.kind}\0${data?.resource?.name}\0${data?.path ?? ""}`);
  }
  return places;
}

/** Whether a reference finding is reported at `place` or beneath it. */
function coversPlace(findings: ReadonlySet<string>, place: WrittenSchemaPlace): boolean {
  const metadata = place.manifest.metadata as { name?: unknown; source?: unknown } | undefined;
  const prefix = `${metadata?.source as string | undefined}\0${place.manifest.kind}\0${String(metadata?.name)}\0`;
  // A reference finding writes its path dotted, or `/`-separated with an
  // index either as a segment or bracketed.
  const dotted = placePath(place.keys);
  const slashed = place.keys.join("/");
  for (const finding of findings) {
    if (!finding.startsWith(prefix)) continue;
    const at = finding.slice(prefix.length);
    if (at === dotted || at.startsWith(`${dotted}.`) || at.startsWith(`${dotted}[`)) return true;
    const segments = at.replace(/\[(\d+)\](?=\/|$)/g, "/$1");
    if (segments === slashed || segments.startsWith(`${slashed}/`)) return true;
  }
  return false;
}

function findingAt(place: WrittenSchemaPlace, node: UnjudgedSchemaNode): AnalysisDiagnostic {
  const { manifest } = place;
  const path = placePath(place.keys);
  const metadata = manifest.metadata as { name?: unknown; source?: unknown } | undefined;
  const name = String(metadata?.name);
  // A choice document is named by the tag it is declared behind.
  const kind = typeof manifest.kind === "string" ? manifest.kind : (expansionTagLabel(manifest) ?? "resource");
  const what =
    node.keywords.length > 0
      ? `${node.keywords.length === 1 ? "keyword" : "keywords"} ${node.keywords.map((k) => `'${k}'`).join(", ")}`
      : node.reason === "intersection-empty"
        ? "a type no value can have"
        : "this shape";
  const how = node.reason === "shape-not-read" && node.keywords.length > 0 ? " in the form written here" : "";
  return {
    severity: DiagnosticSeverity.Warning,
    code: "CEL_SCHEMA_UNJUDGED",
    source: "telo-analyzer",
    message: `${kind}/${name}: the CEL type checker does not read ${what}${how} at '${path}': ${effectOf(node)}.`,
    data: {
      resource: { kind, name },
      filePath: metadata?.source as string | undefined,
      path,
      reason: node.reason,
      keywords: node.keywords,
    },
  };
}

/** What CEL reads beneath the node lose, by what the checker did not read. */
function effectOf(node: UnjudgedSchemaNode): string {
  switch (node.reason) {
    case "keyword-not-read":
      return node.keywords.map(unreadKeywordEffect).join("; ");
    case "shape-not-read":
      return unreadShapeEffect(node.keywords[0]);
    case "intersection-empty":
      return "it admits no value, so CEL reads it as `dyn` and checks no operation on it";
    default:
      return "CEL reads it as `dyn` and checks no operation on it";
  }
}

function unreadKeywordEffect(keyword: string): string {
  if (keyword === "unevaluatedProperties") {
    return "a member no other keyword of the node declares is read as 'additionalProperties' says, refused where that is absent or false";
  }
  if (keyword === "unevaluatedItems") {
    return "an element past the positions 'items' or 'prefixItems' declare is read as those keywords say";
  }
  return `what '${keyword}' says is not applied, so CEL reads beneath the node are typed by its other keywords alone`;
}

/** By the keyword whose form was not read; the others are the ones beside it. */
function unreadShapeEffect(keyword: string | undefined): string {
  switch (keyword) {
    case "not":
      return "what 'not' excludes is not taken out of the node's type";
    case "type":
      return "a 'type' naming no JSON type is read as `dyn`, so no operation on it is checked";
    case "patternProperties":
      return "a member the node does not declare in 'properties' is read as `dyn`, so no operation on it is checked";
    case "prefixItems":
      return "its positions are not read, so every element is read as `dyn` and no operation on one is checked";
    default:
      return "the node is read as `dyn`, so no operation on it is checked";
  }
}

/** The node `pointer` names in `schema`, the registration's own document. */
function nodeAt(schema: Schema, pointer: string): Schema | undefined {
  let current: unknown = schema;
  if (pointer !== "") {
    for (const raw of pointer.slice(1).split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current !== null && typeof current === "object" && !Array.isArray(current) ? (current as Schema) : undefined;
}
