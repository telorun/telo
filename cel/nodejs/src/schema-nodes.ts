/**
 * Which schema node each verdict and the result was read from — the answer a host words a
 * finding from, and compares a forwarded value's schema against.
 *
 * **A type is read from the node that built it.** A node whose type is another node's — a
 * reference's target, a document the host's resolver answered, the one branch a union kept
 * — was read from that node, so a member read through `$ref` names the referenced node and
 * not the reference. A node that combined several parts — a `type` list, an intersection, a
 * union of branches — built its type itself; each member of a union is read from the first
 * branch holding it, and each member of an intersection from the one part typing it, from
 * none where several do. Conversion records this beside each member and each union member
 * (`SchemaProvenance`), so a check only looks it up.
 *
 * **A subexpression is located where its type came straight from a schema node**: a name
 * registered from a schema, a member or element read out of a type a conversion built, a
 * namespaced result declared as a schema, a name a macro bound to such a value, a guarded
 * chain at the branch its guard left, and an optional wrapping such a value (`.?a`,
 * `optional.of(x)`, `optMap`) — for a verdict the wrapping is transparent. A computed value
 * — a literal, an operator's or a function's result, a conditional, a union's members read
 * together — is located nowhere, so a verdict about it names no node.
 *
 * **A result lists every place it may have come from** (`ResultOrigin`), in written order: a
 * located read is one origin; a read over a union whose branches are located at different
 * nodes is one origin per distinct node, in member order, the branches located nowhere
 * sharing one; a conditional contributes its branches' origins in turn, each as its branch
 * was typed; `cel.bind` and `optFlatMap` contribute those of the expression they answer;
 * `optional.of`, `optional.ofNonZeroValue`, `optMap` and a read through an optional operand
 * (`.?a`, `[?k]`) are one origin with the wrapping's own type and range; anything computed
 * is one origin carrying its type alone. **An origin typed `optional<…>` carries no schema
 * node**, since no optional is an instance of one: an origin names a node only where its
 * value is an instance of it.
 *
 * Every node named here is one the same check lists among its `schemaDependencies`: each
 * is reached through a reading the recorder walks.
 */

import { formatType, recordMemberTypes, unionOf, withoutParameters, type CelType } from "./cel-type.js";
import type { EdgeKey, SchemaDependency, SchemaProvenance } from "./schema-dependencies.js";
import type { CelNode, SourceRange } from "./syntax-tree.js";
import { countTypeVisit } from "./type-visits.js";

/** One place a check's result may have come from. */
export interface ResultOrigin {
  /** The subexpression the value comes from. */
  readonly range: SourceRange;
  /** Its type, every unresolved type parameter `dyn`. */
  readonly type: CelType;
  /** How that type is written. */
  readonly typeName: string;
  /** The schema node it was read straight from, where it was. */
  readonly schemaNode?: SchemaDependency;
}

/** What one branch of a read over a union answered, and the node it was read from. */
export interface BranchRead {
  readonly type: CelType;
  readonly schemaNode: SchemaDependency | undefined;
}

/** A subexpression whose value is another's, with the type that one was checked as. */
type Relayed = readonly [node: CelNode, type: CelType];

/** The nodes one check has located, and the registrations it read them through. */
export class SchemaNodeLocator {
  private readonly touched: SchemaProvenance[] = [];
  private readonly located = new Map<CelNode, SchemaDependency>();
  private readonly relays = new Map<CelNode, readonly Relayed[]>();
  private readonly unionReads = new Map<CelNode, readonly BranchRead[]>();

  /** A registration read: the node its type was read from. */
  registration(provenance: SchemaProvenance | undefined): SchemaDependency | undefined {
    if (!provenance) return undefined;
    if (!this.touched.includes(provenance)) this.touched.push(provenance);
    return provenance.rootNode;
  }

  /** The node a container's member was read from, by field name or `*`. */
  member(container: CelType, key: EdgeKey): SchemaDependency | undefined {
    for (const provenance of this.touched) {
      const held = provenance.memberNodes.get(container)?.get(key);
      if (held) return held;
    }
    return undefined;
  }

  /** The node a union's member at `at` was read from. */
  unionMember(union: CelType, at: number): SchemaDependency | undefined {
    for (const provenance of this.touched) {
      const held = provenance.unionNodes.get(union)?.[at];
      if (held) return held;
    }
    return undefined;
  }

  locate(node: CelNode, at: SchemaDependency | undefined): void {
    if (at) this.located.set(node, at);
  }

  at(node: CelNode): SchemaDependency | undefined {
    return this.located.get(node);
  }

  /** Says `node`'s value is one of `answers`', each checked as its type, in written order. */
  relay(node: CelNode, answers: readonly Relayed[]): void {
    this.relays.set(node, answers);
  }

  /** Says `node` read a member of each branch of a union, in member order. */
  unionRead(node: CelNode, branches: readonly BranchRead[]): void {
    if (branches.length > 0) this.unionReads.set(node, branches);
  }

  /** Every place `node`'s value, checked as `type`, may have come from, in written order. */
  origins(node: CelNode, type: CelType): ResultOrigin[] {
    const origins: ResultOrigin[] = [];
    const pending: Relayed[] = [[node, type]];
    while (pending.length > 0) {
      const [at, checked] = pending.pop()!;
      const relayed = this.relays.get(at);
      if (relayed) {
        for (let index = relayed.length - 1; index >= 0; index -= 1) pending.push(relayed[index]!);
        continue;
      }
      const branches = this.unionReads.get(at);
      if (branches) {
        for (const group of groupedByNode(branches)) origins.push(origin(at.range, group.type, group.schemaNode));
        continue;
      }
      origins.push(origin(at.range, checked, this.located.get(at)));
    }
    return origins;
  }
}

function origin(range: SourceRange, type: CelType, schemaNode: SchemaDependency | undefined): ResultOrigin {
  const reported = withoutParameters(type);
  const instance = schemaNode !== undefined && !holdsOptional(reported);
  return { range, type: reported, typeName: formatType(reported, true), ...(instance ? { schemaNode } : {}) };
}

/** Whether a type holds an optional at any depth, each type object walked once: no value of it is an instance of a schema node. */
function holdsOptional(type: CelType): boolean {
  const pending: CelType[] = [type];
  const seen = new Set<CelType>();
  while (pending.length > 0) {
    const at = pending.pop()!;
    countTypeVisit();
    if (seen.has(at)) continue;
    seen.add(at);
    switch (at.kind) {
      case "optional":
        return true;
      case "list":
        pending.push(at.element);
        break;
      case "map":
        pending.push(at.key, at.value);
        break;
      case "union":
        pending.push(...at.members);
        break;
      case "record":
        pending.push(...recordMemberTypes(at));
        break;
      case "nominal":
        pending.push(...at.args);
        break;
    }
  }
  return false;
}

/** A union read's branches, one per distinct node in member order, those located nowhere as one. */
function groupedByNode(branches: readonly BranchRead[]): BranchRead[] {
  const groups: { schemaNode: SchemaDependency | undefined; types: CelType[] }[] = [];
  for (const branch of branches) {
    const held = groups.find((group) => sameNode(group.schemaNode, branch.schemaNode));
    if (held) held.types.push(branch.type);
    else groups.push({ schemaNode: branch.schemaNode, types: [branch.type] });
  }
  return groups.map((group) => ({ schemaNode: group.schemaNode, type: unionOf(group.types) }));
}

function sameNode(left: SchemaDependency | undefined, right: SchemaDependency | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.document === right.document && left.pointer === right.pointer;
}
