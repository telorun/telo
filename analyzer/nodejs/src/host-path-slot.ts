import {
  hostAnchorOf,
  hostEntryOf,
  hostMediaTypeMismatch,
  hostMediaTypeOf,
  isAbsoluteHostPath,
  type HostEntryKind,
  type HostMediaTypeMismatch,
} from "@telorun/sdk";
import { unionBranches } from "./schema-compat.js";

/**
 * Whether a schema node holds a `Telo.HostPath` — declared on the node itself,
 * or as a branch of a union beside non-path readings (`anyOf: [{ const:
 * ":memory:" }, { x-telo-type: Telo.HostPath }]`).
 */
export function holdsHostPath(schema: Record<string, any> | undefined): boolean {
  if (!schema) return false;
  return (
    hostAnchorOf(schema) !== undefined ||
    (unionBranches(schema) ?? []).some((branch) => hostAnchorOf(branch) !== undefined)
  );
}

/**
 * What a host-path node says its path names (`entry: file | directory`) — the
 * node's own, or a union's host-path branch's — or undefined when it says
 * nothing, which matches either.
 */
export function hostEntryAt(schema: Record<string, any> | undefined): HostEntryKind | undefined {
  if (!schema) return undefined;
  if (hostAnchorOf(schema) !== undefined) return hostEntryOf(schema);
  for (const branch of unionBranches(schema) ?? []) {
    if (hostAnchorOf(branch) !== undefined) return hostEntryOf(branch);
  }
  return undefined;
}

/** The node declaring a host path — the node itself, or a union's host-path
 *  branch — or undefined when it holds none. */
function hostPathNode(schema: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!schema) return undefined;
  if (hostAnchorOf(schema) !== undefined) return schema;
  return (unionBranches(schema) ?? []).find((branch) => hostAnchorOf(branch) !== undefined);
}

/** The media type a host-path node says its file holds (`mediaType: image/png`) —
 *  the node's own, or a union's host-path branch's — or undefined when it says
 *  nothing, which matches any. */
export function hostMediaTypeAt(schema: Record<string, any> | undefined): string | undefined {
  const node = hostPathNode(schema);
  return node ? hostMediaTypeOf(node) : undefined;
}

/** A file's leading bytes judged against the media type its host-path node
 *  declares, or undefined when it declares none or the head carries it. */
export function hostMediaTypeMismatchAt(
  schema: Record<string, any> | undefined,
  head: Uint8Array,
): HostMediaTypeMismatch | undefined {
  const node = hostPathNode(schema);
  return node ? hostMediaTypeMismatch(node, head) : undefined;
}

/**
 * How a file's content refusal reads after its subject (`'tray.jpg'`): what it
 * holds — a media type, a directory, or none the slot's vocabulary knows — and
 * the media type the slot takes.
 */
export function hostMediaTypeFinding(
  subject: string,
  found: { mediaType: string | undefined } | "directory",
  declared: string,
): string {
  const held =
    found === "directory"
      ? "is a directory"
      : found.mediaType !== undefined
        ? `is ${found.mediaType}`
        : "carries no known media type's signature";
  return `${subject} ${held}; this slot takes ${declared}`;
}

/** How a host entry reads in a message. */
export function describeHostEntry(entry: HostEntryKind): string {
  return entry === "directory" ? "a directory" : "a file";
}

/**
 * The `fromHost` anchor that applies to `text` at this node, or undefined when
 * the text is not a host path here: the node's own anchor, or — at a union —
 * the host-path branch's, unless the text is exactly what a constant branch
 * names (`":memory:"` is not a path beside one).
 */
export function hostAnchorFor(schema: Record<string, any>, text: string): string | undefined {
  const own = hostAnchorOf(schema);
  if (own !== undefined) return own;
  const branches = unionBranches(schema) ?? [];
  if (branches.some((branch) => "const" in branch && branch.const === text)) return undefined;
  for (const branch of branches) {
    const anchor = hostAnchorOf(branch);
    if (anchor !== undefined) return anchor;
  }
  return undefined;
}

/** A string literal opening an expression — the whole of it, or the left
 *  operand of a `+` — with its escapes left as written. */
const LEADING_LITERAL = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*(?:\+|$)/;

