/**
 * **What a callable kind may declare**, and what a signature may say — the
 * strict half of `callable-signature.ts`, shared verbatim by `telo check` and by
 * the kernel's definition registration.
 *
 * A function is reached from inside a CEL expression. `call(args)` receives no
 * context at all: no zone, no cancellation, no trace, no ambient scope, and
 * nothing to await. So a whole family of declarations that are ordinary
 * elsewhere are meaningless on a callable kind, and meaningless-but-accepted is
 * the failure this repository treats as worst — the author writes it, sees no
 * error, and the runtime quietly ignores it.
 *
 * SHARED, not duplicated. The kernel refuses the same definitions at
 * registration (`ERR_CALLABLE_DEFINITION_INVALID`), reading this module rather
 * than restating the rules — the `buildEvalPaths` / `evalPathCovers` precedent.
 * A guard enforced in a controller with no analyzer twin is a manifest that
 * passes `telo check` and fails at boot; two copies of the guard is the same
 * defect with an extra way to drift.
 *
 * `throws:` is deliberately NOT reported here. A callable declaring one is
 * already refused in both halves by the mechanism that owns the question —
 * `THROWS_ON_NON_DISPATCH_CAPABILITY` statically, the kernel's per-capability
 * schema branch at registration — and a second diagnostic on the same line would
 * say the same thing less precisely.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type DiagnosticFix } from "./types.js";
import { isRefSourceSpelling } from "./ref-sentinel-target.js";
import { refSentinelsIn } from "./contract-shapes.js";
import {
  CALLABLE_CAPABILITY,
  FUNCTION_KIND,
  instanceDeclaresSignature,
  isCallableKind,
  readDeterministic,
  readParams,
  readReturns,
  requiresDeterminism,
  type SignatureParam,
  type SignatureResult,
} from "./callable-signature.js";
import {
  controllerBearingAncestor,
  type DefResolver,
  effectiveAuthorSchema,
  hasOwnControllerOrTemplate,
  inheritedCapability,
  isInheritedDelegation,
  resolveParent,
} from "./extends-resolution.js";
import { isHoistedFragmentDefKey } from "./manifest-schemas.js";
import { readRefSlot, type RefSlot } from "./ref-slot.js";
import { readStepSlot } from "./step-slot.js";
import { untypedCallableSlotIssues } from "./validate-ref-slots.js";

export interface CallableKindIssue {
  readonly code:
    | "CALLABLE_DEFINITION_INVALID"
    | "X_TELO_REF_CALLABLE_UNTYPED"
    | "FUNCTION_OPTIONAL_NOT_TRAILING"
    | "FUNCTION_TYPE_NAME_FORM"
    | "FUNCTION_NAME_RESERVED"
    | "CONTRACT_TYPE_NOT_FOUND";
  /** Dotted path of the offending node within the document. */
  readonly path: string;
  readonly message: string;
  /** A whole-value repair, where one exists. */
  readonly fix?: DiagnosticFix;
}

/** The kind a callable's reference slot may name, beyond another callable: a
 *  shape. A function holds no connections, no clients and no services — it can
 *  reach nothing through them, since `call()` gets no context to reach with. */
const TYPE_CAPABILITY = "Telo.Type";

/** Zone annotations a callable kind may not carry: a zone is established around
 *  a BODY the kernel dispatches, and a callable has none. */
const ZONE_ANNOTATIONS = [
  "x-telo-provides-zone",
  "x-telo-requires-zone",
  "x-telo-violates-zone",
] as const;

/** Method names CEL expands as macros on any receiver before a module call can
 *  resolve: `<Module>.map(1, 2)` is refused as a malformed `map` macro. */
const CEL_MACRO_METHOD_NAMES: ReadonlySet<string> = new Set([
  "all",
  "exists",
  "exists_one",
  "map",
  "filter",
  "bind",
]);

