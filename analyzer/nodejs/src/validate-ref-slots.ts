/**
 * Static validation of the `x-telo-ref` annotation itself — the strict half of
 * the accessor split. `readRefSlot` is deliberately lenient (it normalizes
 * whatever it can read, because every surface must keep working mid-migration);
 * this pass reads the RAW annotation and reports what leniency would otherwise
 * silently absorb:
 *
 *  - an unrecognized `use` token — a typo like `use: cal` would degrade to the
 *    legacy no-use reading, indistinguishable from a slot that never answered;
 *  - a structured annotation with no `kind` — the editor would recognise the
 *    slot but have nothing to pick against;
 *  - a structured annotation with no `use` — the structured form is the
 *    declaration that answers the question; omitting it is only legal in the
 *    legacy bare-string spelling;
 *  - `anyOf` branches whose declared uses disagree — a state with no meaning,
 *    since `use` is a property of the slot, never of a branch;
 *  - a `use` case map whose selector is written in CEL — a call graph known
 *    only at runtime is not statically analyzable, which is the property the
 *    typed reference graph exists to protect. There is deliberately no
 *    fallback: no single value is conservative for every consumer.
 *
 * Scoping follows `X_TELO_REF_UNRESOLVED`: schema issues are reported only for
 * definitions in the entry's own modules, and the dynamic-selector issue only
 * for manifests in them — a published dependency's slot is not the consumer's
 * to fix.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { buildCallGraph, type CallGraph } from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isRefUse, REF_USES, type RefUse } from "./ref-slot.js";

export interface RefSlotIssue {
  code:
    | "X_TELO_REF_INVALID_USE"
    | "X_TELO_REF_MISSING_USE"
    | "X_TELO_REF_MISSING_KIND"
    | "X_TELO_REF_USE_CONFLICT"
    | "X_TELO_REF_DYNAMIC_SELECTOR";
  /** The definition (schema issues) or resource (selector issues) at fault. */
  manifest: ResourceManifest;
  /** Schema path of the slot (schema issues) or concrete value path of the
   *  selector's site (dynamic-selector issues). */
  path: string;
  message: string;
}

const VALID_USES = REF_USES.join(", ");

/** Raw `use` tokens carried by one annotation value: scalar, list, and every
 *  case of a case map. Returned unfiltered so a typo is visible. */
function rawUseTokens(use: unknown): unknown[] {
  if (use === undefined) return [];
  if (Array.isArray(use)) return use;
  if (use && typeof use === "object") {
    const cases = (use as Record<string, unknown>).cases;
    if (!cases || typeof cases !== "object") return [];
    return Object.values(cases as Record<string, unknown>).flatMap((v) =>
      Array.isArray(v) ? v : [v],
    );
  }
  return [use];
}

/** The declared fixed uses of one annotation (scalar/list form only), for the
 *  branch-disagreement check. */
function declaredUses(use: unknown): RefUse[] {
  if (isRefUse(use)) return [use];
  if (Array.isArray(use)) return use.filter(isRefUse);
  return [];
}

function checkAnnotation(
  annotation: unknown,
  manifest: ResourceManifest,
  path: string,
  issues: RefSlotIssue[],
): RefUse[] | undefined {
  if (typeof annotation === "string" || annotation === undefined) return undefined;
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) return undefined;
  const obj = annotation as Record<string, unknown>;

  const kind = obj.kind;
  const hasKind =
    (typeof kind === "string" && kind.length > 0) ||
    (Array.isArray(kind) && kind.some((k) => typeof k === "string" && k.length > 0));
  if (!hasKind) {
    issues.push({
      code: "X_TELO_REF_MISSING_KIND",
      manifest,
      path,
      message:
        `x-telo-ref at '${path}' declares no 'kind'. The structured form is ` +
        `'{ kind: <Alias>.<Kind> | [<kinds>], use: <use> }' — without a kind the slot ` +
        `constrains nothing and the editor has nothing to pick against.`,
    });
  }

  const use = obj.use;
  const isCaseMap =
    !!use && typeof use === "object" && !Array.isArray(use) && "by" in (use as object);
  if (use === undefined) {
    issues.push({
      code: "X_TELO_REF_MISSING_USE",
      manifest,
      path,
      message:
        `x-telo-ref at '${path}' declares no 'use'. The structured form must say what the ` +
        `declaring resource does with the target — one of: ${VALID_USES} — or a ` +
        `'{ by, cases }' map when a sibling config field selects the mode. Only the legacy ` +
        `bare-string spelling ('x-telo-ref: <Kind>') may omit it.`,
    });
  } else {
    for (const token of rawUseTokens(use)) {
      if (isRefUse(token)) continue;
      issues.push({
        code: "X_TELO_REF_INVALID_USE",
        manifest,
        path,
        message:
          `x-telo-ref at '${path}' declares unrecognized use '${String(token)}'. ` +
          `Valid uses: ${VALID_USES}. An unrecognized token would silently degrade the slot ` +
          `to the legacy no-use reading.`,
      });
    }
    if (isCaseMap) {
      const by = (use as Record<string, unknown>).by;
      if (typeof by !== "string" || !by.startsWith("/")) {
        issues.push({
          code: "X_TELO_REF_INVALID_USE",
          manifest,
          path,
          message:
            `x-telo-ref at '${path}' has a 'use' case map whose 'by' is not a JSON Pointer. ` +
            `'by' names a sibling field of the object enclosing the slot, e.g. '/detach'.`,
        });
      }
    }
  }

  return declaredUses(use);
}

