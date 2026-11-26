/**
 * **Does an expression fit the slot it flows into?** The engine typed the
 * expression during the CEL walk, recording where its value may come from (its
 * origins, `cel-slot-origin.ts`), and the schema walk recorded the slot. Each
 * origin is fitted in written order and the first that cannot be what the slot
 * takes is the finding: an optional at any depth is never a field's value, a
 * null where the slot takes none needs a guard or a value, a value read from a
 * schema node is judged by comparing that node with the slot's schema, and one
 * with no node by its CEL type.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { readValueTypeSlot } from "@telorun/sdk";
import { admitsNull, formatType, withoutNull as withoutNullType, type CelType } from "@telorun/cel";
import type { CelValueSlot } from "./analyzer.js";
import { accessorFormatMisfit } from "./accessor-format-fit.js";
import { declaredResultSchemaAt, RETURNS_FROM_ANNOTATION } from "./callable-signature.js";
import type { CelSiteFacts } from "./cel-judge.js";
import { producedValueMisfits } from "./cel-produced-value.js";
import { holdsOptional, type SlotOrigin } from "./cel-slot-origin.js";
import {
  alsoAccepts,
  describeHostEntry,
  holdsHostPath,
  holdsOnlyConstants,
  HOST_PATH_SOURCES,
  hostEntryAt,
  hostMediaTypeAt,
  hostPathBranchesFor,
  leadingRelativeLiteral,
} from "./host-path-slot.js";
import { withoutNull } from "./output-to-slot.js";
import { withQuotedPath } from "./quoted-place.js";
import { shapeNamedBy } from "./referenced-shape.js";
import {
  celTypeIsText,
  celValueTypeSatisfiesJsonSchema,
  checkSchemaCompatibility,
  unionBranches,
  type ExternalSchemaResolver,
} from "./schema-compat.js";
import { producerAdmitsNull, slotAdmitsNull } from "./schema-nullability.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

// The two halves of "does this expression fit the slot it flows into" meet
// here: the engine resolved the expression's type during the walk above,
// and the schema walk recorded the slot. An expression that failed to check
// recorded no type and is already reported by its own diagnostic.
export function judgeSlotWith(
  slot: JoinSlot,
  facts: CelSiteFacts,
  expression: string,
  namedShape: ExternalSchemaResolver,
): AnalysisDiagnostic | undefined {
  const found = slotFinding(slot, facts, expression, namedShape);
  return found && withQuotedPath(found, slot.path);
}

function slotFinding(
  slot: JoinSlot,
  facts: CelSiteFacts,
  expression: string,
  namedShape: ExternalSchemaResolver,
): AnalysisDiagnostic | undefined {
  const type = facts.type;
  if (facts.checkedType === undefined && facts.origins === undefined) return undefined;
  // A field whose value IS a callable's result is held to the declared
  // result rather than to its own schema, which cannot know it. The declared
  // result is a document of its own.
  const result = declaredResultSchemaAt(slot.schema, slot.manifest, (schema) =>
    shapeNamedBy(schema, schema, namedShape),
  );
  const fit: SlotFit = {
    slot,
    target: result ?? slot.schema,
    result,
    literal: facts.literal,
    whole: expression.trim(),
    namedShape,
  };
  // Each place the value may come from is fitted in written order; the first
  // that cannot be what the slot takes is the finding.
  const origins: readonly SlotOrigin[] = facts.origins ?? [
    {
      text: fit.whole,
      typeName: type!,
      ...(facts.checkedType ? { type: facts.checkedType } : {}),
      ...(facts.produced ? { node: facts.produced } : {}),
    },
  ];
  for (const origin of origins) {
    const found = originMisfit(fit, origin);
    if (found) return found;
  }
  return undefined;
}

/** One slot as the fit of each origin reads it. */
interface SlotFit {
  readonly slot: JoinSlot;
  /** What the value must be: the slot's schema, or the callable result it declares. */
  readonly target: Record<string, any>;
  readonly result: Record<string, any> | undefined;
  readonly literal: string | undefined;
  /** The whole expression as written. */
  readonly whole: string;
  readonly namedShape: ExternalSchemaResolver;
}

