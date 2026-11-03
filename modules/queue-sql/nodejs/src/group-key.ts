/**
 * How a message's group is read from its stored body.
 *
 * `groupBy` is an accessor field, so the kernel hands the controller a binding
 * — `{ root: "message", path }` for a chain, `{ value }` for a literal — and
 * never evaluates it. The store reads the chain off the body it is given, which
 * is the message's plain JSON: a string member stays the same string there.
 */
export type GroupBy =
  | { readonly kind: "chain"; readonly path: readonly string[] }
  | { readonly kind: "constant"; readonly value: string };

/** The `groupBy` binding as the kernel delivered it, or undefined when the
 *  queue declares none. */
export function groupByOf(describe: string, binding: unknown): GroupBy | undefined {
  if (binding === undefined || binding === null) return undefined;
  if (typeof binding === "object") {
    const candidate = binding as { root?: unknown; path?: unknown; value?: unknown };
    if (
      candidate.root === "message" &&
      Array.isArray(candidate.path) &&
      candidate.path.every((segment) => typeof segment === "string")
    ) {
      return { kind: "chain", path: candidate.path as string[] };
    }
    if ("value" in candidate && typeof candidate.value === "string") {
      return { kind: "constant", value: candidate.value };
    }
  }
  throw new Error(
    `${describe}: 'groupBy' arrived as ${JSON.stringify(binding)}, which is neither a chain over ` +
      `'message' nor a string.`,
  );
}

/**
 * The group of the message whose body is `body`, or the reason it has none: the
 * member the chain names is absent, null or not a string. On a grouped queue
 * every message must name its group — a message with none could overtake the
 * order its group promises — so the store refuses such an item.
 */
export function groupKeyOf(groupBy: GroupBy, body: string): { key: string } | { refused: string } {
  if (groupBy.kind === "constant") return { key: groupBy.value };
  const at = `message.${groupBy.path.join(".")}`;
  let node: unknown = JSON.parse(body);
  for (const segment of groupBy.path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return { refused: `has no ${at}` };
    node = (node as Record<string, unknown>)[segment];
  }
  if (node === undefined) return { refused: `has no ${at}` };
  if (typeof node !== "string") {
    return { refused: `holds ${JSON.stringify(node)} at ${at}, which is not a string` };
  }
  return { key: node };
}
