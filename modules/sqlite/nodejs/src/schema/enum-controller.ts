import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { normalizeEnum, type DeclaredEnum, type RawEnum } from "@telorun/sql";

/**
 * `SQLite.Enum` — one declared set of permitted values.
 *
 * SQLite has no named types, so nothing in the database corresponds to this
 * resource: the values are rendered as a `CHECK` on every column that references
 * it. The DECLARATION is still a ledger object like any other, which is what
 * lets a change to it be detected at all.
 */
export class SqliteEnumResource implements ResourceInstance {
  readonly declaration: DeclaredEnum;

  constructor(raw: RawEnum) {
    this.declaration = normalizeEnum(raw);
  }

  get typeName(): string {
    return this.declaration.typeName;
  }

  snapshot(): Record<string, unknown> {
    return { typeName: this.declaration.typeName, values: [...this.declaration.values] };
  }
}

export function register(): void {}

export async function create(
  resource: RawEnum,
  _ctx: ResourceContext,
): Promise<SqliteEnumResource> {
  return new SqliteEnumResource(resource);
}
