/** Parsing a `css-selector` value into the AST the matcher walks.
 *
 *  The grammar is the Telo format's (Selectors Level 4, checked by `telo check`
 *  and at creation). `css-selector-parser` tokenizes it, except for the list
 *  after `of` in `:nth-child()`, which it cannot read: that is handed to it as
 *  the equivalent `:is(<list>)`. */

import { createParser, type AstSelector } from "css-selector-parser";

const parser = createParser({
  syntax: { baseSyntax: "selectors-4", pseudoElements: false, namespace: false },
  strict: true,
});

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

function rewriteOnce(text: string): string {
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
    if (topLevel(list, (i) => list[i] === ",").length === 0) continue;
    out += `${text.slice(cursor, listStart)} :is(${list})`;
    cursor = close;
    NTH_OF.lastIndex = close;
  }
  return out + text.slice(cursor);
}

const parsed = new Map<string, AstSelector>();

export function parseSelector(selector: string): AstSelector {
  let ast = parsed.get(selector);
  if (!ast) {
    let text = selector;
    for (let next = rewriteOnce(text); next !== text; next = rewriteOnce(text)) text = next;
    ast = parser(text);
    parsed.set(selector, ast);
  }
  return ast;
}
