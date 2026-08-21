import {
  buildLineOffsets,
  offsetToPosition,
  type AstDocument,
  type AstMap,
  type AstNode,
  type AstScalar,
  type CelSegment,
  type Position,
} from "@telorun/analyzer";

/** The cursor's resolved position against the read-only AST. `locate` produces
 *  this; `detect-context` maps it onto a `CompletionCtx`. Structure comes from
 *  the AST; the cursor *column* is used only to resolve empty-space (blank /
 *  trailing-indent) key positions, where indentation is the sole signal for
 *  "which container am I typing into". */
export interface ResolvedCursor {
  docIndex: number;
  /** The cursor as a document offset. Carried so a consumer hit-testing inside a
   *  node (a CEL chain, the halves of an `Alias.Name` value) reuses the one this
   *  resolution was performed with, rather than recomputing the line table and
   *  risking a different answer. */
  offset: number;
  /** Top-level `kind:` value of the cursor's document, when present. */
  docKind?: string;
  slot: "key" | "value";
  /** Value slot: ancestor keys + the field key (last element is the field).
   *  Key slot: the container map's ancestor key chain. */
  path: string[];
  node?: AstNode;
  container?: AstMap;
  replaceRange?: { start: Position; end: Position };
  /** Value slot: text from the value start up to the cursor. */
  prefix?: string;
  /** Value slot: true when whitespace separates the key's colon from the value
   *  (distinguishes `Console: ` — a value — from `Tiny:` — a bare header). */
  spaceAfterColon?: boolean;
  /** Value slot: the value of a sibling `kind:` in the same map (object-form
   *  ref name completion). */
  siblingKind?: string;
  /** Key slot: keys already present in the container (the key under the cursor
   *  excluded so it still suggests itself). */
  existingKeys?: Set<string>;
  /** Key slot: the kind of the nearest enclosing inline resource (or the root
   *  resource), whose schema the prop keys are completed against. Falls back to
   *  the document kind at the root. */
  resourceKind?: string;
  /** Key slot: number of `path` segments that reach `resourceKind`'s map, so
   *  the schema-relative path is `path.slice(resourceDepth)`. */
  resourceDepth?: number;
  /** The path with sequence INDICES kept (`routes[0].handler.url`),
   *  as distinct from `path`, through which arrays are transparent. This is the
   *  address the analyzer speaks — an `x-telo-context` scope, an error-bearing
   *  region and a step's identity are all resolved per item — so it is what a
   *  CEL site is looked up by. */
  concretePath?: string;
  /** Set when the cursor sits inside a CEL body (closed or open). The CEL
   *  segment plus the cursor's document offset — what completion and hover
   *  hit-test the expression's chain against. */
  cel?: { segment: CelSegment; offset: number };
}

function within(range: [number, number], offset: number): boolean {
  return offset >= range[0] && offset <= range[1];
}

export function scalarString(node: AstNode | undefined): string | undefined {
  if (node?.kind === "scalar" && typeof node.value === "string") return node.value;
  return undefined;
}

/** The `kind:` value of a document's root map, if any. */
function docKindOf(doc: AstDocument): string | undefined {
  if (doc.root?.kind !== "map") return undefined;
  for (const pair of doc.root.entries) {
    if (scalarString(pair.key) === "kind") return scalarString(pair.value);
  }
  return undefined;
}

/** Value of a sibling `kind:` entry in `map`, for object-form ref detection. */
function siblingKindOf(map: AstMap): string | undefined {
  for (const pair of map.entries) {
    if (scalarString(pair.key) === "kind") return scalarString(pair.value);
  }
  return undefined;
}

/** The map's `kind:` value when it names a resource kind (`Alias.Kind`), i.e.
 *  the map is an inline resource. A prop-key position inside such a map is
 *  completed against *this* kind's schema, not the outer ref slot's. */
function resourceKindOf(map: AstMap): string | undefined {
  const kind = siblingKindOf(map);
  return kind && /^\w+\.\w+/.test(kind) ? kind : undefined;
}

