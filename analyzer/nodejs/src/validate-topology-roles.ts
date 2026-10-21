/**
 * What `x-telo-topology-role` may say, and where a `matcher` may sit — the
 * strict half of `topology-role.ts`.
 *
 * A matcher is read in two places and nowhere else:
 *
 *  - a direct property of the items of a top-level `entries` list, which
 *    identifies that entry;
 *  - a top-level property of a kind whose top level reaches a trigger slot
 *    (a `use` holding `trigger.inbound` or `trigger.consumer`, a case map's
 *    cases included) outside every entry list, which labels each such slot.
 *
 * Anywhere else nothing reads it, so it is reported as
 * `TOPOLOGY_ROLE_MISPLACED`; a role outside the closed vocabulary is read as
 * none, and reported as `TOPOLOGY_ROLE_UNKNOWN`. Both are warnings, since the
 * kind works the same with or without the annotation. The kernel reads no role,
 * so there is no runtime twin.
 *
 * Browser-safe: no Node built-ins.
 */
import { isTriggerUse, possibleUses, topFieldOf } from "./ref-slot.js";
import { declaredReach, refSlotOfEntry } from "./reference-reach.js";
import { nearestName } from "./nearest-name.js";
import {
  entryListsOf,
  rootMatchersOf,
  TOPOLOGY_ROLES,
  topologyRoleOf,
  unknownTopologyRole,
} from "./topology-role.js";
import { schemaChildren } from "./value-schema-slot.js";

export interface TopologyRoleProblem {
  code: "TOPOLOGY_ROLE_MISPLACED" | "TOPOLOGY_ROLE_UNKNOWN";
  /** Where the annotation is written, from the definition document
   *  (`schema.properties.a.properties.b.x-telo-topology-role`). */
  path: string;
  message: string;
}

/** Does the schema's top level reach a trigger slot outside its entry lists? */
function reachesRootTrigger(schema: Record<string, any>, entryFields: ReadonlySet<string>): boolean {
  return declaredReach(schema).references.some(
    (reference) =>
      !entryFields.has(topFieldOf(reference.path)) &&
      reference.entries.some((entry) => possibleUses(refSlotOfEntry(entry)).some(isTriggerUse)),
  );
}

/**
 * Every role a definition's own `schema:` writes outside the vocabulary, and
 * every `matcher` it writes where nothing reads it.
 *
 * `authorSchema` is the schema whose slots the kind's resources carry — the
 * merged one for a child extending without `base:` — so a trigger slot the kind
 * inherits makes a matcher at its own top level legal.
 */
export function topologyRoleProblems(
  definition: { metadata?: { name?: unknown }; schema?: unknown },
  authorSchema?: Record<string, any>,
): TopologyRoleProblem[] {
  const schema = definition.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const own = schema as Record<string, any>;
  const reachSchema = authorSchema ?? own;

  const legal = new Set<object>();
  const lists = entryListsOf(own);
  for (const list of lists) for (const node of list.matcherNodes) legal.add(node);
  const rootMatchers = rootMatchersOf(own);
  const entryFields = new Set(entryListsOf(reachSchema).map((list) => list.field));
  const rootLegal = reachesRootTrigger(reachSchema, entryFields);
  if (rootLegal) for (const { node } of rootMatchers) legal.add(node);
  const atRoot = new Set<object>(rootMatchers.map(({ node }) => node));

  const name = String(definition.metadata?.name);
  const out: TopologyRoleProblem[] = [];
  const seen = new Set<object>();
  const scan = (node: Record<string, any>, at: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const unknown = unknownTopologyRole(node);
    if (unknown) {
      const path = `${at}.x-telo-topology-role`;
      const written = typeof unknown.value === "string" ? `'${unknown.value}'` : JSON.stringify(unknown.value);
      const suggestion = typeof unknown.value === "string" ? nearestName(unknown.value, TOPOLOGY_ROLES) : undefined;
      out.push({
        code: "TOPOLOGY_ROLE_UNKNOWN",
        path,
        message:
          `'${name}' declares \`x-telo-topology-role: ${written}\` at '${path}', which is not a topology role, ` +
          `so nothing reads it. ${suggestion ? `Did you mean '${suggestion}'? ` : ""}` +
          `The roles are: ${TOPOLOGY_ROLES.join(", ")}.`,
      });
    }
    if (topologyRoleOf(node) === "matcher" && !legal.has(node)) {
      const path = `${at}.x-telo-topology-role`;
      const reason = atRoot.has(node)
        ? "no top-level reference slot of the kind outside an entry list is a trigger (`use: trigger.inbound` or `trigger.consumer`), so there is nothing for it to label"
        : "it is neither a top-level property of the kind nor a property of the items of a top-level `entries` list";
      out.push({
        code: "TOPOLOGY_ROLE_MISPLACED",
        path,
        message:
          `'${name}' declares \`x-telo-topology-role: matcher\` at '${path}', where nothing reads it: ` +
          `${reason}. A matcher belongs on a property of the items of a top-level \`entries\` list, ` +
          `where it identifies the entry, or on a top-level property of a kind whose top-level trigger ` +
          `slots it labels.`,
      });
    }
    for (const child of schemaChildren(node)) {
      const under = `${at}.${child.keyword}`;
      scan(
        child.schema,
        child.at === undefined ? under : typeof child.at === "number" ? `${under}[${child.at}]` : `${under}.${child.at}`,
      );
    }
  };
  scan(own, "schema");
  return out;
}
