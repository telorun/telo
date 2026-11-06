/**
 * `x-telo-ref` `outputTo: { slot, member }` — a reference slot whose target's
 * output the declaring resource hands to the target of a sibling slot, as one
 * member of that target's input (a credential source feeding a verifier its
 * presentation).
 *
 * Two halves, one reader each:
 *  - the kind ({@link outputToProblems}): the pointer names a sibling reference
 *    slot, and every kind that slot accepts declares the member in its input
 *    contract — `X_TELO_REF_INVALID_OUTPUT_TO`;
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
import { propertySchemas, resolveSchemaPointer } from "./manifest-navigation.js";
import { readRefSlot, type RefOutputTo } from "./ref-slot.js";
import { checkSchemaCompatibility } from "./schema-compat.js";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

export interface OutputToProblem {
  readonly code: "X_TELO_REF_INVALID_OUTPUT_TO";
  /** Schema path of the annotation. */
  readonly path: string;
  readonly message: string;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function derefLocal(node: Schema, document: Schema): Schema {
  const seen = new Set<object>();
  let current = node;
  while (typeof current.$ref === "string" && current.$ref.startsWith("#") && !seen.has(current)) {
    seen.add(current);
    const target = resolveSchemaPointer(document, current.$ref);
    if (!isSchema(target)) break;
    current = target;
  }
  return current;
}

/** The schema `pointer` names from the object schema `enclosing`, or undefined. */
function siblingAt(enclosing: Schema, pointer: string, document: Schema): Schema | undefined {
  let current: Schema | undefined = enclosing;
  for (const segment of pointerSegments(pointer)) {
    if (!current) return undefined;
    const next: Schema | undefined = propertySchemas(derefLocal(current, document)).find(([key]) => key === segment)?.[1];
    current = isSchema(next) ? next : undefined;
  }
  return current ? derefLocal(current, document) : undefined;
}

/** Whether `contract` declares a member named `member`. */
export function declaresMember(contract: Schema, member: string, shapes: (id: string) => Schema | undefined): boolean {
  const root = rootOf(contract, shapes);
  return root !== undefined && propertySchemas(root).some(([key]) => key === member);
}

function rootOf(contract: Schema, shapes: (id: string) => Schema | undefined): Schema | undefined {
  const seen = new Set<object>();
  let current: Schema | undefined = contract;
  while (current && typeof current.$ref === "string" && !current.$ref.startsWith("#") && !seen.has(current)) {
    seen.add(current);
    const target: unknown = shapes(current.$ref);
    current = isSchema(target) ? target : undefined;
  }
  return current;
}

/**
 * Every misdirected `outputTo` of a kind's own schema: a pointer naming no
 * sibling reference slot, or a member some kind of that slot does not declare
 * in its input contract. `inputContractOf` resolves a kind's input contract
 * (undefined: it declares none); a kind `resolve` does not find is left to the
 * reference-constraint check.
 */
export function outputToProblems(
  definition: ResourceDefinition,
  schema: unknown,
  resolve: DefResolver,
  inputContractOf: (target: ResourceDefinition) => Schema | undefined,
  shapes: (id: string) => Schema | undefined,
): OutputToProblem[] {
  if (!isSchema(schema)) return [];
  const document = schema;
  const name = `${definition.kind} '${definition.metadata?.name as string}'`;
  const problems: OutputToProblem[] = [];
  const seen = new Set<object>();

  const judge = (enclosing: Schema, slotNode: Schema, slotPath: string, outputTo: RefOutputTo): void => {
    const where = `${slotPath}.x-telo-ref.outputTo`;
    const refuse = (reason: string): void => {
      problems.push({
        code: "X_TELO_REF_INVALID_OUTPUT_TO",
        path: where,
        message: `${name}: x-telo-ref at '${slotPath}' declares 'outputTo: { slot: ${outputTo.slot}, member: ${outputTo.member} }', but ${reason}.`,
      });
    };
    const target = siblingAt(enclosing, outputTo.slot, document);
    if (!target) return refuse(`the object enclosing the slot declares nothing at '${outputTo.slot}'`);
    if (target === slotNode) return refuse(`'${outputTo.slot}' names the slot itself`);
    const targetSlot = readRefSlot(target);
    if (!targetSlot) return refuse(`'${outputTo.slot}' is not a reference slot, so nothing takes the output`);
    for (const kind of targetSlot.kinds) {
      const targetDefinition = resolve(kind, definition);
      if (!targetDefinition) continue;
      const contract = inputContractOf(targetDefinition);
      if (!contract) {
        refuse(`'${kind}', which '${outputTo.slot}' accepts, declares no input contract, so it has no member '${outputTo.member}'`);
      } else if (!declaresMember(contract, outputTo.member, shapes)) {
        refuse(`the input contract of '${kind}', which '${outputTo.slot}' accepts, declares no member '${outputTo.member}'`);
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
