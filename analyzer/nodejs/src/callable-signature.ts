/**
 * **The callable signature's single reader** — `params`, `returns` and
 * `deterministic`, in whichever document declares them.
 *
 * A function is a resource of the `Telo.Callable` capability, so everything
 * about its lifecycle is the ordinary resource lifecycle; what is new is the
 * signature, and the signature is read here and nowhere else. Four surfaces ask
 * about it — the strict half (`validate-callable-kinds.ts`), the substitution
 * check (`validate-invocation-contract.ts`), the CEL context a body is typed
 * against (`validate-cel-context.ts`), and the kernel's definition registration
 * — which is the `ref-slot.ts` precedent, and the reason none of them
 * pattern-matches the shape again.
 *
 * **Layering follows the invocation contract**: declared on the kind, and on an
 * instance only where the kind's schema lists these as properties (as
 * `Telo.Function`'s does). Resolution goes instance, then the nearest
 * declaration along `extends`, and REPLACES rather than merges — one rule for
 * both declaration forms rather than one per form, which is why the resolver is
 * `effectiveContractField` rather than a second walk written here.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import {
  ancestorChain,
  contractDeclarer,
  type DefResolver,
  effectiveAuthorSchema,
  effectiveContractField,
  inheritedCapability,
} from "./extends-resolution.js";

/** The capability whose entry point is a synchronous `call(args)`. */
export const CALLABLE_CAPABILITY = "Telo.Callable";

/** The built-in callable kind for a function written in CEL. */
export const FUNCTION_KIND = "Telo.Function";

/** One declared parameter. Every field is read leniently — the strict half is
 *  what reports a malformed one, exactly as `readRefSlot` leaves an
 *  unrecognized `use` token for `validate-ref-slots.ts`. */
export interface SignatureParam {
  readonly name?: unknown;
  readonly schema?: unknown;
  readonly description?: unknown;
  readonly nullable?: unknown;
  readonly optional?: unknown;
}

/** The declared result. */
export interface SignatureResult {
  readonly schema?: unknown;
  readonly description?: unknown;
  readonly nullable?: unknown;
}

/** A callable's signature as it resolves at one declaration — each half
 *  independently, because each replaces its ancestor's independently. */
