/**
 * Selectors Level 4 matching over `Html.Node`, owned by this module so every
 * selector the `css-selector` grammar accepts is evaluated per spec.
 *
 * Matching is against a static tree: what a pseudo-class needs is read from the
 * tree (structure, attributes, form markup, table layout, language and
 * direction). Only the pseudo-classes that depend on interaction, a live user
 * agent, or state a parsed page does not carry match nothing — they are listed
 * in {@link NEVER}. HTML documents' case rules apply: type selectors and
 * attribute names match HTML elements case-insensitively and foreign elements
 * case-sensitively, the attribute values HTML lists compare case-insensitively,
 * and classes and ids always compare exactly (no quirks mode).
 */

import type {
  AstAttribute,
  AstEntity,
  AstFormula,
  AstPseudoClass,
  AstRule,
  AstSelector,
} from "css-selector-parser";
import {
  isBlank,
  isChecked,
  isDefault,
  isDisabled,
  isEnablable,
  isIndeterminate,
  isOptionalOrRequired,
  isPlaceholderShown,
  isReadWrite,
  isRequired,
  rangeState,
  validity,
} from "./form-state.js";
import { isHtmlElement, type ElementNode } from "./html-node.js";
import { parseSelector } from "./selector-parse.js";
import { cellColumns, columnElementRange, rangesOverlap } from "./table-columns.js";
import { descendantsOf, isAncestor, textOf, type TreeIndex } from "./tree-index.js";

/** Pseudo-classes that need interaction, a live user agent or state a parsed
 *  page does not carry; in a static tree they match nothing. */
export const NEVER: ReadonlySet<string> = new Set([
  "hover", "active", "focus", "focus-within", "focus-visible", "visited", "target",
  "target-within", "local-link", "user-invalid", "playing", "paused", "modal",
  "fullscreen", "picture-in-picture", "popover-open", "autofill", "loading", "state",
  "current", "past", "future",
]);

/** Attribute values HTML compares ASCII case-insensitively on HTML elements. */
const CASE_INSENSITIVE_VALUES = new Set([
  "accept", "accept-charset", "align", "alink", "axis", "bgcolor", "charset", "checked",
  "clear", "codetype", "color", "compact", "declare", "defer", "dir", "direction",
  "disabled", "enctype", "face", "frame", "hreflang", "http-equiv", "lang", "language",
  "link", "media", "method", "multiple", "nohref", "noresize", "noshade", "nowrap",
  "readonly", "rel", "rev", "rules", "scope", "scrolling", "selected", "shape", "target",
  "text", "type", "valign", "valuetype", "vlink",
]);

const WHITESPACE = /[\t\n\f\r ]+/;

/** Where a selector is matched from: the page itself, or an element. */
export type Scope = ElementNode | "root";

interface Context {
  readonly index: TreeIndex;
  readonly scope: Scope;
}

type Compound = { readonly items: AstRule["items"]; readonly combinator?: string };

/** A complex selector as a list of compounds, left to right, each carrying the
 *  combinator that joins it to the one before (the first carries a leading
 *  combinator, which only a relative selector has). */
function compounds(rule: AstRule): Compound[] {
  const out: Compound[] = [];
  for (let at: AstRule | undefined = rule; at; at = at.nestedRule) {
    out.push({ items: at.items, combinator: at.combinator });
  }
  return out;
}

const compiled = new WeakMap<AstRule, Compound[]>();
function compoundsOf(rule: AstRule): Compound[] {
  let found = compiled.get(rule);
  if (!found) {
    found = compounds(rule);
    compiled.set(rule, found);
  }
  return found;
}

function lower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/* ------------------------------------------------------------ attributes */

function attributeValue(element: ElementNode, name: string): string | undefined {
  return element.attrs[element.namespace === undefined ? lower(name) : name];
}

