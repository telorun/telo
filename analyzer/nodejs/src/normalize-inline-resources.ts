import type { ResourceManifest } from "@telorun/sdk";
import { isRefEntry, isScopeEntry, isInlineResource } from "./reference-field-map.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { AliasResolver } from "./alias-resolver.js";

const SYSTEM_KINDS = new Set(["Kernel.Definition", "Kernel.Module", "Kernel.Import"]);

/** Replaces characters outside [a-zA-Z0-9_] with underscores. */
function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Phase 2 — Inline resource normalization.
 *
 * After all manifests and definitions are loaded, walks every non-system resource's
 * x-telo-ref slots. For each inline resource value (has keys beyond kind/name/metadata),
 * assigns a deterministic name, extracts it as a first-class manifest, and replaces
 * the inline value in-place with `{kind, name}`. Newly extracted resources are enqueued
 * so nested inlines are resolved in the same pass.
 *
 * Naming scheme:
 *   {parentName}_{pathSegment}[_{itemName|index}]_{fieldName}
 *   e.g. TestBasicAddition_steps_AddTwoNumbers_invoke
 *        TestBasicAddition_steps_0_invoke  (when step has no name)
 *
 * Returns a new array containing the original manifests (mutated in-place) plus all
 * extracted manifests. The original array is not mutated.
 */
export function normalizeInlineResources(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
): ResourceManifest[] {
  const result = [...resources];

  // Queue: all non-system resources with a name. Extracted resources are appended.
  const queue = resources.filter(
    (r): r is ResourceManifest & { metadata: { name: string } } =>
      typeof r.metadata?.name === "string" && !!r.kind && !SYSTEM_KINDS.has(r.kind),
  );

  let i = 0;
  while (i < queue.length) {
    const resource = queue[i++];
    const fieldMap = registry.getFieldMapForKind(resource.kind, aliases);
    if (!fieldMap) continue;

    const parentName = resource.metadata.name as string;
    const parentModule = resource.metadata.module as string | undefined;

    // Collect scope visibility prefixes so we can route extracted resources correctly.
    const scopePrefixes: string[] = [];
    for (const [, entry] of fieldMap) {
      if (!isScopeEntry(entry)) continue;
      const paths = Array.isArray(entry.scope) ? entry.scope : [entry.scope];
      for (const p of paths) {
        scopePrefixes.push(p.replace(/^\//, "").replace(/\//g, "."));
      }
    }

    for (const [fieldPath, entry] of fieldMap) {
      if (!isRefEntry(entry)) continue;

      const inScope = scopePrefixes.some(
        (prefix) =>
          fieldPath === prefix ||
          fieldPath.startsWith(prefix + ".") ||
          fieldPath.startsWith(prefix + "["),
      );

      const extracted = extractInlinesAtPath(resource, fieldPath, parentName, parentModule);
      for (const manifest of extracted) {
        result.push(manifest);
        queue.push(manifest as ResourceManifest & { metadata: { name: string } });
        // TODO Phase 5: when inScope, add to parent's scope array instead of outer set
        void inScope;
      }
    }
  }

  return result;
}

/**
 * Walks `resource` following `fieldPath` (dot notation, `[]` = array traversal).
 * Mutates the resource in-place: replaces each inline value with `{kind, name}`.
 * Returns the extracted manifests.
 */
function extractInlinesAtPath(
  resource: ResourceManifest,
  fieldPath: string,
  parentName: string,
  parentModule: string | undefined,
): ResourceManifest[] {
  const extracted: ResourceManifest[] = [];
  const parts = fieldPath.split(".");

  function traverse(obj: unknown, partsLeft: string[], nameParts: string[]): void {
    if (!obj || typeof obj !== "object" || partsLeft.length === 0) return;

    const [head, ...rest] = partsLeft;
    const isArr = head.endsWith("[]");
    const key = isArr ? head.slice(0, -2) : head;
    const container = obj as Record<string, unknown>;
    const val = container[key];
    if (val == null) return;

    if (isArr) {
      if (!Array.isArray(val)) return;
      for (let idx = 0; idx < val.length; idx++) {
        const elem = val[idx];
        if (!elem || typeof elem !== "object") continue;
        const elemId =
          typeof (elem as Record<string, unknown>).name === "string"
            ? ((elem as Record<string, unknown>).name as string)
            : String(idx);

        if (rest.length === 0) {
          // Array element itself is the ref slot
          if (isInlineResource(elem as Record<string, unknown>)) {
            const name = sanitizeName([parentName, ...nameParts, key, elemId].join("_"));
            extracted.push(buildManifest(elem as Record<string, unknown>, name, parentModule));
            val[idx] = { kind: (elem as Record<string, unknown>).kind, name };
          }
        } else {
          traverse(elem, rest, [...nameParts, key, elemId]);
        }
      }
    } else {
      if (rest.length === 0) {
        // val is the ref slot
        if (val && typeof val === "object" && !Array.isArray(val) && isInlineResource(val as Record<string, unknown>)) {
          const name = sanitizeName([parentName, ...nameParts, key].join("_"));
          extracted.push(buildManifest(val as Record<string, unknown>, name, parentModule));
          container[key] = { kind: (val as Record<string, unknown>).kind, name };
        }
      } else {
        traverse(val, rest, [...nameParts, key]);
      }
    }
  }

  traverse(resource, parts, []);
  return extracted;
}

function buildManifest(
  inline: Record<string, unknown>,
  name: string,
  parentModule: string | undefined,
): ResourceManifest {
  const existingMeta =
    inline.metadata && typeof inline.metadata === "object"
      ? (inline.metadata as Record<string, unknown>)
      : {};
  return {
    ...inline,
    metadata: {
      ...existingMeta,
      name,
      // Inherit parent module only if the inline doesn't already declare one
      ...(parentModule && !existingMeta.module ? { module: parentModule } : {}),
    },
  } as ResourceManifest;
}