const PLAIN_CHAIN_TEXT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Why `origin` cannot be what the slot takes: an optional at any depth is
 * never a field's value; a null where the slot takes none needs a guard when
 * the rest of the value fits, and is a type mismatch when the value is only
 * null or the rest does not fit either; otherwise the value is judged by the
 * schema node it is an instance of, or by its CEL type.
 */
function originMisfit(fit: SlotFit, origin: SlotOrigin): AnalysisDiagnostic | undefined {
  const { slot, target, result } = fit;
  const data = { resource: slot.resource, filePath: slot.filePath, path: slot.path };
  const holder = slot.callTarget !== undefined ? `${slot.callTarget}'s declared inputType` : "the field";
  const code = result ? "FUNCTION_RETURN_MISMATCH" : "CEL_TYPE_ERROR";
  const from = origin.text === fit.whole ? "" : ` from '${origin.text}'`;
  const expects = result ? `'${slot.schema[RETURNS_FROM_ANNOTATION]}' declares` : `${holder} expects`;
  const expected = describeSlotType(target);
  const at = `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}'`;
  if (origin.type !== undefined && holdsOptional(origin.type)) {
    return {
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message:
        `${at} produces '${origin.typeName}'${from}, which holds an optional, but ${expects} ` +
        `'${expected}' and no field holds one. Unwrap it with '.orValue(<a default>)', or ` +
        `'.value()' where it is known to be present.`,
      data,
    };
  }
  // Where the engine reads the node's null, its type says whether a guard
  // proved it absent here; `nullable: true` only the node says.
  const node = origin.node;
  const nullable =
    origin.type !== undefined && (!node || producerAdmitsNull({ ...node, nullable: false }))
      ? admitsNull(origin.type)
      : node !== undefined && producerAdmitsNull(node);
  if (!nullable && node && producerAdmitsNull(node)) {
    const proved = nonNullNode(node);
    return valueMisfit(fit, proved ? { ...origin, node: proved } : origin);
  }
  if (!nullable || slot.accessorTemplate || slotAdmitsNull(target)) return valueMisfit(fit, origin);
  const restNode = node ? nonNullNode(node) : undefined;
  const restType = origin.type !== undefined ? withoutNullType(origin.type) : undefined;
  const onlyNull = node
    ? restNode === undefined || isNullOnlySchema(restNode)
    : restType !== undefined && isNullType(restType);
  if (onlyNull) {
    return {
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message: `${at} returns 'null'${from} but ${expects} '${expected}'.`,
      data,
    };
  }
  const rest: SlotOrigin = {
    text: origin.text,
    typeName: restType !== undefined ? formatType(restType, true) : origin.typeName,
    ...(restType !== undefined ? { type: restType } : {}),
    ...(origin.rootType !== undefined ? { rootType: origin.rootType } : {}),
    ...(restNode ? { node: restNode } : {}),
    ...(origin.composed ? { composed: origin.composed } : {}),
  };
  const misfit = valueMisfit(fit, rest);
  if (misfit) return misfit;
  return {
    severity: DiagnosticSeverity.Error,
    code,
    source: SOURCE,
    message: PLAIN_CHAIN_TEXT.test(origin.text)
      ? `${at} reads '${origin.text}', which may be null, but ${expects} '${expected}', which does ` +
        `not admit null. Guard it: '${origin.text} != null ? ${origin.text} : <a value for the null case>'.`
      : `${at} produces '${origin.text}', which may be null, but ${expects} '${expected}', which does ` +
        `not admit null, so the null case needs a value.`,
    data,
  };
}

/** `node` with null taken out of every way it admits one; undefined when only null is left. */
function nonNullNode(node: Record<string, any>): Record<string, any> | undefined {
  const rest = withoutNull(node);
  if (!rest) return undefined;
  const { nullable: _nullable, ...out } = rest;
  if (Array.isArray(out.enum) && out.enum.includes(null)) {
    const values = out.enum.filter((value: unknown) => value !== null);
    if (values.length === 0) return undefined;
    out.enum = values;
  }
  return out;
}

