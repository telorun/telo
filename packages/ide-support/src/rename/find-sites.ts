import {
  CelParseError,
  type AstDocument,
  type AstNode,
  type AstScalar,
  type CelNode,
} from "@telorun/analyzer";

import { walkCel } from "../cel-chain.js";
import { scalarString } from "../completions/resolve-node.js";

/**
 * Every place a name is written, found over the read-only YAML AST plus the CEL
 * AST inside each scalar. Document offsets in, document offsets out — the
 * caller maps them to `Range`s once, with the line table it already built.
 *
 * **Offsets rather than ranges, and a flat list rather than a tree**, because
 * the two things a rename must guarantee are that no site is missed and that no
 * two edits overlap. Both are properties of a flat, sorted offset list, and
 * neither is checkable once the sites have been shaped per-feature.
 *
 * A `!ref` scalar's own range is its VALUE, excluding the tag (`!ref other` →
 * the span of `other`), so a local reference is a whole-node replacement. A CEL
 * identifier is a sub-span of its scalar, taken from `propertyRange` — which the
 * analyzer's `CelNode` has carried since it was written, for exactly this.
 */
export interface NameSite {
  /** `[start, end]` in document offsets — the identifier alone, never the
   *  enclosing scalar or the `!ref`/`!cel` tag. */
  range: [number, number];
}

/** Walk every scalar of a document, in source order. */
function eachScalar(node: AstNode, visit: (scalar: AstScalar) => void): void {
  if (node.kind === "map") {
    for (const pair of node.entries) {
      eachScalar(pair.key, visit);
      if (pair.value) eachScalar(pair.value, visit);
    }
    return;
  }
  if (node.kind === "seq") {
    for (const item of node.items) eachScalar(item, visit);
    return;
  }
  visit(node);
}

/** Every CEL node of a scalar's every segment.
 *
 *  A body that does not parse yields nothing: an author mid-edit is not a
 *  reason to fail a rename, and the analyzer reports the syntax error itself.
 *  Only that failure is tolerated — a defect in the CEL wrapper propagates,
 *  the posture `resolveCelTarget` already takes. */
function eachCelNode(scalar: AstScalar, visit: (node: CelNode) => void): void {
  for (const segment of scalar.celSegments()) {
    let ast: CelNode;
    try {
      ast = segment.ast();
    } catch (error) {
      if (!(error instanceof CelParseError)) throw error;
      continue;
    }
    walkCel(ast, visit);
  }
}

/** `<scope>.<name>` read as a member access — `resources.db`, `steps.build`,
 *  `variables.apiUrl`. Returns the span of `name` alone. */
function scopeMemberSite(node: CelNode, scope: string, name: string): NameSite | undefined {
  if (node.kind !== "member" || node.property !== name) return undefined;
  if (node.target.kind !== "ident" || node.target.name !== scope) return undefined;
  return { range: node.propertyRange };
}

const SELF_PREFIX = "Self.";

/** The span of `name` inside a `!ref` scalar, or undefined when the scalar names
 *  something else. Accepts the bare form and the `Self.`-qualified one, which
 *  also resolves locally; `<Alias>.<name>` is a different module's export and is
 *  deliberately not matched. */
function refSite(scalar: AstScalar, name: string): NameSite | undefined {
  if (scalar.tag !== "!ref") return undefined;
  const [start, end] = scalar.range;
  const raw = refText(scalar);
  if (raw === name) return { range: [start, end] };
  if (raw === `${SELF_PREFIX}${name}`) return { range: [start + SELF_PREFIX.length, end] };
  return undefined;
}

/** A `!ref` scalar's resolved value is a `TaggedSentinel`, so the written text
 *  is read off the sentinel rather than assumed to be a plain string. */
function refText(scalar: AstScalar): string | undefined {
  const value = scalar.value as { source?: unknown } | string | undefined;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.source === "string") return value.source;
  return undefined;
}

/** A resource's references within one document: `!ref <name>` (and its `Self.`
 *  form) plus `resources.<name>` in CEL. */
