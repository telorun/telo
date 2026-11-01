import { getRefIdentity, isCompiledValue, type ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import type { LoadedGraph } from "./loaded-types.js";
import { isResolvedReference } from "./resolved-reference.js";
import {
  formatSegments,
  originSegments,
  readOrigin,
  type Segment,
} from "./rewrite-synthetic-origins.js";

/** The written place of a value a running resource holds, in the shape a
 *  diagnostic's `data` is located by (`locateDiagnostic`). */
export interface WrittenFailureSite {
  filePath: string;
  resource: { kind: string; name: string };
  /** The place in the position index's spelling (`steps[1].inputs.expected`);
   *  absent for the written document itself. */
  path?: string;
}

/**
 * Where `declaration` holds the value at `pointer` (RFC 6901) in the file it was
 * written in. A declaration extracted from another (`metadata.xTeloOrigin`) is
 * followed to its parent through `parentOf`, which answers only for a declaration
 * the caller knows was read from the load.
 *
 * Undefined unless the place is provably the written one: walking the written
 * document and the declaration side by side, every list entry on the way carries
 * the same step name and the value at the place is the one written. A
 * configuration a choice expanded (indices shifted by an `!if` or `!for-each`) or
 * one that was derived from what was written therefore yields nothing rather
 * than a neighbouring line. A place deeper than the written value reaches (inside
 * an expression's result) resolves to the deepest written node above it.
 */
export function writtenFailureSite(
  graph: LoadedGraph,
  declaration: ResourceManifest,
  pointer: string | undefined,
  parentOf: (child: ResourceManifest, parentName: string) => ResourceManifest | undefined,
): WrittenFailureSite | undefined {
  const chain = originChain(declaration, parentOf);
  if (!chain) return undefined;
  const root = chain[chain.length - 1]!;
  const source = root.metadata?.source;
  const name = root.metadata?.name;
  if (typeof source !== "string" || typeof name !== "string" || typeof root.kind !== "string") {
    return undefined;
  }
  const document = writtenDocument(graph, source, root.kind, name);
  if (!document) return undefined;

  let written: unknown = document;
  const path: Segment[] = [];
  for (let i = chain.length - 2; i >= 0; i--) {
    const walked = walk(written, chain[i + 1], originSegments(readOrigin(chain[i])!));
    if (!walked || !walked.complete) return undefined;
    path.push(...walked.keys);
    written = walked.written;
  }
  if (pointer !== undefined) {
    const walked = walk(written, declaration, pointerSegments(pointer));
    if (!walked || !sameWritten(walked.written, walked.declared)) return undefined;
    path.push(...walked.keys);
  }
  return {
    filePath: source,
    resource: { kind: root.kind, name },
    ...(path.length > 0 ? { path: formatSegments(path) } : {}),
  };
}

function originChain(
  declaration: ResourceManifest,
  parentOf: (child: ResourceManifest, parentName: string) => ResourceManifest | undefined,
): ResourceManifest[] | undefined {
  const chain: ResourceManifest[] = [declaration];
  for (let origin = readOrigin(declaration); origin; ) {
    if (chain.length > 64) return undefined;
    const parent = parentOf(chain[chain.length - 1]!, origin.parentName);
    if (!parent) return undefined;
    chain.push(parent);
    origin = readOrigin(parent);
  }
  return chain;
}

/** The resource `declaration` was written under: itself, or the root of the
 *  declarations it was extracted from. Undefined when the chain cannot be followed. */
export function writtenRootOf(
  declaration: ResourceManifest,
  parentOf: (child: ResourceManifest, parentName: string) => ResourceManifest | undefined,
): { kind: string; name: string } | undefined {
  const chain = originChain(declaration, parentOf);
  const root = chain?.[chain.length - 1];
  const name = root?.metadata?.name;
  return root && typeof name === "string" && typeof root.kind === "string"
    ? { kind: root.kind, name }
    : undefined;
}

function writtenDocument(
  graph: LoadedGraph,
  source: string,
  kind: string,
  name: string,
): ResourceManifest | undefined {
  for (const module of graph.modules.values()) {
    for (const file of [module.owner, ...module.partials]) {
      if (file.source !== source) continue;
      const found = file.manifests.find((m) => m?.kind === kind && m.metadata?.name === name);
      if (found) return found;
    }
  }
  return undefined;
}

interface Walked {
  written: unknown;
  declared: unknown;
  keys: Segment[];
  /** False when the walk stopped above the last segment: neither side holds it,
   *  or the written value there is an expression. */
  complete: boolean;
}

/** Descend the written value and the declared one by `segments` together;
 *  undefined at the first place they disagree. */
function walk(written: unknown, declared: unknown, segments: readonly Segment[]): Walked | undefined {
  const keys: Segment[] = [];
  for (const segment of segments) {
    if (!isContainer(written)) return { written, declared, keys, complete: false };
    let key: Segment;
    if (Array.isArray(written)) {
      const index = typeof segment === "number" ? segment : /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || !Array.isArray(declared)) return undefined;
      key = index;
    } else {
      if (!isPlainRecord(declared)) return undefined;
      key = String(segment);
    }
    const nextWritten = (written as Record<Segment, unknown>)[key];
    const nextDeclared = (declared as Record<Segment, unknown>)[key];
    if (nextWritten === undefined && nextDeclared === undefined) {
      return { written, declared, keys, complete: false };
    }
    if (nextWritten === undefined || nextDeclared === undefined) return undefined;
    if (Array.isArray(written) && !sameEntry(nextWritten, nextDeclared)) return undefined;
    keys.push(key);
    written = nextWritten;
    declared = nextDeclared;
  }
  return { written, declared, keys, complete: true };
}

/** A list entry is the same one when it is not an expansion construct and
 *  carries the same name (a step's `name`, an emitted step's `__emitted`). */
function sameEntry(written: unknown, declared: unknown): boolean {
  if (!isPlainRecord(written) || !isPlainRecord(declared)) return sameWritten(written, declared);
  if ("__expand" in written) return false;
  return entryName(written) === entryName(declared);
}

function entryName(entry: Record<string, unknown>): unknown {
  return entry.name ?? entry.__emitted;
}

/** Whether `declared` is the value `written` reads as: an expression by its
 *  source, a reference by the name it names, everything else by value. */
function sameWritten(written: unknown, declared: unknown): boolean {
  if (isTaggedSentinel(written)) {
    if (written.engine === "ref") return sameReference(written, declared);
    return (
      (isCompiledValue(declared) || isTaggedSentinel(declared)) &&
      (declared as { source?: unknown }).source === written.source
    );
  }
  if (Array.isArray(written)) {
    return (
      Array.isArray(declared) &&
      declared.length === written.length &&
      written.every((item, i) => sameWritten(item, declared[i]))
    );
  }
  if (isPlainRecord(written)) {
    if (!isPlainRecord(declared)) return false;
    const keys = Object.keys(written);
    return (
      keys.length === Object.keys(declared).length &&
      keys.every((key) => key in declared && sameWritten(written[key], declared[key]))
    );
  }
  return written === declared;
}

function sameReference(written: { parsed?: unknown }, declared: unknown): boolean {
  const parsed = written.parsed as { alias?: string; name?: string } | undefined;
  if (typeof parsed?.name !== "string") return false;
  if (isResolvedReference(declared)) {
    return declared.name === parsed.name && (declared.alias ?? undefined) === (parsed.alias ?? undefined);
  }
  return declared !== null && typeof declared === "object" && getRefIdentity(declared)?.name === parsed.name;
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value) || (isPlainRecord(value) && !isTaggedSentinel(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}
