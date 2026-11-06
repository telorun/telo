import {
  celDurationFromNanos,
  durationNanos,
  getRefIdentity,
  isCelDuration,
  type CelDuration,
  type CelTimestamp,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import {
  keySourceSettingsOf,
  timestampOfMillis,
  type ApiKeyStore,
  type IssueRequest,
  type KeyOwner,
  type KeySourceSettings,
  type ListRequest,
  type RotateRequest,
  type StoredKey,
} from "@telorun/api-key";
import {
  readTimestampColumn,
  rendersInstantArithmetic,
  rendersLockSkipping,
  resolveSqlConnection,
  retentionCutoffShift,
  RowSweep,
  SqlFragments,
  SWEEP_BATCH_ROWS,
  type SqlConnection,
  type SqlInstantArithmeticSchema,
  type SqlLockSchema,
} from "@telorun/sql";
import { claimStoreName } from "./store-name-claims.js";
import { isDeclaredTable, keyColumns, type DeclaredTableHolder, type KeyColumns } from "./store-table.js";

type StoreSchema = SqlInstantArithmeticSchema & SqlLockSchema;

interface StoreManifest {
  kind: string;
  metadata: { name: string };
  connection?: unknown;
  schema?: unknown;
  table?: unknown;
  name?: unknown;
  retention?: unknown;
  prefix: string;
  scopes: string[];
  maxLifetime?: unknown;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_TYPES = new Set(["user", "service", "organization"]);

type Row = Record<string, unknown>;

function negated(duration: CelDuration, describe: string, what: string): CelDuration {
  const value = celDurationFromNanos(-durationNanos(duration));
  if (!isCelDuration(value)) {
    throw new RangeError(`${describe}: '${what}' is outside the range a duration can be negated in.`);
  }
  return value;
}

/**
 * ApiKeySql.Store — the keys of one named store in one table.
 *
 * Every statement judges retention itself, on the database's clock: a key that
 * ended (was revoked or expired) more than `retention` ago reads as absent from
 * every method, whether or not the background sweep has reclaimed its row yet.
 * The sweep only frees space. It starts at the store's first call and not at
 * boot, in short transactions of their own that pass over rows another
 * transaction holds; `init()` performs no I/O.
 */
export class SqlApiKeyStore implements ResourceInstance, ApiKeyStore {
  private readonly table: string;
  private readonly columns: KeyColumns;
  private readonly cutoff: CelDuration;
  private readonly sweep: RowSweep;

  constructor(
    readonly describe: string,
    private readonly ctx: ResourceContext,
    private readonly connection: SqlConnection,
    private readonly schema: StoreSchema,
    private readonly tableResource: DeclaredTableHolder,
    readonly name: string,
    retention: CelDuration,
    private readonly keySettings: KeySourceSettings,
  ) {
    const declaration = tableResource.declaration;
    this.columns = keyColumns(describe, declaration, connection.dialect);
    this.table = schema.qualifiedTableName(declaration);
    this.cutoff = retentionCutoffShift(retention, describe);
    this.sweep = new RowSweep({
      ctx,
      connection,
      retention,
      batchStatement: () => this.sweepStatement(),
      failureMessage: "Sweeping ended API keys failed; the next pass tries again",
      logAttributes: { "api_key.store": name },
    });
  }

  init(ctx: ResourceContext) {
    return ctx.effect("store name claim", async () => ({
      result: undefined,
      inverse: claimStoreName(
        this.tableResource,
        this.tableResource.declaration.name,
        this.name,
        this,
        this.describe,
      ),
    }));
  }

  snapshot(): Record<string, unknown> {
    return { name: this.name, prefix: this.keySettings.prefix };
  }

  settings(): KeySourceSettings {
    return this.keySettings;
  }

  async lookup(id: string, ctx?: InvokeContext) {
    await this.sweep.ensureStarted();
    const rows = await this.select(this.whereKey(id), ctx);
    return rows[0] ? ({ outcome: "found", key: this.storedKey(rows[0]) } as const) : ({ outcome: "absent" } as const);
  }

  async touch(id: string, resolution: CelDuration, ctx?: InvokeContext) {
    await this.sweep.ensureStarted();
    const c = this.columns;
    const statement = new SqlFragments()
      .text(`UPDATE ${this.table} SET ${c.last_used_at} = ${this.schema.currentInstant()} WHERE `)
      .append(this.whereKey(id))
      .text(` AND (${c.last_used_at} IS NULL OR ${c.last_used_at} <= `)
      .append(this.schema.currentInstantPlus(negated(resolution, this.describe, "resolution")))
      .text(`) RETURNING ${c.key_id}`);
    if ((await this.execute(statement, undefined, ctx)).rows.length > 0) return { outcome: "touched" } as const;
    // Nothing written: either the last use is within `resolution` or there is no such key.
    const [present] = await this.select(this.whereKey(id), ctx);
    return present ? ({ outcome: "fresh" } as const) : ({ outcome: "absent" } as const);
  }

  async issue(request: IssueRequest, ctx?: InvokeContext) {
    await this.sweep.ensureStarted();
    const [row] = await this.insert(request, request.owner, request.scopes, request.label, null, undefined, ctx);
    return { outcome: "issued", key: this.storedKey(row) } as const;
  }

  async list(request: ListRequest, ctx?: InvokeContext) {
    await this.sweep.ensureStarted();
    if (request.after !== undefined && !UUID_PATTERN.test(request.after)) {
      return { outcome: "cursorInvalid" } as const;
    }
    const c = this.columns;
    const where = new SqlFragments()
      .text(`${c.store_name} = `)
      .value(this.name)
      .text(` AND ${c.owner_type} = `)
      .value(request.owner.type)
      .text(` AND ${c.owner_id} = `)
      .value(request.owner.id)
      .text(" AND ")
      .append(this.visible());
    if (request.after !== undefined) where.text(` AND ${c.key_id} > `).value(request.after);
    const rows = await this.select(where, ctx, ` ORDER BY ${c.key_id} LIMIT `, request.limit + 1);
    const page = rows.slice(0, request.limit).map((row) => this.storedKey(row));
    const last = page[page.length - 1];
    return {
      outcome: "page",
      keys: page,
      ...(rows.length > request.limit && last ? { next: last.id } : {}),
    } as const;
  }

  async revoke(id: string, request: { by: string | null }, ctx?: InvokeContext) {
    await this.sweep.ensureStarted();
    const c = this.columns;
    const now = this.schema.currentInstant();
    const statement = new SqlFragments()
      .text(
        `UPDATE ${this.table} SET ${c.revoked_at} = ${now}, ${c.revoked_by} = `,
      )
      .value(request.by)
      .text(
        `, ${c.ends_at} = CASE WHEN ${c.ends_at} IS NULL OR ${c.ends_at} > ${now} THEN ${now} ` +
          `ELSE ${c.ends_at} END WHERE `,
      )
      .append(this.whereKey(id))
      .text(` AND ${c.revoked_at} IS NULL RETURNING ${this.selectList()}`);
    const [revoked] = (await this.execute(statement, undefined, ctx)).rows as Row[];
    if (revoked) return { outcome: "revoked", key: this.storedKey(revoked) } as const;
    const [standing] = await this.select(this.whereKey(id), ctx);
    return standing
      ? ({ outcome: "alreadyRevoked", key: this.storedKey(standing) } as const)
      : ({ outcome: "absent" } as const);
  }

  async rotate(request: RotateRequest, ctx?: InvokeContext) {
    await this.sweep.ensureStarted();
    const c = this.columns;
    const zone: ZoneEntry = { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
    return this.connection.runInTransaction(async (bind) => {
      bind(zone);
      // The conditional update takes the row, so a revoke racing this rotation
      // waits for it and the rotation never replaces a key revoked meanwhile.
      const cap = () => this.schema.currentInstantPlus(request.overlap);
      const capped = (column: string) =>
        new SqlFragments()
          .text(`${column} = CASE WHEN ${c.expires_at} IS NULL OR ${c.expires_at} > `)
          .append(cap())
          .text(" THEN ")
          .append(cap())
          .text(` ELSE ${c.expires_at} END`);
      const update = new SqlFragments()
        .text(`UPDATE ${this.table} SET `)
        .append(capped(c.expires_at))
        .text(", ")
        .append(capped(c.ends_at))
        .text(" WHERE ")
        .append(this.whereKey(request.id))
        .text(` AND ${c.revoked_at} IS NULL RETURNING ${this.selectList()}`);
      const [updated] = (await this.execute(update, zone, ctx)).rows as Row[];
      if (!updated) {
        const [standing] = await this.select(this.whereKey(request.id), ctx, "", undefined, zone);
        return standing ? ({ outcome: "revoked" } as const) : ({ outcome: "absent" } as const);
      }
      const predecessor = this.storedKey(updated);
      const [successor] = await this.insert(
        { id: request.successor.id, digest: request.successor.digest, expiresAt: request.successor.expiresAt },
        predecessor.owner,
        predecessor.scopes,
        predecessor.label,
        predecessor.id,
        zone,
        ctx,
      );
      return {
        outcome: "rotated",
        predecessor,
        successor: this.storedKey(successor),
      } as const;
    });
  }

  private selectList(): string {
    const c = this.columns;
    return [
      c.key_id,
      c.digest,
      c.owner_type,
      c.owner_id,
      c.scopes,
      c.label,
      c.created_at,
      c.expires_at,
      c.revoked_at,
      c.revoked_by,
      c.last_used_at,
      c.rotated_from,
    ].join(", ");
  }

  /** Keys that have not ended, or ended within `retention`. */
  private visible(): SqlFragments {
    const c = this.columns;
    return new SqlFragments()
      .text(`(${c.ends_at} IS NULL OR ${c.ends_at} >= `)
      .append(this.schema.currentInstantPlus(this.cutoff))
      .text(")");
  }

  private whereKey(id: string): SqlFragments {
    const c = this.columns;
    return new SqlFragments()
      .text(`${c.store_name} = `)
      .value(this.name)
      .text(` AND ${c.key_id} = `)
      .value(id)
      .text(" AND ")
      .append(this.visible());
  }

  private async select(
    where: SqlFragments,
    ctx: InvokeContext | undefined,
    tail = "",
    tailValue?: unknown,
    zone?: ZoneEntry,
  ): Promise<Row[]> {
    const statement = new SqlFragments()
      .text(`SELECT ${this.selectList()} FROM ${this.table} WHERE `)
      .append(where)
      .text(tail);
    if (tailValue !== undefined) statement.value(tailValue);
    return (await this.execute(statement, zone, ctx)).rows as Row[];
  }

  private async insert(
    request: { id: string; digest: string; expiresAt: CelTimestamp | null },
    owner: KeyOwner,
    scopes: readonly string[],
    label: string | null,
    rotatedFrom: string | null,
    zone: ZoneEntry | undefined,
    ctx: InvokeContext | undefined,
  ): Promise<Row[]> {
    const c = this.columns;
    const expires = () =>
      request.expiresAt === null
        ? new SqlFragments().text("NULL")
        : this.schema.instantParameter(request.expiresAt);
    const statement = new SqlFragments()
      .text(
        `INSERT INTO ${this.table} (${c.store_name}, ${c.key_id}, ${c.digest}, ${c.owner_type}, ` +
          `${c.owner_id}, ${c.scopes}, ${c.label}, ${c.created_at}, ${c.expires_at}, ${c.ends_at}, ` +
          `${c.rotated_from}) VALUES (`,
      )
      .value(this.name)
      .text(", ")
      .value(request.id)
      .text(", ")
      .value(request.digest)
      .text(", ")
      .value(owner.type)
      .text(", ")
      .value(owner.id)
      .text(", ")
      .value(JSON.stringify(scopes))
      .text(", ")
      .value(label)
      .text(`, ${this.schema.currentInstant()}, `)
      .append(expires())
      .text(", ")
      .append(expires())
      .text(", ")
      .value(rotatedFrom)
      .text(`) RETURNING ${this.selectList()}`);
    const rows = (await this.execute(statement, zone, ctx)).rows as Row[];
    if (rows.length === 0) {
      throw new Error(`${this.describe}: inserting key '${request.id}' returned no row.`);
    }
    return rows;
  }

  private execute(statement: SqlFragments, zone: ZoneEntry | undefined, ctx: InvokeContext | undefined) {
    return this.connection.executeTemplate<Row>(statement.fragments, statement.boundValues, zone, ctx);
  }

  private storedKey(row: Row): StoredKey {
    const text = (column: string): string => {
      const value = row[column];
      if (typeof value !== "string") {
        throw new Error(`${this.describe}: column '${column}' held ${typeof value}, expected text.`);
      }
      return value;
    };
    const optionalText = (column: string): string | null => {
      const value = row[column];
      return value === null || value === undefined ? null : text(column);
    };
    const instant = (column: string): CelTimestamp =>
      timestampOfMillis(readTimestampColumn(row[column]).getTime());
    const optionalInstant = (column: string): CelTimestamp | null =>
      row[column] === null || row[column] === undefined ? null : instant(column);
    const ownerType = text("owner_type");
    if (!OWNER_TYPES.has(ownerType)) {
      throw new Error(`${this.describe}: stored owner type '${ownerType}' is not user, service or organization.`);
    }
    return {
      id: text("key_id"),
      digest: text("digest"),
      owner: { type: ownerType as KeyOwner["type"], id: text("owner_id") },
      scopes: JSON.parse(text("scopes")) as string[],
      label: optionalText("label"),
      createdAt: instant("created_at"),
      expiresAt: optionalInstant("expires_at"),
      revokedAt: optionalInstant("revoked_at"),
      revokedBy: optionalText("revoked_by"),
      lastUsedAt: optionalInstant("last_used_at"),
      rotatedFrom: optionalText("rotated_from"),
    };
  }

  /** One bounded batch: ended keys past retention, oldest end first. Reads only
   *  this store's `ends_at` range. */
  private sweepStatement(): SqlFragments {
    const c = this.columns;
    return new SqlFragments()
      .text(`DELETE FROM ${this.table} WHERE ${c.store_name} = `)
      .value(this.name)
      .text(` AND ${c.key_id} IN (SELECT ${c.key_id} FROM ${this.table} WHERE ${c.store_name} = `)
      .value(this.name)
      .text(` AND ${c.ends_at} < `)
      .append(this.schema.currentInstantPlus(this.cutoff))
      .text(` ORDER BY ${c.ends_at} LIMIT `)
      .value(SWEEP_BATCH_ROWS)
      .text(` ${this.schema.skipLockedClause()})`);
  }
}

export function register(): void {}

export async function create(resource: StoreManifest, ctx: ResourceContext): Promise<SqlApiKeyStore> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const connection = resolveSqlConnection(
    resource.connection as SqlConnection | undefined,
    ctx,
    () => `${describe}: 'connection'`,
  );
  if (!connection) throw new Error(`${describe}: 'connection' is required.`);
  const schema = ctx.resolveRef(
    resource.schema,
    // Any live instance, so one without the members is refused below by name.
    (candidate): candidate is object =>
      typeof candidate === "object" && candidate !== null && !!getRefIdentity(candidate),
    () => `${describe}: 'schema'`,
    "Sql.Schema",
  );
  if (!rendersInstantArithmetic(schema) || !rendersLockSkipping(schema)) {
    const identity = getRefIdentity(schema);
    throw new Error(
      `${describe}: 'schema' references '${identity?.name ?? "(inline)"}' of kind ` +
        `'${identity?.kind ?? "(unknown)"}', whose engine module predates the instant and ` +
        `lock-skipping members a key store needs — its schema instance cannot say how the ` +
        `store's clock is read and shifted, or how a sweep passes over rows another ` +
        `transaction holds. Upgrade the module that declares that kind.`,
    );
  }
  const table = ctx.resolveRef(resource.table, isDeclaredTable, () => `${describe}: 'table'`, "Sql.Table");
  const name = resource.name;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(`${describe}: 'name' must be an identifier.`);
  }
  const retention = resource.retention;
  if (!isCelDuration(retention) || durationNanos(retention) <= 0n) {
    throw new Error(`${describe}: 'retention' must be a positive duration.`);
  }
  const settings = keySourceSettingsOf(resource, describe);
  return new SqlApiKeyStore(describe, ctx, connection, schema, table, name, retention, settings);
}
