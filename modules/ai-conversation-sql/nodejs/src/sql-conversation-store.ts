import {
  attachmentNotFound,
  conflict,
  conversationNotFound,
  cursorInvalid,
  entryNotFound,
  toolCallNotFound,
  type AdmitRequest,
  type AppendRequest,
  type ApprovalRecord,
  type AttachmentRecord,
  type ConversationHeader,
  type ConversationStore,
  type CreateRequest,
  type EntriesRequest,
  type EntryRow,
  type ExpireAttachmentsRequest,
  type ListRequest,
  type Page,
  type RecordApprovalRequest,
  type RegisterAttachmentRequest,
  type Siblings,
  type StoredEntry,
  type UpdateRequest,
} from "@telorun/ai-conversation";
import {
  celTimestampFromMillis,
  decodeJsonValue,
  encodeJsonValue,
  timestampNanos,
  type CelTimestamp,
  type ResourceContext,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import { decodeCursor, encodeCursor } from "./sql-cursor.js";
import { namesOf, validatePrefix, type SqlNames } from "./sql-names.js";
import { ensureSchema, type SchemaExecutor } from "./sql-schema.js";
import { Statement } from "./sql-statement.js";

/** The slice of `Sql.Connection` this store uses, declared structurally: the module ships a bundled controller. */
interface SqlConnection {
  readonly dialect: {
    readonly placeholderStyle: "numbered" | "qmark";
    quoteIdentifier(name: string): string;
  };
  execute<T>(
    sql: string,
    params?: unknown[],
    zone?: ZoneEntry,
  ): Promise<{ rows: T[]; numAffectedRows?: unknown }>;
  runInTransaction<T>(body: (bind: (entry: ZoneEntry) => void) => Promise<T>): Promise<T>;
}

interface StoreResource {
  metadata: { name: string; module?: string };
  connection?: unknown;
  tablePrefix?: string;
  createTables?: boolean;
}

type Row = Record<string, unknown>;
type Query = (statement: Statement) => Promise<Row[]>;

const ROOT = "";

function isSqlConnection(value: unknown): value is SqlConnection {
  const c = value as Partial<SqlConnection> | undefined;
  return typeof c?.execute === "function" && typeof c.runInTransaction === "function";
}

/** Drivers return BIGINT as a number, a bigint or a numeric string. */
function int(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function stamp(value: unknown): CelTimestamp {
  return celTimestampFromMillis(int(value)) as CelTimestamp;
}

function millisOf(value: CelTimestamp): number {
  return Number(timestampNanos(value) / 1_000_000n);
}

function parentOf(value: unknown): string | null {
  return value === ROOT ? null : (value as string);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * SQL-backed conversation store.
 *
 * An attachment row is bound in the transaction of the write that first makes
 * the conversation refer to it (an admission, an append, a registration fenced
 * on a turn), released by the conversation's deletion or by expiry, and
 * forgotten once released.
 *
 * Appends and approvals run in a transaction whose first statement is a guarded
 * `UPDATE` of the conversation's header row: it fences on the current turn, takes
 * the row lock that serialises writers, and (for an append) hands out the next
 * append sequence. A branch page is one recursive statement walking parent links
 * from the resume point, so its cost is bounded by `limit` whatever the
 * conversation's size; sibling facts come from the (conversation, parent,
 * sequence) index.
 */
class SqlConversationStore implements ResourceInstance, ConversationStore {
  private readonly describe: string;
  private readonly prefix: string;
  private connection: SqlConnection | undefined;
  private names: (SqlNames & { raw: Record<string, string> }) | undefined;

  constructor(
    private readonly resource: StoreResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `AiConversationSql.Store "${resource.metadata.name}"`;
    this.prefix = validatePrefix(resource.tablePrefix ?? "ai_conversation_", this.describe);
  }

  private conn(): SqlConnection {
    this.connection ??= this.ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `${this.describe}: 'connection'`,
      "Sql.Connection",
    );
    return this.connection;
  }

  private n(): SqlNames {
    this.names ??= namesOf(this.prefix, (name) => this.conn().dialect.quoteIdentifier(name));
    return this.names;
  }

  private statement(): Statement {
    return new Statement(this.conn().dialect.placeholderStyle === "numbered");
  }

  private query: Query = async (s) => (await this.conn().execute<Row>(s.toString(), s.params)).rows;

  /** Runs `body` in one transaction, its statements bound to a private zone entry. */
  private transaction<T>(body: (query: Query) => Promise<T>): Promise<T> {
    const conn = this.conn();
    const entry: ZoneEntry = { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
    return conn.runInTransaction((bind) => {
      bind(entry);
      return body(async (s) => (await conn.execute<Row>(s.toString(), s.params, entry)).rows);
    });
  }

  async init(): Promise<void> {
    const conn = this.conn();
    const entry: ZoneEntry = { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
    const direct: SchemaExecutor = {
      query: async (sql, params) => (await conn.execute<Row>(sql, params)).rows,
      inTransaction: (body) =>
        conn.runInTransaction((bind) => {
          bind(entry);
          const inside: SchemaExecutor = {
            query: async (sql, params) => (await conn.execute<Row>(sql, params, entry)).rows,
            inTransaction: (inner) => inner(inside),
          };
          return body(inside);
        }),
    };
    await ensureSchema(direct, this.n(), this.resource.createTables !== false, this.describe);
  }

  async provide(): Promise<SqlConversationStore> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  // --- headers -----------------------------------------------------------

  private static readonly HEADER_COLUMNS =
    "id, title, archived, turn, version, created_at, updated_at";

  private header(row: Row): ConversationHeader {
    return {
      id: row.id as string,
      title: (row.title as string | null) ?? null,
      archived: int(row.archived) !== 0,
      turn: (row.turn as string | null) ?? null,
      version: int(row.version),
      createdAt: stamp(row.created_at),
      updatedAt: stamp(row.updated_at),
    };
  }

  async create(request: CreateRequest): Promise<ConversationHeader> {
    const now = Date.now();
    const s = this.statement();
    s.sql(`INSERT INTO ${this.n().conversations} (id, title, archived, turn, version, next_sequence, created_at, updated_at) VALUES (`)
      .value(request.id)
      .sql(", ")
      .value(request.title ?? null)
      .sql(", 0, NULL, 1, 0, ")
      .value(now)
      .sql(", ")
      .value(now)
      .sql(`) ON CONFLICT (id) DO NOTHING RETURNING ${SqlConversationStore.HEADER_COLUMNS}`);
    const [row] = await this.query(s);
    // A caller-minted id that already exists answers its header unchanged.
    return row ? this.header(row) : this.read(request.id);
  }

  async read(conversation: string): Promise<ConversationHeader> {
    return this.header(await this.headerRow(this.query, conversation));
  }

  private async headerRow(query: Query, conversation: string): Promise<Row> {
    const s = this.statement()
      .sql(`SELECT ${SqlConversationStore.HEADER_COLUMNS} FROM ${this.n().conversations} WHERE id = `)
      .value(conversation);
    const [row] = await query(s);
    if (!row) throw conversationNotFound(conversation);
    return row;
  }

  async update(request: UpdateRequest): Promise<ConversationHeader> {
    const s = this.statement().sql(`UPDATE ${this.n().conversations} SET version = version + 1, updated_at = `).value(Date.now());
    if (request.title !== undefined) s.sql(", title = ").value(request.title);
    if (request.archived !== undefined) s.sql(", archived = ").value(request.archived ? 1 : 0);
    s.sql(" WHERE id = ").value(request.conversation).sql(" AND version = ").value(request.version);
    s.sql(` RETURNING ${SqlConversationStore.HEADER_COLUMNS}`);
    const [row] = await this.query(s);
    if (row) return this.header(row);
    throw await this.versionConflict(this.query, request.conversation, request.version);
  }

  private async versionConflict(query: Query, conversation: string, version: number): Promise<Error> {
    const current = await this.headerRow(query, conversation);
    return conflict(
      `Conversation '${conversation}' is at version ${int(current.version)}, not ${version}: another change landed first. Read it again.`,
    );
  }

  async admit(request: AdmitRequest): Promise<ConversationHeader> {
    return this.transaction(async (query) => {
      const s = this.statement()
        .sql(`UPDATE ${this.n().conversations} SET version = version + 1, updated_at = `)
        .value(Date.now())
        .sql(", turn = ")
        .value(request.turn)
        .sql(" WHERE id = ")
        .value(request.conversation)
        .sql(" AND version = ")
        .value(request.version)
        .sql(` RETURNING ${SqlConversationStore.HEADER_COLUMNS}`);
      const [row] = await query(s);
      if (!row) throw await this.versionConflict(query, request.conversation, request.version);
      await this.bind(query, request.conversation, request.attachments, millisOf(request.expiredBefore));
      return this.header(row);
    });
  }

  /**
   * Binds each attachment to the conversation, inside the caller's transaction:
   * an unreleased row that is pending (and, with a cutoff, registered at or
   * after it) or already this conversation's. Any other refuses the whole write.
   * The conditions sit on the row's own UPDATE, so a release racing the bind is
   * re-checked against the row it committed.
   */
  private async bind(query: Query, conversation: string, ids: readonly string[], expiredBefore?: number): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      const s = this.statement()
        .sql(`UPDATE ${this.n().attachments} SET conversation_id = `)
        .value(conversation)
        .sql(", bound_at = COALESCE(bound_at, ")
        .value(now)
        .sql(") WHERE id = ")
        .value(id)
        .sql(" AND released_at IS NULL AND (conversation_id = ")
        .value(conversation)
        .sql(" OR (conversation_id IS NULL");
      if (expiredBefore !== undefined) s.sql(" AND created_at >= ").value(expiredBefore);
      s.sql(")) RETURNING id");
      const bound = await query(s);
      if (bound.length === 0) throw attachmentNotFound(id);
    }
  }

  async delete(conversation: string): Promise<void> {
    await this.transaction(async (query) => {
      const gone = await query(
        this.statement().sql(`DELETE FROM ${this.n().conversations} WHERE id = `).value(conversation).sql(" RETURNING id"),
      );
      if (gone.length === 0) throw conversationNotFound(conversation);
      await query(this.statement().sql(`DELETE FROM ${this.n().approvals} WHERE conversation_id = `).value(conversation));
      await query(this.statement().sql(`DELETE FROM ${this.n().entries} WHERE conversation_id = `).value(conversation));
      await query(
        this.statement()
          .sql(`UPDATE ${this.n().attachments} SET released_at = `)
          .value(Date.now())
          .sql(" WHERE conversation_id = ")
          .value(conversation)
          .sql(" AND released_at IS NULL"),
      );
    });
  }

  // --- attachments -------------------------------------------------------

  private static readonly ATTACHMENT_COLUMNS = "id, conversation_id, name, created_at, bound_at";

  private attachment(row: Row): AttachmentRecord {
    return {
      id: row.id as string,
      conversation: (row.conversation_id as string | null) ?? null,
      name: (row.name as string | null) ?? null,
      createdAt: stamp(row.created_at),
      boundAt: row.bound_at === null || row.bound_at === undefined ? null : stamp(row.bound_at),
    };
  }

  async registerAttachment(request: RegisterAttachmentRequest): Promise<AttachmentRecord> {
    const binding = request.binding;
    if (binding === undefined) return this.insertAttachment(this.query, request, null);
    return this.transaction(async (query) => {
      // Fenced as an append, so a superseded turn registers nothing.
      const fenced = await query(
        this.statement()
          .sql(`UPDATE ${this.n().conversations} SET updated_at = `)
          .value(Date.now())
          .sql(" WHERE id = ")
          .value(binding.conversation)
          .sql(" AND turn = ")
          .value(binding.turn)
          .sql(" RETURNING id"),
      );
      if (fenced.length === 0) throw await this.fenceFailure(query, binding.conversation, binding.turn);
      return this.insertAttachment(query, request, binding.conversation);
    });
  }

  /** Inserts a row pending (`conversation` null) or bound. A caller-minted id that
   *  exists answers its record only in the state this insert would have left it. */
  private async insertAttachment(
    query: Query,
    request: RegisterAttachmentRequest,
    conversation: string | null,
  ): Promise<AttachmentRecord> {
    const now = Date.now();
    const s = this.statement()
      .sql(`INSERT INTO ${this.n().attachments} (id, conversation_id, name, created_at, bound_at, released_at) VALUES (`)
      .value(request.id)
      .sql(", ")
      .value(conversation)
      .sql(", ")
      .value(request.name ?? null)
      .sql(", ")
      .value(now)
      .sql(", ")
      .value(conversation === null ? null : now)
      .sql(`, NULL) ON CONFLICT (id) DO NOTHING RETURNING ${SqlConversationStore.ATTACHMENT_COLUMNS}`);
    const [row] = await query(s);
    if (row) return this.attachment(row);
    const [existing] = await query(
      this.statement()
        .sql(`SELECT ${SqlConversationStore.ATTACHMENT_COLUMNS} FROM ${this.n().attachments} WHERE id = `)
        .value(request.id)
        .sql(" AND released_at IS NULL"),
    );
    if (!existing || ((existing.conversation_id as string | null) ?? null) !== conversation) {
      throw attachmentNotFound(request.id);
    }
    return this.attachment(existing);
  }

  async readAttachment(attachment: string): Promise<AttachmentRecord> {
    const s = this.statement()
      .sql(`SELECT ${SqlConversationStore.ATTACHMENT_COLUMNS} FROM ${this.n().attachments} WHERE id = `)
      .value(attachment)
      .sql(" AND released_at IS NULL");
    const [row] = await this.query(s);
    if (!row) throw attachmentNotFound(attachment);
    return this.attachment(row);
  }

  async expireAttachments(request: ExpireAttachmentsRequest): Promise<{ ids: string[] }> {
    const a = this.n().attachments;
    const cutoff = millisOf(request.expiredBefore);
    // The outer conditions repeat the inner ones, so a row a concurrent
    // admission bound is skipped when this statement reaches it.
    const release = this.statement()
      .sql(`UPDATE ${a} SET released_at = `)
      .value(Date.now())
      .sql(" WHERE conversation_id IS NULL AND released_at IS NULL AND created_at < ")
      .value(cutoff)
      .sql(` AND id IN (SELECT id FROM ${a} WHERE conversation_id IS NULL AND released_at IS NULL AND created_at < `)
      .value(cutoff)
      .sql(" ORDER BY created_at LIMIT ")
      .value(request.limit)
      .sql(")");
    await this.query(release);
    const released = this.statement()
      .sql(`SELECT id FROM ${a} WHERE released_at IS NOT NULL ORDER BY released_at, id LIMIT `)
      .value(request.limit);
    return { ids: (await this.query(released)).map((row) => row.id as string) };
  }

  async forgetAttachments(request: { readonly ids: readonly string[] }): Promise<void> {
    if (request.ids.length === 0) return;
    const s = this.statement().sql(`DELETE FROM ${this.n().attachments} WHERE released_at IS NOT NULL AND id IN (`);
    request.ids.forEach((id, i) => s.sql(i === 0 ? "" : ", ").value(id));
    s.sql(")");
    await this.query(s);
  }

  async list(request: ListRequest): Promise<Page<ConversationHeader>> {
    const filter = (s: Statement) => {
      s.sql(" WHERE 1 = 1");
      if (request.archived !== undefined) s.sql(" AND archived = ").value(request.archived ? 1 : 0);
      if (request.query !== undefined && request.query !== "") {
        s.sql(" AND LOWER(title) LIKE LOWER(").value(`%${escapeLike(request.query)}%`).sql(") ESCAPE '\\'");
      }
    };
    const count = this.statement().sql(`SELECT COUNT(*) AS total FROM ${this.n().conversations}`);
    filter(count);
    const [{ total }] = (await this.query(count)) as [Row];

    const s = this.statement().sql(`SELECT ${SqlConversationStore.HEADER_COLUMNS} FROM ${this.n().conversations}`);
    filter(s);
    if (request.cursor !== undefined) {
      const [updated, id, direction] = decodeCursor("list", request.cursor);
      if (typeof updated !== "number" || typeof id !== "string" || direction !== request.direction) throw cursorInvalid();
      const after = request.direction === "asc" ? ">" : "<";
      s.sql(` AND (updated_at ${after} `).value(updated).sql(" OR (updated_at = ").value(updated).sql(` AND id ${after} `).value(id).sql("))");
    }
    const order = request.direction === "asc" ? "ASC" : "DESC";
    s.sql(` ORDER BY updated_at ${order}, id ${order} LIMIT `).value(request.limit + 1);
    const rows = await this.query(s);
    const more = rows.length > request.limit;
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);
    return {
      rows: page.map((row) => this.header(row)),
      total: int(total),
      next: more && last ? encodeCursor("list", [int(last.updated_at), last.id, request.direction]) : null,
    };
  }

  // --- entries -----------------------------------------------------------

  /** Columns of an entry with its sibling facts, read through the (conversation, parent, sequence) index. */
  private entryColumns(alias: string): string {
    const e = this.n().entries;
    const sib = (select: string, cond: string, order = "") =>
      `(SELECT ${select} FROM ${e} s WHERE s.conversation_id = ${alias}.conversation_id AND s.parent_id = ${alias}.parent_id${cond}${order})`;
    return (
      `${alias}.id AS id, ${alias}.parent_id AS parent_id, ${alias}.seq AS seq, ${alias}.depth AS depth, ` +
      `${alias}.turn AS turn, ${alias}.message AS message, ${alias}.created_at AS created_at, ` +
      `${sib("COUNT(*)", ` AND s.seq <= ${alias}.seq`)} AS pos, ` +
      `${sib("COUNT(*)", "")} AS sibling_count, ` +
      `${sib("s.id", ` AND s.seq < ${alias}.seq`, " ORDER BY s.seq DESC LIMIT 1")} AS previous_id, ` +
      `${sib("s.id", ` AND s.seq > ${alias}.seq`, " ORDER BY s.seq ASC LIMIT 1")} AS next_id`
    );
  }

  private siblings(row: Row): Siblings {
    return {
      position: int(row.pos),
      count: int(row.sibling_count),
      previous: (row.previous_id as string | null) ?? null,
      next: (row.next_id as string | null) ?? null,
    };
  }

  private entry(row: Row): StoredEntry {
    return {
      id: row.id as string,
      parent: parentOf(row.parent_id),
      sequence: int(row.seq),
      depth: int(row.depth),
      turn: row.turn as string,
      createdAt: stamp(row.created_at),
      message: decodeJsonValue(row.message as string),
      siblings: this.siblings(row),
    };
  }

  /** The leaf of the branch through `through`: below it, the most recently appended child at each step. */
  private async leafBelow(conversation: string, through: string): Promise<{ id: string; depth: number }> {
    const e = this.n().entries;
    const s = this.statement();
    s.sql(`WITH RECURSIVE down(id, depth) AS (SELECT id, depth FROM ${e} WHERE conversation_id = `)
      .value(conversation)
      .sql(" AND id = ")
      .value(through)
      .sql(` UNION ALL SELECT c.id, c.depth FROM ${e} c JOIN down d ON c.parent_id = d.id WHERE c.conversation_id = `)
      .value(conversation)
      .sql(` AND NOT EXISTS (SELECT 1 FROM ${e} c2 WHERE c2.conversation_id = c.conversation_id AND c2.parent_id = c.parent_id AND c2.seq > c.seq)) `)
      .sql("SELECT id, depth FROM down ORDER BY depth DESC LIMIT 1");
    const [row] = await this.query(s);
    if (!row) throw entryNotFound(conversation, through);
    return { id: row.id as string, depth: int(row.depth) };
  }

  private async latestLeaf(conversation: string): Promise<{ id: string; depth: number } | undefined> {
    const s = this.statement()
      .sql(`SELECT id, depth FROM ${this.n().entries} WHERE conversation_id = `)
      .value(conversation)
      .sql(" ORDER BY seq DESC LIMIT 1");
    const [row] = await this.query(s);
    return row ? { id: row.id as string, depth: int(row.depth) } : undefined;
  }

  async entries(request: EntriesRequest): Promise<Page<EntryRow>> {
    const { conversation, limit } = request;
    await this.headerRow(this.query, conversation);
    const leaf =
      request.through !== undefined
        ? await this.leafBelow(conversation, request.through)
        : await this.latestLeaf(conversation);
    if (!leaf) return { rows: [], total: 0, next: null };

    let start: string | undefined = leaf.id;
    if (request.cursor !== undefined) {
      const [resumeAbove] = decodeCursor("entries", request.cursor);
      if (typeof resumeAbove !== "string") throw cursorInvalid();
      const s = this.statement()
        .sql(`SELECT parent_id FROM ${this.n().entries} WHERE conversation_id = `)
        .value(conversation)
        .sql(" AND id = ")
        .value(resumeAbove);
      const [row] = await this.query(s);
      if (!row) throw cursorInvalid();
      start = row.parent_id === ROOT ? undefined : (row.parent_id as string);
    }
    if (start === undefined) return { rows: [], total: leaf.depth, next: null };

    const e = this.n().entries;
    const s = this.statement();
    s.sql(`WITH RECURSIVE walk(id, parent_id, n) AS (SELECT id, parent_id, 1 FROM ${e} WHERE conversation_id = `)
      .value(conversation)
      .sql(" AND id = ")
      .value(start)
      .sql(` UNION ALL SELECT x.id, x.parent_id, w.n + 1 FROM ${e} x JOIN walk w ON x.id = w.parent_id WHERE x.conversation_id = `)
      .value(conversation)
      .sql(" AND w.n < ")
      .value(limit + 1)
      .sql(`) SELECT ${this.entryColumns("e")} FROM walk w JOIN ${e} e ON e.id = w.id ORDER BY w.n`);
    const found = await this.query(s);
    const more = found.length > limit;
    const page = found.slice(0, limit);

    const approvals = await this.approvalsOf(
      conversation,
      page.map((row) => row.id as string),
    );
    const rows: EntryRow[] = page.map((row) => ({
      ...this.entry(row),
      approvals: approvals.get(row.id as string) ?? [],
    }));
    return { rows, total: leaf.depth, next: more ? encodeCursor("entries", [rows.at(-1)!.id]) : null };
  }

  async append(request: AppendRequest): Promise<StoredEntry> {
    const message = request.message;
    return this.transaction(async (query) => {
      const h = this.n().conversations;
      const e = this.n().entries;
      const now = Date.now();
      // Fence on the current turn, lock the header row and take the next sequence in one statement.
      const claimed = await query(
        this.statement()
          .sql(`UPDATE ${h} SET next_sequence = next_sequence + 1, updated_at = `)
          .value(now)
          .sql(" WHERE id = ")
          .value(request.conversation)
          .sql(" AND turn = ")
          .value(request.turn)
          .sql(" RETURNING next_sequence"),
      );
      if (claimed.length === 0) throw await this.fenceFailure(query, request.conversation, request.turn);
      const sequence = int(claimed[0]!.next_sequence);

      let depth = 1;
      if (request.parent !== null) {
        const [parent] = await query(
          this.statement()
            .sql(`SELECT depth FROM ${e} WHERE conversation_id = `)
            .value(request.conversation)
            .sql(" AND id = ")
            .value(request.parent),
        );
        if (!parent) throw entryNotFound(request.conversation, request.parent);
        depth = int(parent.depth) + 1;
        const pending = await query(
          this.statement()
            .sql(`SELECT approval_id FROM ${this.n().approvals} WHERE conversation_id = `)
            .value(request.conversation)
            .sql(" AND entry_id = ")
            .value(request.parent)
            .sql(" AND decided_at IS NULL LIMIT 1"),
        );
        if (pending.length > 0) {
          throw conflict(
            `Entry '${request.parent}' has an undecided approval ('${pending[0]!.approval_id}'); nothing may follow it until every approval is decided.`,
          );
        }
      }

      await this.bind(query, request.conversation, request.attachments);
      await query(
        this.statement()
          .sql(`INSERT INTO ${e} (id, conversation_id, parent_id, seq, depth, turn, message, created_at) VALUES (`)
          .value(request.id)
          .sql(", ")
          .value(request.conversation)
          .sql(", ")
          .value(request.parent ?? ROOT)
          .sql(", ")
          .value(sequence)
          .sql(", ")
          .value(depth)
          .sql(", ")
          .value(request.turn)
          .sql(", ")
          .value(encodeJsonValue(message))
          .sql(", ")
          .value(now)
          .sql(")"),
      );
      const [row] = await query(
        this.statement()
          .sql(`SELECT ${this.entryColumns("e")} FROM ${e} e WHERE e.conversation_id = `)
          .value(request.conversation)
          .sql(" AND e.id = ")
          .value(request.id),
      );
      return this.entry(row!);
    });
  }

  /** Why a fenced write matched no header: unknown conversation, or another turn is current. */
  private async fenceFailure(query: Query, conversation: string, turn: string): Promise<Error> {
    const header = await this.headerRow(query, conversation);
    const current = (header.turn as string | null) ?? null;
    return conflict(
      current === null
        ? `Conversation '${conversation}' has admitted no turn, so turn '${turn}' may not write to it; admit it with Admit first.`
        : `Turn '${turn}' has been superseded by turn '${current}' on conversation '${conversation}'.`,
    );
  }

  // --- approvals ---------------------------------------------------------

  private approval(row: Row): ApprovalRecord {
    return {
      id: row.approval_id as string,
      toolCallId: row.tool_call_id as string,
      requestedAt: stamp(row.requested_at),
      decision:
        row.decided_at === null || row.decided_at === undefined
          ? null
          : {
              approved: int(row.approved) !== 0,
              ...(row.reason === null || row.reason === undefined ? {} : { reason: row.reason as string }),
              decidedAt: stamp(row.decided_at),
              turn: row.decided_turn as string,
            },
    };
  }

  private async approvalsOf(conversation: string, entries: string[]): Promise<Map<string, ApprovalRecord[]>> {
    const byEntry = new Map<string, ApprovalRecord[]>();
    if (entries.length === 0) return byEntry;
    const s = this.statement()
      .sql(`SELECT * FROM ${this.n().approvals} WHERE conversation_id = `)
      .value(conversation)
      .sql(" AND entry_id IN (");
    entries.forEach((id, i) => s.sql(i === 0 ? "" : ", ").value(id));
    s.sql(") ORDER BY requested_at, approval_id");
    for (const row of await this.query(s)) {
      const list = byEntry.get(row.entry_id as string) ?? [];
      list.push(this.approval(row));
      byEntry.set(row.entry_id as string, list);
    }
    return byEntry;
  }

  async recordApproval(request: RecordApprovalRequest): Promise<ApprovalRecord> {
    return this.transaction(async (query) => {
      const a = this.n().approvals;
      const now = Date.now();
      const fenced = await query(
        this.statement()
          .sql(`UPDATE ${this.n().conversations} SET updated_at = `)
          .value(now)
          .sql(" WHERE id = ")
          .value(request.conversation)
          .sql(" AND turn = ")
          .value(request.turn)
          .sql(" RETURNING id"),
      );
      if (fenced.length === 0) throw await this.fenceFailure(query, request.conversation, request.turn);

      const [entry] = await query(
        this.statement()
          .sql(`SELECT message FROM ${this.n().entries} WHERE conversation_id = `)
          .value(request.conversation)
          .sql(" AND id = ")
          .value(request.entry),
      );
      if (!entry) throw entryNotFound(request.conversation, request.entry);
      const calls = (decodeJsonValue(entry.message as string) as { toolCalls?: Array<{ id?: string }> }).toolCalls;
      if (!calls?.some((call) => call.id === request.toolCallId)) {
        throw toolCallNotFound(request.entry, request.toolCallId);
      }

      const existing = await query(
        this.statement()
          .sql(`SELECT * FROM ${a} WHERE conversation_id = `)
          .value(request.conversation)
          .sql(" AND (approval_id = ")
          .value(request.id)
          .sql(" OR (entry_id = ")
          .value(request.entry)
          .sql(" AND tool_call_id = ")
          .value(request.toolCallId)
          .sql("))"),
      );
      const found = existing[0];
      if (found) {
        if (found.approval_id !== request.id || found.entry_id !== request.entry || found.tool_call_id !== request.toolCallId) {
          throw conflict(
            `Approval '${request.id}' does not match the recorded approval '${found.approval_id}' for tool call '${found.tool_call_id}' of entry '${found.entry_id}'.`,
          );
        }
        if (request.decision === undefined) return this.approval(found);
        if (found.decided_at !== null && found.decided_at !== undefined) {
          throw conflict(`Approval '${request.id}' has already been decided.`);
        }
        const s = this.statement()
          .sql(`UPDATE ${a} SET decided_at = `)
          .value(now)
          .sql(", approved = ")
          .value(request.decision.approved ? 1 : 0)
          .sql(", reason = ")
          .value(request.decision.reason ?? null)
          .sql(", decided_turn = ")
          .value(request.turn)
          .sql(" WHERE conversation_id = ")
          .value(request.conversation)
          .sql(" AND approval_id = ")
          .value(request.id)
          .sql(" AND decided_at IS NULL RETURNING *");
        const [updated] = await query(s);
        if (!updated) throw conflict(`Approval '${request.id}' has already been decided.`);
        return this.approval(updated);
      }

      const decision = request.decision;
      const s = this.statement()
        .sql(`INSERT INTO ${a} (conversation_id, approval_id, entry_id, tool_call_id, requested_at, decided_at, approved, reason, decided_turn) VALUES (`)
        .value(request.conversation)
        .sql(", ")
        .value(request.id)
        .sql(", ")
        .value(request.entry)
        .sql(", ")
        .value(request.toolCallId)
        .sql(", ")
        .value(now)
        .sql(", ")
        .value(decision ? now : null)
        .sql(", ")
        .value(decision ? (decision.approved ? 1 : 0) : null)
        .sql(", ")
        .value(decision?.reason ?? null)
        .sql(", ")
        .value(decision ? request.turn : null)
        .sql(") RETURNING *");
      const [inserted] = await query(s);
      return this.approval(inserted!);
    });
  }
}

export const store = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: StoreResource, ctx: ResourceContext) {
    return new SqlConversationStore(resource, ctx);
  },
};
