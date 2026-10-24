/**
 * Where `x-telo-caught-member` may be written — the strict half of
 * `caught-member.ts`.
 *
 * A mark is read only on a member of a binding of the `x-telo-context` a catch
 * list (`x-telo-outcome-list: catches`) declares; anywhere else — an
 * `x-telo-error-context` included — nothing reads it, and a `code` mark on a
 * member that is not a string cannot be compared with a code. Both are
 * `CAUGHT_MEMBER_MISPLACED`. A catch list whose context marks no `code` proves
 * coverage with no `when:` at all, which is `CAUGHT_MEMBER_MISSING`. Both are
 * warnings judged at the kind; the kernel reads no mark, so there is no
 * runtime twin. A value outside the vocabulary is `SCHEMA_VIOLATION`.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  CAUGHT_MEMBERS,
  X_TELO_CAUGHT_MEMBER,
  caughtMemberNodes,
  caughtMemberOf,
  catchListContext,
  isCatchListSchema,
} from "./caught-member.js";

export interface CaughtMemberProblem {
  code: "CAUGHT_MEMBER_MISPLACED" | "CAUGHT_MEMBER_MISSING" | "SCHEMA_VIOLATION";
  /** From the definition document (`schema.properties.catches.x-telo-context…`). */
  path: string;
  message: string;
}

/** The kind-document fields holding a schema. Only `schema:` declares fields,
 *  so only there can a catch list exist. */
const SCHEMA_FIELDS = ["schema", "status", "inputType", "outputType"] as const;

/** Data-bearing keywords: what is under them is a value, not a schema. */
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStringSchema = (node: Record<string, any>): boolean =>
  node.type === "string" || (Array.isArray(node.type) && node.type.length > 0 && node.type.every((t: unknown) => t === "string"));

/** Every mark a definition writes where nothing reads it, every catch list
 *  whose context marks no `code`, and every mark outside the vocabulary. */
export function caughtMemberProblems(definition: Record<string, any>): CaughtMemberProblem[] {
  const name = String(definition.metadata?.name);
  const out: CaughtMemberProblem[] = [];
  const legal = new Set<object>();
  const lists: Array<{ path: string; hasCode: boolean }> = [];

  // First the legal positions: the members of every catch list's context.
  const collectLists = (node: unknown, at: string, seen: Set<object>): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => collectLists(item, `${at}[${i}]`, seen));
      return;
    }
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    if (isCatchListSchema(node)) {
      let hasCode = false;
      for (const { node: member } of caughtMemberNodes(catchListContext(node))) {
        legal.add(member);
        if (caughtMemberOf(member) === "code" && isStringSchema(member)) hasCode = true;
      }
      lists.push({ path: at, hasCode });
    }
    for (const [key, child] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      collectLists(child, `${at}.${key}`, seen);
    }
  };
  collectLists(definition.schema, "schema", new Set());

  const scan = (node: unknown, at: string, seen: Set<object>): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => scan(item, `${at}[${i}]`, seen));
      return;
    }
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    if (Object.hasOwn(node, X_TELO_CAUGHT_MEMBER)) {
      const path = `${at}.${X_TELO_CAUGHT_MEMBER}`;
      const value = node[X_TELO_CAUGHT_MEMBER];
      const member = caughtMemberOf(node);
      if (member === undefined) {
        out.push({
          code: "SCHEMA_VIOLATION",
          path,
          message: `'${name}' declares \`${X_TELO_CAUGHT_MEMBER}: ${JSON.stringify(value)}\` at '${path}': it must be one of ${CAUGHT_MEMBERS.map((m) => `'${m}'`).join(", ")}.`,
        });
      } else if (!legal.has(node)) {
        out.push({
          code: "CAUGHT_MEMBER_MISPLACED",
          path,
          message:
            `'${name}' declares \`${X_TELO_CAUGHT_MEMBER}: ${member}\` at '${path}', where nothing reads it. ` +
            `A caught member is marked on a member of a binding of the \`x-telo-context\` a catch list ` +
            `(\`x-telo-outcome-list: catches\`) declares — never in an \`x-telo-error-context\`, whose \`error\` ` +
            `a step's \`catch:\` reads by name.`,
        });
      } else if (member === "code" && !isStringSchema(node)) {
        out.push({
          code: "CAUGHT_MEMBER_MISPLACED",
          path,
          message:
            `'${name}' marks a member that is not a string as the caught code at '${path}'. ` +
            `A code is compared with string literals in a \`when:\`, so the marked member must declare \`type: string\`.`,
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      scan(child, `${at}.${key}`, seen);
    }
  };
  for (const field of SCHEMA_FIELDS) scan(definition[field], field, new Set());

  for (const list of lists) {
    if (list.hasCode) continue;
    out.push({
      code: "CAUGHT_MEMBER_MISSING",
      path: list.path,
      message:
        `'${name}' declares a catch list at '${list.path}' whose context marks no member ` +
        `\`${X_TELO_CAUGHT_MEMBER}: code\`, so no \`when:\` can prove which codes an entry renders and every ` +
        `entry with one is read as undecided. Declare the caught error in the list's \`x-telo-context\` and ` +
        `mark its code member (\`code: { type: string, ${X_TELO_CAUGHT_MEMBER}: code }\`) and its data member ` +
        `(\`${X_TELO_CAUGHT_MEMBER}: data\`).`,
    });
  }
  return out;
}
