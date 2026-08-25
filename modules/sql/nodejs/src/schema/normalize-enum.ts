import type { DeclaredEnum } from "./declared-schema.js";

/**
 * The manifest shape a backend's `Enum` kind declares, reduced to the normalized
 * model — the counterpart of `normalizeTable`, and the same division of labour:
 * the STRUCTURE is shared, the rendering is not.
 *
 * `baseType` is present only for an engine with no named types, where the values
 * are rendered as a per-column constraint and something has to say which storage
 * class they sit in. An engine whose enum IS its own base type declares none.
 */
export interface RawEnum {
  readonly typeName: string;
  readonly values: readonly string[];
  readonly baseType?: string;
  readonly renamedFrom?: string;
}

/**
 * Structural checks over one declaration, at resource creation.
 *
 * The same checks `Sql.Enum`'s resource rules make at `telo check`, kept here for
 * the reason the table rules are: a library caller reaching the schema pass
 * directly never passed through the analyzer. Each would otherwise reach the
 * engine as raw DDL and come back naming a statement the author never wrote.
 */
export function normalizeEnum(raw: RawEnum): DeclaredEnum {
  if (raw.values.length === 0) {
    throw new Error(`enum '${raw.typeName}' declares no values — an enum needs at least one.`);
  }
  const seen = new Set<string>();
  for (const value of raw.values) {
    if (seen.has(value)) {
      throw new Error(
        `enum '${raw.typeName}' repeats the value '${value}'. Each label is distinct, and the ` +
          `engine would refuse the type rather than name the duplicate.`,
      );
    }
    seen.add(value);
  }
  if (raw.renamedFrom === raw.typeName) {
    throw new Error(
      `enum '${raw.typeName}' declares renamedFrom itself, which describes no rename.`,
    );
  }
  return {
    typeName: raw.typeName,
    values: [...raw.values],
    baseType: raw.baseType,
    renamedFrom: raw.renamedFrom,
  };
}
