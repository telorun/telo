/** The AJV half of `x-telo-type`, and the single place any Telo keyword is
 *  registered on an AJV instance.
 *
 *  WHY CODEGEN RATHER THAN A `validate` FUNCTION. The kernel compiles standalone
 *  validators and caches them on disk; a function-valued keyword does not survive
 *  that serialization, so the check would silently be absent from exactly the
 *  validators the runtime uses. Codegen inlines instead.
 *
 *  WHY THE CODEGEN LIVES HERE AND THE VOCABULARY DOES NOT. The SDK cannot depend
 *  on ajv, and an entry declares a REPRESENTATION rather than a code fragment —
 *  which is what lets one JSON file be read by a Rust kernel that has no AJV at
 *  all. The split is the whole point: `sdk/value-types/*.json` says *what a value
 *  is*, `sdk/nodejs/src/value-type.ts` says *what that means in this runtime*,
 *  and this file turns the pair into a check.
 *
 *  ONE REGISTRATION SITE. {@link registerTeloKeywords} replaced five drifted
 *  ones — the analyzer's `createAjv` and the kernel's `schema-validator`,
 *  `resource-context`, `observed-state` and `manifest-schemas` — which registered
 *  overlapping lists of twelve, four, one and one. Drift there is not cosmetic: a
 *  no-op registration is what keeps `strict` mode quiet about an annotation, and
 *  a keyword that emits code is missing entirely from any instance that forgot
 *  it, so the same schema validated two ways depending on which AJV saw it. */

import * as AjvNS from "ajv";
import type { KeywordDefinition } from "ajv";
import {
  CEL_SCALAR_FORMS,
  celScalarTypeOf,
  PLAIN_ENCODINGS,
  VALUE_TYPE_BINDINGS,
  X_TELO_TYPE,
  readValueTypeSlot,
  valueTypeOf,
  type ValueTypeEntry,
} from "@telorun/sdk";
import { builtinEngines } from "@telorun/templating";

// AJV's codegen template tag. The package is consumed in both ESM and CJS interop
// shapes, so the named export may sit on the namespace or behind `.default` —
// the same fallback `schema-compat` uses to reach the constructor. Skipping it
// would leave `codegen` undefined under a loader that does not detect AJV's named
// CJS re-exports, and the keyword would throw on its first compile.
type CodegenTag = (s: TemplateStringsArray, ...a: unknown[]) => unknown;
const ajvExports = (AjvNS as any).default ?? AjvNS;
const codegen: CodegenTag = ajvExports._ ?? (AjvNS as any)._;

/**
 * Annotations that carry no validation at all: analyzer, editor and topology
 * metadata. Registered as no-ops so AJV does not treat them as unknown keywords,
 * and listed in one place so an instance cannot know about half of them.
 *
 * `x-telo-type` is deliberately absent — it is the one that emits code.
 */
export const ANNOTATION_KEYWORDS = [
  "x-telo-bindings-from",
  "x-telo-catches-for",
  "x-telo-context",
  "x-telo-context-collection-from",
  "x-telo-context-element-from",
  "x-telo-context-from",
  "x-telo-context-from-ref-kind",
  "x-telo-context-from-root",
  "x-telo-context-parameters-from",
  "x-telo-context-ref-from",
  "x-telo-error-context",
  "x-telo-eval",
  "x-telo-inline",
  "x-telo-outcome-list",
  "x-telo-provides-zone",
  "x-telo-ref",
  "x-telo-requires-zone",
  "x-telo-resource-rules",
  "x-telo-returns-from",
  "x-telo-schema-from",
  "x-telo-schema-map",
  "x-telo-schema-projection",
  "x-telo-schema-projection-from",
  "x-telo-scope",
  "x-telo-sensitive",
  "x-telo-step-context",
  "x-telo-topology-role",
  "x-telo-unbound-calls",
  "x-telo-value-schema-from",
  "x-telo-widget",
] as const;

/** Folded into the kernel's validator cache key. Bump it with any change to the
 *  code or messages {@link valueTypeKeyword} emits: a validator compiled before
 *  the change is otherwise served from disk unchanged. */
export const VALUE_TYPE_KEYWORD_VERSION = 3;

/** How an AJV instance treats a `live` value type. */
export interface TeloKeywordOptions {
  /**
   * Assert a `live` type as an instance too, so a literal at such a slot is
   * refused — a value written in a manifest can never be a live instance.
   *
   * STATIC analysis only, where a CEL leaf's stand-in is an instance
   * (`celPlaceholderForSchema`). The kernel's instances leave it off: at
   * dispatch a live value is exempt from validation, and the stage that pulls
   * from it refuses a non-stream itself — so the static half refuses a strict
   * subset of what the runtime refuses, and the two cannot disagree.
   */
  readonly assertLive?: boolean;
}

