/**
 * **Module calls, judged at the site they are written.**
 *
 * Every module call an expression makes (`Billing.format(x)`) is resolved
 * through `ModuleFunctionIndex` and checked against what it reaches:
 *
 *  - `FUNCTION_UNRESOLVED` — the name reaches no resource;
 *  - `FUNCTION_NOT_EXPORTED` — the imported library declares it and keeps it
 *    private;
 *  - `FUNCTION_NOT_CALLABLE` — it reaches a resource that is not a function;
 *  - `FUNCTION_ARITY_MISMATCH` — the call passes a number of arguments the
 *    parameter list does not accept;
 *  - `FUNCTION_ARGUMENT_MISMATCH` — an argument's type, or the declared shape of a
 *    plain-chain argument, is incompatible with its parameter's schema;
 *  - `FUNCTION_CALL_UNBOUND` — the expression sits where the runtime binds no
 *    module function (`x-telo-unbound-calls`), so no call in it can be judged
 *    against what it names.
 *
 * The first three are the kernel's binding refusals (`ERR_FUNCTION_*`); arity is
 * `ERR_FUNCTION_ARITY_MISMATCH` at evaluation. Entry-module-scoped, the
 * `X_TELO_REF_UNRESOLVED` rule: a dependency's expression is its own author's to
 * fix, and the kernel's refusal is what covers it in a consumer.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { CallSite } from "@telorun/templating";
import { moduleCallsInSource } from "./cel-access-chains.js";
import type { ModuleFunctionIndex } from "./module-function-index.js";
import type { UnboundCallSource } from "./unbound-call-site.js";
import {
  celTypeSatisfiesJsonSchema,
  checkSchemaCompatibility,
  navigateSchemaToExprPath,
} from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

export interface ModuleCallSite {
  readonly manifest: ResourceManifest;
  readonly resource: { kind: string; name: string };
  readonly filePath: string | undefined;
  readonly path: string;
  readonly calls: readonly CallSite[];
  /** The context the expression is typed against, for a chain argument's
   *  declared shape. */
  readonly contextSchema: Record<string, any> | null;
  readonly resolveRef: (ref: string) => Record<string, any> | undefined;
  /** Why no module function is bound where this expression is evaluated, when
   *  none is (`unbound-call-site.ts`). */
  readonly unboundReason?: string;
}