/** The template-body keys that make a kind a template. */
const TEMPLATE_BODY_KEYS = ["resources", "invoke", "run", "targets", "provide", "mount"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const SOURCE = "telo-analyzer";

/**
 * The pass: every callable declaration in the entry's own modules.
 *
 * Entry-module-scoped, the `X_TELO_REF_UNRESOLVED` rule — a published
 * dependency's kind is not the consumer's to fix, and the kernel's own refusal
 * at registration is what covers it there. That split is what
 * `tests/check-run-agreement.yaml` pins on both sides.
 *
 * Two shapes are walked. A KIND document answers for what it declares; an
 * INSTANCE of a callable kind answers for the signature it declares over its
 * kind's — which is `Telo.Function`, whose schema lists `params` / `returns` as
 * properties, and any other callable kind that chooses to.
 */
export function validateCallableDeclarations(
  manifests: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: ReadonlyMap<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const resolveDef: DefResolver = (kind, from) => {
    const scope = moduleAliasScope(
      from?.metadata,
      aliases,
      aliasesByModule as Map<string, AliasResolver>,
    );
    return registry.resolve(kind) ?? registry.resolve(scope.resolveKind(kind) ?? kind);
  };

  for (const m of manifests) {
    const ownModule = (m.metadata?.module as string | undefined) ?? undefined;
    if (ownModule && !rootModules.has(ownModule)) continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;

    const issues =
      m.kind === "Telo.Definition" || m.kind === "Telo.Abstract"
        ? callableKindIssues(m, resolveDef)
        : callableInstanceIssues(m, resolveDef);
    for (const issue of issues) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: issue.code,
        source: SOURCE,
        message: issue.message,
        data: {
          resource: { kind: m.kind, name },
          filePath: (m.metadata as { source?: string } | undefined)?.source,
          path: issue.path,
          ...(issue.fix ? { fix: issue.fix } : {}),
        },
      });
    }
  }

  return diagnostics;
}

/** An instance's own signature, checked only where its kind is a callable — a
 *  `params:` property on any other kind is that kind's own field and means
 *  whatever it says. Shared with the kernel, which refuses the same instances at
 *  creation. */
export function callableInstanceIssues(
  manifest: ResourceManifest,
  resolve: DefResolver,
): CallableKindIssue[] {
  const doc = manifest as unknown as Record<string, unknown>;
  const name = manifest.metadata?.name;
  const macroName = typeof name === "string" && CEL_MACRO_METHOD_NAMES.has(name);
  if (
    !macroName &&
    doc.params === undefined &&
    doc.returns === undefined &&
    doc.deterministic === undefined
  ) {
    return [];
  }
  const definition = resolve(manifest.kind, manifest as unknown as ResourceDefinition);
  if (!isCallableKind(definition, resolve)) return [];
  const issues: CallableKindIssue[] = [];
  if (macroName) {
    issues.push({
      code: "FUNCTION_NAME_RESERVED",
      path: "metadata.name",
      message:
        `${label(manifest)}: a function cannot be named '${name}'. CEL expands a call ` +
        `'<Module>.${name}(…)' as its own '${name}' macro before a module call resolves, so most ` +
        `calls to it do not parse. Rename the function.`,
    });
  }
  // A determinism claim is the implementer's, made once on the kind: an instance
  // is one configuration of that code and cannot make it more or less pure. A
  // kind whose closed schema already rejects the key reports it as a schema
  // violation, and one diagnostic is enough.
  const authorSchema = effectiveAuthorSchema(definition, resolve);
  const closedAgainstIt =
    authorSchema.additionalProperties === false &&
    !("deterministic" in (authorSchema.properties ?? {}));
  if (readDeterministic(doc) !== undefined && !closedAgainstIt) {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: "deterministic",
      message:
        `${label(manifest)}: declares \`deterministic\` on an instance of a function kind. The flag ` +
        `is a promise about the kind's code, made once on the \`Telo.Definition\` that supplies ` +
        `it — an instance is one configuration of that code and changes nothing about it. Drop ` +
        `the key.`,
    });
  }
  // Only the halves the kind's schema declares are a signature; anywhere else the
  // field is the kind's own configuration.
  const declared: Record<string, unknown> = {};
  for (const half of ["params", "returns"] as const) {
    if (doc[half] !== undefined && instanceDeclaresSignature(definition, resolve, half)) {
      declared[half] = doc[half];
    }
  }
  return [...issues, ...declaredSignatureIssues(declared)];
}

