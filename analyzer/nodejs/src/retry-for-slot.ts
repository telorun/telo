/**
 * The single reader of `x-telo-retry-for` — a kind declaring that the retry
 * policy at one of its fields re-attempts the dispatch through one of its own
 * reference slots, and which codes it raises into that loop itself.
 *
 * A step's own `retry:` sits beside the `invoke:` it re-attempts, so the throws
 * pass finds both through the step grammar. A kind that drives a handler and
 * retries it on its own — a queue worker re-delivering a message — holds the
 * policy at a field of its own, beside the slot, and raises a code of its own
 * into the loop (an attempt that overran its deadline). Nothing in the schema
 * relates the two fields, so `nonRetryable` and `retryAfter` went unjudged for
 * exactly the holders whose policy decides whether a message is dead-lettered.
 * The annotation is that relation, as data:
 *
 * ```yaml
 * retry:
 *   $ref: telo://manifest#/$defs/RetryPolicy
 *   x-telo-retry-for:
 *     slot: /invoke
 *     codes:
 *       ERR_QUEUE_TIMEOUT: { description: The attempt overran its timeout. }
 * ```
 *
 * `codes` has the `throws:` vocabulary's shape — a description per code and an
 * optional `data` schema — because the holder is usually a `Telo.Service`, which
 * may declare no `throws:` of its own.
 *
 * Placement: a named top-level property of the kind's schema, holding a retry
 * policy, naming a top-level reference slot that transfers control. Read only by
 * the analyzer, so there is no runtime twin — the holder's controller runs its
 * own loop.
 *
 * Lenient here, the `ref-slot.ts` precedent: anything unreadable reads as
 * absent, and {@link retryForProblems} is the strict half.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ThrowsCodeMeta } from "./resolve-throws-union.js";
import { drivenReads } from "./caught-member.js";
import type { ReadReporter } from "./read-place.js";
import { possibleUses, readRefSlot, transfersControl } from "./ref-slot.js";
import { schemaChildren } from "./value-schema-slot.js";

export const RETRY_FOR_ANNOTATION = "x-telo-retry-for";

/** The fragment a retry policy expands from, read off the expansion's stamp. */
const RETRY_POLICY_FRAGMENT = "RetryPolicy";

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface RetryForSlot {
  /** The top-level reference slot whose dispatch the policy re-attempts. */
  readonly slot: string;
  /** Codes the holder raises into the loop itself, beside the slot target's. */
  readonly codes: ReadonlyMap<string, ThrowsCodeMeta>;
}

