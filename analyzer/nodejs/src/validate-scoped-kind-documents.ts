import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { capabilityProblem } from "./capability-roster.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isKindDocument } from "./kind-declaration.js";
import type { SchemaIssue } from "./schema-error-report.js";
import { importAnchoredDiagnostic, type ImportReach } from "./reaching-import.js";
import { declaredScopes, isScopeMember } from "./scope-declarations.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** The two kind documents whose own grammar the roster and the entry schema judge. */
type KindDocumentKind = "Telo.Definition" | "Telo.Abstract";

const isDeclarationDocument = (m: { kind?: unknown }): boolean =>
  m.kind === "Telo.Application" ||
  m.kind === "Telo.Library" ||
  m.kind === "Telo.Import" ||
  isKindDocument(m);

/**
 * A `Telo.Definition` / `Telo.Abstract` declared as a member of a `with:` scope,
 * judged as the kernel judges it when the scope opens and creates it: its
 * `capability:` against the roster (`CAPABILITY_UNKNOWN` /
 * `CAPABILITY_NOT_DECLARABLE`) and the document against its built-in entry's
 * schema (`SCHEMA_VIOLATION`). A scope member gets no per-resource pass, so
 * without this both passed `telo check` and failed only once the scope ran.
 *
 * Only these two checks: every other pass over a kind document reads top-level
 * documents alone. The schema's own `capability` finding is dropped where the
 * roster reports the value, so a mistaken capability is one diagnostic.
 *
 * The entry's own modules are anchored at the member inside the resource
 * declaring the scope (`with[0].capability`), the path position lookup walks
 * into its owner. Every imported library is judged too, over its full
 * documents, and each refusal reported at the entry's `imports:` entry through
 * which the library is first reached: the kernel refuses the consumer's run
 * all the same, and the library's file is not a line the consumer can change.
 *
 * Browser-safe.
 */
export function validateScopedKindDocuments(
  manifests: ResourceManifest[],
  /** Every imported library's full documents (`AnalysisOptions.moduleDocuments`). */
  libraries: readonly ModuleDocuments[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
  reach: ImportReach,
  /** The document's findings against its built-in entry's schema. */
  validate: (member: ResourceManifest, kind: KindDocumentKind) => SchemaIssue[],
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  /** One refusal: its code, its message, and the member path it was found at. */
  type Report = (code: string, message: string, path: string) => void;

  /** Every scope member beneath `root`, at any depth, read in the aliases of
   *  the module that declared it. */
  const judgeScopes = (root: ResourceManifest, module: string | undefined, report: Report): void => {
    const at = (prefix: string, path: string) => (path ? `${prefix}.${path}` : prefix);

    const judge = (member: ResourceManifest, kind: KindDocumentKind, prefix: string): void => {
      const label = `${kind} '${member.metadata.name}'`;
      const capability = capabilityProblem(
        (member as Record<string, unknown>).capability,
        (member as Record<string, unknown>).extends !== undefined,
      );
      if (capability) {
        report(capability.code, `${label}: ${capability.message}`, at(prefix, "capability"));
      }
      for (const issue of validate(member, kind)) {
        if (capability && issue.path === "capability") continue;
        report(
          "SCHEMA_VIOLATION",
          `${kind}/${member.metadata.name}: ${issue.message}`,
          at(prefix, issue.path),
        );
      }
    };

    const visit = (declaration: ResourceManifest, prefix: string): void => {
      const view =
        module !== undefined && typeof declaration.metadata?.module !== "string"
          ? ({ ...declaration, metadata: { ...declaration.metadata, module } } as ResourceManifest)
          : declaration;
      for (const scope of declaredScopes(
        registry.referenceSites(view, aliases, aliasesByModule, declaration),
      )) {
        scope.declarations.forEach((member, i) => {
          if (!isScopeMember(member)) return;
          const path = `${prefix ? `${prefix}.` : ""}${scope.path}[${i}]`;
          if (member.kind === "Telo.Definition" || member.kind === "Telo.Abstract") {
            judge(member, member.kind, path);
            return;
          }
          visit(member, path);
        });
      }
    };

    visit(root, "");
  };

  /** A document that may declare scopes: a named resource, never a module,
   *  import or kind document, nor a copy forwarded from another module. */
  const scopeHolder = (m: ResourceManifest): { name: string; module?: string } | undefined => {
    if (!m.kind || isDeclarationDocument(m) || isForwardedDeclaration(m)) return undefined;
    const meta = m.metadata as { name?: unknown; module?: unknown } | undefined;
    if (typeof meta?.name !== "string") return undefined;
    return { name: meta.name, ...(typeof meta.module === "string" ? { module: meta.module } : {}) };
  };

  for (const root of manifests) {
    const holder = scopeHolder(root);
    if (!holder || (holder.module && !rootModules.has(holder.module))) continue;
    const resource = { kind: root.kind, name: holder.name };
    const filePath = (root.metadata as { source?: unknown }).source;
    judgeScopes(root, holder.module, (code, message, path) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message,
        data: { resource, filePath: typeof filePath === "string" ? filePath : undefined, path },
      }),
    );
  }

  for (const library of libraries) {
    if (rootModules.has(library.module) || !reach.loads(library)) continue;
    const via = reach.of(library.module);
    if (!via) continue;
    for (const root of library.manifests) {
      if (!scopeHolder(root)) continue;
      judgeScopes(root, library.module, (code, message) =>
        out.push(importAnchoredDiagnostic(code, library.module, via, message)),
      );
    }
  }

  return out;
}