/**
 * The `x-telo-type` keyword.
 *
 * Three postures, decided by the entry and never by this code:
 *
 *  - a `json` representation validates through its own declared schema, so the
 *    keyword emits nothing — the name carries nominal identity for static wiring
 *    — unless the CEL type it carries has a range JSON Schema cannot state
 *    (`CEL_SCALAR_FORMS`), which is checked;
 *  - a `live` instance is EXEMPT at dispatch: its value is never traversed,
 *    because iterating a stream to check it is precisely what the exemption is
 *    for. Statically ({@link TeloKeywordOptions.assertLive}) it is asserted like
 *    any other instance, which checks what the value IS and never iterates it;
 *  - every other instance is ASSERTED against the constructor its binding names.
 *
 * An unknown name emits nothing here. It is a hard diagnostic in the analyzer
 * (`X_TELO_TYPE_UNKNOWN`), which is where a name can be reported against the
 * manifest that wrote it; failing compilation instead would take out every
 * validator in a module for one typo in one slot.
 */
export function valueTypeKeyword(options: TeloKeywordOptions = {}): KeywordDefinition {
  return {
    keyword: X_TELO_TYPE,
    // Both spellings: a bare name, or the object form carrying type arguments.
    schemaType: ["string", "object"],
    code(cxt: any) {
      const entry: ValueTypeEntry | undefined = readValueTypeSlot({
        [X_TELO_TYPE]: cxt.schema,
      })?.entry;
      if (!entry) return;
      if (entry.representation === "json") {
        // A CEL type whose range JSON Schema cannot state (a uint) carries its
        // own check, reached through the value scope like a constructor.
        const celType = celScalarTypeOf(entry);
        const range = celType === undefined ? undefined : CEL_SCALAR_FORMS[celType]?.range;
        if (!range) return;
        const accepts = cxt.gen.scopeValue("func", {
          ref: range.accepts,
          code: codegen`require("@telorun/sdk").CEL_SCALAR_FORMS[${celType!}].range.accepts`,
        });
        // The container and key let the check tell a host view's exact rendering
        // of a wide integer from a number that was written that wide.
        cxt.pass(codegen`${accepts}(${cxt.data}, ${cxt.it.parentData}, ${cxt.it.parentDataProperty})`);
        return;
      }
      if (entry.live && !options.assertLive) return;
      const binding = VALUE_TYPE_BINDINGS[entry.binding!];
      if (!binding) return;
      // The constructor reaches generated code through AJV's value scope, which
      // is what keeps this general: `Uint8Array` happens to be a global, but a
      // binding may name a class that is not, and inlining a bare identifier
      // would compile to a reference that does not resolve.
      const ctor = cxt.gen.scopeValue("obj", {
        ref: binding.constructor,
        code: codegen`require("@telorun/sdk").VALUE_TYPE_BINDINGS[${entry.binding!}].constructor`,
      });
      cxt.pass(codegen`${cxt.data} instanceof ${ctor}`);
    },
    error: {
      message: (cxt: any) => {
        const entry = readValueTypeSlot({ [X_TELO_TYPE]: cxt.schema })?.entry;
        if (entry?.live) {
          return (
            `must be a live ${entry.name} — a value written in the manifest can never be one; ` +
            "pass the result of a step that produces it, with a !cel expression"
          );
        }
        if (!entry) return "must be a declared value type";
        const celType = celScalarTypeOf(entry);
        const range = celType === undefined ? undefined : CEL_SCALAR_FORMS[celType]?.range;
        if (range) return `must be a ${entry.name}, ${range.describe}`;
        const encoding = entry.encoding === undefined ? undefined : PLAIN_ENCODINGS[entry.encoding];
        if (!encoding) return `must be a ${entry.name}`;
        return (
          `must be a ${entry.name} — text written in the manifest or an environment variable ` +
          `is read only as ${encoding.form}, and a computed value must already be one` +
          producingTags(entry)
        );
      },
    },
  } as KeywordDefinition;
}

/** The tags whose produced type is this value type, as a closing hint — an
 *  embed's contents are never decoded, so a file is written with its own tag. */
function producingTags(entry: ValueTypeEntry): string {
  const tags = builtinEngines
    .filter((engine) => valueTypeOf(engine.producedType?.())?.name === entry.name)
    .map((engine) => `!${engine.name}`);
  return tags.length === 0 ? "" : `; embed a file with ${tags.join(" or ")}`;
}

/**
 * Register every Telo keyword on an AJV instance: the annotations as no-ops and
 * `x-telo-type` as the one that checks.
 *
 * Every AJV instance in the runtime and the analyzer goes through this, so a
 * schema means the same thing wherever it is validated — apart from the one
 * posture {@link TeloKeywordOptions} names, which only static analysis takes.
 */
export function registerTeloKeywords(
  ajv: { addKeyword: (keyword: any, definition?: any) => unknown },
  options: TeloKeywordOptions = {},
): void {
  for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword(keyword);
  ajv.addKeyword(valueTypeKeyword(options));
}