/** True when a node is a reference slot: it carries `x-telo-ref` directly or on
 *  an `anyOf`/`oneOf` branch. */
function carriesRefAnnotation(obj: Record<string, unknown>): boolean {
  if (obj["x-telo-ref"] !== undefined) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = obj[key];
    if (!Array.isArray(branches)) continue;
    if (
      branches.some(
        (b) => b && typeof b === "object" && (b as Record<string, unknown>)["x-telo-ref"] !== undefined,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Walk a definition schema, invoking `onSlot` for every node that carries an
 *  `x-telo-ref` (directly or on an `anyOf`/`oneOf` branch — the SLOT is the
 *  node holding the branches, so a branch is never reported twice). Pure-schema
 *  walk, so it needs — and has — a visited guard for cyclic `$defs`. */
function walkSchema(
  node: unknown,
  path: string,
  visited: Set<object>,
  claimedBranches: Set<object>,
  onSlot: (node: Record<string, unknown>, path: string) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (visited.has(node as object)) return;
  visited.add(node as object);
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSchema(item, `${path}[${i}]`, visited, claimedBranches, onSlot));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (carriesRefAnnotation(obj) && !claimedBranches.has(obj)) {
    onSlot(obj, path);
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = obj[key];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (branch && typeof branch === "object") claimedBranches.add(branch as object);
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "x-telo-ref" || key === "examples" || key === "default") continue;
    walkSchema(value, path ? `${path}.${key}` : key, visited, claimedBranches, onSlot);
  }
}

/** Schema-level checks over one definition/abstract manifest. */
export function validateRefSlotDeclarations(definition: ResourceManifest): RefSlotIssue[] {
  const issues: RefSlotIssue[] = [];
  const schema = (definition as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object") return issues;

  walkSchema(schema, "schema", new Set(), new Set(), (node, path) => {
    const branchUses: RefUse[][] = [];
    const own = checkAnnotation(node["x-telo-ref"], definition, path, issues);
    if (own) branchUses.push(own);
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, i) => {
        if (!branch || typeof branch !== "object") return;
        const declared = checkAnnotation(
          (branch as Record<string, unknown>)["x-telo-ref"],
          definition,
          `${path}.${key}[${i}]`,
          issues,
        );
        if (declared) branchUses.push(declared);
      });
    }
    const nonEmpty = branchUses.filter((uses) => uses.length > 0);
    if (nonEmpty.length > 1) {
      const first = [...nonEmpty[0]].sort().join(",");
      const disagrees = nonEmpty.some((uses) => [...uses].sort().join(",") !== first);
      if (disagrees) {
        issues.push({
          code: "X_TELO_REF_USE_CONFLICT",
          manifest: definition,
          path,
          message:
            `x-telo-ref branches at '${path}' declare disagreeing uses ` +
            `(${nonEmpty.map((u) => u.join("|")).join(" vs ")}). 'use' is a property of the ` +
            `slot, never of a branch — declare several acceptable kinds as one ` +
            `'kind: [<kinds>]' list with one 'use'.`,
        });
      }
    }
  });

  return issues;
}

/** Manifest-level check: a `use` case map whose selector is written in CEL.
 *  Reads the built graph's `unresolvedReason`, so the detection lives once, in
 *  `resolveUseAtSite`, and this pass cannot disagree with what consumers saw. */
export function validateDynamicSelectors(
  allManifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  graph?: CallGraph,
): RefSlotIssue[] {
  const issues: RefSlotIssue[] = [];
  const callGraph = graph ?? buildCallGraph(allManifests, registry, { aliases, aliasesByModule });
  for (const edge of callGraph.edges) {
    if (edge.unresolvedReason !== "dynamic") continue;
    const from = callGraph.nodes.get(edge.from);
    const owner =
      from?.type === "step" ? callGraph.nodes.get(from.owner) : from;
    if (!owner || owner.type !== "resource") continue;
    // Anchor at the SELECTOR — the field the author must change — not at the
    // ref slot several lines away. Derivable: the slot's enclosing path plus
    // the pointer's segments.
    const selectorPath = selectorPathOf(edge.path, edge.unresolved?.by ?? "");
    issues.push({
      code: "X_TELO_REF_DYNAMIC_SELECTOR",
      manifest: owner.manifest,
      path: selectorPath,
      message:
        `The mode selector at '${selectorPath}' is a CEL expression, so which 'use' holds ` +
        `for the reference at '${edge.path}' cannot be resolved statically. The selector must ` +
        `be a literal or take its schema default — a call graph known only at runtime is not ` +
        `statically analyzable. Write the mode as a literal, or split the wiring into one ` +
        `resource per mode.`,
    });
  }
  return issues;
}

/** Concrete path of a case-map selector: the slot's enclosing path joined with
 *  the pointer's segments (`steps[0].invoke` + `/detach` → `steps[0].detach`). */
function selectorPathOf(slotPath: string, pointer: string): string {
  const lastDot = slotPath.lastIndexOf(".");
  const enclosing = lastDot < 0 ? "" : slotPath.slice(0, lastDot);
  const segments = pointer
    .replace(/^\//, "")
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
  return enclosing ? `${enclosing}.${segments}` : segments;
}