function matchesAttribute(element: ElementNode, item: AstAttribute): boolean {
  const actual = attributeValue(element, item.name);
  if (actual === undefined) return false;
  if (item.operator === undefined || item.value?.type !== "String") return true;
  const insensitive =
    item.caseSensitivityModifier === "i" ||
    (item.caseSensitivityModifier === undefined &&
      element.namespace === undefined &&
      CASE_INSENSITIVE_VALUES.has(lower(item.name)));
  const value = insensitive ? lower(actual) : actual;
  const wanted = insensitive ? lower(item.value.value) : item.value.value;
  switch (item.operator) {
    case "=":
      return value === wanted;
    case "~=":
      return wanted !== "" && !WHITESPACE.test(wanted) && value.split(WHITESPACE).includes(wanted);
    case "|=":
      return value === wanted || value.startsWith(`${wanted}-`);
    case "^=":
      return wanted !== "" && value.startsWith(wanted);
    case "$=":
      return wanted !== "" && value.endsWith(wanted);
    case "*=":
      return wanted !== "" && value.includes(wanted);
    default:
      return false;
  }
}

/* --------------------------------------------------------------- formulas */

function formulaMatches(formula: { a: number; b: number }, position: number): boolean {
  const { a, b } = formula;
  if (a === 0) return position === b;
  const n = (position - b) / a;
  return Number.isInteger(n) && n >= 0;
}

/* ----------------------------------------------------- language, direction */

function languageOf(index: TreeIndex, element: ElementNode): string | undefined {
  for (let at: ElementNode | undefined = element; at; at = index.parentOf(at)) {
    const value = at.attrs["xml:lang"] ?? at.attrs.lang;
    if (value !== undefined) return value;
  }
  return undefined;
}

/** RFC 4647 extended filtering of one language tag by one range. */
function languageMatches(tag: string, range: string): boolean {
  const tags = lower(tag).split("-");
  const ranges = lower(range).split("-");
  if (tags[0] === "" || (ranges[0] !== "*" && ranges[0] !== tags[0])) return false;
  let t = 1;
  for (let r = 1; r < ranges.length; r++) {
    const want = ranges[r]!;
    if (want === "*") continue;
    for (;;) {
      if (t >= tags.length) return false;
      if (tags[t] === want) {
        t++;
        break;
      }
      if (tags[t]!.length === 1) return false;
      t++;
    }
  }
  return true;
}

const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const STRONG = /\p{L}/u;

function textDirection(text: string): "ltr" | "rtl" | undefined {
  for (const char of text) {
    if (RTL_SCRIPT.test(char)) return "rtl";
    if (STRONG.test(char)) return "ltr";
  }
  return undefined;
}

function autoDirection(element: ElementNode): "ltr" | "rtl" | undefined {
  if (isHtmlElement(element, "textarea") || isHtmlElement(element, "input")) {
    return textDirection(isHtmlElement(element, "textarea") ? textOf(element.children) : element.attrs.value ?? "");
  }
  for (const child of element.children) {
    if (child.type === "text") {
      const found = textDirection(child.text);
      if (found) return found;
    } else if (child.type === "element") {
      if (child.namespace !== undefined || ["bdi", "script", "style", "textarea"].includes(child.tag)) continue;
      if (child.attrs.dir !== undefined) continue;
      const found = autoDirection(child);
      if (found) return found;
    }
  }
  return undefined;
}

function directionOf(index: TreeIndex, element: ElementNode): "ltr" | "rtl" {
  for (let at: ElementNode | undefined = element; at; at = index.parentOf(at)) {
    const dir = lower((at.attrs.dir ?? "").trim());
    if (dir === "ltr" || dir === "rtl") return dir;
    if (dir === "auto" || (isHtmlElement(at, "bdi") && at.attrs.dir === undefined)) {
      return autoDirection(at) ?? "ltr";
    }
  }
  return "ltr";
}

/* ----------------------------------------------------------- the matcher */

function isRoot(index: TreeIndex, element: ElementNode): boolean {
  return index.parentOf(element) === undefined && isHtmlElement(element, "html");
}

function sameType(a: ElementNode, b: ElementNode): boolean {
  return a.tag === b.tag && a.namespace === b.namespace;
}