/**
 * Every issue a `Telo.Definition` / `Telo.Abstract` document carries about
 * callables — its own signature, the refusals a callable kind is subject to, and
 * the untyped-slot refusal, which applies to EVERY kind's slots rather than only
 * a callable's.
 */
export function callableKindIssues(
  definition: ResourceManifest,
  resolve: DefResolver,
): CallableKindIssue[] {
  const issues: CallableKindIssue[] = [];
  const def = definition as unknown as ResourceDefinition;
  const doc = definition as unknown as Record<string, unknown>;
  const schema = isObject(doc.schema) ? doc.schema : undefined;

  // A slot constrained to bare `Telo.Callable` accepts any function whatever its
  // signature, so a wrongly typed one passes `telo check` and fails at the first
  // call with `ERR_INPUT_INVALID`. Checked on every kind, because the slot is
  // declared by whoever HOLDS a function, which is usually not a callable.
  if (schema) issues.push(...untypedCallableSlotIssues(schema, "schema", def, resolve));

  const parent = resolveParent(def, resolve);
  // An `extends` naming nothing leaves an UNDECLARED capability unknowable here,
  // and the broken `extends` is what the author must fix; judging the kind as not
  // callable would stack a second, wrong diagnostic on the typo. A capability the
  // document states itself needs nothing from the chain.
  if (typeof doc.extends === "string" && !parent && doc.capability === undefined) {
    return [...issues, ...declaredSignatureIssues(doc)];
  }

  const callable = isCallableKind(def, resolve);
  const signatureIssues = declaredSignatureIssues(doc);
  // A signature on a kind that is not callable is read by nothing, so it is
  // reported where it is written rather than left to do nothing. A signature on
  // a callable is checked for its own well-formedness.
  if (!callable) {
    if (doc.params !== undefined || doc.returns !== undefined) {
      issues.push({
        code: "CALLABLE_DEFINITION_INVALID",
        path: doc.params !== undefined ? "params" : "returns",
        message:
          `${label(definition)}: declares a signature (\`params\` / \`returns\`) but its capability ` +
          `resolves to '${inheritedCapability(def, resolve) ?? "<none>"}', not '${CALLABLE_CAPABILITY}'. ` +
          `A signature is the call contract of a function; nothing reads one on any other capability. ` +
          `Declare \`capability: ${CALLABLE_CAPABILITY}\`, or drop the signature.`,
      });
    }
    if (readDeterministic(doc) !== undefined) {
      issues.push({
        code: "CALLABLE_DEFINITION_INVALID",
        path: "deterministic",
        message:
          `${label(definition)}: declares \`deterministic\` but its capability resolves to ` +
          `'${inheritedCapability(def, resolve) ?? "<none>"}', not '${CALLABLE_CAPABILITY}'. ` +
          `The flag states that a CALL's result depends only on its arguments; nothing reads it ` +
          `on a kind that is never called from CEL.`,
      });
    }
    return [...issues, ...signatureIssues];
  }

  issues.push(...signatureIssues);
  issues.push(...determinismIssues(definition, def, doc, resolve));
  issues.push(...inheritedSignatureIssues(definition, def, doc, resolve));

  // `extends: Telo.Function` — a body is a `Telo.Function`'s own declaration,
  // and a kind extending it would be a kind whose instances each carry a body,
  // which is the "half kind, half instance" document the design exists to
  // prevent. Its determinism is derived, so there is nothing for a child to add.
  if (parent && `${parent.metadata?.module}.${parent.metadata?.name}` === FUNCTION_KIND) {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: "extends",
      message:
        `${label(definition)}: extends '${FUNCTION_KIND}', which cannot be specialized. A ` +
        `${FUNCTION_KIND} IS a function — its body and its derived determinism belong to the ` +
        `instance, so there is nothing for a kind to inherit. Write a native function as a ` +
        `\`Telo.Definition\` with \`capability: ${CALLABLE_CAPABILITY}\` and its own \`controllers:\`, ` +
        `or declare a \`${FUNCTION_KIND}\` resource.`,
    });
  }

  if (doc.status !== undefined) {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: "status",
      message:
        `${label(definition)}: declares \`status:\`. Observed state is reported with ` +
        `\`ctx.setStatus()\` from a resource that has STARTED, and a callable never starts — it is ` +
        `evaluated inside a CEL expression, with no context to report through and no reading to ` +
        `publish. Drop the block.`,
    });
  }

  for (const key of TEMPLATE_BODY_KEYS) {
    if (doc[key] === undefined) continue;
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: key,
      message:
        `${label(definition)}: declares a template body (\`${key}:\`). A template dispatches a child ` +
        `resource's entry point, which is asynchronous and traced; a callable's \`call(args)\` is ` +
        `synchronous and receives no context, so there is nothing for a body to dispatch through. ` +
        `Write the function in CEL as a \`${FUNCTION_KIND}\`, or give this kind its own ` +
        `\`controllers:\`.`,
    });
  }

  if (schema) collectCallableSchemaIssues(definition, schema, "schema", resolve, issues);

  return issues;
}

