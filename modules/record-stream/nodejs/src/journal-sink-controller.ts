import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { JournalStore, resolveJournal } from "./journal-store.js";

interface JournalSinkResource {
  metadata: { name: string; module?: string };
  journal?: JournalStore | { name: string; alias?: string };
}

interface JournalSinkInputs {
  key: string;
  input: AsyncIterable<unknown>;
}

interface JournalSinkOutputs {
  key: string;
  count: number;
}

/**
 * RecordStream.JournalSink — drain a stream into a Journal under `key`. Each
 * record is appended (getting a monotonic id); on normal completion the key is
 * finished, on error it is failed (recording the error so a reader sees it) and
 * the error is rethrown — never swallowed. Callers that want the turn to run
 * detached invoke this without awaiting and return a handle (the key) to their
 * client, which then reads it back through a JournalSource.
 */
class JournalSink implements ResourceInstance<JournalSinkInputs, JournalSinkOutputs> {
  constructor(
    private readonly resource: JournalSinkResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: JournalSinkInputs): Promise<JournalSinkOutputs> {
    const name = this.resource.metadata.name;
    const key = inputs?.key;
    if (typeof key !== "string" || key.length === 0) {
      throw new InvokeError("ERR_INVALID_INPUT", `RecordStream.JournalSink "${name}": 'key' must be a non-empty string.`);
    }
    const input = inputs?.input;
    if (!input || typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      throw new InvokeError("ERR_INVALID_INPUT", `RecordStream.JournalSink "${name}": 'input' must be an AsyncIterable.`);
    }
    const journal = resolveJournal(this.resource.journal, this.ctx);

    let count = 0;
    try {
      for await (const record of input) {
        journal.append(key, record);
        count++;
      }
      journal.finish(key);
      return { key, count };
    } catch (err) {
      journal.fail(key, err);
      throw err;
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: JournalSinkResource, ctx: ResourceContext): Promise<JournalSink> {
  return new JournalSink(resource, ctx);
}
