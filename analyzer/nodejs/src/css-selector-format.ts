/** The Node checker for the `css-selector` Telo format.
 *
 *  The grammar is Selectors Level 4's `<complex-selector-list>` in the snapshot
 *  profile — no pseudo-elements, no namespace prefixes, no nesting selector, no
 *  leading combinator — and the authority is the spec plus the entry's
 *  conformance set. `css-selector-parser` tokenizes; what it accepts beyond the
 *  spec is refused here (a relative selector outside `:has()`, `:has()` nested in
 *  `:has()`), and the one spec form it cannot read — a selector LIST after `of`
 *  in `:nth-child()` — is handed to it as the equivalent `:is(<list>)`.
 *  Browser-safe. */

import { createParser, type AstRule, type AstSelector } from "css-selector-parser";
import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

const parse = createParser({
  syntax: { baseSyntax: "selectors-4", pseudoElements: false, namespace: false },
  strict: true,
});

/** The parser's own sentence carries a fixed prefix and a trailing `Pos: N.`;
 *  the position travels separately, so only the reason is kept. */
const PREFIX = /^css-selector-parser parse error:\s*/;
const POSITION_SUFFIX = /\s*Pos:\s*-?\d+\.?\s*$/;

interface Rewritten {
  readonly text: string;
  /** Maps an offset in `text` back to the author's text. */
  readonly original: (offset: number) => number;
}

/** Index of the `)` closing the `(` at `open`, skipping strings, escapes and
 *  nested parentheses; -1 when unbalanced. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Offsets of the top-level occurrences of `ch` in `text`, outside strings and
 *  parentheses. */
function topLevel(text: string, test: (i: number) => boolean): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && test(i)) found.push(i);
  }
  return found;
}

const NTH_OF = /:nth-(last-)?child\(/gi;

/** One pass of {@link withOfListsAsIs}, over the outermost occurrences. */
function rewriteOnce(text: string): Rewritten & { readonly changed: boolean } {
  const insertions: { at: number; length: number }[] = [];
  let out = "";
  let cursor = 0;
  NTH_OF.lastIndex = 0;
  for (let match = NTH_OF.exec(text); match; match = NTH_OF.exec(text)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(text, open);
    if (close < 0) break;
    const argument = text.slice(open + 1, close);
    const of = topLevel(argument, (i) => /\s/.test(argument[i - 1] ?? "") && /^of\s/i.test(argument.slice(i)))[0];
    if (of === undefined) continue;
    const listStart = open + 1 + of + 2;
    const list = text.slice(listStart, close);
    // Nothing to rewrite here: look inside for a nested one.
    if (topLevel(list, (i) => list[i] === ",").length === 0) continue;
    NTH_OF.lastIndex = close;
    out += text.slice(cursor, listStart) + " :is(";
    insertions.push({ at: out.length - 5, length: 5 });
    out += list + ")";
    insertions.push({ at: out.length - 1, length: 1 });
    cursor = close;
  }
  out += text.slice(cursor);
  return {
    text: out,
    changed: insertions.length > 0,
    original: (offset) =>
      offset - insertions.filter((insertion) => insertion.at < offset).reduce((n, i) => n + i.length, 0),
  };
}

/**
 * `:nth-child(An+B of S1, S2)` → `:nth-child(An+B of :is(S1, S2))`, which means
 * the same thing and is a form the parser reads — repeated until nested ones are
 * rewritten too. Offsets are mapped back so a failure inside the list still
 * points at what the author wrote.
 */
export function withOfListsAsIs(text: string): Rewritten {
  let current: Rewritten = { text, original: (offset) => offset };
  for (;;) {
    const pass = rewriteOnce(current.text);
    if (!pass.changed) return current;
    const previous = current.original;
    current = { text: pass.text, original: (offset) => previous(pass.original(offset)) };
  }
}

/** Why a selector the parser read is still not in the grammar, or undefined.
 *  Pseudo-classes are visited in source order, so each is located by searching
 *  forward from the previous one. */
function specProblem(selector: AstSelector, text: string): TeloFormatFailure | undefined {
  const lower = text.toLowerCase();
  let cursor = 0;
  const locate = (name: string): number => {
    const index = lower.indexOf(`:${name}`, cursor);
    if (index < 0) return 0;
    cursor = index + 1;
    return index;
  };
  const inSelector = (
    sel: AstSelector,
    inHas: boolean,
    enclosing: { name: string; offset: number } | undefined,
  ): TeloFormatFailure | undefined => {
    for (const rule of sel.rules) {
      if (rule.combinator && enclosing) {
        return {
          reason: `A leading combinator is valid only in :has(), not in :${enclosing.name}()`,
          offset: enclosing.offset,
        };
      }
      const problem = inRule(rule, inHas);
      if (problem) return problem;
    }
    return undefined;
  };
  const inRule = (rule: AstRule, inHas: boolean): TeloFormatFailure | undefined => {
    for (const item of rule.items) {
      if (item.type !== "PseudoClass") continue;
      const offset = locate(item.name);
      const argument = item.argument;
      let problem: TeloFormatFailure | undefined;
      if (item.name === "has") {
        if (inHas) return { reason: ":has() cannot be nested inside :has()", offset };
        if (argument?.type === "Selector") problem = inSelector(argument, true, undefined);
      } else if (argument?.type === "Selector") {
        problem = inSelector(argument, inHas, { name: item.name, offset });
      } else if (argument?.type === "FormulaOfSelector") {
        if (argument.selector.combinator) {
          return { reason: `A leading combinator is not valid after 'of' in :${item.name}()`, offset };
        }
        problem = inRule(argument.selector, inHas);
      }
      if (problem) return problem;
    }
    return rule.nestedRule ? inRule(rule.nestedRule, inHas) : undefined;
  };
  return inSelector(selector, false, undefined);
}

export const cssSelectorChecker: TeloFormatChecker = {
  check(value) {
    const rewritten = withOfListsAsIs(value);
    let selector: AstSelector;
    try {
      selector = parse(rewritten.text);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const position = (err as { position?: unknown }).position;
      return {
        reason: raw.replace(PREFIX, "").replace(POSITION_SUFFIX, "").replace(/\.$/, ""),
        offset:
          typeof position === "number" && position >= 0 ? rewritten.original(position) : 0,
      };
    }
    const problem = specProblem(selector, rewritten.text);
    return problem ? { ...problem, offset: rewritten.original(problem.offset) } : undefined;
  },
};