function matchesPseudo(element: ElementNode, item: AstPseudoClass, context: Context): boolean {
  const { index } = context;
  const name = item.name;
  if (NEVER.has(name)) return false;
  const argument = item.argument;
  const siblings = index.siblingsOf(element);
  const position = index.indexOf(element);
  const ofType = () => siblings.filter((sibling) => sameType(sibling, element));
  switch (name) {
    case "root":
      return isRoot(index, element);
    case "scope":
      return context.scope === "root" ? isRoot(index, element) : element === context.scope;
    case "first-child":
      return position === 0;
    case "last-child":
      return position === siblings.length - 1;
    case "only-child":
      return siblings.length === 1;
    case "first-of-type":
      return ofType()[0] === element;
    case "last-of-type": {
      const same = ofType();
      return same[same.length - 1] === element;
    }
    case "only-of-type":
      return ofType().length === 1;
    case "nth-child":
    case "nth-last-child": {
      if (argument?.type !== "Formula" && argument?.type !== "FormulaOfSelector") return false;
      let pool = siblings;
      if (argument.type === "FormulaOfSelector") {
        const of = (candidate: ElementNode) => matchesComplex(candidate, compoundsOf(argument.selector), context);
        if (!of(element)) return false;
        pool = siblings.filter(of);
      }
      const at = pool.indexOf(element);
      return formulaMatches(argument, name === "nth-child" ? at + 1 : pool.length - at);
    }
    case "nth-of-type":
    case "nth-last-of-type": {
      if (argument?.type !== "Formula") return false;
      const same = ofType();
      const at = same.indexOf(element);
      return formulaMatches(argument, name === "nth-of-type" ? at + 1 : same.length - at);
    }
    case "nth-col":
    case "nth-last-col": {
      const cell = cellColumns(index, element);
      if (!cell || argument?.type !== "Formula") return false;
      for (let c = cell.range.start; c < cell.range.start + cell.range.span; c++) {
        if (formulaMatches(argument as AstFormula, name === "nth-col" ? c + 1 : cell.width - c)) return true;
      }
      return false;
    }
    case "empty":
      // Selectors 4: document white space does not make an element non-empty.
      return element.children.every(
        (child) => child.type === "comment" || (child.type === "text" && /^[\t\n\f\r ]*$/.test(child.text)),
      );
    case "blank":
      return isBlank(element);
    case "is":
    case "where":
      return argument?.type === "Selector" && matchesList(element, argument, context);
    case "not":
      return argument?.type === "Selector" && !matchesList(element, argument, context);
    case "has":
      return argument?.type === "Selector" && argument.rules.some((rule) => hasRelative(element, rule, context));
    case "any-link":
    case "link":
      return (isHtmlElement(element, "a") || isHtmlElement(element, "area")) && "href" in element.attrs;
    case "lang": {
      if (argument?.type !== "String") return false;
      const language = languageOf(index, element);
      if (language === undefined) return false;
      return argument.value
        .split(",")
        .map((range) => range.trim().replace(/^["']|["']$/g, ""))
        .some((range) => languageMatches(language, range));
    }
    case "dir":
      return argument?.type === "String" && lower(argument.value.trim()) === directionOf(index, element);
    case "checked":
      return isChecked(index, element);
    case "default":
      return isDefault(index, element);
    case "indeterminate":
      return isIndeterminate(index, element);
    case "enabled":
      return isEnablable(element) && !isDisabled(index, element);
    case "disabled":
      return isEnablable(element) && isDisabled(index, element);
    case "required":
      return isRequired(element);
    case "optional":
      return isOptionalOrRequired(element) && !isRequired(element);
    case "read-write":
      return isReadWrite(index, element);
    case "read-only":
      return !isReadWrite(index, element);
    case "placeholder-shown":
      return isPlaceholderShown(element);
    case "in-range":
      return rangeState(index, element) === true;
    case "out-of-range":
      return rangeState(index, element) === false;
    case "valid":
      return validity(index, element) === true;
    case "invalid":
      return validity(index, element) === false;
    case "defined":
      return element.namespace !== undefined || !element.tag.includes("-");
    default:
      throw new Error(`html: the selector matcher has no rule for :${name}()`);
  }
}

function matchesItem(element: ElementNode, item: AstEntity, context: Context): boolean {
  switch (item.type) {
    case "WildcardTag":
      return true;
    case "TagName":
      return element.namespace === undefined ? element.tag === lower(item.name) : element.tag === item.name;
    case "Id":
      return element.attrs.id === item.name;
    case "ClassName":
      return (element.attrs.class ?? "").split(WHITESPACE).includes(item.name);
    case "Attribute":
      return matchesAttribute(element, item);
    case "PseudoClass":
      return matchesPseudo(element, item, context);
    default:
      throw new Error(`html: the selector matcher has no rule for a ${item.type}`);
  }
}

function matchesCompound(element: ElementNode, compound: Compound, context: Context): boolean {
  return compound.items.every((item) => matchesItem(element, item, context));
}

/** Whether `element` is the subject of the complex selector `list`, matched
 *  right to left. With `anchor`, the leftmost compound must stand in its leading
 *  combinator's relation to the anchor — a relative selector inside `:has()`. */
function matchesComplex(
  element: ElementNode,
  list: readonly Compound[],
  context: Context,
  anchor?: ElementNode,
): boolean {
  const { index } = context;
  const at = (candidate: ElementNode | undefined, i: number): boolean => {
    if (!candidate || !matchesCompound(candidate, list[i]!, context)) return false;
    if (i === 0) return anchor === undefined || related(index, anchor, candidate, list[0]!.combinator);
    const previous = i - 1;
    switch (list[i]!.combinator) {
      case ">":
        return at(index.parentOf(candidate), previous);
      case "+":
        return at(index.siblingsOf(candidate)[index.indexOf(candidate) - 1], previous);
      case "~":
        return index.siblingsOf(candidate).slice(0, index.indexOf(candidate)).some((sibling) => at(sibling, previous));
      case "||": {
        const cell = cellColumns(index, candidate);
        if (!cell) return false;
        return index.elements.some((column) => {
          const range = columnElementRange(index, column);
          return !!range && range.table === cell.table && rangesOverlap(range.range, cell.range) && at(column, previous);
        });
      }
      default:
        for (let up = index.parentOf(candidate); up; up = index.parentOf(up)) if (at(up, previous)) return true;
        return false;
    }
  };
  return at(element, list.length - 1);
}

/** Whether `element` stands in `combinator`'s relation to `anchor`. */
function related(index: TreeIndex, anchor: ElementNode, element: ElementNode, combinator: string | undefined): boolean {
  switch (combinator) {
    case ">":
      return index.parentOf(element) === anchor;
    case "+":
      return index.siblingsOf(element)[index.indexOf(element) - 1] === anchor;
    case "~": {
      const siblings = index.siblingsOf(element);
      return siblings.indexOf(anchor) >= 0 && siblings.indexOf(anchor) < index.indexOf(element);
    }
    default:
      return isAncestor(index, anchor, element);
  }
}

function hasRelative(anchor: ElementNode, rule: AstRule, context: Context): boolean {
  const { index } = context;
  const list = compoundsOf(rule);
  const combinator = list[0]!.combinator;
  const candidates =
    combinator === "+" || combinator === "~"
      ? index
          .siblingsOf(anchor)
          .slice(index.indexOf(anchor) + 1)
          .flatMap((sibling) => [sibling, ...descendantsOf(index, sibling)])
      : descendantsOf(index, anchor);
  return candidates.some((candidate) => matchesComplex(candidate, list, context, anchor));
}

function matchesList(element: ElementNode, selector: AstSelector, context: Context): boolean {
  return selector.rules.some((rule) => matchesComplex(element, compoundsOf(rule), context));
}

/**
 * The elements matching `selector`, in document order: every indexed element
 * when the scope is the page, the scope element and its descendants otherwise.
 */
export function selectAll(selector: string, index: TreeIndex, scope: Scope): ElementNode[] {
  const ast = parseSelector(selector);
  const context: Context = { index, scope };
  const candidates = scope === "root" ? index.elements : [scope, ...descendantsOf(index, scope)];
  return candidates.filter((element) => matchesList(element, ast, context));
}
