import * as csstree from "css-tree/dist/csstree.esm";
import type { Atrule, CssNode, List, ListItem, Rule, Selector, SelectorList } from "css-tree";

/** One style rule of a stylesheet, its nesting resolved. */
export interface StyleRule {
  /** The selector list as written, each nested selector expanded to its full form. */
  written: string;
  /** What the window matches: the same list with user-action pseudo-classes and
   *  pseudo-elements taken out, since no snapshot is hovered or focused on purpose. */
  matched: string;
  /** Every property the rule declares, lower case; custom properties as written. */
  properties: string[];
}

/** What a stylesheet says that the style checks read. */
export interface StylesheetReading {
  rules: StyleRule[];
  /** Every custom property some `var()` reads, a fallback's included. */
  reads: Set<string>;
  /** Every custom property a `:root` rule outside any condition declares. */
  rootDeclarations: Set<string>;
}

export type StylesheetResult = { ok: true; reading: StylesheetReading } | { ok: false; message: string };

/** At-rules whose block holds style rules that apply under a condition or in a layer. */
const GROUPING = new Set(["media", "supports", "layer", "container"]);
/** At-rules whose rules still state a default: a layer is no condition. */
const UNCONDITIONAL = new Set(["layer"]);
const USER_ACTION = new Set(["hover", "active", "focus", "focus-visible", "focus-within"]);
/** Pseudo-elements CSS 2 wrote with one colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

interface ParseError {
  offset: number;
  message: string;
}

/**
 * Read a stylesheet as css-tree parses it. Anything css-tree cannot parse is an
 * error, with one exception it is recovered from: a nested rule whose selector
 * starts with a combinator or an attribute (`> .item { … }`, `[data-x] { … }`),
 * which CSS nesting allows and css-tree's block parser does not see as a rule,
 * is parsed again on its own — and is an error only if it fails there too.
 */
export function readStylesheet(text: string): StylesheetResult {
  let errors: ParseError[] = [];
  const trees: CssNode[] = [];
  const parse = (source: string, base: number) => {
    const tree = csstree.parse(source, {
      positions: true,
      parseCustomProperty: true,
      onParseError: (error) => errors.push({ offset: base + error.offset, message: error.message }),
    });
    trees.push(tree);
    return tree;
  };
  const sheet = parse(text, 0);
  const reading: StylesheetReading = { rules: [], reads: new Set(), rootDeclarations: new Set() };

  const visitBlock = (children: List<CssNode>, parents: string | null, conditional: boolean) => {
    for (const child of children) {
      if (child.type === "Rule") visitRule(child, parents, conditional);
      else if (child.type === "Atrule") visitAtrule(child, parents, conditional);
      else if (child.type === "Raw" && parents !== null && child.loc) {
        // What css-tree's block parser could not read in a rule's block: a
        // nested rule its lookahead misses, read again alone, where it parses.
        const start = child.loc.start.offset;
        const end = child.loc.end.offset;
        errors = errors.filter(({ offset }) => offset < start || offset >= end);
        const nested = parse(child.value, start);
        if (nested.type === "StyleSheet") visitBlock(nested.children, parents, conditional);
      }
    }
  };

  const visitAtrule = (atrule: Atrule, parents: string | null, conditional: boolean) => {
    const name = atrule.name.toLowerCase();
    if (!GROUPING.has(name) || !atrule.block) return;
    visitBlock(atrule.block.children, parents, conditional || !UNCONDITIONAL.has(name));
  };

  const visitRule = (rule: Rule, parents: string | null, conditional: boolean) => {
    if (rule.prelude.type !== "SelectorList") return;
    const selectors = rule.prelude.children.toArray().filter((node): node is Selector => node.type === "Selector");
    const full = selectors.map((selector) => (parents === null ? selector : nestedIn(selector, parents)));
    const written = full.map((selector) => csstree.generate(selector)).join(", ");
    const properties: string[] = [];
    for (const child of rule.block.children) {
      if (child.type !== "Declaration") continue;
      properties.push(child.property.startsWith("--") ? child.property : child.property.toLowerCase());
    }
    if (properties.length > 0) {
      reading.rules.push({ written, matched: full.map((selector) => csstree.generate(stripped(selector))).join(", "), properties });
    }
    if (parents === null && !conditional && full.some(isRoot)) {
      for (const property of properties) if (property.startsWith("--")) reading.rootDeclarations.add(property);
    }
    visitBlock(rule.block.children, written, conditional);
  };

  if (sheet.type === "StyleSheet") visitBlock(sheet.children, null, false);
  if (errors.length > 0) {
    const first = errors.sort((a, b) => a.offset - b.offset)[0];
    const before = text.slice(0, first.offset).split("\n");
    return { ok: false, message: `${first.message} at line ${before.length}, column ${before[before.length - 1].length + 1}` };
  }
  for (const tree of trees) csstree.walk(tree, {
    visit: "Function",
    enter(node) {
      if (node.name.toLowerCase() !== "var") return;
      const first = node.children.first;
      if (first?.type === "Identifier") reading.reads.add(first.name);
    },
  });
  return { ok: true, reading };
}