function isNullType(type: CelType): boolean {
  return type.kind === "primitive" && type.name === "null";
}

/** A schema whose only value is null. */
function isNullOnlySchema(schema: Record<string, any>): boolean {
  return (
    schema.type === "null" ||
    ("const" in schema && schema.const === null) ||
    (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value: unknown) => value === null))
  );
}

/** Why the non-null value `origin` cannot be what the slot takes. */
function valueMisfit(fit: SlotFit, origin: SlotOrigin): AnalysisDiagnostic | undefined {
  const { slot, target, result, namedShape } = fit;
  const type = origin.typeName;
  const expression = origin.text;
  const from = origin.text === fit.whole ? "" : ` from '${origin.text}'`;
  const data = { resource: slot.resource, filePath: slot.filePath, path: slot.path };
  // Whether the value is text, read from its type — a navigated forward's included, whose
  // fit its node judges.
  const rootType = origin.type ?? origin.rootType;
  const text = rootType !== undefined && celTypeIsText(rootType);
  // What declares the slot, as a message names it.
  const holder =
    slot.callTarget !== undefined ? `${slot.callTarget}'s declared inputType` : "the field";
  const hostPath = holdsHostPath(target);
  // A value read straight from a schema node is judged by that node below;
  // only a value with no node is judged by its CEL type — the engine's type, a
  // union fitting where every member does, whose null the fit above has decided.
  const judgedTarget = hostPath ? hostPathBranchesFor(target, fit.literal, undefined) : target;
  const fits =
    origin.node !== undefined ||
    // With neither a node nor a type, nothing says what the value is.
    origin.type === undefined ||
    celValueTypeSatisfiesJsonSchema(withoutNullType(origin.type), judgedTarget);
  // Text that is not a host path is the host-path finding; a value that is
  // not text at all is an ordinary type mismatch.
  if (!fits && hostPath && text) {
    const leading = leadingRelativeLiteral(expression, target);
    return {
      severity: DiagnosticSeverity.Error,
      code: leading !== undefined ? "HOST_PATH_RELATIVE" : "HOST_PATH_UNTYPED_SOURCE",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' is a Telo.HostPath, but ` +
        (leading !== undefined
          ? `this expression builds a path starting with '${leading}', which is relative.`
          : `this expression produces a plain '${type}'.`) +
        ` ${HOST_PATH_SOURCES}${alsoAccepts(target)}`,
      data,
    };
  }
  if (!fits) {
    const expected = describeSlotType(target);
    return result
      ? {
          severity: DiagnosticSeverity.Error,
          code: "FUNCTION_RETURN_MISMATCH",
          source: SOURCE,
          message: `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' returns '${type}'${from} but '${slot.schema[RETURNS_FROM_ANNOTATION]}' declares '${expected}'.`,
          data,
        }
      : {
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ERROR",
          source: SOURCE,
          message: `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' returns '${type}'${from} but ${holder} expects '${expected}'.`,
          data,
        };
  }
  // The type fits; do its ARGUMENTS agree? Covariant and gradual — an
  // omitted argument is *any* in both directions, so an unmigrated producer
  // or consumer is never reported, and only a definite conflict is.
  // A string that STARTS with relative text is relative whatever follows it
  // — `'data/' + variables.name` — which the expression's text alone decides.
  const leading = holdsHostPath(target)
    ? leadingRelativeLiteral(expression, target)
    : undefined;
  if (leading !== undefined) {
    return {
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_RELATIVE",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' is a Telo.HostPath, but ` +
        `this expression builds a path starting with '${leading}', which is relative. ` +
        `${HOST_PATH_SOURCES}${alsoAccepts(target)}`,
      data,
    };
  }
  const produced = origin.node;
  const formatMisfit = slot.accessorTemplate && produced ? accessorFormatMisfit(target, produced, namedShape) : undefined;
  if (formatMisfit) {
    return {
      severity: DiagnosticSeverity.Error,
      code: "CEL_TYPE_ERROR",
      source: SOURCE,
      message: `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}': '${expression.trim()}' ${formatMisfit}.`,
      data,
    };
  }
  if (!produced) {
    const composed = origin.composed;
    if (!composed) return undefined;
    const misfits = producedValueMisfits(composed, target, namedShape);
    if (misfits.length === 0) return undefined;
    const reasons = misfits.map((conflict) => conflict.message).join("; ");
    return result
      ? {
          severity: DiagnosticSeverity.Error,
          code: "FUNCTION_RETURN_MISMATCH",
          source: SOURCE,
          message:
            `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
            `that disagrees with '${slot.schema[RETURNS_FROM_ANNOTATION]}': ${reasons}.`,
          data,
        }
      : misfits.every((conflict) => conflict.beneathTypeArgument)
        ? {
            severity: DiagnosticSeverity.Error,
            code: "CEL_TYPE_ARGUMENT_MISMATCH",
            source: SOURCE,
            message:
              `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
              `whose type arguments disagree with ${
                slot.callTarget !== undefined ? holder : "the field's"
              }: ${reasons}.`,
            data,
          }
        : {
            severity: DiagnosticSeverity.Error,
            code: "CEL_TYPE_ERROR",
            source: SOURCE,
            message:
              `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
              `that does not fit what ${holder} expects: ${reasons}.`,
            data,
          };
  }
  // A host path forwarded from a source DECLARED as something else — a
  // plain `type: string` field or variable — carries whatever relative text
  // it was given, and is refused at creation for every consumer. The source
  // is what must say what it holds. An undeclared source (an open result)
  // says nothing either way and is left to the runtime.
  // A source declared as something other than text is an ordinary misfit,
  // judged by the comparison below.
  if (
    holdsHostPath(target) &&
    !holdsHostPath(produced) &&
    !holdsOnlyConstants(target, undefined, produced) &&
    (text || unionBranches(produced) !== undefined)
  ) {
    return {
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_UNTYPED_SOURCE",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' is a Telo.HostPath, but ` +
        `the value it reads is declared '${produced["x-telo-type"] ?? produced.type ?? "a union with no host-path branch"}', so a ` +
        `relative path reaches it unresolved and is refused when the resource is created. ` +
        `Declare the source 'x-telo-type: Telo.HostPath' — a variable resolves a relative ` +
        `value against the working directory; any other source must already hold an ` +
        `absolute one.${alsoAccepts(target)}`,
      data,
    };
  }
  // A host path declared to name one kind of entry, read where the other is
  // wanted, is refused by what it names; at a call site the generic argument
  // comparison below reports it as the call's argument mismatch.
  if (slot.callTarget === undefined && holdsHostPath(target) && holdsHostPath(produced)) {
    const wanted = hostEntryAt(target);
    const declared = hostEntryAt(produced);
    if (wanted !== undefined && declared !== undefined && wanted !== declared) {
      return {
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_ENTRY_MISMATCH",
        source: SOURCE,
        message:
          `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' takes the path of ` +
          `${describeHostEntry(wanted)}, but '${expression.trim()}' is declared to name ` +
          `${describeHostEntry(declared)} (entry: ${declared}).`,
        data,
      };
    }
    const wantedMedia = hostMediaTypeAt(target);
    const declaredMedia = hostMediaTypeAt(produced);
    if (wantedMedia !== undefined && declaredMedia !== undefined && wantedMedia !== declaredMedia) {
      return {
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_CONTENT_MISMATCH",
        source: SOURCE,
        message:
          `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' takes a file of ${wantedMedia}, ` +
          `but '${expression.trim()}' is declared to hold ${declaredMedia} (mediaType: ${declaredMedia}).`,
        data,
      };
    }
  }
  const { compatible, issues, conflicts } = nodeCompatibility(produced, target, namedShape);
  if (compatible) return undefined;
  return result
    ? {
        severity: DiagnosticSeverity.Error,
        code: "FUNCTION_RETURN_MISMATCH",
        source: SOURCE,
        message:
          `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
          `whose declared shape disagrees with '${slot.schema[RETURNS_FROM_ANNOTATION]}': ${issues.join("; ")}.`,
        data,
      }
    : conflicts.every((conflict) => conflict.beneathTypeArgument)
      ? {
          // Every conflict sits beneath a type argument of a value type
          // both sides name; one outside makes it a shape misfit.
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ARGUMENT_MISMATCH",
          source: SOURCE,
          message:
            `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
            `whose type arguments disagree with ${
              slot.callTarget !== undefined ? holder : "the field's"
            }: ${issues.join("; ")}.`,
          data,
        }
      : {
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ERROR",
          source: SOURCE,
          message: nodeMisfitMessage(
            `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' ` +
              `${PLAIN_CHAIN_TEXT.test(expression) ? "reads" : "produces"} '${expression.trim()}'`,
            holder,
            issues,
          ),
          data,
        };
}

