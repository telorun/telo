/**
 * **`Telo.HostPath` at runtime** — the kernel's half of the value type whose
 * values are absolute paths on the host.
 *
 * Two rules, one per direction a value arrives from:
 *
 *  - text the HOST supplies (an Application variable's env value, or the
 *    `default:` standing in for one) may be relative, and is resolved against
 *    the entry's `fromHost` anchor — the one place a relative path is read;
 *  - everything else must already be absolute. A literal is refused by the
 *    `x-telo-type` keyword at validation; a compile-eval expression is only a
 *    placeholder then, so its RESULT is checked here, once it exists.
 */
import path from "node:path";
import { isAbsoluteHostPath, RuntimeError, VALUE_TYPES } from "@telorun/sdk";
import {
  decodePlainLiterals,
  type ExternalSchemaResolver,
  hostAnchorFor,
  hostPathRelativeMessage,
  mapTextLeaves,
} from "@telorun/analyzer";

/** The one host-path value type, named in the refusal. */
const HOST_PATH_TYPE = VALUE_TYPES.get("Telo.HostPath")!;

/** Each `fromHost` anchor mapped to what it means in this runtime. */
const HOST_ANCHOR_RESOLVERS: Readonly<Record<string, (text: string) => string>> = {
  "working-directory": (text) => path.resolve(process.cwd(), text),
};

// An anchor this runtime cannot map would leave a relative host value relative,
// and every slot of that type would then refuse the operator's input — so it is
// a startup error, the rule an unmapped value-type binding follows.
for (const entry of VALUE_TYPES.values()) {
  if (entry.fromHost !== undefined && !(entry.fromHost in HOST_ANCHOR_RESOLVERS)) {
    throw new Error(
      `Value type '${entry.name}' anchors host values at '${entry.fromHost}', which this ` +
        `kernel cannot resolve (it knows: ${Object.keys(HOST_ANCHOR_RESOLVERS).join(", ")}).`,
    );
  }
}

/**
 * Decode a host-supplied value's plain-encoded text AND resolve every relative
 * host path in it against its anchor, in place. The whole value may be the path
 * (`x-telo-type: Telo.HostPath`), or a field of a JSON-decoded one.
 */
export function decodeHostValue(
  value: unknown,
  schema: Record<string, any>,
  external?: ExternalSchemaResolver,
): unknown {
  const decoded = decodePlainLiterals(value, schema, external);
  return mapTextLeaves(
    decoded,
    schema,
    (slot, text) => {
      const anchor = hostAnchorFor(slot, text);
      return anchor === undefined ? text : HOST_ANCHOR_RESOLVERS[anchor]!(text);
    },
    external,
  );
}

/**
 * Refuse a relative host path a compile-eval expression produced, naming where.
 * Literals never reach this — validation refused them first — so what is left
 * is an expression whose result the placeholder could not predict.
 */
export function refuseRelativeHostPaths(
  resource: Record<string, unknown>,
  schema: Record<string, any>,
  label: string,
  external?: ExternalSchemaResolver,
): void {
  mapTextLeaves(
    resource,
    schema,
    (slot, text) => {
      if (hostAnchorFor(slot, text) === undefined || isAbsoluteHostPath(text)) return text;
      throw new RuntimeError(
        "ERR_HOST_PATH_RELATIVE",
        `${label}: '${text}' ${hostPathRelativeMessage(HOST_PATH_TYPE)}.`,
      );
    },
    external,
  );
}
