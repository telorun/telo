/**
 * A unit's release tag as a rendered template.
 *
 * A tag format is text with the placeholders `{key}`, `{name}` and `{version}`.
 * Resolved against one unit it becomes a tag pattern — the text around each
 * `{version}` — so rendering is a join, and whether two units can ever be
 * tagged alike is decided on the patterns alone, before any tag exists. The
 * ledger, never a tag, is the source of truth, so a format shapes future tags
 * only.
 */

export const TAG_PLACEHOLDERS = ["key", "name", "version"] as const;
export type TagPlaceholder = (typeof TAG_PLACEHOLDERS)[number];

/** The format of a unit no `tagFormat` names. */
export const DEFAULT_TAG_FORMAT = "{key}@{version}";
/** The root unit's (key `.`): `.@1.0.0` is no legal git ref. */
export const ROOT_TAG_FORMAT = "v{version}";

export type TagFormatPart = { readonly literal: string } | { readonly placeholder: TagPlaceholder };

/** The text around each `{version}` of a unit's tag: `["web/", ""]`. */
export type TagPattern = readonly string[];

/** The version a format is rendered with to judge it against git's rules. */
export const SAMPLE_TAG_VERSION = "0.0.0";

/** A format's parts, or what is wrong with it, worded to follow its value. */
export function parseTagFormat(format: string): { readonly parts: readonly TagFormatPart[] } | { readonly problem: string } {
  const parts: TagFormatPart[] = [];
  let literal = "";
  let i = 0;
  while (i < format.length) {
    const c = format[i]!;
    if (c === "}") return { problem: "which holds a '}' that closes no placeholder" };
    if (c !== "{") {
      literal += c;
      i++;
      continue;
    }
    const end = format.indexOf("}", i + 1);
    const open = format.indexOf("{", i + 1);
    if (end < 0 || (open >= 0 && open < end)) return { problem: "which holds a '{' that opens no placeholder" };
    const name = format.slice(i + 1, end);
    if (!(TAG_PLACEHOLDERS as readonly string[]).includes(name)) return { problem: `whose '{${name}}' is no placeholder` };
    if (literal !== "") parts.push({ literal });
    literal = "";
    parts.push({ placeholder: name as TagPlaceholder });
    i = end + 1;
  }
  if (literal !== "") parts.push({ literal });
  if (!parts.some((part) => "placeholder" in part && part.placeholder === "version")) {
    return { problem: "which holds no {version}, so every version of a unit would get the same tag" };
  }
  return { parts };
}

/** The sentence a refused format's report ends with. */
export const TAG_FORMAT_HINT =
  "A tag format is text with the placeholders {key}, {name} and {version}, e.g. '{key}@{version}'.";

/** The format of a unit that names none. */
export function defaultTagFormat(key: string): string {
  return key === "." ? ROOT_TAG_FORMAT : DEFAULT_TAG_FORMAT;
}

/** The pattern of a unit that names no format. */
export function defaultTagPattern(key: string): TagPattern {
  return key === "." ? ["v", ""] : [`${key}@`, ""];
}

/** `parts` resolved for one unit; `undefined` when it uses `{name}` and the
 *  unit has none. */
export function tagPatternOf(parts: readonly TagFormatPart[], key: string, name: string | undefined): TagPattern | undefined {
  const pattern = [""];
  for (const part of parts) {
    if ("literal" in part) pattern[pattern.length - 1] += part.literal;
    else if (part.placeholder === "key") pattern[pattern.length - 1] += key;
    else if (part.placeholder === "name") {
      if (name === undefined) return undefined;
      pattern[pattern.length - 1] += name;
    } else pattern.push("");
  }
  return pattern;
}

export function renderTag(pattern: TagPattern, version: string): string {
  return pattern.join(version);
}

/** Why git refuses `tag` as a tag name (`git check-ref-format`), or `undefined`. */
export function gitTagRefusal(tag: string): string | undefined {
  for (const c of tag) {
    const code = c.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return "it holds a control character";
    if (c === " ") return "it holds a space";
    if ("~^:?*[\\".includes(c)) return `it holds '${c}'`;
  }
  if (tag === "@") return "it is '@'";
  if (tag.includes("..")) return "it holds '..'";
  if (tag.includes("@{")) return "it holds '@{'";
  if (tag.startsWith("/") || tag.endsWith("/") || tag.includes("//")) return "it starts or ends with '/', or holds '//'";
  if (tag.endsWith(".")) return "it ends with '.'";
  for (const part of tag.split("/")) {
    if (part.startsWith(".")) return "a part of it starts with '.'";
    if (part.endsWith(".lock")) return "a part of it ends with '.lock'";
  }
  return undefined;
}

