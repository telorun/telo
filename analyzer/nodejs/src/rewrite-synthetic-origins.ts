import type { ResourceManifest } from "@telorun/sdk";
import type { AnalysisDiagnostic } from "./types.js";

interface XTeloOrigin {
  parentKind: string;
  parentName: string;
  pathFromParent: string;
}

function readOrigin(manifest: unknown): XTeloOrigin | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const origin = (manifest as { metadata?: { xTeloOrigin?: XTeloOrigin } }).metadata?.xTeloOrigin;
  if (
    !origin ||
    typeof origin.parentKind !== "string" ||
    typeof origin.parentName !== "string" ||
    typeof origin.pathFromParent !== "string"
  ) {
    return undefined;
  }
  return origin;
}

/** Diagnostics emitted on synthetic manifests (resources extracted by
 *  `normalizeInlineResources`) carry the synthetic's identity in
 *  `data.resource`, which has no YAML source. Rewrite each such diagnostic
 *  back to the chain root: walk up `metadata.xTeloOrigin` until a manifest
 *  with no origin is reached, and prepend each hop's `pathFromParent` to
 *  `data.path` so position-index lookups against the root doc resolve.
 *
 *  An extraction from a scope member lives INSIDE the scope array rather than at
 *  the top level, so a diagnostic about it names the top-level owner and a path
 *  through an array index the author never wrote (`with[3]`). That prefix is
 *  unfolded the same way, into the position the declaration was written at. */
export function rewriteSyntheticOrigins(
  diagnostics: AnalysisDiagnostic[],
  manifests: ResourceManifest[],
): AnalysisDiagnostic[] {
  const byName = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    const name = m.metadata?.name;
    if (typeof name === "string") byName.set(name, m);
  }

  return diagnostics.map((d) => {
    const data = d.data as
      | { resource?: { kind?: string; name?: string }; path?: string; filePath?: string }
      | undefined;
    if (!data?.resource?.name) return d;

    let current = byName.get(data.resource.name);
    let origin = readOrigin(current);
    const path = typeof data.path === "string" ? data.path : "";
    let accumPath = path;
    let root: { kind?: string; name?: string } = data.resource;

    while (origin) {
      accumPath = accumPath ? `${origin.pathFromParent}.${accumPath}` : origin.pathFromParent;
      root = { kind: origin.parentKind, name: origin.parentName };
      current = byName.get(origin.parentName);
      origin = readOrigin(current);
    }

    const rerouted = root !== data.resource;
    const unfolded = current ? unfoldScopedOrigins(current, accumPath) : accumPath;
    if (!rerouted && unfolded === path) return d;

    return {
      ...d,
      data: {
        ...data,
        resource: root,
        filePath: rerouted
          ? ((current?.metadata as { source?: string } | undefined)?.source ?? data.filePath)
          : data.filePath,
        path: unfolded,
      },
    };
  });
}

type Segment = string | number;

/** Replace every scope-array index that holds an extraction with the position
 *  the extraction was written at, until none is left. */
function unfoldScopedOrigins(root: ResourceManifest, path: string): string {
  let segments = parseSegments(path);
  let unfoldedAny = false;
  // Each unfolding replaces one extraction with its parent, which is strictly
  // closer to what the author wrote, so the chain is as long as the nesting.
  for (let hops = 0; hops <= segments.length + 16; hops++) {
    const next = unfoldOnce(root, segments);
    if (!next) break;
    segments = next;
    unfoldedAny = true;
  }
  // Re-formatting is lossy (an empty segment in `entries../x` is dropped), so a
  // path nothing unfolded is returned as written.
  return unfoldedAny ? formatSegments(segments) : path;
}

function unfoldOnce(root: ResourceManifest, segments: Segment[]): Segment[] | undefined {
  let node: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const container = node;
    node =
      typeof segment === "number"
        ? Array.isArray(container)
          ? container[segment]
          : undefined
        : container && typeof container === "object" && !Array.isArray(container)
          ? (container as Record<string, unknown>)[segment]
          : undefined;
    if (node === undefined || node === null) return undefined;
    if (typeof segment !== "number" || i === 0) continue;
    const origin = readOrigin(node);
    if (!origin) continue;

    // Its parent is either the resource holding this scope array (a slot of
    // the resource that declares the scope) or a sibling member of the array.
    const holderPath = segments.slice(0, i - 1);
    let parentPath: Segment[] | undefined;
    if (nameOf(at(root, holderPath)) === origin.parentName) {
      parentPath = holderPath;
    } else {
      const sibling = (container as unknown[]).findIndex((m) => nameOf(m) === origin.parentName);
      if (sibling >= 0) parentPath = [...segments.slice(0, i), sibling];
    }
    if (!parentPath) return undefined;
    return [...parentPath, ...parseSegments(origin.pathFromParent), ...segments.slice(i + 1)];
  }
  return undefined;
}

function at(root: unknown, segments: Segment[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

function nameOf(value: unknown): string | undefined {
  const name = (value as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
  return typeof name === "string" ? name : undefined;
}

/** `with[3].steps[0].invoke` → `["with", 3, "steps", 0, "invoke"]`. */
function parseSegments(path: string): Segment[] {
  const out: Segment[] = [];
  for (const match of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    out.push(match[1] !== undefined ? Number(match[1]) : match[2]!);
  }
  return out;
}

function formatSegments(segments: Segment[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${segment}` : segment;
  }
  return out;
}