export interface CallableSignature {
  readonly params?: readonly SignatureParam[];
  readonly returns?: SignatureResult;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The parameter list a document declares, or undefined when it declares none.
 *  An empty list is a DECLARATION (this callable takes no arguments) and is
 *  distinct from undefined (this document says nothing). */
export function readParams(doc: unknown): readonly SignatureParam[] | undefined {
  if (!isObject(doc)) return undefined;
  const raw = doc.params;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((entry) => (isObject(entry) ? (entry as SignatureParam) : {}));
}

/** The result a document declares, or undefined. */
export function readReturns(doc: unknown): SignatureResult | undefined {
  if (!isObject(doc)) return undefined;
  const raw = doc.returns;
  return isObject(raw) ? (raw as SignatureResult) : undefined;
}

/** The determinism value as WRITTEN — raw, so the strict half can report a
 *  non-boolean rather than silently reading it as absent. */
export function readDeterministic(doc: unknown): unknown {
  return isObject(doc) ? doc.deterministic : undefined;
}

/** True when the document CLAIMS determinism. Anything but `true` is false —
 *  absent means false, and a non-boolean is reported, never interpreted. */
export function claimsDeterministic(doc: unknown): boolean {
  return readDeterministic(doc) === true;
}

/** True when a slot constraint guarantees a deterministic referent: the kind or
 *  an ancestor declares `deterministic: true`. A requirement written on an
 *  abstract binds every kind below it, however many abstracts sit between. */
export function requiresDeterminism(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): boolean {
  if (!def) return false;
  if (claimsDeterministic(def)) return true;
  return ancestorChain(def, resolve).some((ancestor) => claimsDeterministic(ancestor));
}

/** True when a kind's capability resolves to `Telo.Callable` along `extends`.
 *  A child that omits `capability:` inherits it, so the test is the resolved
 *  one — never the declared string. */
export function isCallableKind(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): boolean {
  return inheritedCapability(def, resolve) === CALLABLE_CAPABILITY;
}

/**
 * The signature in force for an instance of `definition`, layered exactly as an
 * invocation contract is: the instance's own declaration, then the nearest along
 * `extends`, replacing rather than merging.
 *
 * `manifest` is omitted when the question is about the KIND itself.
 */
export function resolveSignature(
  manifest: ResourceManifest | undefined,
  definition: ResourceDefinition | undefined,
  resolve: DefResolver,
): CallableSignature {
  const ownParams = instanceDeclaresSignature(definition, resolve, "params")
    ? readParams(manifest)
    : undefined;
  const ownReturns = instanceDeclaresSignature(definition, resolve, "returns")
    ? readReturns(manifest)
    : undefined;
  return {
    params:
      ownParams ??
      (effectiveContractField(definition, resolve, "params") as
        | readonly SignatureParam[]
        | undefined),
    returns:
      ownReturns ??
      (effectiveContractField(definition, resolve, "returns") as SignatureResult | undefined),
  };
}

/**
 * Whether an INSTANCE of `definition` may declare this half of the signature: its
 * kind's author schema lists the field as a property, as `Telo.Function`'s does.
 * Anywhere else a `params:` / `returns:` on an instance is the kind's own
 * configuration, and reading it as a signature would let config replace the
 * contract every caller is checked against.
 */
export function instanceDeclaresSignature(
  definition: ResourceDefinition | undefined,
  resolve: DefResolver,
  half: "params" | "returns",
): boolean {
  const properties = effectiveAuthorSchema(definition, resolve)?.properties;
  return !!properties && typeof properties === "object" && half in properties;
}

/** The definition in the `extends` chain (self first) that DECLARES this half of
 *  the signature — the scope its named shapes resolved in, and what a diagnostic
 *  should name. */
export function signatureDeclarer(
  definition: ResourceDefinition | undefined,
  resolve: DefResolver,
  half: "params" | "returns",
): ResourceDefinition | undefined {
  return contractDeclarer(definition, resolve, half);
}

/**
 * The JSON Schema a signature slot declares, with `nullable: true` folded in.
 *
 * `nullable` is shorthand for a union with `{type: "null"}` — for an argument
 * that genuinely IS null, as opposed to `optional`, which is about omission. It
 * is folded HERE so every consumer compares, types and validates the same node;
 * a consumer reading `schema` raw would silently drop the widening.
 */
export function signatureSchemaOf(
  slot: SignatureParam | SignatureResult | undefined,
): Record<string, any> | undefined {
  if (!slot) return undefined;
  const schema = slot.schema;
  if (!isObject(schema)) return undefined;
  return slot.nullable === true ? withNull(schema as Record<string, any>) : (schema as Record<string, any>);
}

/** A schema widened to admit `null`. A single declared `type` widens in place
 *  (`["object", "null"]`), which keeps the node's `properties` readable by every
 *  member-access and null-guard walk; anything else becomes a union. */
function withNull(schema: Record<string, any>): Record<string, any> {
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

/** On a CEL field whose value IS a callable's result: names the root field
 *  holding the result declaration it must satisfy. */
export const RETURNS_FROM_ANNOTATION = "x-telo-returns-from";

/**
 * The field a callable kind computes its result from — the one its author-facing
 * schema annotates {@link RETURNS_FROM_ANNOTATION} — or undefined when it has
 * none, which is what makes an instance of it NATIVE: its result comes from its
 * controller's code rather than from an expression in the manifest.
 */
export function callableBodyField(
  definition: ResourceDefinition | undefined,
  resolve: DefResolver,
): string | undefined {
  const properties = effectiveAuthorSchema(definition, resolve)?.properties as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  for (const [field, schema] of Object.entries(properties ?? {})) {
    if (typeof schema?.[RETURNS_FROM_ANNOTATION] === "string") return field;
  }
  return undefined;
}

/**
 * The schema the value of a field annotated {@link RETURNS_FROM_ANNOTATION} must
 * satisfy — the result declared at the named field of `manifestRoot`, nullable
 * folded in — or undefined when the field carries no annotation or nothing
 * declares a result there.
 */
export function declaredResultSchemaAt(
  slotSchema: Record<string, any> | undefined,
  manifestRoot: unknown,
  resolveSchema?: (schema: Record<string, any>) => Record<string, any> | undefined,
): Record<string, any> | undefined {
  const field = slotSchema?.[RETURNS_FROM_ANNOTATION];
  if (typeof field !== "string" || field.length === 0) return undefined;
  let declared: unknown = manifestRoot;
  for (const segment of field.split("/")) {
    declared = isObject(declared) ? declared[segment] : undefined;
  }
  const result = readReturns({ returns: declared });
  if (!result || !isObject(result.schema)) return undefined;
  const schema = result.schema as Record<string, any>;
  return signatureSchemaOf({ ...result, schema: resolveSchema?.(schema) ?? schema });
}

/**
 * The CEL context properties a parameter list contributes — `name → schema`,
 * nullable folded in.
 *
 * A parameter with no usable schema contributes an OPEN node rather than
 * nothing: the parameter plainly exists, and withholding it would report every
 * read of it as an unknown identifier, blaming the body for the signature's
 * omission.
 */
export function parameterContextProperties(
  params: readonly SignatureParam[] | undefined,
  /** Sees through a parameter typed by a named shape (`schema: !ref Money`), at
   *  the root and at any depth, so its members type rather than reading as one
   *  opaque reference node. The caller supplies it because only the caller holds
   *  the shapes in scope. */
  resolveSchema?: (schema: Record<string, any>) => Record<string, any> | undefined,
): Record<string, any> {
  const properties: Record<string, any> = {};
  for (const param of params ?? []) {
    if (typeof param.name !== "string" || param.name.length === 0) continue;
    properties[param.name] = parameterSchemaOf(param, resolveSchema) ?? {};
  }
  return properties;
}

/**
 * The schema a body reads one parameter as.
 *
 * An OPTIONAL parameter with no `default` reads as `null` when a call omits it,
 * so it is nullable inside the body whatever its schema says — a member read off
 * it unguarded is exactly the failure that shape invites. One with a default
 * always holds a value.
 */
export function parameterSchemaOf(
  param: SignatureParam,
  resolveSchema?: (schema: Record<string, any>) => Record<string, any> | undefined,
): Record<string, any> | undefined {
  const declared = isObject(param.schema) ? (param.schema as Record<string, any>) : undefined;
  const resolved = declared ? (resolveSchema?.(declared) ?? declared) : undefined;
  const omittedReadsNull = param.optional === true && !(resolved && "default" in resolved);
  return signatureSchemaOf({
    ...param,
    schema: resolved,
    ...(omittedReadsNull ? { nullable: true } : {}),
  });
}