/** A copy of the tree under `node`, so a rewrite leaves the parsed sheet alone. */
const copy = <T extends CssNode>(node: T): T => csstree.clone(node) as T;

/** A nested selector in full: each `&` stands for its parents, and a selector
 *  naming none is relative to them. */
function nestedIn(selector: Selector, parents: string): Selector {
  const full = copy(selector);
  const parentsNode = () => (csstree.parse(`:is(${parents})`, { context: "selector" }) as Selector).children.first as CssNode;
  let nests = false;
  csstree.walk(full, {
    visit: "NestingSelector",
    enter(_node, item, list) {
      nests = true;
      list.replace(item, list.createItem(parentsNode()));
    },
  });
  if (nests) return full;
  const children = full.children;
  if (children.first?.type !== "Combinator") children.prependData({ type: "Combinator", name: " " });
  children.prependData(parentsNode());
  return full;
}

function isRoot(selector: Selector): boolean {
  const only = selector.children.first;
  return selector.children.size === 1 && only?.type === "PseudoClassSelector" && only.name.toLowerCase() === "root";
}

/** The selector with what no snapshot holds taken out: the user-action
 *  pseudo-classes and every pseudo-element. A compound left empty is `*`. */
function stripped(selector: Selector): Selector {
  const result = copy(selector);
  strip(result);
  return result;
}

/** Strip one selector in place; answers whether anything was taken out. */
function strip(selector: Selector): boolean {
  const children = selector.children;
  const relative = children.first?.type === "Combinator";
  const removed: ListItem<CssNode>[] = [];
  let changed = false;
  children.forEach((node, item) => {
    if (node.type === "PseudoElementSelector") removed.push(item);
    else if (node.type === "PseudoClassSelector") {
      const name = node.name.toLowerCase();
      if (USER_ACTION.has(name) || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        removed.push(item);
        return;
      }
      const list = node.children?.first;
      if (list?.type !== "SelectorList") return;
      const result = stripList(list, name === "not");
      changed ||= result.changed;
      if (result.left === 0) removed.push(item);
    }
  });
  for (const item of removed) children.remove(item);
  fillEmptyCompounds(children, relative);
  return changed || removed.length > 0;
}

/**
 * Strip each selector of a functional pseudo-class's list. Under `:not`, a
 * selector that lost anything goes: what it negates may not hold in some state,
 * so the negation can hold. Elsewhere a stripped selector stays, matching in
 * every state. Answers how many selectors are left.
 */
function stripList(list: SelectorList, negated: boolean): { left: number; changed: boolean } {
  const gone: ListItem<CssNode>[] = [];
  let changed = false;
  list.children.forEach((node, item) => {
    if (node.type !== "Selector" || !strip(node)) return;
    changed = true;
    if (negated) gone.push(item);
  });
  for (const item of gone) list.children.remove(item);
  return { left: list.children.size, changed };
}

/** A compound with nothing left in it — at the start, between two combinators
 *  or at the end — is `*`. A selector written relative (`:has(> x)`) keeps its
 *  leading combinator bare. */
function fillEmptyCompounds(children: List<CssNode>, relative: boolean): void {
  const universal = (): CssNode => ({ type: "TypeSelector", name: "*" });
  if (children.isEmpty) {
    children.appendData(universal());
    return;
  }
  let previousCombinator = !relative;
  children.forEach((node, item) => {
    const combinator = node.type === "Combinator";
    if (combinator && previousCombinator) children.insertData(universal(), item);
    previousCombinator = combinator;
  });
  if (previousCombinator) children.appendData(universal());
}
