import { childNodes, parseSyntax, type CelNode } from "@telorun/cel";
import { isCompiledValue } from "@telorun/sdk";

/**
 * Which request headers an expression evaluated per request reads — what its
 * answer varies by. Read off the parsed expression: `request.headers.<name>`,
 * `request.headers['<name>']`, `'<name>' in request.headers` read one header; any
 * other use of `request.headers` or of `request` whole — a computed name, the map
 * handed on — may read any, which is `*`.
 */
export type HeaderReads = ReadonlySet<string> | "*";

const ANY = "*" as const;

const isRequest = (node: CelNode): boolean => node.kind === "ident" && node.name === "request";
const isHeaders = (node: CelNode): boolean =>
  node.kind === "select" && node.field === "headers" && isRequest(node.operand);
const stringLiteral = (node: CelNode): string | undefined =>
  node.kind === "literal" && node.literal.type === "string" ? node.literal.value : undefined;

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
      if (name === undefined) any = true;
      else names.add(name.toLowerCase());
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

/** The headers a configured expression reads: none for a literal, `*` for one whose text cannot be read. */
export function headerReads(value: unknown): HeaderReads {
  if (!isCompiledValue(value)) return new Set();
  if (typeof value.source !== "string") return ANY;
  const parsed = parseSyntax(value.source);
  return parsed.diagnostics.length === 0 ? treeReads(parsed.root) : ANY;
}
