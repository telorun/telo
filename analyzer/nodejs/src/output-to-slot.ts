/**
 * `x-telo-ref` `outputTo: { slot, member }` — a reference slot whose target's
 * output the declaring resource hands to the target of a sibling slot, as one
 * member of that target's input (a credential source feeding a verifier its
 * presentation).
 *
 * Two halves, one reader each:
 *  - the kind ({@link outputToProblems}): the pointer names a sibling reference
 *    slot, and every kind that slot accepts declares the member in its input
 *    contract — `X_TELO_REF_INVALID_OUTPUT_TO`, read through a reader of the
 *    named shapes on the way, so each finding holds where its reading does;
 *  - the resource ({@link outputToRefusal}): the source's declared output, null
 *    removed (a source returning null presents nothing), fits that member of
 *    the target's resolved input contract — `CONTRACT_INPUTS_MISMATCH`, at the
 *    source.
 *
 * No kernel half: the kernel binds the target's input contract at `create()`,
 * so a value that does not fit is refused at dispatch (`ERR_INPUT_INVALID`).
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition } from "@telorun/sdk";
import type { DefResolver } from "./extends-resolution.js";
import { propertySchemas } from "./manifest-navigation.js";
import { followSchemaReferences } from "./schema-reference.js";
import { readRefSlot, type RefOutputTo } from "./ref-slot.js";
import { checkSchemaCompatibility } from "./schema-compat.js";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

export interface OutputToProblem<C> {
  readonly code: "X_TELO_REF_INVALID_OUTPUT_TO";
  /** Schema path of the annotation. */
  readonly path: string;
  /** Schema path of the slot carrying it, which the message quotes. */
  readonly slotPath: string;
  readonly message: string;
  /** Where the problem holds. */
  readonly held: C;
}

/**
 * What judging a kind's `outputTo` reads of the schemas references name, each
 * answer with where it holds — the reading of every configuration at once, or
 * of one.
 */
export interface OutputToReads<C> {
  /** The nodes following `segments` from `node`, written in `document`, ends
   *  at within `at`, references followed: undefined where the path names
   *  nothing. */
  follow(
    node: Schema,
    document: Schema | undefined,
    segments: readonly string[],
    at: C,
  ): readonly { readonly node: Schema | undefined; readonly held: C }[];
  /** A kind's input contract's root node, or undefined when it declares none. */
  inputContract(target: ResourceDefinition): Schema | undefined;
  /** Where every judgement starts. */
  readonly everywhere: C;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Every misdirected `outputTo` of a kind's own schema `schema`: a pointer
 * naming no sibling reference slot, or a member some kind of that slot does not
 * declare in its input contract — each where it holds. A kind `resolve` does
 * not find is left to the reference-constraint check.
 */
export function outputToProblems<C>(
  definition: ResourceDefinition,
  schema: unknown,
  resolve: DefResolver,
  reads: OutputToReads<C>,
): OutputToProblem<C>[] {
  if (!isSchema(schema)) return [];
  const document = schema;
  const name = `${definition.kind} '${definition.metadata?.name as string}'`;
  const problems: OutputToProblem<C>[] = [];
  const seen = new Set<object>();

  const judge = (enclosing: Schema, slotNode: Schema, slotPath: string, outputTo: RefOutputTo): void => {
    const where = `${slotPath}.x-telo-ref.outputTo`;
    const refuse = (reason: string, held: C): void => {
      problems.push({
        code: "X_TELO_REF_INVALID_OUTPUT_TO",
        path: where,
        slotPath,
        message: `${name}: x-telo-ref at '${slotPath}' declares 'outputTo: { slot: ${outputTo.slot}, member: ${outputTo.member} }', but ${reason}.`,
        held,
      });
    };
    for (const { node: target, held } of reads.follow(enclosing, document, pointerSegments(outputTo.slot), reads.everywhere)) {
      if (!target) {
        refuse(`the object enclosing the slot declares nothing at '${outputTo.slot}'`, held);
        continue;
      }
      if (target === slotNode) {
        refuse(`'${outputTo.slot}' names the slot itself`, held);
        continue;
      }
      const targetSlot = readRefSlot(target);
      if (!targetSlot) {
        refuse(`'${outputTo.slot}' is not a reference slot, so nothing takes the output`, held);
        continue;
      }
      for (const kind of targetSlot.kinds) {
        const targetDefinition = resolve(kind, definition);
        if (!targetDefinition) continue;
        const contract = reads.inputContract(targetDefinition);
        if (!contract) {
          refuse(`'${kind}', which '${outputTo.slot}' accepts, declares no input contract, so it has no member '${outputTo.member}'`, held);
          continue;
        }
        for (const root of reads.follow(contract, undefined, [], held)) {
          if (root.node && propertySchemas(root.node).some(([key]) => key === outputTo.member)) continue;
          refuse(`the input contract of '${kind}', which '${outputTo.slot}' accepts, declares no member '${outputTo.member}'`, root.held);
        }
      }
    }
  };

  const visit = (node: unknown, path: string): void => {
    if (!isSchema(node) || seen.has(node)) return;
    seen.add(node);
    if (isSchema(node.properties)) {
      for (const [key, child] of Object.entries(node.properties as Schema)) {
        if (!isSchema(child)) continue;
        const outputTo = readRefSlot(child)?.outputTo;
        if (outputTo) judge(node, child, `${path}.properties.${key}`, outputTo);
      }
    }
    for (const map of ["properties", "patternProperties", "$defs", "definitions"] as const) {
      if (!isSchema(node[map])) continue;
      for (const [key, child] of Object.entries(node[map] as Schema)) visit(child, `${path}.${map}.${key}`);
    }
    visit(node.additionalProperties, `${path}.additionalProperties`);
    if (Array.isArray(node.items)) node.items.forEach((item, i) => visit(item, `${path}.items[${i}]`));
    else visit(node.items, `${path}.items`);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((branch: unknown, i: number) => visit(branch, `${path}.${key}[${i}]`));
    }
  };
  visit(schema, "schema");
  return problems;
}

