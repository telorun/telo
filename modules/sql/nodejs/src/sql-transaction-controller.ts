import {
  InvokeError,
  getRefIdentity,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { SqlConnection } from "./sql-connection.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";

interface SqlTransactionManifest {
  metadata: { name: string; module: string };
  connection: SqlConnection;
  steps: ResourceInstance;
  inputs?: Record<string, unknown>;
}

/** The steps slot is `Telo.Executable`: an instance with either entry point. */
function isExecutable(value: unknown): value is ResourceInstance {
  const v = value as ResourceInstance | undefined;
  return typeof v?.invoke === "function" || typeof v?.run === "function";
}

export class SqlTransactionResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlTransactionManifest,
    private readonly ctx: ResourceContext,
  ) {}

  getConnection(): SqlConnection {
    return (
      resolveSqlConnection(
        this.manifest.connection,
        this.ctx,
        () => `Sql.Transaction "${this.manifest.metadata.name}": 'connection'`,
      ) ?? failMissingConnection(this.manifest.metadata.name)
    );
  }

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const m = this.manifest;
    const ctx = this.ctx;

    // The declared `inputs:` map's CEL reads the caller's invocation input as
    // `inputs.<field>` — the same variable name a Run.Sequence step's inputs
    // read, and what the slot's `inputs: /inputs` pointer names.
    const celScope = { inputs: input ?? {} };
    const expandedInputs = ctx.expandValue(m.inputs ?? {}, celScope) as Record<string, unknown>;

    // `invokeCtx` is threaded rather than left to the ambient throughout: the
    // caller's context is the authority on which zones are open, and a runtime
    // with no ambient store has nothing else to read.
    //
    // Flat nesting: an ambient transaction on the SAME connection is joined; a
    // different connection's transaction is not ours and we open our own.
    const conn = this.getConnection();
    if (conn.hasOpenTransaction(invokeCtx)) {
      return this.dispatchSteps(expandedInputs, invokeCtx);
    }

    return conn.runInTransaction((bind) =>
      // "steps" is this kind's own slot; the kernel reads `x-telo-provides-zone`
      // there for the zone kind (this kind) and the correlation key
      // (`/connection`). The entry is handed to the connection's own map —
      // across the bundle/npm delivery split — and the derived context is
      // threaded into the body dispatch, the discipline cancellation has.
      ctx.withZone(
        "steps",
        (zoneCtx, entry) => {
          bind(entry);
          return this.dispatchSteps(expandedInputs, zoneCtx);
        },
        invokeCtx,
      ),
    );
  }

  private dispatchSteps(inputs: Record<string, unknown>, zoneCtx?: InvokeContext): Promise<unknown> {
    const m = this.manifest;
    const target = this.ctx.resolveRef(
      m.steps,
      isExecutable,
      () => `Sql.Transaction "${m.metadata.name}": 'steps'`,
      "Telo.Executable",
    );
    // The kernel stamps `!ref` identity at Phase-5 injection, and `resolveRef`
    // rescues the sentinel form, so a resolved target always carries one.
    // Guessing a label instead would emit malformed dispatch events (`.Invoked`
    // with no kind) — a silent wrong answer where a missing identity means the
    // resolution path changed under us.
    const id = getRefIdentity(target as object);
    if (!id) {
      throw new InvokeError(
        "ERR_SQL_STEPS_UNIDENTIFIED",
        `Sql.Transaction '${m.metadata.name}': the resolved 'steps' target carries no reference ` +
          `identity, so its dispatch cannot be traced or named`,
      );
    }
    return this.ctx.invokeResolved(id.kind, id.name, target, inputs, zoneCtx);
  }
}

function failMissingConnection(name: string): never {
  throw new Error(`Sql.Transaction '${name}': missing connection`);
}

export function register(): void {}

export async function create(
  resource: SqlTransactionManifest,
  ctx: ResourceContext,
): Promise<SqlTransactionResource> {
  return new SqlTransactionResource(resource, ctx);
}