/** The kind + path-depth of the nearest enclosing inline resource (or the root
 *  resource). `depth` is the number of `path` segments consumed to reach that
 *  map, so a prop-key `yamlPath` relative to it is `path.slice(depth)`. */
interface ResourceScope {
  kind?: string;
  depth: number;
}

function enter(scope: ResourceScope, map: AstMap, ancestorsLen: number): ResourceScope {
  const kind = resourceKindOf(map);
  return kind ? { kind, depth: ancestorsLen } : scope;
}

// ---------------------------------------------------------------------------
// Containment descent — used for the cursor sitting ON a real node.
// ---------------------------------------------------------------------------

type Descent =
  | {
      type: "key";
      container: AstMap;
      path: string[];
      concretePath: string;
      keyNode: AstScalar;
      keyName?: string;
      scope: ResourceScope;
    }
  | {
      type: "value";
      /** The enclosing map, or `undefined` for a bare scalar sequence item
       *  (which has no keyed siblings). */
      container: AstMap | undefined;
      path: string[];
      concretePath: string;
      keyName?: string;
      keyEnd: number;
      valueNode: AstNode;
    }
  | { type: "empty" };

/** Append one key segment to a concrete path (`routes[0]` + `handler`). */
function joinKey(concrete: string, key: string): string {
  return concrete ? `${concrete}.${key}` : key;
}

