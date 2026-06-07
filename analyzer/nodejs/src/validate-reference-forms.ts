import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { visitManifest } from "./manifest-visitor.js";
import { REF_VALIDATION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Reference-form validation — the single enforcement point for "a reference is
 * written `!ref <name>` (or `!ref <Alias>.<name>`), nothing else".
 *
 * Runs on the RAW manifest set, BEFORE inline-resource extraction and `!ref`
 * sentinel resolution. That ordering is load-bearing: only at this point is an
 * author-written value still distinguishable from the resolver's own
 * substitution. After normalization both an author's `{kind, name}` and a
 * resolved `!ref` are the same `{kind, name}` object, so no later pass — and no
 * JSON Schema — can tell them apart.
 *
 * At every `x-telo-ref` slot the only accepted value is:
 *   - a `!ref` sentinel (or any tagged sentinel — e.g. a `${{ }}` ref passed
 *     through a template), or
 *   - an inline definition: a plain object with a `kind` and NO `name` (the
 *     extractor assigns the name), or
 *   - a `${{ }}` CEL expression string (a reference flowed through CEL).
 *
 * Rejected, each with an actionable diagnostic pointing at `!ref`:
 *   - the object form `{ kind, name }` (the old reference object), and
 *   - a bare string (the old name / dotted-FQN reference).
 */
export function validateReferenceForms(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): AnalysisDiagnostic[] {
  if (!aliases) return [];
  const diagnostics: AnalysisDiagnostic[] = [];

  const isForeign = (r: ResourceManifest): boolean =>
    (r.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport === true;
  const localResources = resources.filter((r) => !isForeign(r));

  visitManifest(
    localResources,
    registry,
    {
      onRef: (e) => {
        const value = e.value;
        // `!ref` and `!cel`/`${{ }}` sentinels are the supported shapes.
        if (isTaggedSentinel(value)) return;

        const r = e.source;
        const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
        const resourceData = { kind: r.kind, name: r.metadata!.name as string };
        const filePath = (r.metadata as { source?: string } | undefined)?.source;
        const path = e.concretePath;

        if (typeof value === "string") {
          // A `${{ }}` reference flowed through CEL is fine; any other bare
          // string at a ref slot is the removed string / dotted-FQN form.
          if (value.includes("${{")) return;
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "INVALID_REFERENCE_FORM",
            source: SOURCE,
            message: `${resourceLabel}: string reference at '${path}' → '${value}' is not supported; write it as '!ref ${refHint(value)}'`,
            data: { resource: resourceData, filePath, path },
          });
          return;
        }

        if (value && typeof value === "object" && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>;
          // A plain object is an inline definition unless it names a resource —
          // a `name` makes it the removed `{ kind, name }` reference object.
          if (typeof obj.name === "string" && typeof obj.kind === "string") {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "INVALID_REFERENCE_FORM",
              source: SOURCE,
              message: `${resourceLabel}: object reference '{ kind, name }' at '${path}' is not supported; write it as '!ref ${obj.name}'`,
              data: { resource: resourceData, filePath, path },
            });
          }
        }
      },
    },
    {
      aliases,
      aliasesByModule,
      skipKinds: SYSTEM_KINDS,
      expand: true,
      discoverNestedRefs: true,
    },
  );

  return diagnostics;
}

/** Best-effort name for the `!ref` suggestion in a string-ref diagnostic: a
 *  dotted-FQN (`Http.Api.UsersApi`) keeps its last segment, an alias-qualified
 *  name (`Console.writeLine`) is left intact, a bare name passes through. */
function refHint(value: string): string {
  const dotCount = (value.match(/\./g) ?? []).length;
  if (dotCount >= 2) return value.slice(value.lastIndexOf(".") + 1);
  return value;
}
