import * as AjvNS from "ajv";
import type { KeywordDefinition } from "ajv";

/**
 * `x-telo-binary: true` — the annotation that gives a byte buffer a declared
 * identity, and the single accessor every surface reads it through (the
 * `ref-slot.ts` precedent).
 *
 * WHY AN ANNOTATION RATHER THAN A TYPE. Bytes are not expressible in JSON
 * Schema's type vocabulary. `type: object` is the closest fit and it is a lie
 * that costs a real check: every arbitrary object satisfies it, so a mistyped
 * `content: { foo: bar }` reaches the controller instead of failing statically.
 * `type: binary` would fix the honesty and break everything else — AJV refuses
 * to compile an unknown type at all (`type must be JSONType or JSONType[]`),
 * with no option to allow it, so the schema would produce no validator; and a
 * published `telo.yaml` would stop being JSON Schema, which is what the hub, the
 * editor and any third-party reader consume. An `x-` keyword is ignored by
 * unaware tooling BY SPECIFICATION, so it degrades to "unconstrained" rather
 * than to "cannot validate this kind at all".
 *
 * ONE RULE, BOTH HALVES. The keyword is implemented as AJV CODEGEN rather than a
 * `validate` function so it inlines into standalone-compiled validators — the
 * kernel compiles and caches those, and a function-valued keyword would not
 * survive serialization. The analyzer registers the identical keyword, and
 * `celPlaceholderForSchema` hands a real `Uint8Array` to a CEL leaf at a binary
 * slot, so static and runtime agree by construction instead of by two rules kept
 * in step. What falls out is the check the annotation exists for: **bytes can
 * never be manifest-authored** — no YAML literal is a `Uint8Array` — so a literal
 * at a binary slot is rejected while a value arriving by reference passes.
 */

export const X_TELO_BINARY = "x-telo-binary";

/** True when this schema node declares its value to be raw bytes. */
export function isBinarySlot(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as Record<string, unknown>)[X_TELO_BINARY] === true
  );
}

// AJV's codegen template tag. The package is consumed in both ESM and CJS interop
// shapes, so the named export may sit on the namespace or behind `.default` —
// the same fallback `schema-compat` uses to reach the constructor. Skipping it
// would leave `codegen` undefined under a loader that does not detect AJV's named
// CJS re-exports, and the keyword would throw on its first compile.
type CodegenTag = (s: TemplateStringsArray, ...a: unknown[]) => unknown;
const ajvExports = (AjvNS as any).default ?? AjvNS;
const codegen: CodegenTag = ajvExports._ ?? (AjvNS as any)._;

/**
 * The AJV keyword. `Uint8Array` is the structural test rather than any richer
 * notion of "binary": it is what every byte producer in the runtime hands over
 * (`Buffer` extends it, so Node buffers pass), and it is the one check that means
 * the same thing in a browser-side analyzer and in the kernel.
 */
export function binaryKeyword(): KeywordDefinition {
  return {
    keyword: X_TELO_BINARY,
    schemaType: "boolean",
    code(cxt: any) {
      // `x-telo-binary: false` states nothing, so it constrains nothing.
      if (cxt.schema !== true) return;
      cxt.pass(codegen`${cxt.data} instanceof Uint8Array`);
    },
    error: {
      message: "must be raw bytes (a Uint8Array) — bytes cannot be written inline in a manifest",
    },
  } as KeywordDefinition;
}
