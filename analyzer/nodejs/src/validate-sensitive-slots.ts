import type { ResourceManifest } from "@telorun/sdk";
import { SCHEMA_REGION_KEYS } from "./schema-region.js";

/**
 * `x-telo-sensitive` where nothing reads it.
 *
 * The annotation has exactly one consumer: the kernel resolves it from a
 * resource's bound CONTRACT — `inputType` / `outputType` — and carries the
 * marked value as `[redacted]` in trace payloads. Written anywhere else it is an
 * unknown keyword in an open schema, which is to say it validates, ships, and
 * does nothing.
 *
 * For a security control that is the worst available failure: an author marks a
 * token, sees no error, and puts it on the debug wire anyway. So a misplacement
 * is reported rather than ignored — the same posture `X_TELO_REF_UNRESOLVED`
 * takes toward a reference constraint that resolves to nothing, and for the same
 * reason: silence reads as protection.
 *
 * Scoped by the caller to the entry's own modules, since a dependency's schema
 * is not the consumer's to fix.
 */
export interface SensitiveSlotIssue {
  code: "SENSITIVE_ANNOTATION_MISPLACED" | "SENSITIVE_ANNOTATION_INVALID";
  manifest: ResourceManifest;
  /** Dotted path to the annotated schema node. */
  path: string;
  message: string;
}

const ANNOTATION = "x-telo-sensitive";

/** The only regions the kernel reads the annotation from. */
const CONTRACT_KEYS = new Set(["inputType", "outputType"]);

export function validateSensitiveSlots(manifest: ResourceManifest): SensitiveSlotIssue[] {
  const issues: SensitiveSlotIssue[] = [];

  const walk = (node: unknown, path: (string | number)[], seen: Set<object>): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, i], seen));
      return;
    }

    const record = node as Record<string, unknown>;
    if (Object.hasOwn(record, ANNOTATION)) {
      const dotted = path.join(".");
      if (record[ANNOTATION] !== true) {
        issues.push({
          code: "SENSITIVE_ANNOTATION_INVALID",
          manifest,
          path: dotted,
          message:
            `'${ANNOTATION}' must be \`true\`; got ${JSON.stringify(record[ANNOTATION])}. ` +
            `It is a marker, not a level — a value other than \`true\` reads as "not sensitive".`,
        });
      } else {
        const region = enclosingSchemaRegion(path);
        if (region === undefined || !CONTRACT_KEYS.has(region)) {
          issues.push({
            code: "SENSITIVE_ANNOTATION_MISPLACED",
            manifest,
            path: dotted,
            message:
              `'${ANNOTATION}' is only read from a resource's declared contract ` +
              `(\`inputType\` / \`outputType\`), and this node is ` +
              (region === undefined
                ? "not inside a schema at all"
                : `inside \`${region}\``) +
              `. The kernel will not redact it, so the value would still reach trace ` +
              `payloads and the debug wire. Move the mark onto the contract property ` +
              `that carries the value.`,
          });
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      walk(child, [...path, key], seen);
    }
  };

  walk(manifest as unknown as Record<string, unknown>, [], new Set());
  return issues;
}

/**
 * The OUTERMOST segment naming a schema-valued key, or `undefined` when the node
 * is not inside a schema.
 *
 * Outermost, not nearest, because a contract is routinely written in the inline
 * `{kind: Telo.JsonSchema, schema: …}` form — so the path to a marked property is
 * `outputType.schema.properties.headers`, and the nearest region key is that
 * wrapper's own `schema`. Reading it as a kind's configuration would report every
 * correctly-marked contract as misplaced, which is how this check first behaved.
 *
 * It is the same reasoning `expandManifestFragments` uses when it keys on the
 * top-level slot: the object a contract resolver is handed is the one under
 * `inputType` / `outputType`, whatever nesting the authoring form adds beneath.
 */
function enclosingSchemaRegion(path: readonly (string | number)[]): string | undefined {
  for (const segment of path) {
    if (typeof segment === "string" && SCHEMA_REGION_KEYS.includes(segment)) return segment;
  }
  return undefined;
}
