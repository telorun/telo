import type { ResourceManifest } from "@telorun/sdk";
import { quotingIssue, type QuotedPlace } from "./quoted-place.js";
import type { AliasResolver } from "./alias-resolver.js";
import { capabilityProblem } from "./capability-roster.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isKindDocument } from "./kind-declaration.js";
import type { SchemaIssue } from "./schema-error-report.js";
import { importAnchoredDiagnostic, type ImportReach } from "./reaching-import.js";
import { declaredScopes, isScopeMember } from "./scope-declarations.js";
import type { ScopeMember } from "./scope-members.js";
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
 * schema (`SCHEMA_VIOLATION`). Every other pass over a kind document reads the
 * documents that register kinds, which a scope member does not, so the analysis
 * holds such a member apart from the declarations it checks
 * (`collectScopeMembers`), and this is all that judges it. The schema's own
 * `capability` finding is dropped where the roster reports the value, so a
 * mistaken capability is one diagnostic.
 *
 * The entry's own modules are judged over the members the analysis recorded,
 * each reported at itself, which the analysis moves to its place inside the
 * resource declaring the scope (`with[0].capability`). Every imported library is
 * judged too, over its full documents, and each refusal reported at the entry's
 * `imports:` entry through which the library is first reached: the kernel
 * refuses the consumer's run all the same, and the library's file is not a line
 * the consumer can change.
 *
 * Browser-safe.
 */
export function validateScopedKindDocuments(
  /** The kind documents the analysis recorded as scope members. */
  members: readonly ScopeMember[],
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
  type Report = (code: string, message: string, path: string, quotedPlace?: QuotedPlace[]) => void;

  const judge = (member: ResourceManifest, kind: KindDocumentKind, report: Report): void => {
    const label = `${kind} '${member.metadata.name}'`;
    const capability = capabilityProblem(
      (member as Record<string, unknown>).capability,
      (member as Record<string, unknown>).extends !== undefined,
    );
    if (capability) report(capability.code, `${label}: ${capability.message}`, "capability");
    for (const issue of validate(member, kind)) {
      if (capability && issue.path === "capability") continue;
      const quoted = quotingIssue(`${kind}/${member.metadata.name}: `, issue, issue.path);
      report("SCHEMA_VIOLATION", quoted.message, issue.path, quoted.quotedPlace);
    }
  };
  const kindOf = (m: ResourceManifest): KindDocumentKind | undefined =>
    m.kind === "Telo.Definition" || m.kind === "Telo.Abstract" ? m.kind : undefined;

  for (const { declaration } of members) {
    const kind = kindOf(declaration);
    if (!kind || isForwardedDeclaration(declaration)) continue;
    const module = (declaration.metadata as { module?: unknown }).module;
    if (typeof module === "string" && !rootModules.has(module)) continue;
    const resource = { kind: declaration.kind, name: declaration.metadata.name as string };
    const filePath = (declaration.metadata as { source?: string }).source;
    judge(declaration, kind, (code, message, path, quotedPlace) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message,
        data: { resource, filePath, path, ...(quotedPlace ? { quotedPlace } : {}) },
      }),
    );
  }

  /** Every scope member beneath a library's `root`, at any depth, read in the
   *  aliases of the library. */
  const judgeLibraryScopes = (root: ResourceManifest, module: string, report: Report): void => {
    const visit = (declaration: ResourceManifest): void => {
      const view =
        typeof declaration.metadata?.module !== "string"
          ? ({ ...declaration, metadata: { ...declaration.metadata, module } } as ResourceManifest)
          : declaration;
      for (const scope of declaredScopes(
        registry.referenceSites(view, aliases, aliasesByModule, declaration),
      )) {
        for (const member of scope.declarations) {
          if (!isScopeMember(member)) continue;
          const kind = kindOf(member);
          if (kind) judge(member, kind, report);
          else visit(member);
        }
      }
    };
    visit(root);
  };

  /** A document that may declare scopes: a named resource, never a module,
   *  import or kind document. */
  const scopeHolder = (m: ResourceManifest): boolean =>
    !!m.kind && !isDeclarationDocument(m) && typeof m.metadata?.name === "string";

  for (const library of libraries) {
    if (rootModules.has(library.module) || !reach.loads(library)) continue;
    const via = reach.of(library.module);
    if (!via) continue;
    for (const root of library.manifests) {
      if (!scopeHolder(root)) continue;
      judgeLibraryScopes(root, library.module, (code, message) =>
        out.push(importAnchoredDiagnostic(code, library.module, via, message)),
      );
    }
  }

  return out;
}
