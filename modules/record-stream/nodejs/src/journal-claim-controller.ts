import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type Journal, isJournal } from "./journal.js";
import type { RecordedError } from "./recorded-error.js";

interface JournalClaimResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

interface JournalClaimInputs {
  key: string;
  writer: string;
  resume?: boolean;
}

interface JournalClaimOutputs {
  key: string;
  lastId: number;
  error: RecordedError | null;
}

/**
 * RecordStream.JournalClaim — claim a key for a named writer without draining
 * anything into it, so the key exists (and readers tail it) before the work that
 * fills it starts. A `JournalSink` given the same `writer` adopts it. With
 * `resume`, a failed or abandoned key is taken over exactly as the sink's
 * `resume` does. A key already open under the same writer is returned as it is,
 * whether or not a sink has adopted it, and nothing is written — as is one a sink
 * under the same writer already finished or failed, or left open with a stale
 * heartbeat (failed as lost first). Reports the recorded error of the failed key
 * it took over or returned; null when it created the key or found it open.
 * Nothing heartbeats the claim until a sink adopts it, so an undrained claim
 * goes stale and is failed as abandoned by the next reader or expiry pass.
 */
class JournalClaim implements ResourceInstance<JournalClaimInputs, JournalClaimOutputs> {
  constructor(
    private readonly resource: JournalClaimResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: JournalClaimInputs): Promise<JournalClaimOutputs> {
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalClaim "${this.resource.metadata.name}": 'journal'`,
      "Self.Journal",
    );
    const claimed = await journal.reserve(inputs.key, { resume: inputs.resume === true, writer: inputs.writer });
    return { key: inputs.key, lastId: claimed.lastId, error: claimed.error };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalClaimResource, ctx: ResourceContext): Promise<JournalClaim> {
  return new JournalClaim(resource, ctx);
}
