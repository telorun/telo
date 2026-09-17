import {
  callableInstanceIssues,
  callableKindIssues,
  type CallableKindIssue,
  type DefResolver,
} from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

/** Resolves a kind in a named module's scope — the kernel's resource context. */
export interface DefinitionScopeHost {
  resolveDefinitionIn(kind: string, module: string | undefined): ResourceDefinition | undefined;
}

/**
 * The kernel half of "what a callable kind may declare".
 *
 * Both meta-controllers refuse here — a `Telo.Definition` and a `Telo.Abstract`
 * may each carry a signature and each be callable — so the refusal lives beside
 * them rather than in either, for the reason the two already share
 * `manifest-schemas.ts`.
 *
 * **The rules are read, never restated.** `callableKindIssues` is the analyzer's,
 * browser-safe and re-imported here exactly as `effectiveAuthorSchema` and
 * `evalPathCovers` are; a second copy would eventually refuse a different set
 * and turn `telo check`'s verdict into a guess about what boot will do.
 *
 * Every clause is raised under ONE code. The issue's own text says which clause
 * fired and what to write instead; splitting the code per clause would put a
 * vocabulary in the kernel that the analyzer already owns, and a consumer
 * branching on it has exactly one action either way — fix the kind, or pin a
 * version that does not carry it.
 */
export function refuseInvalidCallable(
  definition: ResourceDefinition,
  host: DefinitionScopeHost,
): void {
  // Every hop of the chain resolves in the module that declared the definition
  // it was read off: an ancestor's `extends` alias is its own library's, which
  // the defining module may never have imported.
  const resolve: DefResolver = (kind, from) =>
    host.resolveDefinitionIn(kind, (from ?? definition).metadata?.module);
  const issues = callableKindIssues(definition as unknown as ResourceManifest, resolve);
  if (issues.length === 0) return;
  throw new RuntimeError(
    "ERR_CALLABLE_DEFINITION_INVALID",
    describe(definition, issues),
  );
}

/**
 * The instance half: a resource of a callable kind that declares `deterministic`,
 * or a signature of its own that no caller could be bound against. Refused at
 * creation, before its controller is reached, by the same rules `telo check`
 * reports — which a dependency's instances otherwise escape, since that check is
 * entry-module-scoped.
 */
export function refuseInvalidCallableInstance(
  resource: ResourceManifest,
  resolve: DefResolver,
): void {
  const issues = callableInstanceIssues(resource, resolve);
  if (issues.length === 0) return;
  throw new RuntimeError(
    "ERR_CALLABLE_DEFINITION_INVALID",
    describe(resource as unknown as ResourceDefinition, issues),
  );
}

/** The headline names what was refused and each line names its own clause by
 *  the analyzer's code — a kind refused only for holding a function through an
 *  untyped slot is not a callable kind at all, so one sentence about "what a
 *  callable kind cannot carry" misdescribed it. */
function describe(definition: ResourceDefinition, issues: readonly CallableKindIssue[]): string {
  const name = definition.metadata?.name ?? "<unnamed>";
  const lines = issues.map((issue) => `  - ${issue.code} at ${issue.path}: ${issue.message}`);
  return (
    `${definition.kind} '${name}' declares or holds a function in a way the kernel refuses:\n` +
    lines.join("\n")
  );
}