/** One annotated field of a kind: the policy's field and what it retries. */
export interface RetryForSite {
  readonly field: string;
  readonly retryFor: RetryForSlot;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The single top-level property a pointer names (`/invoke` → `invoke`). */
function topLevelField(pointer: unknown): string | undefined {
  if (typeof pointer !== "string" || !/^\/[^/]+$/.test(pointer)) return undefined;
  return pointer.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The annotation on one schema node, or undefined when it is absent or
 *  unreadable. */
export function readRetryFor(node: Record<string, any> | undefined): RetryForSlot | undefined {
  const raw = node?.[RETRY_FOR_ANNOTATION];
  if (!isObject(raw) || topLevelField(raw.slot) === undefined) return undefined;
  const codes = new Map<string, ThrowsCodeMeta>();
  if (raw.codes !== undefined) {
    if (!isObject(raw.codes)) return undefined;
    for (const [code, meta] of Object.entries(raw.codes)) {
      if (!CODE_PATTERN.test(code) || !isObject(meta)) return undefined;
      codes.set(code, isObject(meta.data) ? { data: meta.data } : {});
    }
  }
  return { slot: raw.slot as string, codes };
}

/** Every top-level field of a kind's schema carrying the annotation. */
export function retryForSites(schema: unknown): RetryForSite[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const out: RetryForSite[] = [];
  for (const [field, node] of Object.entries(schema.properties)) {
    const retryFor = isObject(node) ? readRetryFor(node) : undefined;
    if (retryFor) out.push({ field, retryFor });
  }
  return out;
}

/** The field of the resource a site's slot names. */
export function retryForTargetField(retryFor: RetryForSlot): string {
  return topLevelField(retryFor.slot)!;
}

/** What `x-telo-retry-for` reads: the throws of what the slot it names
 *  dispatches, as a catch list reads its handler's. */
export const retryForReads: ReadReporter = ({ node }) => {
  const retryFor = readRetryFor(node);
  return retryFor ? [{ kind: "reference", keys: [retryForTargetField(retryFor)], transitive: true, reads: drivenReads }] : [];
};

export interface RetryForProblem {
  /** Where the annotation is written, from the definition document. */
  readonly path: string;
  readonly message: string;
}

/**
 * Every way a kind's `x-telo-retry-for` annotations are malformed or misplaced —
 * `RETRY_FOR_INVALID` at the annotation. An annotation the reader cannot read is
 * one the throws pass silently skips, which reads as a policy with nothing wrong
 * with it.
 */
export function retryForProblems(definition: {
  metadata?: { name?: unknown };
  schema?: unknown;
}): RetryForProblem[] {
  const schema = definition.schema;
  if (!isObject(schema)) return [];
  const name = String(definition.metadata?.name);
  const problems: RetryForProblem[] = [];
  const properties = isObject(schema.properties) ? schema.properties : {};

  const visit = (node: Record<string, any>, path: string, topLevelField: string | undefined): void => {
    if (node[RETRY_FOR_ANNOTATION] !== undefined) {
      const at = `${path}.${RETRY_FOR_ANNOTATION}`;
      if (topLevelField === undefined) {
        problems.push({
          path: at,
          message:
            `'${name}' declares \`${RETRY_FOR_ANNOTATION}\` at '${at}', where nothing reads it. It ` +
            "belongs on a named top-level property of the kind's schema holding a retry policy.",
        });
      } else {
        problems.push(...annotationProblems(name, node, at, topLevelField, properties));
      }
    }
    for (const child of schemaChildren(node)) {
      const childPath =
        child.at === undefined ? `${path}.${child.keyword}` : `${path}.${child.keyword}.${child.at}`;
      const isTopLevel = node === schema && child.keyword === "properties" && typeof child.at === "string";
      visit(child.schema as Record<string, any>, childPath, isTopLevel ? (child.at as string) : undefined);
    }
  };
  visit(schema, "schema", undefined);
  return problems;
}

function annotationProblems(
  name: string,
  node: Record<string, any>,
  at: string,
  field: string,
  properties: Record<string, any>,
): RetryForProblem[] {
  const problems: RetryForProblem[] = [];
  const problem = (where: string, message: string) =>
    problems.push({ path: where, message: `'${name}' ${message}` });
  const raw = node[RETRY_FOR_ANNOTATION];
  if (!isObject(raw)) {
    problem(at, `\`${RETRY_FOR_ANNOTATION}\` must be an object: { slot: /<field>, codes?: { <CODE>: { description, data? } } }.`);
    return problems;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "slot" && key !== "codes") {
      problem(`${at}.${key}`, `\`${RETRY_FOR_ANNOTATION}\` has no key '${key}' — only 'slot' and 'codes'.`);
    }
  }
  if (node["x-telo-fragment"] !== RETRY_POLICY_FRAGMENT) {
    problem(
      at,
      `annotates '${field}', which does not hold a retry policy. Write the field as ` +
        "`$ref: telo://manifest#/$defs/RetryPolicy` beside the annotation.",
    );
  }
  const target = topLevelField(raw.slot);
  if (target === undefined) {
    problem(
      `${at}.slot`,
      "names its slot with 'slot', a JSON Pointer to one top-level field of the kind (/invoke).",
    );
  } else {
    const slot = isObject(properties[target]) ? readRefSlot(properties[target]) : undefined;
    if (!slot) {
      problem(
        `${at}.slot`,
        `names '${raw.slot}' as the slot '${field}' retries, but the kind declares no reference slot there.`,
      );
    } else if (!possibleUses(slot).some(transfersControl) && possibleUses(slot).length > 0) {
      problem(
        `${at}.slot`,
        `names '${raw.slot}' as the slot '${field}' retries, but that slot transfers no control — ` +
          "a held dependency is never dispatched, so nothing there is re-attempted.",
      );
    }
  }
  if (raw.codes !== undefined) {
    if (!isObject(raw.codes)) {
      problem(`${at}.codes`, "lists its own codes as a map: { <CODE>: { description, data? } }.");
    } else {
      for (const [code, meta] of Object.entries(raw.codes)) {
        const where = `${at}.codes.${code}`;
        if (!CODE_PATTERN.test(code)) {
          problem(where, `names code '${code}', which is not an upper-case code (ERR_QUEUE_TIMEOUT).`);
        }
        if (!isObject(meta) || typeof meta.description !== "string") {
          problem(where, `describes code '${code}' with no 'description' — say when the kind raises it.`);
          continue;
        }
        for (const key of Object.keys(meta)) {
          if (key !== "description" && key !== "data") {
            problem(`${where}.${key}`, `describes code '${code}' with '${key}' — only 'description' and 'data'.`);
          }
        }
        if (meta.data !== undefined && !isObject(meta.data)) {
          problem(`${where}.data`, `types code '${code}''s data with something that is not a JSON Schema object.`);
        }
      }
    }
  }
  return problems;
}