export function resourceSites(doc: AstDocument, name: string): NameSite[] {
  const sites: NameSite[] = [];
  if (!doc.root) return sites;
  eachScalar(doc.root, (scalar) => {
    const ref = refSite(scalar, name);
    if (ref) sites.push(ref);
    eachCelNode(scalar, (node) => {
      const site = scopeMemberSite(node, "resources", name);
      if (site) sites.push(site);
    });
  });
  return sites;
}

/** A step's references within its declaring document: `steps.<name>` in CEL.
 *  Deliberately document-scoped — `steps.<name>.result` is readable only inside
 *  the resource whose body declares the step, and a resource is one document. */
export function stepSites(doc: AstDocument, name: string): NameSite[] {
  const sites: NameSite[] = [];
  if (!doc.root) return sites;
  eachScalar(doc.root, (scalar) => {
    eachCelNode(scalar, (node) => {
      const site = scopeMemberSite(node, "steps", name);
      if (site) sites.push(site);
    });
  });
  return sites;
}

/** A `variables:` / `secrets:` / `ports:` entry's reads: `<block>.<name>`. */
export function declarationSites(doc: AstDocument, block: string, name: string): NameSite[] {
  const sites: NameSite[] = [];
  if (!doc.root) return sites;
  eachScalar(doc.root, (scalar) => {
    eachCelNode(scalar, (node) => {
      const site = scopeMemberSite(node, block, name);
      if (site) sites.push(site);
    });
  });
  return sites;
}

/**
 * Every map in a document that declares a resource named `name` — a `kind:`
 * beside a `metadata.name`.
 *
 * Used to detect a **shadowing scope declaration**: a resource declared inside
 * another's `x-telo-scope` array shadows a module-level name of the same
 * spelling within that scope's regions, so renaming the module-level one must
 * not rewrite references that resolve to the scoped one. Detected structurally
 * rather than by reading `x-telo-scope` off the kind's schema, because the
 * question a rename needs answered is "is this spelling declared more than once
 * in reach", which is true of any nested declaration whether or not the slot
 * carrying it is annotated.
 */
export function resourceDeclarations(doc: AstDocument, name: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  const visit = (node: AstNode): void => {
    if (node.kind === "map") {
      let hasKind = false;
      let nameNode: AstScalar | undefined;
      for (const pair of node.entries) {
        const key = scalarString(pair.key);
        if (key === "kind") hasKind = true;
        if (key === "metadata" && pair.value?.kind === "map") {
          for (const inner of pair.value.entries) {
            if (scalarString(inner.key) === "name" && inner.value?.kind === "scalar") {
              nameNode = inner.value;
            }
          }
        }
      }
      if (hasKind && nameNode && scalarString(nameNode) === name) found.push(nameNode.range);
      for (const pair of node.entries) if (pair.value) visit(pair.value);
      return;
    }
    if (node.kind === "seq") {
      for (const item of node.items) visit(item);
    }
  };
  if (doc.root) visit(doc.root);
  return found;
}

/** Every step in a document declaring `name:` — the span of the name scalar.
 *  More than one means the spelling is ambiguous within the resource, which is
 *  a refusal rather than a guess. */
export function stepDeclarations(doc: AstDocument, name: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  const visit = (node: AstNode, inStepArray: boolean): void => {
    if (node.kind === "map") {
      // A step is a map in a sequence carrying a `name:`; a resource's own
      // `metadata.name` is nested under `metadata:` and so never matches here.
      if (inStepArray) {
        for (const pair of node.entries) {
          if (
            scalarString(pair.key) === "name" &&
            pair.value?.kind === "scalar" &&
            scalarString(pair.value) === name
          ) {
            found.push(pair.value.range);
          }
        }
      }
      for (const pair of node.entries) if (pair.value) visit(pair.value, false);
      return;
    }
    if (node.kind === "seq") {
      for (const item of node.items) visit(item, true);
    }
  };
  if (doc.root) visit(doc.root, false);
  return found;
}
