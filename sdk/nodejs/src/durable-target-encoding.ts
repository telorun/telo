/**
 * The wire form of a {@link DurableTarget} — spec §5.3.
 *
 * Written in the slice where something first sends one across a process
 * boundary, and not before: a normative format frozen with no consumer is the
 * failure the sequencing rule exists to prevent. What crosses first is a child
 * kernel, which is a real boundary — it shares no instance graph with its
 * parent, so nothing about a target can survive by accident.
 *
 * **JSON, not a URI.** A journal entry already carries its target as JSON, and a
 * second serialization vocabulary for one value is a second thing to keep
 * agreeing. What this adds over `JSON.stringify` is what a FORMAT has to add:
 * a canonical key order, so two runtimes producing the same identity produce the
 * same bytes and an equality check needs no parser; a version tag, so a later
 * form is refused rather than misread; and a stated set of required fields per
 * form, so an incomplete identity is refused at the encoder rather than
 * resolving to the wrong resource at the far end.
 *
 * **Three forms, discriminated by shape rather than by a tag.** Which one a
 * target is follows from which fields it carries — `scope` makes it scoped,
 * `pointer` makes it inline, neither makes it module-level — and the encoder
 * refuses a value carrying both, since that is not a fourth form but a
 * contradiction.
 */
import type { DurableTarget } from "./durable-run.js";
import { InvokeError } from "./invoke-error.js";

/** Bumped only for a change a previous reader would MISREAD. A new optional
 *  field a reader can ignore is not one; a change to what an existing field
 *  means is. */
export const DURABLE_TARGET_ENCODING_VERSION = 1;

/**
 * Canonical key order: `v`, `kind`, `name`, `module`, `pointer`, `scope`, and
 * inside `scope`, `owner`, `site`, `stepPath`.
 *
 * Fixed rather than left to whichever code path built the target, because two
 * paths producing the same identity must produce the same bytes — that is what
 * lets a recipient compare, log and key on the encoded form without decoding it
 * first. Enforced by BUILDING the payload in this order and letting
 * `JSON.stringify` follow insertion order, not by passing these as its replacer
 * array: a replacer array filters keys at EVERY depth, so the nested scope keys
 * are absent from the top-level list and a scoped target would encode with an
 * empty `scope` — the identity's whole distinguishing half, dropped silently.
 */
const SCOPE_KEY_ORDER = ["owner", "site", "stepPath"] as const;

/**
 * Encode a target for transport.
 *
 * Refuses rather than guesses. An identity missing what its form requires would
 * decode at the far end into a resource that is merely *similar*, and a step
 * executed against the wrong resource is the one failure durable execution must
 * never produce quietly — so an incomplete target is an error at the sender,
 * where the manifest that produced it is still in reach.
 */
export function encodeDurableTarget(target: DurableTarget): string {
  if (!target.kind || !target.name) {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNENCODABLE",
      `A step target must carry both a kind and a name to cross a process boundary; ` +
        `got kind='${target.kind ?? ""}' name='${target.name ?? ""}'.`,
      { target },
    );
  }
  if (target.pointer !== undefined && (target.scoped || target.scope !== undefined)) {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNENCODABLE",
      `A step target is declared one way: at module level, inside a 'with:' scope, or ` +
        `inline. This one carries both a scope and a pointer, which describes no ` +
        `declaration site.`,
      { target },
    );
  }
  // The module is what disambiguates two libraries that each declare a `store`,
  // and a recipient resolving without it would pick whichever it saw first. It
  // is required for every form that leaves the process, and optional only on the
  // in-process interface, where an entry written before it was recorded must
  // still replay.
  if (!target.module) {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNENCODABLE",
      `Step target ${target.kind} '${target.name}' carries no declaring module, so a ` +
        `recipient could not tell it from a same-named resource in another module.`,
      { target },
    );
  }
  // A SCOPED target must carry its tuple, and the check is on `scoped` rather
  // than on the presence of `scope` — otherwise a scoped target whose tuple
  // could not be derived would pass here as module-level, which is precisely the
  // misresolution this refusal exists to prevent: at the far end that identity
  // names a DIFFERENT resource that merely shares the name.
  if (target.scoped || target.scope !== undefined) {
    for (const key of SCOPE_KEY_ORDER) {
      if (target.scope?.[key]) continue;
      throw new InvokeError(
        "ERR_DURABLE_TARGET_UNENCODABLE",
        `Step target ${target.kind} '${target.name}' is declared inside a 'with:' scope ` +
          `but records no ${key}. A scoped instance is distinguished by its scope RUN, so ` +
          `an identity missing that names every run of the scope at once.`,
        { target },
      );
    }
  }
  const payload: Record<string, unknown> = {
    v: DURABLE_TARGET_ENCODING_VERSION,
    kind: target.kind,
    name: target.name,
    module: target.module,
    ...(target.pointer === undefined ? {} : { pointer: target.pointer }),
    ...(target.scope === undefined
      ? {}
      : {
          scope: {
            owner: target.scope.owner,
            site: target.scope.site,
            stepPath: target.scope.stepPath,
          },
        }),
  };
  return JSON.stringify(payload);
}

/**
 * Decode a target received from another process.
 *
 * A version this reader does not know is REFUSED, never read as far as it
 * understands: the fields it recognizes may mean something else in a form it has
 * never seen, and resolving anyway is how a step gets executed against a
 * resource nobody named.
 */
export function decodeDurableTarget(encoded: string): DurableTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (err) {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNDECODABLE",
      `A step target arrived that is not valid JSON: ${(err as Error).message}`,
      { encoded },
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNDECODABLE",
      `A step target arrived that is not an object.`,
      { encoded },
    );
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== DURABLE_TARGET_ENCODING_VERSION) {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNDECODABLE",
      `A step target arrived in encoding version ${String(raw.v)}, and this runtime reads ` +
        `version ${DURABLE_TARGET_ENCODING_VERSION}. Reading the fields it recognizes would ` +
        `risk resolving a resource nobody named.`,
      { encoded },
    );
  }
  if (typeof raw.kind !== "string" || typeof raw.name !== "string" || typeof raw.module !== "string") {
    throw new InvokeError(
      "ERR_DURABLE_TARGET_UNDECODABLE",
      `A step target arrived without a kind, a name or a module.`,
      { encoded },
    );
  }
  const scope = raw.scope as Record<string, unknown> | undefined;
  return {
    kind: raw.kind,
    name: raw.name,
    module: raw.module,
    ...(typeof raw.pointer === "string" ? { pointer: raw.pointer } : {}),
    ...(scope &&
    typeof scope.owner === "string" &&
    typeof scope.site === "string" &&
    typeof scope.stepPath === "string"
      ? { scope: { owner: scope.owner, site: scope.site, stepPath: scope.stepPath } }
      : {}),
  };
}
