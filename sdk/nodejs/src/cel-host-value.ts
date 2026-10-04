/**
 * **The one seam a CEL value crosses on its way OUT to a host reader.**
 *
 * The value domain has two representations of one map: a `CelMap`, whose entries are keyed
 * by each key's own typed value so that one container holds CEL's four key types and no key
 * can ever be a property name; and a plain object with string keys, which is how a host
 * hands a map over and the only one of the two that the rest of the runtime can read — a
 * JSON Schema validator, a controller's `inputs`, an HTTP body and `JSON.stringify` all see
 * a `CelMap`'s internals (`{"entries":{}}`) rather than its contents.
 *
 * So every boundary where a value computed by the engine reaches a host reader converts
 * here, and nowhere else: the result of a compiled value, the arguments of a module
 * function's call, the arguments of a host-backed catalog function. Writing the conversion
 * at one of those and not the others is what produced `sealCursor({"query":{"entries":{}}})`
 * and `json({'a': 1}) == "{\"entries\":{}}"` from one omission each.
 *
 * **A map with an int, uint or bool key is left exactly as it is.** A plain object cannot
 * hold one, so converting would collapse the four key types to text and lose what the
 * author wrote — which is the whole reason a map's entries are keyed by their typed value.
 * Whatever meets such a map next refuses it on its own terms (the typed frame names it
 * unencodable; the plain-JSON writer writes each key as its text, the protobuf JSON rule)
 * rather than being handed a silently different map.
 *
 * It converts the map REPRESENTATION and nothing else: a `uint`, a duration, an instant and
 * bytes cross unchanged, because a host reader of a typed slot must receive the value its
 * contract declares. Writing a value as text for a reader that is not a Telo runtime is the
 * plain-JSON writer's job (`plain-json.ts`), and the typed frame's for one that is.
 */
import { isCelDuration, isCelMap, isCelRecord } from "./cel-value-identity.js";
import { withLegacyDurationMethods } from "./legacy-value-classes.js";

/**
 * `value` in the form a host holds it: every all-string-key map in it a plain object,
 * returned by identity wherever nothing moved, so an unchanged tree costs no allocation and
 * a caller can tell whether anything was converted.
 */
export function hostValueOf(value: unknown): unknown {
  // A duration the ENGINE produced (`!cel "duration('30s')"`) reaches a controller here, and
  // a controller published against the replaced `Duration` class reads it with
  // `getMilliseconds()`. Attached non-enumerably and in place, so the value keeps its brand
  // and its identity — this seam already exists to say what a CEL value is to a host, which
  // makes it the one point both the decoded and the computed duration pass through.
  if (isCelDuration(value)) return withLegacyDurationMethods(value);
  if (Array.isArray(value)) {
    const out = value.map(hostValueOf);
    return out.every((held, at) => held === value[at]) ? value : out;
  }
  if (isCelMap(value)) {
    const out: Record<string, unknown> = {};
    for (const entry of value.entries.values()) {
      // One non-string key and the whole map stays as it is: a plain object holds no other
      // key type, and a partial conversion would be a third representation.
      if (typeof entry.key !== "string") return value;
      out[entry.key] = hostValueOf(entry.value);
    }
    return out;
  }
  // A branded value is a plain object, so the descent asks the value domain rather than the
  // prototype: testing the prototype would rebuild a duration or a uint without its brand.
  if (isCelRecord(value)) {
    let copy: Record<string, unknown> | undefined;
    for (const [key, held] of Object.entries(value)) {
      const converted = hostValueOf(held);
      if (converted !== held) (copy ??= { ...value })[key] = converted;
    }
    return copy ?? value;
  }
  return value;
}