// A version a unit may carry — `N.N.N` or `N.N.N-<id>.<k>` — as a DFA; 5 and
// 9 accept.
const VERSION_START = 0;
const VERSION_ACCEPTING = new Set([5, 9]);
const VERSION_ALPHABET = [..."-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"];

function versionStep(state: number, c: string): number {
  const digit = c >= "0" && c <= "9" && c.length === 1;
  const letter = c.length === 1 && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z"));
  switch (state) {
    case 0:
      return digit ? 1 : -1;
    case 1:
      return digit ? 1 : c === "." ? 2 : -1;
    case 2:
      return digit ? 3 : -1;
    case 3:
      return digit ? 3 : c === "." ? 4 : -1;
    case 4:
      return digit ? 5 : -1;
    case 5:
      return digit ? 5 : c === "-" ? 6 : -1;
    case 6:
      return letter ? 7 : -1;
    case 7:
      return digit || letter ? 7 : c === "." ? 8 : -1;
    case 8:
      return digit && c !== "0" ? 9 : -1;
    case 9:
      return digit ? 9 : -1;
    default:
      return -1;
  }
}

/** A pattern as items: one code point each, `null` a version. */
function itemsOf(pattern: TagPattern): (string | null)[] {
  const items: (string | null)[] = [];
  for (const [index, text] of pattern.entries()) {
    if (index > 0) items.push(null);
    items.push(...text);
  }
  return items;
}

type Position = readonly [item: number, state: number];

/** A position and where a finished version moves it, without reading. */
function closure(items: readonly (string | null)[], [item, state]: Position): Position[] {
  const out: Position[] = [[item, state]];
  if (item < items.length && items[item] === null && VERSION_ACCEPTING.has(state)) out.push([item + 1, VERSION_START]);
  return out;
}

function step(items: readonly (string | null)[], [item, state]: Position, c: string): Position | undefined {
  if (item >= items.length) return undefined;
  const at = items[item];
  if (at !== null) return at === c ? [item + 1, VERSION_START] : undefined;
  const next = versionStep(state, c);
  return next < 0 ? undefined : [item, next];
}

function readable(items: readonly (string | null)[], [item, state]: Position): string[] {
  if (item >= items.length) return [];
  const at = items[item];
  if (at !== null) return [at];
  return VERSION_ALPHABET.filter((c) => versionStep(state, c) >= 0);
}

/**
 * The shortest tag both patterns render, each with some version, or
 * `undefined` when none exists — decided by walking the two patterns together.
 */
export function tagCollision(a: TagPattern, b: TagPattern): string | undefined {
  // Both read text, not a version, until the shorter leading (or trailing)
  // text ends, so a difference there settles it without the walk.
  const [a0, b0, az, bz] = [a[0]!, b[0]!, a[a.length - 1]!, b[b.length - 1]!];
  const lead = Math.min(a0.length, b0.length);
  const tail = Math.min(az.length, bz.length);
  if (a0.slice(0, lead) !== b0.slice(0, lead) || az.slice(az.length - tail) !== bz.slice(bz.length - tail)) return undefined;
  const left = itemsOf(a);
  const right = itemsOf(b);
  const keyOf = (p: Position, q: Position) => `${p[0]},${p[1]},${q[0]},${q[1]}`;
  const start: [Position, Position] = [
    [0, VERSION_START],
    [0, VERSION_START],
  ];
  const seen = new Set([keyOf(...start)]);
  let frontier: { readonly pair: readonly [Position, Position]; readonly text: string }[] = [{ pair: start, text: "" }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { pair, text } of frontier) {
      const lefts = closure(left, pair[0]);
      const rights = closure(right, pair[1]);
      for (const p of lefts) for (const q of rights) if (p[0] === left.length && q[0] === right.length) return text;
      for (const p of lefts) {
        for (const q of rights) {
          const theirs = readable(right, q);
          for (const c of readable(left, p)) {
            if (!theirs.includes(c)) continue;
            const p2 = step(left, p, c)!;
            const q2 = step(right, q, c)!;
            const key = keyOf(p2, q2);
            if (seen.has(key)) continue;
            seen.add(key);
            next.push({ pair: [p2, q2], text: text + c });
          }
        }
      }
    }
    frontier = next;
  }
  return undefined;
}