function rootOf(contract: Schema, shapes: (id: string) => Schema | undefined): Schema | undefined {
  return followSchemaReferences(contract, undefined, shapes).node;
}

/** `schema` admitting no null: a `type` list without `null`, an `anyOf` /
 *  `oneOf` without its null branches; undefined when only null is left. */
export function withoutNull(schema: Schema): Schema | undefined {
  if (schema.type === "null") return undefined;
  let out = schema;
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    const types = schema.type.filter((type: unknown) => type !== "null");
    if (types.length === 0) return undefined;
    out = { ...out, type: types.length === 1 ? types[0] : types };
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = out[key];
    if (!Array.isArray(branches)) continue;
    const kept = branches.filter((branch: unknown) => !(isSchema(branch) && branch.type === "null" && Object.keys(branch).length === 1));
    if (kept.length === branches.length) continue;
    if (kept.length === 0) return undefined;
    const { [key]: _branches, ...rest } = out;
    out = kept.length === 1 && Object.keys(rest).length === 0 ? kept[0] : { ...rest, [key]: kept };
  }
  return out;
}

/** Each mismatch is told from the target's side: what the source's output
 *  lacks or holds against the member it fills. */
const ROLES = { source: "the source's output", target: "the member it fills" };

/**
 * Why a source producing `produced` cannot fill `member` of `consumed`: one
 * line per definite mismatch, empty when it can — or when either side
 * declares no contract, or the target declares no such member (the kind-level
 * check reports that).
 */
export function outputToRefusal(
  produced: Schema | undefined,
  consumed: Schema | undefined,
  member: string,
  shapes: (id: string) => Schema | undefined,
): string[] {
  if (!produced || !consumed) return [];
  const presented = withoutNull(produced);
  const root = rootOf(consumed, shapes);
  const target = root ? propertySchemas(root).find(([key]) => key === member)?.[1] : undefined;
  if (!presented || !isSchema(target)) return [];
  const { compatible, issues } = checkSchemaCompatibility(presented, target, shapes, ROLES);
  return compatible ? [] : issues;
}
