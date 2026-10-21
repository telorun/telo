import { childNodes, parseSyntax, type CelNode } from "@telorun/cel";
import { isCompiledValue } from "@telorun/sdk";

/**
 * Which request headers the expressions an application evaluates per request
 * read — what its documents' `Vary` names. Read off each expression as parsed:
 * `request.headers.<name>`, `request.headers['<name>']`, `'<name>' in
 * request.headers` and `has(request.headers.<name>)` read one header; any other
 * use of `request.headers` or of `request` whole — a computed name, the map
 * handed on — may read any, which is `*`.
 */
export type HeaderReads = ReadonlySet<string> | "*";

const ANY = "*" as const;

const isRequest = (node: CelNode): boolean => node.kind === "ident" && node.name === "request";
const isHeaders = (node: CelNode): boolean =>
  node.kind === "select" && node.field === "headers" && isRequest(node.operand);
const stringLiteral = (node: CelNode): string | undefined =>
  node.kind === "literal" && node.literal.type === "string" ? node.literal.value : undefined;

/** The headers one parsed expression reads, lowercased, or `*`. */
function treeReads(root: CelNode): HeaderReads {
  const names = new Set<string>();
  let any = false;
  const visit = (node: CelNode): void => {
    if (any) return;
    if (node.kind === "select" && isHeaders(node.operand)) {
      names.add(node.field.toLowerCase());
      return;
    }
    if (node.kind === "index" && isHeaders(node.operand)) {
      const name = stringLiteral(node.index);
      if (name === undefined) any = true;
      else names.add(name.toLowerCase());
      return;
    }
    if (node.kind === "binary" && node.operator === "in" && isHeaders(node.right)) {
      const name = stringLiteral(node.left);
      if (name === undefined) {
        any = true;
        return;
      }
      names.add(name.toLowerCase());
      return;
    }
    if (isHeaders(node)) {
      any = true;
      return;
    }
    if (node.kind === "select" && isRequest(node.operand)) return;
    if (isRequest(node)) {
      any = true;
      return;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return any ? ANY : names;
}

/**
 * The expressions an `!interpolate` text holds: the text of each `${{ … }}`
 * hole, read as the hole grammar reads it — a string literal may hold `}}`.
 */
function holes(source: string): string[] | undefined {
  const out: string[] = [];
  let at = source.indexOf("${{");
  while (at >= 0) {
    let index = at + 3;
    let quote: string | undefined;
    for (; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === "}" && source[index + 1] === "}") break;
    }
    if (index >= source.length) return undefined;
    out.push(source.slice(at + 3, index));
    at = source.indexOf("${{", index + 2);
  }
  return out;
}

/** The headers a compiled expression reads, or `*` when its text cannot be read. */
function expressionReads(source: string): HeaderReads {
  const parsed = parseSyntax(source);
  if (parsed.diagnostics.length === 0) return treeReads(parsed.root);
  const expressions = holes(source);
  if (!expressions || expressions.length === 0) return ANY;
  const names = new Set<string>();
  for (const expression of expressions) {
    const hole = parseSyntax(expression);
    if (hole.diagnostics.length > 0) return ANY;
    const reads = treeReads(hole.root);
    if (reads === ANY) return ANY;
    for (const name of reads) names.add(name);
  }
  return names;
}

/** The headers every expression held in `values` reads, at any depth. */
export function headerReads(...values: unknown[]): HeaderReads {
  const names = new Set<string>();
  const pending = [...values];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (!isCompiledValue(value) && !Array.isArray(value) && prototype !== Object.prototype && prototype !== null) continue;
    if (isCompiledValue(value)) {
      if (value.refs !== undefined && !value.refs.includes("request")) continue;
      if (typeof value.source !== "string") return ANY;
      const reads = expressionReads(value.source);
      if (reads === ANY) return ANY;
      for (const name of reads) names.add(name);
      continue;
    }
    pending.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return names;
}

/** Both sets of reads as one. */
export function unionReads(...reads: HeaderReads[]): HeaderReads {
  const names = new Set<string>();
  for (const each of reads) {
    if (each === ANY) return ANY;
    for (const name of each) names.add(name);
  }
  return names;
}

/** `Vary`'s value for what was read: the header names, each as HTTP writes it. */
export function varyHeader(reads: HeaderReads): string | undefined {
  if (reads === ANY) return ANY;
  if (reads.size === 0) return undefined;
  return [...reads]
    .sort()
    .map((name) => name.replace(/(?:^|-)[a-z]/g, (start) => start.toUpperCase()))
    .join(", ");
}
