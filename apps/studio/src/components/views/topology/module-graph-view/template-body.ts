import type { ModuleGraph } from "@telorun/analyzer";
import { makeTaggedSentinel } from "@telorun/templating";
import { isRecord } from "../../../../lib/utils";
import {
  concretePathToPointer,
  leafConcreteIndex,
  readConcretePath,
  writeConcretePath,
} from "../../../../lib/concrete-path";
import type { ParsedResource } from "../../../../model";
import type { RefWrite } from "../application-canvas-model";
import { BOOT_FIELD } from "../boot-targets";

/**
 * A templated definition's body, as the canvas edits it.
 *
 * The canvas draws the body's entries as resources and the definition as the
 * boot root (see `templateModule` in the analyzer), so every edit it makes is
 * addressed to a resource that has no document of its own. This is where each
 * is re-addressed into the one document that holds them all: an entry's field
 * is a field of `resources[i]`, and the boot sequence is the definition's
 * `targets:` — or its lone `run:`, which the canvas reads as a one-entry
 * sequence.
 *
 * An entry the analyzer extracted from a sibling's inline declaration is not an
 * entry the author wrote: its writes land where the declaration IS written,
 * inside the sibling.
 */
export interface TemplateBody {
  definition: ParsedResource;
  /** Each literally named `resources:` entry, and each extracted one, as a
   *  resource of its own: its config without `kind` and `metadata`, which is
   *  what a resource's `fields` are. */
  entries: ParsedResource[];
  /** Where each name's writes land — more than one address is a name the body
   *  declares twice, which no write may be sent to. */
  addresses: ReadonlyMap<string, readonly EntryAddress[]>;
  /** Where the boot sequence is written today. */
  bootFrom: "targets" | "run";
  /** The boot root the canvas edits: the definition's identity, carrying its
   *  boot sequence as `targets`. */
  bootRoot: ParsedResource;
}

/** Entry `index` of `resources:`, at `site` inside it — empty for the entry
 *  itself, the declaration's concrete path for an extracted one. */
export interface EntryAddress {
  index: number;
  site: string;
}

/** An entry the analyzer extracted from `parent`'s declaration at `site`. */
export interface ExtractedEntry {
  name: string;
  parent: string;
  site: string;
}

/** A canvas write the body cannot take — the name addresses no entry, or more
 *  than one. Reported to the reader, never sent. */
export class TemplateWriteRefused extends Error {
  override name = "TemplateWriteRefused";
}

const RESOURCES_FIELD = "resources";
const RUN_FIELD = "run";

/** The extracted entries a body's graph draws, read off its inline ownership:
 *  the parent is the owning box, the site where it was written. */
export function extractedEntries(graph: ModuleGraph): ExtractedEntry[] {
  const out: ExtractedEntry[] = [];
  for (const node of graph.nodes) {
    if (node.ownership !== "inline" || !node.owner || node.ownerSite === undefined) continue;
    const owner = graph.nodeById(node.owner);
    if (!owner || owner.root) continue;
    out.push({ name: node.name, parent: owner.name, site: node.ownerSite });
  }
  return out;
}

export function templateBody(
  definition: ParsedResource,
  extracted: readonly ExtractedEntry[] = [],
): TemplateBody {
  const entries: ParsedResource[] = [];
  const addresses = new Map<string, EntryAddress[]>();
  const written = definition.fields[RESOURCES_FIELD];
  const resources = Array.isArray(written) ? written : [];
  resources.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.kind !== "string") return;
    const name = isRecord(entry.metadata) ? entry.metadata.name : undefined;
    if (typeof name !== "string") return;
    const { kind, metadata, ...fields } = entry;
    entries.push({ kind, name, fields });
    addresses.set(name, [...(addresses.get(name) ?? []), { index, site: "" }]);
  });

  // An extraction may itself hold one, so a parent is resolved before its child
  // whatever order the graph listed them in.
  const byName = new Map(extracted.map((e) => [e.name, e] as const));
  const resolving = new Set<string>();
  const resolve = (name: string): readonly EntryAddress[] => {
    const known = addresses.get(name);
    if (known) return known;
    const origin = byName.get(name);
    if (!origin || resolving.has(name)) return [];
    resolving.add(name);
    const found: EntryAddress[] = [];
    for (const parent of resolve(origin.parent)) {
      const site = parent.site ? `${parent.site}.${origin.site}` : origin.site;
      const declared = readConcretePath(resources[parent.index], site);
      // The graph is the last analysis; the text may have moved on since. A
      // site that no longer holds a declaration is no address at all.
      if (!isRecord(declared) || typeof declared.kind !== "string") continue;
      if (found.length === 0) {
        const { kind, metadata, ...fields } = declared;
        entries.push({ kind: kind as string, name, fields });
      }
      found.push({ index: parent.index, site });
    }
    if (found.length > 0) addresses.set(name, found);
    return found;
  };
  for (const entry of extracted) resolve(entry.name);

  const targets = definition.fields[BOOT_FIELD];
  const run = definition.fields[RUN_FIELD];
  const bootFrom = targets === undefined && run !== undefined && run !== null ? "run" : "targets";
  return {
    definition,
    entries,
    addresses,
    bootFrom,
    bootRoot: {
      kind: definition.kind,
      name: definition.name,
      fields: { [BOOT_FIELD]: bootFrom === "run" ? [run] : (targets ?? []) },
    },
  };
}

/** Is this the boot root, rather than an entry? */
export function isBootRoot(body: TemplateBody, kind: string, name: string): boolean {
  return kind === body.bootRoot.kind && name === body.bootRoot.name;
}