function descend(
  node: AstNode,
  ancestors: string[],
  concrete: string,
  offset: number,
  scope: ResourceScope,
): Descent | undefined {
  if (node.kind === "map") {
    const mapScope = enter(scope, node, ancestors.length);
    for (const pair of node.entries) {
      const keyName = scalarString(pair.key);
      if (within(pair.key.range, offset)) {
        return {
          type: "key",
          container: node,
          path: ancestors,
          concretePath: concrete,
          keyNode: pair.key as AstScalar,
          keyName,
          scope: mapScope,
        };
      }
      if (pair.value && within(pair.value.range, offset)) {
        const childAncestors = keyName != null ? [...ancestors, keyName] : ancestors;
        const childConcrete = keyName != null ? joinKey(concrete, keyName) : concrete;
        if (pair.value.kind === "map" || pair.value.kind === "seq") {
          return descend(pair.value, childAncestors, childConcrete, offset, mapScope) ?? { type: "empty" };
        }
        return {
          type: "value",
          container: node,
          path: ancestors,
          concretePath: childConcrete,
          keyName,
          keyEnd: pair.key.range[1],
          valueNode: pair.value,
        };
      }
    }
    return undefined;
  }
  if (node.kind === "seq") {
    // Sequence items are transparent to the key path (mirrors the schema
    // walker, which auto-descends arrays) but NOT to the concrete path: an
    // `x-telo-context` scope, an error-bearing region and a step's identity are
    // all addressed per item, so a CEL site is unreachable without the index.
    for (const [index, item] of node.items.entries()) {
      if (within(item.range, offset)) {
        const itemConcrete = `${concrete}[${index}]`;
        if (item.kind === "map" || item.kind === "seq") {
          return descend(item, ancestors, itemConcrete, offset, scope) ?? { type: "empty" };
        }
        // A bare scalar list item (`targets:\n  - One`) has no enclosing map of
        // keyed siblings — leave `container` undefined rather than treating the
        // seq as a map.
        return {
          type: "value",
          container: undefined,
          path: ancestors,
          concretePath: itemConcrete,
          keyEnd: item.range[0],
          valueNode: item,
        };
      }
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Column search — used for empty-space (blank / trailing-indent) key positions.
// ---------------------------------------------------------------------------

interface MapScope {
  path: string[];
  /** The same location with sequence indices kept — what addresses a manifest
   *  node, as distinct from `path`, which addresses a schema node. */
  concrete: string;
  childColumn: number;
  keys: Set<string>;
  rangeStart: number;
  scope: ResourceScope;
}

interface PairScope {
  path: string[]; // full key path to this pair
  concrete: string;
  keyColumn: number;
  keyOffset: number;
  childKeys: Set<string>;
  scope: ResourceScope;
}

function collectScopes(
  node: AstNode,
  ancestors: string[],
  concrete: string,
  scope: ResourceScope,
  lineOffsets: number[],
  maps: MapScope[],
  pairs: PairScope[],
): void {
  if (node.kind === "map") {
    const mapScope = enter(scope, node, ancestors.length);
    const keys = new Set<string>();
    let childColumn = -1;
    for (const pair of node.entries) {
      const keyName = scalarString(pair.key);
      if (keyName != null) keys.add(keyName);
      if (childColumn < 0) childColumn = offsetToPosition(pair.key.range[0], lineOffsets).character;
    }
    if (childColumn >= 0) {
      maps.push({
        path: ancestors,
        concrete,
        childColumn,
        keys,
        rangeStart: node.range[0],
        scope: mapScope,
      });
    }
    for (const pair of node.entries) {
      const keyName = scalarString(pair.key);
      const fullPath = keyName != null ? [...ancestors, keyName] : ancestors;
      const fullConcrete = keyName != null ? joinKey(concrete, keyName) : concrete;
      const childKeys = new Set<string>();
      if (pair.value?.kind === "map") {
        for (const p of pair.value.entries) {
          const k = scalarString(p.key);
          if (k != null) childKeys.add(k);
        }
      }
      pairs.push({
        path: fullPath,
        concrete: fullConcrete,
        keyColumn: offsetToPosition(pair.key.range[0], lineOffsets).character,
        keyOffset: pair.key.range[0],
        childKeys,
        scope: mapScope,
      });
      if (pair.value) {
        collectScopes(pair.value, fullPath, fullConcrete, mapScope, lineOffsets, maps, pairs);
      }
    }
  } else if (node.kind === "seq") {
    node.items.forEach((item, index) =>
      collectScopes(item, ancestors, `${concrete}[${index}]`, scope, lineOffsets, maps, pairs),
    );
  }
}

interface KeyResolution {
  path: string[];
  concrete: string;
  existingKeys: Set<string>;
  scope: ResourceScope;
}

/** Resolve the container a new key at `cursorColumn` belongs to. Prefers an
 *  existing sibling level (a map whose child keys sit at exactly `cursorColumn`);
 *  otherwise nests under the nearest-preceding shallower key. */
function columnSearch(
  root: AstNode,
  cursorColumn: number,
  cursorOffset: number,
  lineOffsets: number[],
): KeyResolution {
  const maps: MapScope[] = [];
  const pairs: PairScope[] = [];
  collectScopes(root, [], "", { depth: 0 }, lineOffsets, maps, pairs);

  // Sibling level: a map whose children already sit at the cursor's column.
  let sibling: MapScope | undefined;
  for (const m of maps) {
    if (m.childColumn === cursorColumn && m.rangeStart < cursorOffset) {
      if (!sibling || m.rangeStart > sibling.rangeStart) sibling = m;
    }
  }
  if (sibling) {
    return {
      path: sibling.path,
      concrete: sibling.concrete,
      existingKeys: sibling.keys,
      scope: sibling.scope,
    };
  }

  // Nest under the nearest-preceding key shallower than the cursor.
  let nest: PairScope | undefined;
  for (const p of pairs) {
    if (p.keyColumn < cursorColumn && p.keyOffset < cursorOffset) {
      if (
        !nest ||
        p.keyColumn > nest.keyColumn ||
        (p.keyColumn === nest.keyColumn && p.keyOffset > nest.keyOffset)
      ) {
        nest = p;
      }
    }
  }
  if (nest) {
    return {
      path: nest.path,
      concrete: nest.concrete,
      existingKeys: nest.childKeys,
      scope: nest.scope,
    };
  }

  return { path: [], concrete: "", existingKeys: new Set(), scope: { depth: 0 } };
}

// ---------------------------------------------------------------------------

function selectDoc(docs: AstDocument[], offset: number): number {
  let best = -1;
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].range[0] <= offset) best = i;
  }
  return best < 0 ? (docs.length > 0 ? 0 : -1) : best;
}