/**
 * The relative text an expression at a host-path slot starts with, or undefined.
 * A string built from a relative prefix is relative whatever follows it, so this
 * is decided by the expression's text alone; an empty prefix decides nothing, and
 * a constant the slot accepts beside a path (`":memory:"`) is not a path.
 */
export function leadingRelativeLiteral(
  expression: string,
  slot: Record<string, any>,
): string | undefined {
  const match = LEADING_LITERAL.exec(expression);
  const literal = match?.[1] ?? match?.[2];
  if (!literal || isAbsoluteHostPath(literal)) return undefined;
  const constants = (unionBranches(slot) ?? []).map((branch) => branch.const);
  return constants.includes(literal) ? undefined : literal;
}

/** Where a host path comes from — the closing advice of every host-path finding. */
export const HOST_PATH_SOURCES =
  "A host path comes from a variable declared x-telo-type: Telo.HostPath (which resolves a " +
  "relative value against the working directory), from !module-path, or from " +
  ".joinPath('sub/dir') on either.";

/** The constants a union accepts beside the path, as a closing hint — a typo of
 *  one reads as a relative path, and naming it is what points at the repair. */
export function alsoAccepts(slot: Record<string, any> | undefined): string {
  const constants = (slot ? (unionBranches(slot) ?? []) : [])
    .filter((branch) => typeof branch.const === "string")
    .map((branch) => `'${branch.const as string}'`);
  return constants.length === 0 ? "" : ` The field also accepts ${constants.join(", ")}.`;
}

/**
 * Whether an expression at a union beside a host path can hold nothing but the
 * union's constants (`":memory:"`): it is that literal (`literal`, read off the
 * parsed expression), or it reads a source declared `const` / `enum` over them.
 */
export function holdsOnlyConstants(
  slot: Record<string, any>,
  literal: string | undefined,
  source: Record<string, any> | undefined,
): boolean {
  const constants = (unionBranches(slot) ?? [])
    .filter((branch) => "const" in branch)
    .map((branch) => branch.const);
  const held =
    literal !== undefined
      ? [literal]
      : source && "const" in source
        ? [source.const]
        : Array.isArray(source?.enum)
          ? (source.enum as unknown[])
          : [];
  return held.length > 0 && held.every((value) => constants.includes(value));
}

/**
 * The branches of a host-path slot an expression may fill. A constant beside the
 * path is filled only by an expression {@link holdsOnlyConstants} admits: any
 * other string expression might equal it or might be a relative path, and only
 * the second reaches the runtime's refusal.
 */
export function hostPathBranchesFor(
  slot: Record<string, any>,
  literal: string | undefined,
  source: Record<string, any> | undefined,
): Record<string, any> {
  const branches = unionBranches(slot);
  if (!branches || hostAnchorOf(slot) !== undefined) return slot;
  if (holdsOnlyConstants(slot, literal, source)) return slot;
  const paths = branches.filter((branch) => !("const" in branch));
  return { ...slot, ...(slot.anyOf ? { anyOf: paths } : { oneOf: paths }) };
}

/** One host-path input of a library, as its importer must supply it. */
export interface HostPathInput {
  /** The constants a union beside the path accepts (`":memory:"`), which are not paths. */
  constants: string[];
  /** What the path names, when the input says. */
  entry?: HostEntryKind;
  /** The media type of the file it names, when the input says. */
  mediaType?: string;
}

/** A module doc's `variables:` / `secrets:` entries that hold a host path — what
 *  an importer must supply as one — keyed `variables.<name>`. */
export function hostPathInputs(moduleDoc: Record<string, unknown>): Record<string, HostPathInput> {
  const inputs: Record<string, HostPathInput> = {};
  for (const block of ["variables", "secrets"] as const) {
    const entries = moduleDoc[block];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || !holdsHostPath(entry as Record<string, any>)) {
        continue;
      }
      const kind = hostEntryAt(entry as Record<string, any>);
      const mediaType = hostMediaTypeAt(entry as Record<string, any>);
      inputs[`${block}.${name}`] = {
        constants: (unionBranches(entry as Record<string, any>) ?? [])
          .filter((branch) => typeof branch.const === "string")
          .map((branch) => branch.const as string),
        ...(kind !== undefined ? { entry: kind } : {}),
        ...(mediaType !== undefined ? { mediaType } : {}),
      };
    }
  }
  return inputs;
}
