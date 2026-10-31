/**
 * `x-telo-context-element-from-item: "<relative pointer>"` — a binding typed as
 * the element of the collection a chain at ANOTHER site names.
 *
 * The value is a Relative JSON Pointer: a non-negative integer of levels to
 * climb from the context holder — the object holding the field the region is
 * declared on — followed by a non-empty JSON Pointer descending from there
 * (`0/rows` is a sibling of that field, `2/rows` a member two levels up). The
 * chain at the named field is typed exactly as at its own site, and the binding
 * is its element; data that cannot be typed leaves the binding untyped.
 *
 * The one reader: the grammar, the holder and the concrete target path (read
 * by the scope rule, `cel-scope.ts`), and the strict half over a schema
 * document (`ELEMENT_FROM_ITEM_INVALID`, reported by `validate-match-for.ts`).
 *
 * Browser-safe: no Node built-ins.
 */
import { declaredEvalMode, scopeMatchOf, type NamedShapeLookup } from "./eval-paths.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { dispatchReads } from "./invocation-contract.js";
import { placeAt, type ReadReporter } from "./read-place.js";

export const ELEMENT_FROM_ITEM = "x-telo-context-element-from-item";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

export interface RelativePointer {
  /** Levels climbed from the context holder. */
  readonly up: number;
  /** Reference tokens descended from there, decoded. */
  readonly segments: readonly string[];
}

const GRAMMAR = /^(0|[1-9][0-9]*)((\/([^/~]|~[01])*)+)$/;

/** The pointer `value` spells, or `undefined` outside the grammar. */
export function readRelativePointer(value: unknown): RelativePointer | undefined {
  if (typeof value !== "string") return undefined;
  const match = GRAMMAR.exec(value);
  if (!match) return undefined;
  return {
    up: Number(match[1]),
    segments: match[2]!
      .slice(1)
      .split("/")
      .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~")),
  };
}

/** One step of a concrete path: a member name or a list index. */
type Token = string | number;

function tokensOf(path: string): Token[] {
  const tokens: Token[] = [];
  for (const match of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    tokens.push(match[1] !== undefined ? Number(match[1]) : match[2]!);
  }
  return tokens;
}

function pathOf(tokens: readonly Token[]): string {
  return tokens.map((token, i) => (typeof token === "number" ? `[${token}]` : i === 0 ? token : `.${token}`)).join("");
}

/**
 * The concrete path of the field a pointer names, for an expression at
 * `exprPath` inside the region `scope` matched — `undefined` when it climbs
 * above `root` or names nothing the data holds.
 */
export function itemTargetPath(
  exprPath: string,
  scope: string,
  root: unknown,
  pointer: RelativePointer,
): string | undefined {
  const match = scopeMatchOf(exprPath, scope);
  if (!match) return undefined;
  // The region sits on a field; the object holding that field is the holder.
  const regionTokens = tokensOf(match.prefix);
  const holder = regionTokens.slice(0, -1);
  if (pointer.up > holder.length) return undefined;
  const target = holder.slice(0, holder.length - pointer.up);
  let current: unknown = target.reduce<unknown>(
    (value, token) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[token as string] : undefined),
    root,
  );
  for (const segment of pointer.segments) {
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)) {
      target.push(Number(segment));
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      target.push(segment);
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current === undefined ? undefined : pathOf(target);
}

/** One instance level of a schema walk: the node the walk entered it at, and
 *  the member name or `*` (an item, a map value) that reached it. */
export interface SchemaLevel {
  readonly node: Schema;
  readonly key: string | undefined;
}

/**
 * Why `pointer`, written on a binding of the `x-telo-context` on the field at
 * `levels[levels.length - 1]`, names no CEL-typed field — or `undefined`.
 * `levels` runs from the document root; `rootIsResource` says whether that
 * root is a resource's (a kind's schema) or a named shape's, whose holder is
 * not known here.
 */
export function relativePointerRefusal(
  levels: readonly SchemaLevel[],
  pointer: RelativePointer,
  document: Schema,
  shapes: NamedShapeLookup,
  rootIsResource: boolean,
): string | undefined {
  const holderLevel = levels.length - 2;
  const at = holderLevel - pointer.up;
  if (at < 0) {
    return rootIsResource
      ? `it climbs ${pointer.up} level${pointer.up === 1 ? "" : "s"} from the object holding the field, above the resource`
      : `it climbs ${pointer.up} level${pointer.up === 1 ? "" : "s"} from the object holding the field, above the named shape, whose holder is not known here`;
  }
  const keys: Array<string | undefined> = levels.slice(1, at + 1).map((level) => level.key);
  let node: Schema | undefined = levels[at]!.node;
  let doc = document;
  for (const segment of pointer.segments) {
    const found = memberOf(node, doc, segment, shapes);
    if (!found) return `it names '${segment}', which the schema does not declare there`;
    [node, doc] = found;
    keys.push(segment);
  }
  const region = levels.slice(1).map((level) => level.key);
  if (region.every((key, i) => keys[i] === key)) {
    return "it lands at or beneath the field the region is declared on, whose own value it would type";
  }
  if (!declaredEvalMode(deref(node!, doc, shapes)[0])) {
    return "it names a field no CEL is typed at — the field must declare 'x-telo-eval'";
  }
  return undefined;
}

/** A schema node read through its `$ref`s, with the document its own local
 *  references resolve against. */
function deref(node: Schema, document: Schema, shapes: NamedShapeLookup): [Schema, Schema] {
  const seen = new Set<object>();
  let current = node;
  let doc = document;
  while (typeof current.$ref === "string" && !seen.has(current)) {
    seen.add(current);
    const local = current.$ref.startsWith("#");
    const target = local ? resolveSchemaPointer(doc, current.$ref) : shapes(current.$ref);
    if (!isSchema(target)) break;
    if (!local) doc = target;
    current = target;
  }
  return [current, doc];
}

/** The schema a member name or list index reaches from `node`. */
function memberOf(node: Schema, document: Schema, segment: string, shapes: NamedShapeLookup): [Schema, Schema] | undefined {
  const [resolved, doc] = deref(node, document, shapes);
  if (/^(0|[1-9][0-9]*)$/.test(segment) && isSchema(resolved.items)) return [resolved.items, doc];
  if (isSchema(resolved.properties) && isSchema(resolved.properties[segment])) {
    return [resolved.properties[segment], doc];
  }
  for (const member of Array.isArray(resolved.allOf) ? resolved.allOf : []) {
    if (isSchema(member)) {
      const found = memberOf(member, doc, segment, shapes);
      if (found) return found;
    }
  }
  return undefined;
}

/** What `x-telo-context-element-from-item` reads: the chain at another field,
 *  typed as at its own site — which may read anything its declaration does. */
export const elementFromItemReads: ReadReporter = ({ value, at }) =>
  typeof value === "string"
    ? [
        { kind: "value", keys: placeAt(at, value) },
        { kind: "reference", keys: [], transitive: true, reads: dispatchReads },
      ]
    : [];
