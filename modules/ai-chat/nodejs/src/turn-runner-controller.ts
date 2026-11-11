import { createHash } from "node:crypto";
import {
  InvokeError,
  Stream,
  celTimestampFromMillis,
  createCancellationSource,
  deriveContext,
  isInvokeError,
  type CancellationSource,
  type CelTimestamp,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { mintId } from "./chat-ids.js";
import {
  ERR_CONVERSATION_CONFLICT,
  conflictAfterRetries,
  idempotencyConflict,
  turnRunning,
} from "./chat-refusals.js";
import { isChatEndpoint, type ChatEndpoint } from "./conversation-controller.js";
import { titleIfUntitled } from "./conversation-titles.js";
import { operationsOf } from "./operation-call.js";
import {
  ERR_CONVERSATION_ATTACHMENT_NOT_FOUND,
  TURN_OPERATIONS,
  attachmentRefused,
  planTurn,
  turnRequestOf,
  versionOf,
  type TurnOperations,
  type TurnPlan,
  type TurnRequest,
} from "./turn-plan.js";
import { TurnInput, turnRecords, type TurnIdentity } from "./turn-run.js";

/** How many rounds admission tries against a header that keeps changing. */
const ADMISSION_ROUNDS = 3;
/** How many times an idempotent send re-reads a key another send is settling. */
const IDEMPOTENCY_READS = 5;

interface RunnerResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
  conversation?: unknown;
}

/** What an idempotency key records before any effect: the request it was
 *  first sent with and the ids that request is admitted under. */
interface Intent {
  fingerprint: string;
  conversation: string;
  turn: string;
}

interface TurnStarted {
  conversation: string;
  turn: string;
}

/** The canonical text of a JSON value: keys sorted, so equal requests digest alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A request's fingerprint; an absent parent and a null one differ. */
function fingerprintOf(request: TurnRequest): string {
  return sha256(
    canonical({
      conversation: request.conversation,
      ...(Object.hasOwn(request, "parent") ? { parent: request.parent } : {}),
      message: request.message,
      attachments: request.attachments,
      approvals: request.approvals,
    }),
  );
}

const codeOf = (err: unknown) => (isInvokeError(err) ? err.code : undefined);

/**
 * The private controller behind AiChat.StartTurn: admits a turn, runs it
 * detached into the turn's journal key, and holds the running turns so a
 * shutdown fails each key as cancelled rather than leaving it to go stale.
 */
class TurnRunner implements ResourceInstance {
  private readonly ops: TurnOperations;
  private readonly label: string;
  private readonly shutdown: CancellationSource = createCancellationSource();

  constructor(
    private readonly resource: RunnerResource,
    private readonly ctx: ResourceContext,
  ) {
    this.label = `AiChat.StartTurn "${resource.metadata.name}"`;
    this.ops = operationsOf(ctx, resource, "AiChat.StartTurn", TURN_OPERATIONS);
  }

  init() {
    return this.ctx.effect("running turns", async () => ({
      result: undefined,
      // Each running turn's agent is cancelled, so its sink fails the key with
      // ERR_INVOKE_CANCELLED; the detached drains are awaited after this.
      inverse: () => this.shutdown.cancel("the application is shutting down"),
    }));
  }

  private endpoint(): ChatEndpoint {
    return this.ctx.resolveRef(
      this.resource.conversation,
      isChatEndpoint,
      () => `${this.label}: 'conversation'`,
      "AiChat.Conversation",
    );
  }

  async invoke(inputs: Record<string, any>, invokeCtx?: InvokeContext): Promise<TurnStarted> {
    const ctx = invokeCtx ?? this.ctx.rootContext();
    const request = turnRequestOf(inputs);
    if (inputs.idempotencyKey === undefined) {
      const ids = { conversation: request.conversation ?? mintId("cnv_"), turn: mintId("trn_") };
      const rounds = this.admission(request, ids, "", ctx);
      while (true) {
        const step = await rounds.next();
        if (step.done) return step.value;
      }
    }
    return this.idempotent(request, inputs.idempotencyKey as string, ctx);
  }