/**
 * A child that inherits its controller and REDECLARES a signature.
 *
 * For an invocation contract this is `CONTRACT_MISSING_MAPPING`: the inherited
 * controller understands only its own shape, so the child bridges it with
 * `inputs:` / `result:`. A callable has no such bridge — there is no dispatch to
 * wrap, no arguments to remap and no result to translate, because `call(args)`
 * goes straight to the inherited instance. So a redeclared signature here is not
 * a missing mapping but a declaration that cannot be honoured at all.
 */
function inheritedSignatureIssues(
  definition: ResourceManifest,
  def: ResourceDefinition,
  doc: Record<string, unknown>,
  resolve: DefResolver,
): CallableKindIssue[] {
  if (definition.kind === "Telo.Abstract") return [];
  if (hasOwnControllerOrTemplate(def) || !isInheritedDelegation(def, resolve)) return [];
  const ancestor = controllerBearingAncestor(def, resolve);
  const ancestorKind = ancestor
    ? `${(ancestor.metadata as { module?: string } | undefined)?.module ?? ""}.${ancestor.metadata?.name ?? "?"}`.replace(/^\./, "")
    : "its ancestor";
  return (["params", "returns"] as const)
    .filter((half) => doc[half] !== undefined)
    .map((half) => ({
      code: "CALLABLE_DEFINITION_INVALID" as const,
      path: half,
      message:
        `${label(definition)}: declares \`${half}:\` but inherits the controller of ` +
        `'${ancestorKind}'. A callable has no \`inputs:\` / \`result:\` bridge — \`call(args)\` ` +
        `reaches the inherited instance directly — so there is no mapping that could make the ` +
        `replaced signature true. Give this kind its own \`controllers:\`, or drop \`${half}:\` to ` +
        `inherit the signature unchanged.`,
    }));
}

/** The kind's own label, as a diagnostic names it. */
function label(manifest: ResourceManifest): string {
  return `${manifest.kind}/${(manifest.metadata?.name as string | undefined) ?? "<unnamed>"}`;
}

/**
 * `deterministic` — the three ways the claim is written wrong.
 *
 * It is a PROMISE about code the runtime cannot inspect, so where it may be
 * written is what keeps it meaningful: a claim belongs to the kind that supplies
 * the implementation, a requirement to the abstract that demands one, and a body
 * function derives its own. Anywhere else it is a second source of truth for a
 * fact something already answers.
 */