export function moduleCallDiagnostics(
  site: ModuleCallSite,
  index: ModuleFunctionIndex,
): AnalysisDiagnostic[] {
  if (!index.isOwned(site.manifest)) return [];
  const out: AnalysisDiagnostic[] = [];
  const { manifest, resource, filePath, path } = site;
  const prefix = `${manifest.kind}/${resource.name}: CEL at '${path}' calls`;
  const push = (code: string, message: string) =>
    out.push({
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message,
      data: { resource, filePath, path },
    });
  // A name reported once per expression, however often it is called: the same
  // name reaches the same resource at every call in one expression.
  const reported = new Set<string>();

  for (const call of site.calls) {
    if (!call.moduleCall) continue;
    if (site.unboundReason !== undefined) {
      if (reported.has(call.name)) continue;
      reported.add(call.name);
      push("FUNCTION_CALL_UNBOUND", unboundCallMessage(prefix, call.name, site.unboundReason));
      continue;
    }
    const resolution = index.resolve(manifest, call.name);
    const receiver = call.name.slice(0, call.name.indexOf("."));
    switch (resolution.status) {
      case "unknown":
        continue;
      case "unresolved":
        if (reported.has(call.name)) continue;
        reported.add(call.name);
        push(
          "FUNCTION_UNRESOLVED",
          `${prefix} '${call.name}', which names no function this module can reach. A CEL function is a resource declared with capability 'Telo.Callable' in the module '${receiver}' names; an imported one must also be listed in that library's 'exports.resources'. Here, ${resolution.reason}`,
        );
        continue;
      case "not-exported":
        if (reported.has(call.name)) continue;
        reported.add(call.name);
        push(
          "FUNCTION_NOT_EXPORTED",
          `${prefix} '${call.name}', but the library imported as '${resolution.alias}' does not list '${resolution.name}' in its 'exports.resources', so it is private to that library. Export it there, or call a function the library does export.`,
        );
        continue;
      case "not-callable":
        if (reported.has(call.name)) continue;
        reported.add(call.name);
        push(
          "FUNCTION_NOT_CALLABLE",
          `${prefix} '${call.name}', which names the ${resolution.kind} resource '${resolution.manifest.metadata?.name}' — its capability resolves to '${resolution.capability ?? "<none>"}', not 'Telo.Callable'. Only a function can be called from an expression; dispatch any other resource from a step.`,
        );
        continue;
      case "resolved":
        break;
    }

    const params = resolution.params;
    const required = params.filter((param) => !param.optional).length;
    if (call.arity < required || call.arity > params.length) {
      const expected =
        required === params.length ? `${required}` : `${required} to ${params.length}`;
      push(
        "FUNCTION_ARITY_MISMATCH",
        `${prefix} '${call.name}' with ${call.arity} argument(s), but it takes ${expected} (${params.map((p) => (p.optional ? `${p.name}?` : p.name)).join(", ") || "none"}).`,
      );
      continue;
    }

    (call.arguments ?? []).forEach((argument, index) => {
      const param = params[index];
      if (!param?.schema) return;
      if (argument.type !== undefined && !celTypeSatisfiesJsonSchema(argument.type.split("<")[0]!, param.schema)) {
        push(
          "FUNCTION_ARGUMENT_MISMATCH",
          `${prefix} '${call.name}' passing a '${argument.type}' for parameter '${param.name}', which expects '${describeSchema(param.schema)}'.`,
        );
        return;
      }
      if (!argument.chain || !site.contextSchema) return;
      const produced = navigateSchemaToExprPath(site.contextSchema, argument.chain.join("."));
      if (!produced) return;
      const { compatible, issues } = checkSchemaCompatibility(
        produced,
        param.schema,
        site.resolveRef,
      );
      if (compatible) return;
      push(
        "FUNCTION_ARGUMENT_MISMATCH",
        `${prefix} '${call.name}' passing '${argument.chain.join(".")}' for parameter '${param.name}', whose declared shape disagrees with it: ${issues.join("; ")}.`,
      );
    });
  }
  return out;
}

/**
 * `FUNCTION_CALL_UNBOUND` for the plain-text expressions a field evaluates as
 * CEL source with no module function bound (`unboundCallSources`) — text no
 * CEL walk reaches, read for calls with the declaring module's names, since
 * that is what its author wrote them against.
 */
export function unboundSourceDiagnostics(
  manifest: ResourceManifest,
  filePath: string | undefined,
  sources: readonly UnboundCallSource[],
  moduleNames: ReadonlySet<string>,
  index: ModuleFunctionIndex,
): AnalysisDiagnostic[] {
  if (!index.isOwned(manifest)) return [];
  const resource = { kind: manifest.kind as string, name: manifest.metadata?.name as string };
  return sources.flatMap(({ path, source, reason }) =>
    [...new Set(moduleCallsInSource(source, moduleNames))].map(
      (call): AnalysisDiagnostic => ({
        severity: DiagnosticSeverity.Error,
        code: "FUNCTION_CALL_UNBOUND",
        source: SOURCE,
        message: unboundCallMessage(`${resource.kind}/${resource.name}: CEL at '${path}' calls`, call, reason),
        data: { resource, filePath, path },
      }),
    ),
  );
}

function unboundCallMessage(prefix: string, call: string, reason: string): string {
  return `${prefix} '${call}', but ${reason}, so no module function can be called here. Write the logic into the expression itself.`;
}

function describeSchema(schema: Record<string, any>): string {
  const declared = schema["x-telo-type"] ?? schema.type;
  if (Array.isArray(declared)) return declared.join(" | ");
  if (typeof declared === "string") return declared;
  if (declared && typeof declared === "object" && typeof declared.name === "string") {
    return declared.name;
  }
  return "the declared schema";
}
