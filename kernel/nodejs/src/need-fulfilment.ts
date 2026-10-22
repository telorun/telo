import { DURABLE_DIRECTORY_TYPE, sensitiveNeedFields, type NeedTypeShape } from "@telorun/analyzer";
import type { ControllerInstance, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { membersEntryOfValue, plainScalar, redactedTextsOf, RuntimeError } from "@telorun/sdk";
import { refuseUnusableDirectories } from "./durable-directories.js";

/**
 * A FULFILMENT — the values that satisfy a need, as one instance of the kernel's
 * need-type controller. Every need is bound to one: a self-supplied resource of
 * the need type, the anonymous one an import's field-by-field supply builds, or
 * the importer's own need or fulfilment handed down whole.
 *
 * Its published reading is exactly its fields, which are fixed once it exists —
 * so a module bound to it publishes the values directly rather than mirroring a
 * reading that can never change.
 *
 * A fulfilment is read by field (`resources.<need>.<field>`), or whole through
 * `ctx.resolveNeed`, and is never handed to a controller as an instance:
 * `ctx.resolveRef` refuses it and Phase-5 injection leaves its reference in place.
 */
export class NeedFulfilment implements ResourceInstance {
  constructor(
    /** The canonical need-type kind. */
    readonly type: string,
    readonly fields: Readonly<Record<string, unknown>>,
    /** The values of the fields marked `x-telo-sensitive` — what joins the
     *  redaction set of every module context the fulfilment reaches. */
    readonly sensitiveValues: readonly string[],
    /** The names of those fields — what `ctx.resolveNeed` marks sensitive. */
    readonly sensitiveFields: readonly string[],
  ) {
    fulfilments.add(this);
  }

  snapshot(): Record<string, unknown> {
    return { ...this.fields };
  }
}

const fulfilments = new WeakSet<object>();

export function isNeedFulfilment(value: unknown): value is NeedFulfilment {
  return typeof value === "object" && value !== null && fulfilments.has(value);
}

/**
 * Build a fulfilment of `shape` from its field values.
 *
 * A field marked `x-telo-sensitive` is sensitive whole: its text joins the redaction set,
 * a value of a type with members written as its plain encoding's text. A field whose value
 * type declares a sensitive member (a URL's password) is sensitive when its value holds
 * one: then its whole text and that member join the set, and the field is marked sensitive
 * as delivered.
 */
export function needFulfilment(
  type: string,
  shape: NeedTypeShape,
  fields: Record<string, unknown>,
): NeedFulfilment {
  const sensitive: string[] = [];
  const names: string[] = [];
  for (const name of sensitiveNeedFields(shape)) {
    const value = fields[name];
    const members = redactedTextsOf(value);
    if (shape.fields[name]?.["x-telo-sensitive"] === true) {
      names.push(name);
      const text = typeof value === "string" ? value : membersEntryOfValue(value) ? plainScalar(value) : undefined;
      if (typeof text === "string" && text.length > 0) sensitive.push(text);
    } else if (members.length > 0) {
      names.push(name);
    }
    sensitive.push(...members);
  }
  return new NeedFulfilment(type, fields, [...new Set(sensitive)], names);
}

/** What a module context offers a fulfilment: the redaction set its sensitive
 *  values join. */
export interface RedactionHost {
  addRedactedValues(values: Iterable<string>): void;
}

/**
 * The controller every need-type kind is served by. A resource of the kind is a
 * self-supplied fulfilment: its `fields:` are evaluated at startup (the kind is
 * a `Telo.Provider`), and its sensitive values join the redaction set of the
 * module context that declares it.
 *
 * Which keys it may and must write is the need table's to refuse, at load and at
 * `telo check` (`NEED_FIELD_UNDECLARED`, `NEED_SLOT_MISMATCH`); a fulfilment
 * reached here has passed it.
 */
export function needFulfilmentController(type: string, shape: NeedTypeShape): ControllerInstance {
  return {
    create: async (resource, ctx: ResourceContext) => {
      const written = (resource as Record<string, unknown>).fields;
      if (written !== undefined && (typeof written !== "object" || written === null || Array.isArray(written))) {
        throw new RuntimeError(
          "ERR_NEED_SLOT_MISMATCH",
          `${type}/${resource.metadata.name}: 'fields' must be a map of the type's fields.`,
        );
      }
      const fields = (written ?? {}) as Record<string, unknown>;
      if (type === DURABLE_DIRECTORY_TYPE) {
        refuseUnusableDirectories([
          {
            subject: `fulfilment '${resource.metadata.name}'`,
            directory: fields.path,
            source: "its 'fields.path'",
          },
        ]);
      }
      const fulfilment = needFulfilment(type, shape, fields);
      (ctx.moduleContext as unknown as RedactionHost).addRedactedValues(fulfilment.sensitiveValues);
      return fulfilment;
    },
  };
}