  /**
   * Admission, as the plan orders it, each round recorded as an intent first:
   * read the header, judge its turn by the journal, plan the turn, claim the
   * new key, then admit it at the version read. On a version conflict the
   * claimed key is removed and the next round starts under a new turn id.
   */
  private async *admission(
    request: TurnRequest,
    ids: { conversation: string; turn: string },
    fingerprint: string,
    ctx: InvokeContext,
  ): AsyncGenerator<Intent, TurnStarted> {
    const isNew = request.conversation === undefined;
    const endpoint = this.endpoint();
    const spec = await endpoint.provide();
    // An upload registered before this instant has expired, whether or not an expiry pass has run.
    const expiredBefore = celTimestampFromMillis(Date.now() - endpoint.pendingRetentionMs()) as CelTimestamp;
    let turn = ids.turn;
    for (let round = 0; round < ADMISSION_ROUNDS; round++) {
      yield { fingerprint, conversation: ids.conversation, turn };
      // A new conversation is created only once its first message is judged
      // admissible, so a refusal leaves nothing behind.
      let plan = isNew
        ? await planTurn(this.ops, request, ids.conversation, isNew, expiredBefore, spec, ctx)
        : undefined;
      const header = isNew
        ? await this.ops.create.invoke({ id: ids.conversation }, ctx)
        : await this.ops.read.invoke({ conversation: ids.conversation }, ctx);
      if (header.turn !== null) {
        const current = await this.ops.journalRead.invoke({ key: header.turn, limit: 0 }, ctx);
        if (current.state === "open") throw turnRunning(ids.conversation, header.turn);
      }
      plan ??= await planTurn(this.ops, request, ids.conversation, isNew, expiredBefore, spec, ctx);
      const writer = mintId("wrt_");
      await this.ops.journalClaim.invoke({ key: turn, writer }, ctx);
      try {
        await this.ops.admit.invoke(
          {
            conversation: ids.conversation,
            version: versionOf(header),
            turn,
            attachments: plan.attachments,
            expiredBefore,
          },
          ctx,
        );
      } catch (err) {
        const code = codeOf(err);
        if (code !== ERR_CONVERSATION_CONFLICT && code !== ERR_CONVERSATION_ATTACHMENT_NOT_FOUND) throw err;
        await this.ops.journalRemoval.invoke({ key: turn }, ctx);
        if (code === ERR_CONVERSATION_ATTACHMENT_NOT_FOUND) {
          // A file bound or released between the plan and the admission.
          const refused = String(((err as InvokeError).data as { attachment?: unknown } | undefined)?.attachment ?? "");
          throw attachmentRefused(refused, Math.max(0, request.attachments.indexOf(refused)));
        }
        turn = mintId("trn_");
        continue;
      }
      this.start({ conversation: ids.conversation, turn }, writer, plan, request.message, ctx);
      return { conversation: ids.conversation, turn };
    }
    throw conflictAfterRetries(ids.conversation);
  }