function determinismIssues(
  definition: ResourceManifest,
  def: ResourceDefinition,
  doc: Record<string, unknown>,
  resolve: DefResolver,
): CallableKindIssue[] {
  const issues: CallableKindIssue[] = [];
  const declared = readDeterministic(doc);
  if (declared === undefined) return issues;

  if (typeof declared !== "boolean") {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: "deterministic",
      message:
        `${label(definition)}: \`deterministic: ${JSON.stringify(declared)}\` is not a boolean. It is ` +
        `a claim, not a level — anything else reads as "not deterministic", which silently ` +
        `falsifies every check that consults it.`,
    });
    return issues;
  }

  // On a `Telo.Definition` the flag is a CLAIM, and a claim is only the
  // implementer's to make: a child that inherits its controller inherits the
  // claim with it, and restating it there creates two places the same fact is
  // written. A kind with no controller at all has nothing to promise about.
  if (definition.kind !== "Telo.Abstract" && !hasOwnControllerOrTemplate(def)) {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: "deterministic",
      message:
        `${label(definition)}: declares \`deterministic\` but supplies no implementation of its own — ` +
        `it declares no \`controllers:\`. The flag is a promise about native code, so it is the ` +
        `implementer's to make: a child inheriting its controller inherits the claim and may not ` +
        `restate it, and an abstract that wants to REQUIRE determinism declares it as a ` +
        `\`Telo.Abstract\`. Drop the key.`,
    });
    return issues;
  }

  if (declared !== true) return issues;

  // A deterministic kind that HOLDS a function is only as deterministic as
  // whatever is wired into that slot. The slot's abstract is the only thing that
  // can bound it, so the claim stands exactly when the abstract requires it too.
  const schema = isObject(doc.schema) ? doc.schema : undefined;
  if (definition.kind !== "Telo.Abstract" && schema) {
    for (const [path, kinds] of callableSlotKinds(schema, "schema", def, resolve)) {
      const undetermined = kinds.filter((kind) => !requiresDeterminism(resolve(kind, def), resolve));
      if (undetermined.length === 0) continue;
      issues.push({
        code: "CALLABLE_DEFINITION_INVALID",
        path,
        message:
          `${label(definition)}: claims \`deterministic: true\` while holding a function at ` +
          `'${path}', whose constraint ${undetermined.map((k) => `'${k}'`).join(", ")} does not ` +
          `require determinism. Whatever is wired there decides this kind's result, so the claim ` +
          `would be falsified by a non-deterministic referent with nothing reporting it. Require ` +
          `\`deterministic: true\` on the abstract, or drop the claim.`,
      });
    }
  }

  return issues;
}

/**
 * The signature a document DECLARES — a kind's or an instance's, through one
 * implementation — checked for the two things a signature can say that no
 * consumer could act on.
 */
export function declaredSignatureIssues(doc: Record<string, unknown>): CallableKindIssue[] {
  const issues: CallableKindIssue[] = [];

  const params = readParams(doc);
  if (params) {
    let optionalSeen: string | undefined;
    params.forEach((param, index) => {
      issues.push(...typeSlotIssues(param, `params[${index}].schema`));
      const name = typeof param.name === "string" ? param.name : `#${index}`;
      if (param.optional === true) {
        optionalSeen ??= name;
        return;
      }
      if (optionalSeen === undefined) return;
      issues.push({
        code: "FUNCTION_OPTIONAL_NOT_TRAILING",
        path: `params[${index}]`,
        message:
          `Parameter '${name}' is required but follows the optional parameter '${optionalSeen}'. A ` +
          `call site is positional, so an omitted parameter can only ever be a trailing one — ` +
          `otherwise there is no way to supply '${name}' without also supplying '${optionalSeen}'. ` +
          `Move every optional parameter to the end of the list.`,
      });
    });
  }

  const returns = readReturns(doc);
  if (returns) issues.push(...typeSlotIssues(returns, "returns.schema"));

  return issues;
}

/** A `schema` written as a bare name. Telo has ONE reference grammar, and a
 *  string here is a shape the author meant to name — left as written it is an
 *  unconstrained JSON Schema keyword nothing reads, so every value would pass. */
function typeSlotIssues(
  slot: SignatureParam | SignatureResult,
  path: string,
): CallableKindIssue[] {
  if (typeof slot.schema !== "string" || slot.schema.length === 0) {
    return unresolvedShapeRefIssues(slot.schema, path);
  }
  return [
    {
      code: "FUNCTION_TYPE_NAME_FORM",
      path,
      message:
        `'${path}' names the shape '${slot.schema}' as a bare string. A named shape is referenced ` +
        `the one way every reference in Telo is written — \`!ref ${slot.schema}\` for this module's ` +
        `own \`Telo.JsonSchema\`, \`!ref <Alias>.${slot.schema}\` for an imported one. A bare string ` +
        `here is read as a JSON Schema that constrains nothing.`,
      ...(isRefSourceSpelling(slot.schema)
        ? { fix: { replacement: slot.schema, tag: "ref" as const } }
        : {}),
    },
  ];
}

