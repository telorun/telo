import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { normalizeEnum, type DeclaredEnum, type RawEnum } from "@telorun/sql";

/**
 * `Postgres.Enum` — one declared enum type.
 *
 * The resource holds a declaration and performs no I/O; the `Schema` resource
 * that lists it creates and reconciles it. Nothing is dispatched to an enum,
 * which is why a schema's `enums:` slot declares `use: dependency` and a
 * column's `type:` declares `use: schema`.
 */
export class PostgresEnumResource implements ResourceInstance {
  readonly declaration: DeclaredEnum;

  constructor(raw: RawEnum) {
    this.declaration = normalizeEnum(raw);
  }

  /** The physical type name, read by consumers that build statements against it. */
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
): Promise<PostgresEnumResource> {
  return new PostgresEnumResource(resource);
}
