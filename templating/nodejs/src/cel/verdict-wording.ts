import { childNodes, type CelCheckDiagnostic, type CelNode, type SchemaDependency } from "@telorun/cel";
import { membersOf } from "@telorun/sdk";
import { memberReadPath } from "./analyze.js";

/**
 * The engine's verdicts as a site reports them: one finding per member read,
 * worded from the read as written and from the schema node the verdict names.
 *
 * The engine judges every member read, operand and nullable read; this only
 * phrases them. A read the engine refuses in several branches of a union is
 * one finding listing what every branch declares. A refused member is named by
 * its whole chain with the members the node declares, unless it is declared
 * absent; a nullable read by the value and the member read off it; a member
 * read off a stream by the stream and how to read one. Any other verdict, and
 * one whose read or node cannot be named, keeps the engine's own words.
 */
export function wordedVerdicts(
  source: string,
  ast: CelNode,
  diagnostics: readonly CelCheckDiagnostic[],
): CelCheckDiagnostic[] {
  const groups = new Map<string, CelCheckDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\0${diagnostic.range[0]}:${diagnostic.range[1]}`;
    const group = groups.get(key);
    if (group) group.push(diagnostic);
    else groups.set(key, [diagnostic]);
  }
  let reads: ReturnType<typeof memberReads> | undefined;
  const selectAt = (range: readonly [number, number]) => (reads ??= memberReads(ast)).selects.get(`${range[0]}:${range[1]}`);
  const indexAt = (range: readonly [number, number]) => (reads ??= memberReads(ast)).indexes.get(`${range[0]}:${range[1]}`);
  const out: CelCheckDiagnostic[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const select = first.code === "CEL_TYPE_ERROR" ? undefined : selectAt(first.range);
    const index = first.code === "CEL_NULLABLE_ACCESS" && !select ? indexAt(first.range) : undefined;
    const streamRead = first.code === "CEL_TYPE_ERROR" && isStream(first.schemaNode) ? selectAt(first.range) : undefined;
    const message =
      first.code === "CEL_UNKNOWN_FIELD" && select
        ? unknownMemberMessage(select, group)
        : first.code === "CEL_NULLABLE_ACCESS" && (select ?? index)
          ? nullableReadMessage(source, (select ?? index)!)
          : streamRead
            ? streamReadMessage(source, streamRead)
            : undefined;
    if (message !== undefined) {
      out.push({ ...first, message });
      continue;
    }
    const seen = new Set<string>();
    for (const diagnostic of group) {
      if (seen.has(diagnostic.message)) continue;
      seen.add(diagnostic.message);
      out.push(diagnostic);
    }
  }
  return out;
}

/** `'<chain>' is not defined (available: …)`, the members each branch's node
 *  declares; undefined where the read is no chain or a branch names no node. */
function unknownMemberMessage(
  select: Extract<CelNode, { kind: "select" }>,
  group: readonly CelCheckDiagnostic[],
): string | undefined {
  const path = memberReadPath(select);
  if (path === null) return undefined;
  // A member whose schema admits no value is declared, not missing: the
  // engine's words say so and name the presence read that reads it.
  if (group.some((diagnostic) => diagnostic.absent === true)) return undefined;
  const available: string[] = [];
  for (const diagnostic of group) {
    const names = declaredNames(diagnostic.schemaNode);
    if (!names) return undefined;
    for (const name of names) if (!available.includes(name)) available.push(name);
  }
  // A member some branch declares is read through a union: the engine's
  // words name `.?`.
  if (available.includes(select.field)) return undefined;
  return `'${path}' is not defined (available: ${available.length > 0 ? available.join(", ") : "none"})`;
}

/** The member names the node a verdict was judged at declares: a value
 *  type's members, else its own `properties`. */
function declaredNames(located: SchemaDependency | undefined): readonly string[] | undefined {
  const node = nodeAt(located);
  // A member only some shapes of a union declare keeps the engine's words, and
  // so does one read through an intersection, whose parts declare its members.
  if (!node || Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)) return undefined;
  const members = membersOf(node);
  if (members) return Object.keys(members);
  const properties = node.properties;
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

function nullableReadMessage(source: string, read: Extract<CelNode, { kind: "select" | "index" }>): string {
  const value = source.slice(read.operand.range[0], read.operand.range[1]).trim();
  const access = read.kind === "select" ? `.${read.field}` : "[index]";
  return `'${value}' may be null — guard it (e.g. '${value} != null && …' or '${value} == null ? … : ${value}${access}') before accessing '${access}'`;
}

/** Whether the node a verdict names declares a stream. */
function isStream(located: SchemaDependency | undefined): boolean {
  const type = nodeAt(located)?.["x-telo-type"];
  return (typeof type === "object" && type !== null ? type.name : type) === "Telo.Stream";
}

function streamReadMessage(source: string, read: Extract<CelNode, { kind: "select" }>): string {
  const value = source.slice(read.operand.range[0], read.operand.range[1]).trim();
  return `'${value}' is a Telo.Stream, which holds no members: hand it to a step that consumes a stream and read that step's result`;
}

/** The node `pointer` names in the document the engine read it from. */
function nodeAt(located: SchemaDependency | undefined): Record<string, any> | undefined {
  if (!located) return undefined;
  let current: unknown = located.document;
  if (located.pointer !== "") {
    for (const raw of located.pointer.slice(1).split("/")) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
  }
  return current !== null && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, any>)
    : undefined;
}

/** Every member read of the tree by where the engine ranges its verdict: a
 *  select by its member, an index by the whole read. */
function memberReads(ast: CelNode) {
  const selects = new Map<string, Extract<CelNode, { kind: "select" }>>();
  const indexes = new Map<string, Extract<CelNode, { kind: "index" }>>();
  const visit = (node: CelNode): void => {
    if (node.kind === "select") selects.set(`${node.fieldRange[0]}:${node.fieldRange[1]}`, node);
    if (node.kind === "index") indexes.set(`${node.range[0]}:${node.range[1]}`, node);
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast);
  return { selects, indexes };
}