/** Where a write to `name` lands — refused when the body has no such entry, or
 *  declares the name more than once, since a write sent to either would edit
 *  something the reader did not point at. */
export function entryAddress(body: TemplateBody, name: string): EntryAddress {
  const found = body.addresses.get(name) ?? [];
  if (found.length === 0) {
    throw new TemplateWriteRefused(
      `'${name}' is not an entry of '${body.definition.name}': ` +
        `a template body's canvas writes only to its own entries.`,
    );
  }
  if (found.length > 1) {
    const at = found.map((address) => concretePathOf(address)).join(", ");
    throw new TemplateWriteRefused(
      `'${name}' names ${found.length} entries of '${body.definition.name}' (${at}). ` +
        `Rename all but one so each entry has a name of its own, then edit it here.`,
    );
  }
  return found[0]!;
}

/** `resources[i]` — or the declaration's place inside it. */
function concretePathOf(address: EntryAddress): string {
  return `${RESOURCES_FIELD}[${address.index}]${address.site ? `.${address.site}` : ""}`;
}

/** JSON Pointer into the definition for a pointer into the entry at `address`. */
export function entryPointer(address: EntryAddress, pointer: string): string {
  return `${concretePathToPointer(concretePathOf(address))}${pointer}`;
}

/** The entry a definition pointer lands in — the one written deepest, so a
 *  pointer inside an extracted declaration names it rather than its host. */
export function entryAt(
  body: TemplateBody,
  pointer: string,
): { kind: string; name: string } | undefined {
  let best: { kind: string; name: string; depth: number } | undefined;
  for (const [name, found] of body.addresses) {
    for (const address of found) {
      const prefix = entryPointer(address, "");
      if (pointer !== prefix && !pointer.startsWith(`${prefix}/`)) continue;
      if (best && best.depth >= prefix.length) continue;
      const declared = readConcretePath(body.definition.fields, concretePathOf(address));
      if (isRecord(declared) && typeof declared.kind === "string") {
        best = { kind: declared.kind, name, depth: prefix.length };
      }
    }
  }
  return best ? { kind: best.kind, name: best.name } : undefined;
}

/** The definition's next fields, with the entry at `address` holding `fields`
 *  — its `kind` and `metadata` kept, since a resource's fields carry neither. */
export function withEntryFields(
  body: TemplateBody,
  address: EntryAddress,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const resources = [...(body.definition.fields[RESOURCES_FIELD] as unknown[])];
  if (!address.site) {
    const current = resources[address.index] as Record<string, unknown>;
    resources[address.index] = { kind: current.kind, metadata: current.metadata, ...fields };
  } else {
    const host = structuredClone(resources[address.index]) as Record<string, unknown>;
    const current = readConcretePath(host, address.site) as Record<string, unknown>;
    writeConcretePath(host, address.site, {
      kind: current.kind,
      ...(current.metadata !== undefined ? { metadata: current.metadata } : {}),
      ...fields,
    });
    resources[address.index] = host;
  }
  return { ...body.definition.fields, [RESOURCES_FIELD]: resources };
}

/**
 * The definition's next fields, with `targets` as its boot sequence.
 *
 * A lone `run:` is the one-entry spelling of the same thing, and a definition
 * declaring both is refused — so a `run:` the canvas edits becomes `targets:`,
 * and one emptied is removed rather than left naming what was taken out.
 */
export function withBootSequence(
  body: TemplateBody,
  targets: readonly unknown[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body.definition.fields };
  if (body.bootFrom === "run") {
    delete next[RUN_FIELD];
    if (targets.length > 0) next[BOOT_FIELD] = [...targets];
    return next;
  }
  next[BOOT_FIELD] = [...targets];
  return next;
}

/** Reference writes against entries, re-addressed into the definition. */
export function entryRefWrites(body: TemplateBody, writes: readonly RefWrite[]): RefWrite[] {
  return writes.map((write) => ({
    ...write,
    source: { kind: body.definition.kind, name: body.definition.name },
    concretePath: `${concretePathOf(entryAddress(body, write.source.name))}.${write.concretePath}`,
  }));
}

/**
 * The definition's next fields for a batch that CREATES what it points at.
 *
 * A resource created for a slot inside the body is an entry of the body — a
 * top-level document would be one the body's siblings do not own — so the
 * entry and every reference to it land in one write of the one document,
 * ordered as the host orders any batch: removals first, highest index first,
 * so a splice cannot shift a later target.
 */
export function withCreatedEntries(
  body: TemplateBody,
  writes: readonly RefWrite[],
  nameFor: (kind: string, taken: readonly string[]) => string,
): Record<string, unknown> {
  const next = structuredClone(body.definition.fields);
  const resources = (Array.isArray(next[RESOURCES_FIELD]) ? next[RESOURCES_FIELD] : []) as unknown[];
  next[RESOURCES_FIELD] = resources;
  const taken = [...body.addresses.keys()];

  const resolved = writes.map((write) => {
    if (!write.createKind) return write;
    const name = write.createName ?? nameFor(write.createKind, taken);
    taken.push(name);
    resources.push({ kind: write.createKind, metadata: { name } });
    return { ...write, target: name };
  });

  const ordered = entryRefWrites(body, resolved).sort((a, b) => {
    const ra = a.target === null ? 0 : 1;
    const rb = b.target === null ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return leafConcreteIndex(b.concretePath) - leafConcreteIndex(a.concretePath);
  });
  for (const write of ordered) {
    writeConcretePath(
      next,
      write.concretePath,
      write.target === null ? null : makeTaggedSentinel("ref", write.target),
    );
  }
  return next;
}