/** A compared node's issue as the comparison words it: `<pointer>: <reason>`. */
const COMPARISON_ISSUE = /^(\/\S*): ([\s\S]*)$/;
const ROOT_TYPE_MISMATCH = /^type mismatch — source is '([^']*)', target expects '([^']*)'$/;

/**
 * A located origin's misfit: at the compared node itself, what it is declared
 * and what the slot expects; deeper, each issue at its pointer. A bare root
 * pointer is never shown.
 */
function nodeMisfitMessage(read: string, holder: string, issues: readonly string[]): string {
  const parsed = issues.map((issue) => {
    const match = COMPARISON_ISSUE.exec(issue);
    return match ? { pointer: match[1]!, reason: match[2]! } : { pointer: "/", reason: issue };
  });
  const root = parsed.length === 1 && parsed[0]!.pointer === "/" ? ROOT_TYPE_MISMATCH.exec(parsed[0]!.reason) : null;
  if (root) return `${read}, declared '${root[1]}', but ${holder} expects '${root[2]}'.`;
  const reasons = parsed.map(({ pointer, reason }) => (pointer === "/" ? reason : `at '${pointer}': ${reason}`));
  return `${read}, whose declared shape does not fit what ${holder} expects${parsed[0]!.pointer === "/" ? ":" : ""} ${reasons.join("; ")}.`;
}


/** A node's fit to a slot's schema, memoised by the pair under the shape
 *  lookup that reads both: one node meets one slot once however many sites
 *  forward it. */
type Compatibility = ReturnType<typeof checkSchemaCompatibility>;
const nodeCompatibilityMemo = new WeakMap<object, WeakMap<object, WeakMap<object, Compatibility>>>();
function nodeCompatibility(
  node: Record<string, any>,
  target: Record<string, any>,
  namedShape: ExternalSchemaResolver,
): Compatibility {
  let byNode = nodeCompatibilityMemo.get(namedShape);
  if (!byNode) nodeCompatibilityMemo.set(namedShape, (byNode = new WeakMap()));
  let byTarget = byNode.get(node);
  if (!byTarget) byNode.set(node, (byTarget = new WeakMap()));
  const known = byTarget.get(target);
  if (known) return known;
  const found = checkSchemaCompatibility(node, target, namedShape, undefined, { targetFillsDefaults: true });
  byTarget.set(target, found);
  return found;
}

/** A value an expression produces, and the slot it flows into. */
export type JoinSlot = CelValueSlot & {
  manifest: ResourceManifest;
  resource: { kind: string; name: string };
  filePath?: string;
  /** Set for a call-site argument: the target whose declared inputType the
   *  slot's schema is. */
  callTarget?: string;
  /** Set for a chain within an `accessor-template` field: its consumer leaves
   *  out a member whose chain holds nothing, and the chain names a value, so
   *  its format is judged as an accessor's. */
  accessorTemplate?: true;
};

/** What a slot holds, as a type-mismatch message names it: its value type, its
 *  JSON type, or a union's branches (`Telo.HostPath | ":memory:"`). */
function describeSlotType(schema: Record<string, any>): string {
  const branches = schema["x-telo-type"] === undefined ? unionBranches(schema) : undefined;
  if (branches) return branches.map(describeSlotType).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  const type = readValueTypeSlot(schema)?.name ?? schema.type;
  if (Array.isArray(type)) return type.join(" | ");
  return typeof type === "string" ? type : "unknown";
}