function celAt(node: AstScalar, offset: number): ResolvedCursor["cel"] {
  for (const segment of node.celSegments()) {
    if (offset >= segment.range[0] && offset <= segment.range[1]) return { segment, offset };
  }
  return undefined;
}

/** Resolve `(line, character)` against the AST (Approach B: AST for structure,
 *  cursor column only to place empty-space key positions). */
export function resolveNodeAtPosition(
  text: string,
  docs: AstDocument[],
  line: number,
  character: number,
): ResolvedCursor | undefined {
  if (docs.length === 0) return undefined;
  const lineOffsets = buildLineOffsets(text);
  const offset = (lineOffsets[line] ?? 0) + character;
  const toPos = (o: number): Position => offsetToPosition(o, lineOffsets);

  const docIndex = selectDoc(docs, offset);
  if (docIndex < 0) return undefined;
  const doc = docs[docIndex];
  const docKind = docKindOf(doc);

  const found = doc.root ? descend(doc.root, [], "", offset, { depth: 0 }) : undefined;

  // Cursor sits on an existing map key → key/prop-key position.
  if (found?.type === "key") {
    const existingKeys = new Set<string>();
    for (const pair of found.container.entries) {
      const k = scalarString(pair.key);
      if (k != null && k !== found.keyName) existingKeys.add(k);
    }
    return {
      docIndex,
      offset,
      docKind,
      slot: "key",
      path: found.path,
      concretePath: found.concretePath,
      node: found.keyNode,
      replaceRange: { start: toPos(found.keyNode.range[0]), end: toPos(found.keyNode.range[1]) },
      container: found.container,
      existingKeys,
      resourceKind: found.scope.kind,
      resourceDepth: found.scope.depth,
    };
  }

  // Cursor sits on a scalar value.
  if (found?.type === "value" && found.valueNode.kind === "scalar") {
    const value = found.valueNode;
    const cel = celAt(value, offset);
    // A bare identifier on its own line with no colon is a partial *key* being
    // typed as a first child (yaml parses it as the parent's value). Route to a
    // key position via column search — the documented cursor-line carve-out.
    const lineText = text.slice(lineOffsets[line] ?? 0, lineOffsets[line + 1] ?? text.length);
    const isPartialKey =
      typeof value.value === "string" &&
      !lineText.includes(":") &&
      /^\s*[A-Za-z_][\w-]*\s*$/.test(lineText) &&
      toPos(value.range[0]).line !== toPos(found.keyEnd).line;
    if (isPartialKey && doc.root) {
      const col = toPos(value.range[0]).character;
      const { path, concrete, existingKeys, scope } = columnSearch(doc.root, col, offset, lineOffsets);
      return {
        docIndex,
        offset,
        docKind,
        slot: "key",
        path,
        concretePath: concrete,
        container: found.container,
        existingKeys,
        resourceKind: scope.kind,
        resourceDepth: scope.depth,
      };
    }

    const clampedEnd = Math.min(offset, value.range[1]);
    return {
      docIndex,
      offset,
      docKind,
      slot: "value",
      path: found.keyName != null ? [...found.path, found.keyName] : found.path,
      concretePath: found.concretePath,
      node: value,
      container: found.container,
      prefix: text.slice(value.range[0], clampedEnd),
      spaceAfterColon: value.range[0] - found.keyEnd >= 2,
      siblingKind: found.container ? siblingKindOf(found.container) : undefined,
      replaceRange: { start: toPos(value.range[0]), end: toPos(value.range[1]) },
      cel,
    };
  }

  // Empty space (blank line, trailing indent, empty document) → key position,
  // resolved by cursor column.
  const resolution: KeyResolution = doc.root
    ? columnSearch(doc.root, character, offset, lineOffsets)
    : { path: [], concrete: "", existingKeys: new Set<string>(), scope: { depth: 0 } };
  return {
    docIndex,
    offset,
    docKind,
    slot: "key",
    path: resolution.path,
    concretePath: resolution.concrete,
    existingKeys: resolution.existingKeys,
    resourceKind: resolution.scope.kind,
    resourceDepth: resolution.scope.depth,
  };
}