/**
 * A `!ref` inside a signature shape, at the root or at any depth, that resolved
 * to nothing. Reference resolution leaves such a tag in place, and every reader
 * of the shape takes it as a node that constrains nothing — so the parameter
 * types open, a substitution check skips it, and a call through it would be
 * bound against a type no module declares.
 */
function unresolvedShapeRefIssues(schema: unknown, path: string): CallableKindIssue[] {
  return refSentinelsIn(schema, path).map(({ sentinel, path: at }) => ({
    code: "CONTRACT_TYPE_NOT_FOUND" as const,
    path: at,
    message:
      `'${at}' names the shape '${sentinel.source}' with \`!ref\`, and nothing by that name is ` +
      `declared in scope — a \`Telo.JsonSchema\` of this module, or one an import lists in its ` +
      `\`exports.resources\`. A shape that resolves to nothing constrains nothing, so every ` +
      `argument would pass. Declare the shape, or correct the name.`,
  }));
}

/**
 * Every node in a kind's schema that a callable cannot honour.
 *
 * One walk, because the answer to "what did this kind declare" is one traversal
 * and splitting it per annotation would visit the schema five times. The ref
 * slots are checked here too, against the one constraint a callable's slots
 * have: a function can hold another function or a shape, and nothing else,
 * because `call()` receives no context to reach anything through.
 */
function collectCallableSchemaIssues(
  definition: ResourceManifest,
  schema: Record<string, unknown>,
  path: string,
  resolve: DefResolver,
  issues: CallableKindIssue[],
): void {
  forEachSchemaNode(schema, path, (record, path, slot) => {
    collectNodeIssues(definition, record, path, slot, resolve, issues);
  });
}

function collectNodeIssues(
  definition: ResourceManifest,
  record: Record<string, unknown>,
  path: string,
  slot: RefSlot | undefined,
  resolve: DefResolver,
  issues: CallableKindIssue[],
): void {
  if (record["x-telo-eval"] === "runtime") {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: `${path}.x-telo-eval`,
      message:
        `${label(definition)}: declares \`x-telo-eval: runtime\` at '${path}'. A runtime-eval field ` +
        `is expanded per invocation, against the arguments and ambient scope of a dispatch — and a ` +
        `callable is never dispatched, so nothing would ever expand it. A callable's configuration ` +
        `is fixed at \`create()\`; use \`x-telo-eval: compile\`.`,
    });
  }

  for (const annotation of ZONE_ANNOTATIONS) {
    if (record[annotation] === undefined) continue;
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: `${path}.${annotation}`,
      message:
        `${label(definition)}: declares \`${annotation}\` at '${path}'. An execution zone rides the ` +
        `ambient invocation context, and \`call(args)\` receives no context at all — so a zone can ` +
        `neither be established around a call nor be found from inside one. Drop the annotation.`,
    });
  }

  if (record["x-telo-scope"] !== undefined) {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path: `${path}.x-telo-scope`,
      message:
        `${label(definition)}: declares \`x-telo-scope\` at '${path}'. A scope's resources are stood ` +
        `up on demand around a dispatch and torn down when it ends; a callable has no dispatch to ` +
        `hang that lifetime on. Declare the resources at module level and hold them by reference.`,
    });
  }

  if (readStepSlot(record)) {
    issues.push({
      code: "CALLABLE_DEFINITION_INVALID",
      path,
      message:
        `${label(definition)}: declares a step body at '${path}'. The step grammar invokes resources ` +
        `and awaits them; a callable is evaluated synchronously inside a CEL expression and can ` +
        `await nothing. Write the logic in CEL as a \`${FUNCTION_KIND}\`, or keep it in this kind's ` +
        `own controller.`,
    });
  }

  if (slot) {
    for (const kind of slot.kinds) {
      if (kind === CALLABLE_CAPABILITY) continue; // X_TELO_REF_CALLABLE_UNTYPED owns it.
      const target = resolve(kind, definition as unknown as ResourceDefinition);
      // A constraint that resolves to nothing says nothing: `X_TELO_REF_UNRESOLVED`
      // is what reports it, and guessing here would refuse a correct slot.
      if (!target) continue;
      const capability = constraintCapability(kind, target, resolve);
      if (capability === CALLABLE_CAPABILITY || capability === TYPE_CAPABILITY) continue;
      issues.push({
        code: "CALLABLE_DEFINITION_INVALID",
        path,
        message:
          `${label(definition)}: holds '${kind}' at '${path}', whose capability is ` +
          `'${capability}'. A callable's \`call(args)\` receives no context — no cancellation, no ` +
          `zone, no trace and nothing to await — so it can do nothing with a held resource. A ` +
          `callable kind's reference slots may name only another callable or a ` +
          `'${TYPE_CAPABILITY}'.`,
      });
    }
  }
}

