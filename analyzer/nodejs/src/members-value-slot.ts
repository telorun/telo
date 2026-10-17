/**
 * A slot holding a value type that declares `members` — a URL — and the one reader of
 * what such a slot accepts as written: its TEXT, read through the type's plain encoding, or
 * an OBJECT of its members, built by the same encoding; and, at a slot whose type argument
 * binds a member (`scheme: { enum: [postgres, postgresql] }`), that member held to the
 * argument. Named by nothing but the entry: no type is spelled here.
 *
 * Shared by `telo check` and the kernel, so the two read one slot the same way: decoding a
 * literal, standing in for an expression inside an object of members, typing such an
 * expression against its member, explaining a refusal — and, in the kernel, building the
 * value from whatever compile-eval expansion produced.
 *
 * Every refusal names what is wrong and never quotes the value: a URL routinely carries a
 * password. Browser-safe.
 */
import {
  isCelRecord,
  isCompiledValue,
  PLAIN_ENCODINGS,
  readValueTypeSlot,
  VALUE_TYPE_BINDINGS,
  type MembersCodec,
  type PlainEncoding,
  type ValueTypeBinding,
  type ValueTypeEntry,
} from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";

/** A slot whose value type declares members, read off its schema node. */
export interface MembersSlot {
  readonly entry: ValueTypeEntry;
  /** The slot's type arguments, by parameter name, each a schema node. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly encoding: PlainEncoding;
  readonly codec: MembersCodec;
  readonly binding: ValueTypeBinding;
}

/** The members slot a schema node declares, or undefined when it declares none. */
export function membersSlotOf(schema: unknown): MembersSlot | undefined {
  const slot = readValueTypeSlot(schema);
  const entry = slot?.entry;
  if (!entry?.members || entry.encoding === undefined || entry.binding === undefined) return undefined;
  const encoding = PLAIN_ENCODINGS[entry.encoding];
  const binding = VALUE_TYPE_BINDINGS[entry.binding];
  if (!encoding?.members || !binding) return undefined;
  return { entry, args: slot!.args, encoding, codec: encoding.members, binding };
}

/** The schema a member's value is held to at this slot: its own, with the argument of a
 *  parameter bound to it laid over it — what a stand-in for it must satisfy, and what an
 *  expression written there is typed against. */
export function memberSlotSchema(slot: MembersSlot, member: string): Record<string, any> | undefined {
  const own = slot.entry.members![member];
  if (!own) return undefined;
  const argument = boundArgument(slot, member);
  return argument ? { ...own, ...argument } : { ...own };
}

/** Each member's slot schema — the object authoring form's properties. */
export function memberSlotSchemas(slot: MembersSlot): Record<string, Record<string, any>> {
  return Object.fromEntries(
    Object.keys(slot.entry.members!).map((member) => [member, memberSlotSchema(slot, member)!]),
  );
}

/**
 * Both authoring forms of a members type, as one schema an editor offers and completes
 * from: its text, or an object of its members. What the value IS stays the slot's own
 * annotation; this says what may be WRITTEN there.
 */
export function membersAuthoringSchema(slot: MembersSlot): Record<string, any> {
  return {
    anyOf: [
      { type: "string", description: `${slot.entry.name} as text: ${slot.encoding.form}.` },
      {
        type: "object",
        properties: memberSlotSchemas(slot),
        additionalProperties: false,
        description: `${slot.entry.name} as an object of its members, each escaped by the type.`,
      },
    ],
  };
}

/** A parameter's argument bound to `member`, when the slot supplies one as a schema. */
function boundArgument(slot: MembersSlot, member: string): Record<string, any> | undefined {
  const parameter = slot.entry.parameters.find((p) => p.member === member);
  const argument = parameter ? slot.args[parameter.name] : undefined;
  return argument && typeof argument === "object" && !Array.isArray(argument)
    ? (argument as Record<string, any>)
    : undefined;
}

/** Whether the slot's argument for `member` refuses every value (`{ not: {} }`, `false`), so
 *  no value at the slot holds that member. */
export function memberForbidden(slot: MembersSlot, member: string): boolean {
  const parameter = slot.entry.parameters.find((p) => p.member === member);
  const argument = parameter ? slot.args[parameter.name] : undefined;
  if (argument === false) return true;
  if (!argument || typeof argument !== "object" || Array.isArray(argument)) return false;
  const not = (argument as Record<string, unknown>).not;
  return (
    not === true ||
    (not !== null && typeof not === "object" && !Array.isArray(not) && Object.keys(not).length === 0)
  );
}

/** Whether a value is still an expression — a compiled value or a tag sentinel. */
function isExpression(value: unknown): boolean {
  return isCompiledValue(value) || isTaggedSentinel(value);
}

/** Whether a record holds an expression at any depth. */
function holdsExpression(value: unknown): boolean {
  if (isExpression(value)) return true;
  if (Array.isArray(value)) return value.some(holdsExpression);
  if (isCelRecord(value)) return Object.values(value).some(holdsExpression);
  return false;
}

/**
 * The value a LITERAL written at the slot reads as — its text decoded, or an object of
 * literal members built — or undefined when it is neither, holds an expression, or does
 * not read (the slot's assertion then refuses it, with {@link membersValueRefusal}'s
 * reason). The argument is the assertion's to judge.
 */
export function readMembersLiteral(slot: MembersSlot, written: unknown): unknown | undefined {
  if (typeof written === "string") return slot.encoding.decode(written);
  if (!isCelRecord(written) || holdsExpression(written)) return undefined;
  const built = slot.codec.compose(written as Record<string, unknown>);
  return "value" in built ? built.value : undefined;
}

/**
 * What a value written or produced at the slot builds: text decoded, an object of members
 * built, an instance as it is — or why it builds nothing. No argument is judged here; the
 * slot's assertion does that, and {@link membersValueRefusal} explains it.
 */
export function readMembersValue(
  slot: MembersSlot,
  value: unknown,
): { readonly value: unknown } | { readonly refusal: string } {
  if (slot.binding.holds(value)) return { value };
  if (typeof value === "string") {
    const decoded = slot.encoding.decode(value);
    return decoded === undefined
      ? { refusal: slot.encoding.refusal?.(value) ?? `it is not ${slot.encoding.form}` }
      : { value: decoded };
  }
  if (isCelRecord(value)) return slot.codec.compose(value as Record<string, unknown>);
  return {
    refusal: `it is ${describeKind(value)}, where ${slot.entry.name} is written as text or as an object of its members`,
  };
}

/**
 * Why a value at the slot is not one of its type — the reason a refusal gives, worded
 * without the value. A value that reads is refused for a member its argument constrains;
 * one that does not read, for whatever stopped it.
 */
export function membersValueRefusal(slot: MembersSlot, value: unknown): string {
  const read = readMembersValue(slot, value);
  if ("refusal" in read) return read.refusal;
  return boundArgumentRefusal(slot, read.value) ?? `it does not satisfy the slot's type arguments`;
}

/** The first member a bound argument refuses, described — or undefined when every bound
 *  argument accepts its member, or says nothing a reader can name. */
export function boundArgumentRefusal(slot: MembersSlot, value: unknown): string | undefined {
  for (const parameter of slot.entry.parameters) {
    if (parameter.member === undefined) continue;
    const argument = boundArgument(slot, parameter.member);
    if (!argument) continue;
    const held = (value as Record<string, unknown>)[parameter.member];
    if (held === undefined) continue;
    if (Array.isArray(argument.enum) && !argument.enum.includes(held)) {
      return `its ${parameter.member} must be one of ${argument.enum.map((item: unknown) => String(item)).join(", ")}`;
    }
    if ("const" in argument && argument.const !== held) {
      return `its ${parameter.member} must be ${String(argument.const)}`;
    }
    if (isRefusingEverything(argument)) return `it must have no ${parameter.member}`;
  }
  return undefined;
}

/** `{ not: {} }` — an argument no present value satisfies. */
function isRefusingEverything(argument: Record<string, any>): boolean {
  const not = argument.not;
  return (
    Object.keys(argument).length === 1 &&
    !!not &&
    typeof not === "object" &&
    !Array.isArray(not) &&
    Object.keys(not).length === 0
  );
}

function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a value of another type";
  return `${/^[aeiou]/.test(typeof value) ? "an" : "a"} ${typeof value}`;
}

/** The message a members slot's refusal carries: `'<path>' is not a <type>: <reason>`. */
export function membersRefusalMessage(slot: MembersSlot, path: string, value: unknown): string {
  return `'${path || "/"}' is not a ${slot.entry.name}: ${membersValueRefusal(slot, value)}`;
}

/** The refusal code a members slot's type declares (`URL_INVALID`), or undefined. */
export function membersRefusalCode(slot: MembersSlot): string | undefined {
  return slot.entry.acceptsText?.code;
}
