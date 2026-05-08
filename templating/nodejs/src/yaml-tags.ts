import type { ScalarTag } from "yaml";
import { stringifyString } from "yaml/util";
import { defaultRegistry } from "./builtins.js";
import { isTaggedSentinel, makeTaggedSentinel, type TaggedSentinel } from "./sentinel.js";
import type { TemplatingEngineRegistry } from "./registry.js";

/** Build the `customTags` array passed to `yaml`'s `parseAllDocuments` /
 *  `Document` from the registered engines. Each engine contributes one
 *  ScalarTag whose `resolve` produces a `TaggedSentinel`, and whose
 *  `identify` + `stringify` round-trip the sentinel back to its original
 *  `!<engine> "<source>"` form when the document is re-serialized.
 *
 *  Without `stringify`, `Document.toString()` would emit the sentinel as a
 *  YAML mapping (`{__tagged: true, engine: cel, source: ...}`), corrupting
 *  the file on the editor's first save. Without `identify`, the serializer
 *  wouldn't know to use the custom tag at all and would fall through to
 *  default object serialization.
 *
 *  Single source of truth: every `parseAllDocuments` call site in the repo
 *  calls this factory so the parse-side configuration cannot drift between
 *  hosts. Each host passes its own registry (in practice always
 *  `createDefaultRegistry()`), keeping the door open for future
 *  test-only registries. */
export function buildCustomTags(registry: TemplatingEngineRegistry): ScalarTag[] {
  return registry.list().map((engine) => buildTagForEngine(engine.name));
}

/** Returns `customTags` built from the default registry, freshly each call.
 *  Every `parseAllDocuments` call site in the repo calls this so they all
 *  parse the same set of tags. Built from `defaultRegistry()` (the same
 *  singleton precompile + the analyzer use) so registering a new engine on
 *  the default registry propagates to YAML parsing on the next call. The
 *  rebuild cost is negligible (one array of N small ScalarTag objects). */
export function defaultCustomTags(): ScalarTag[] {
  return buildCustomTags(defaultRegistry());
}

function buildTagForEngine(engineName: string): ScalarTag {
  const tagId = `!${engineName}`;
  return {
    tag: tagId,
    resolve: (value: string): TaggedSentinel => makeTaggedSentinel(engineName, value),
    identify: (v: unknown): boolean => isTaggedSentinel(v) && v.engine === engineName,
    stringify(item, ctx, onComment, onChompKeep): string {
      // Two paths reach this function:
      // 1. Parsed-then-serialized: the resolver produced a TaggedSentinel
      //    and we recover the original `source` from it; the original
      //    Scalar carries the user's chosen quoting style on `item.type`,
      //    which we pass through so single-quoted stays single-quoted.
      // 2. setTag applied to an existing scalar: the underlying value is a
      //    plain primitive (string/number/boolean) — coerce to string and
      //    let yaml's stringifier pick a safe default style.
      // Either way, delegate to yaml's `stringifyString` so newlines, tabs,
      // control characters, leading-whitespace lines, and multi-line content
      // are all escaped/quoted correctly. The yaml lib emits the tag prefix
      // itself; this only returns the scalar body.
      const value = item.value;
      const source = isTaggedSentinel(value)
        ? value.source
        : value === null || value === undefined
          ? ""
          : String(value);
      return stringifyString(
        { value: source, type: (item as { type?: string }).type },
        ctx,
        onComment,
        onChompKeep,
      );
    },
  } satisfies ScalarTag;
}