/**
 * The capability a slot constraint names. A kind whose chain declares none IS a
 * capability abstract — `Telo.Type`, `Telo.Callable`, `Telo.Executable` — so the
 * constraint names that capability itself: the reading `isRunOnlySlot` takes.
 */
function constraintCapability(
  kind: string,
  target: ResourceDefinition,
  resolve: DefResolver,
): string {
  return inheritedCapability(target, resolve) ?? kind;
}

/**
 * Visit every node of a kind's own schema, with the reference slot it declares.
 *
 * Two things are NOT descended, both because descending reports a declaration
 * nobody wrote at that node:
 *
 *  - an annotation's own value (`x-telo-*`), which holds vocabulary rather than
 *    schema;
 *  - the reserved `$defs/telo:<Fragment>` entries that fragment expansion hoists
 *    — the shared step grammar's own `invoke:` slot among them. A kind pointing
 *    at a fragment is reported where it pointed, not inside the analyzer's copy.
 *
 * A slot's `anyOf` / `oneOf` branches are claimed by the node that holds them,
 * so a multi-branch slot is visited as ONE slot rather than once per branch —
 * the `validate-ref-slots.ts` rule.
 */
function forEachSchemaNode(
  schema: Record<string, unknown>,
  path: string,
  visit: (record: Record<string, unknown>, path: string, slot: RefSlot | undefined) => void,
): void {
  const seen = new Set<object>();
  const claimed = new Set<object>();
  const walk = (node: unknown, at: string): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    const record = node as Record<string, unknown>;
    const slot = claimed.has(record) ? undefined : readRefSlot(record);
    if (slot) {
      for (const key of ["anyOf", "oneOf"] as const) {
        const branches = record[key];
        if (!Array.isArray(branches)) continue;
        for (const branch of branches) if (branch && typeof branch === "object") claimed.add(branch);
      }
    }
    visit(record, at, slot);
    for (const [key, child] of Object.entries(record)) {
      if (key.startsWith("x-telo-")) continue;
      if (key === "$defs" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [name, def] of Object.entries(child as Record<string, unknown>)) {
          if (!isHoistedFragmentDefKey(name)) walk(def, `${at}.$defs.${name}`);
        }
        continue;
      }
      walk(child, at ? `${at}.${key}` : key);
    }
  };
  walk(schema, path);
}

/** The callable kinds each reference slot of a schema accepts, by path — the
 *  input to the determinism-over-a-slot rule. */
function callableSlotKinds(
  schema: Record<string, unknown>,
  path: string,
  from: ResourceDefinition,
  resolve: DefResolver,
): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  forEachSchemaNode(schema, path, (_record, at, slot) => {
    if (!slot) return;
    // A bare `Telo.Callable` constraint is `X_TELO_REF_CALLABLE_UNTYPED`'s; it
    // is left out here so one wrong slot is not reported twice.
    const callableKinds = slot.kinds.filter((kind) => {
      if (kind === CALLABLE_CAPABILITY) return false;
      const target = resolve(kind, from);
      return !!target && constraintCapability(kind, target, resolve) === CALLABLE_CAPABILITY;
    });
    if (callableKinds.length > 0) out.push([at, callableKinds]);
  });
  return out;
}