  /** Admission under an idempotency key kept on the turn journal. */
  private async idempotent(request: TurnRequest, key: string, ctx: InvokeContext): Promise<TurnStarted> {
    const idemKey = `idempotency/${sha256(key)}`;
    const fingerprint = fingerprintOf(request);
    const reused = () =>
      idempotencyConflict(`The idempotency key was first sent with a different request; send this one under a new key.`);
    for (let read = 0; read < IDEMPOTENCY_READS; read++) {
      const snapshot = await this.ops.journalRead.invoke({ key: idemKey }, ctx);
      const intents = (snapshot.entries as Array<{ data: Intent }>).map((entry) => entry.data);
      const last = intents[intents.length - 1];
      switch (snapshot.state) {
        case "unknown": {
          const writer = mintId("wrt_");
          try {
            await this.ops.journalClaim.invoke({ key: idemKey, writer }, ctx);
          } catch (err) {
            if (codeOf(err) === "ERR_JOURNAL_KEY_BUSY") continue;
            throw err;
          }
          const ids = { conversation: request.conversation ?? mintId("cnv_"), turn: mintId("trn_") };
          return this.recorded(idemKey, writer, request, ids, fingerprint, ctx);
        }
        case "open": {
          // Another send is being admitted under this key: wait for its ending.
          try {
            const { output } = await this.ops.journalSource.invoke({ key: idemKey }, ctx);
            const entries = (output as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            while (!(await entries.next()).done);
          } catch (err) {
            // Only the key's own ending is read again above: the other send's
            // failure, recorded on the key. Anything else is this call's.
            if (ctx.cancellation.isCancelled) throw err;
            const ended = await this.ops.journalRead.invoke({ key: idemKey, limit: 0 }, ctx);
            if (ended.state !== "failed" && ended.state !== "removed") throw err;
          }
          continue;
        }
        case "finished":
          if (!last || last.fingerprint !== fingerprint) throw reused();
          return { conversation: last.conversation, turn: last.turn };
        case "failed": {
          if (last && last.fingerprint !== fingerprint) throw reused();
          const writer = mintId("wrt_");
          try {
            await this.ops.journalClaim.invoke({ key: idemKey, writer, resume: true }, ctx);
          } catch (err) {
            if (codeOf(err) === "ERR_JOURNAL_KEY_BUSY") continue;
            throw err;
          }
          if (!last) {
            const ids = { conversation: request.conversation ?? mintId("cnv_"), turn: mintId("trn_") };
            return this.recorded(idemKey, writer, request, ids, fingerprint, ctx);
          }
          const turnKey = await this.ops.journalRead.invoke({ key: last.turn, limit: 0 }, ctx);
          if (turnKey.state === "removed") {
            const ids = { conversation: last.conversation, turn: mintId("trn_") };
            return this.recorded(idemKey, writer, request, ids, fingerprint, ctx);
          }
          if (turnKey.state === "unknown") {
            return this.recorded(idemKey, writer, request, last, fingerprint, ctx);
          }
          // A turn key claimed by an attempt that died before the header named
          // it was never admitted: the retry admits a new turn.
          const header = await this.ops.read.invoke({ conversation: last.conversation }, ctx);
          if (header.turn !== last.turn && turnKey.state !== "finished") {
            const ids = { conversation: last.conversation, turn: mintId("trn_") };
            return this.recorded(idemKey, writer, request, ids, fingerprint, ctx);
          }
          // The first attempt's turn exists: the retry answers it.
          await this.ops.journalSink.invoke({ key: idemKey, writer, input: new Stream(emptyRecords()) }, ctx);
          return { conversation: last.conversation, turn: last.turn };
        }
        default:
          throw idempotencyConflict(
            "The idempotency key is no longer remembered; send the request under a new key.",
          );
      }
    }
    throw idempotencyConflict(
      "Another request under this idempotency key did not settle; send the request again.",
    );
  }

  /** Admission drained into the idempotency key: each intent journaled before
   *  the effects it leads to, a refusal failing the key with its code. */
  private async recorded(
    idemKey: string,
    writer: string,
    request: TurnRequest,
    ids: { conversation: string; turn: string },
    fingerprint: string,
    ctx: InvokeContext,
  ): Promise<TurnStarted> {
    let started: TurnStarted | undefined;
    const rounds = this.admission(request, ids, fingerprint, ctx);
    async function* intents(): AsyncGenerator<Intent> {
      started = yield* rounds;
    }
    await this.ops.journalSink.invoke({ key: idemKey, writer, input: new Stream(intents()) }, ctx);
    if (!started) throw new InvokeError("ERR_CONTRACT_VIOLATION", `${this.label}: admission ended without a turn.`);
    return started;
  }

  /** Runs an admitted turn detached, draining its records into the turn's key
   *  under the writer that claimed it. */
  private start(
    identity: TurnIdentity,
    writer: string,
    plan: TurnPlan,
    text: string,
    admittedBy: InvokeContext,
  ): void {
    // The turn's own context, opened through the runtime: what the turn reads
    // (the agent's streamed output) is held for it until the turn ends.
    const stop = this.ctx.createCancellationSource();
    const unlink = this.shutdown.token.onCancelled((reason) => stop.cancel(reason));
    // The run continues the admitting call's trace, and inherits neither its
    // cancellation nor its zones: it outlives the call.
    const runCtx: InvokeContext = deriveContext(
      stop.context,
      admittedBy.traceId === undefined
        ? {}
        : {
            traceId: admittedBy.traceId,
            invocationId: admittedBy.invocationId,
            parentInvocationId: admittedBy.parentInvocationId,
          },
    );
    const titler = this.endpoint().titler?.();
    // A title is the turn's courtesy, not its work: a failure is logged and the turn ends as it would have.
    const beforeEnd = titler
      ? async (reply: string) => {
          try {
            await titleIfUntitled(this.ops, titler, identity.conversation, text, reply, runCtx);
          } catch (err) {
            if (runCtx.cancellation.isCancelled) throw err;
            this.ctx.log.warn("A conversation could not be titled", {
              conversation: identity.conversation,
              turn: identity.turn,
              code: codeOf(err) ?? null,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      : undefined;
    const input = new TurnInput(
      (agentOutput) => turnRecords(this.ops, identity, plan, text, runCtx, agentOutput, beforeEnd),
      stop,
      this.ctx.log,
      identity.turn,
    );
    this.ctx.runDetached(async () => {
      try {
        await this.ops.journalSink.invoke({ key: identity.turn, writer, input: new Stream(input) }, runCtx);
      } catch (err) {
        // The key holds the ending — readers see it as the turn's last events.
        this.ctx.log.warn("A turn ended without finishing", {
          conversation: identity.conversation,
          turn: identity.turn,
          code: codeOf(err) ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        unlink();
        stop.dispose();
      }
    });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* emptyRecords(): AsyncGenerator<never> {}

export function register(): void {}

export async function create(resource: RunnerResource, ctx: ResourceContext): Promise<TurnRunner> {
  return new TurnRunner(resource, ctx);
}
