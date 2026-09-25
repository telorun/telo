/**
 * **Telo formats at creation**, for the values validation could not see.
 *
 * A resource is validated before its compile-eval expressions run, so an
 * expression at a `format: css-selector` slot is checked as the format's
 * stand-in. Its RESULT is checked here, once it exists — the same order the
 * host-path refusal follows. A result that is not text at all is refused too:
 * a `dyn` expression passes `telo check`, and the controller must not receive
 * a number where the format promises a string.
 */
import { isCompiledValue, RuntimeError } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import {
  describeTeloFormatFailure,
  type ExternalSchemaResolver,
  mapTextLeaves,
  teloFormatFailure,
  teloFormatOf,
} from "@telorun/analyzer";

export function refuseMalformedFormats(
  resource: Record<string, unknown>,
  schema: Record<string, any>,
  label: string,
  external?: ExternalSchemaResolver,
): void {
  mapTextLeaves(
    resource,
    schema,
    (slot, text, pointer) => {
      const format = teloFormatOf(slot);
      const failure = format && teloFormatFailure(format.name, text);
      if (!failure) return text;
      throw new RuntimeError(
        "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
        `${label}: ${pointer || "/"} ${describeTeloFormatFailure(format!.name, text, failure)} (the value an expression produced).`,
      );
    },
    external,
    schema,
    (slot, node, pointer) => {
      if (typeof node === "string" || node === undefined) return;
      if (isCompiledValue(node) || isTaggedSentinel(node)) return;
      const format = teloFormatOf(slot);
      if (!format || (node === null && allowsNull(slot))) return;
      throw new RuntimeError(
        "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
        `${label}: ${pointer || "/"} must be a ${format.name} string, but the expression produced ${describeValue(node)}.`,
      );
    },
  );
}

function allowsNull(slot: Record<string, any>): boolean {
  return slot.type === "null" || (Array.isArray(slot.type) && slot.type.includes("null"));
}

function describeValue(node: unknown): string {
  if (node === null) return "null";
  if (Array.isArray(node)) return "a list";
  if (typeof node === "number" || typeof node === "bigint") return `the number ${String(node)}`;
  if (typeof node === "boolean") return `the boolean ${String(node)}`;
  return "an object";
}
