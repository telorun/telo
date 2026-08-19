/**
 * `DurableLocal.Result` — what did this run produce?
 *
 * Answers immediately by default. The optional `wait:` is what makes a
 * detached start usable from a caller that genuinely wants the outcome — a test,
 * a request that can afford to block, a script — without putting that choice on
 * the START, where it would have to hold a connection open across a wait
 * measured in days.
 *
 * Polling rather than a subscription, and stated plainly: the journal contract
 * is a store, not a bus. A backend whose store can push (Postgres `LISTEN`)
 * makes this promptness question its own; a directory of files cannot, and
 * pretending otherwise in the shared contract would put a method every journal
 * must implement badly into the seam.
 */
import {
  InvokeError,
  parseDurationMs,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import { journalOf } from "./journal-ref.js";
import { runIdOf } from "./run-id.js";

interface ResultManifest extends ResourceManifest {
  journal: unknown;
  run?: string;
  wait?: string;
  poll?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

class ResultController {
  constructor(
    private readonly resource: ResultManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const run = runIdOf(this.ctx, this.resource.run, input, `DurableLocal.Result '${name}'`);
    const journal = journalOf(this.ctx, this.resource.journal, `DurableLocal.Result "${name}"`);

    const deadline =
      this.resource.wait === undefined
        ? 0
        : Date.now() + parseDurationMs(String(this.resource.wait));
    const poll = parseDurationMs(String(this.resource.poll ?? "100ms"));

    for (;;) {
      const record = await journal.readRun(run);
      if (record && TERMINAL.has(record.status)) {
        return {
          run,
          status: record.status,
          ...(record.result === undefined ? {} : { result: record.result }),
          ...(record.error === undefined ? {} : { error: record.error }),
          // Reported with the outcome rather than only logged, because §8.3
          // makes it a conformance requirement: a durability feature whose
          // guarantee is decided by an invisible runtime coincidence has to say
          // which way it resolved.
          ...(record.collapsedRegions === undefined
            ? {}
            : { collapsedRegions: record.collapsedRegions }),
          ...(record.collapseReasons === undefined
            ? {}
            : { collapseReasons: record.collapseReasons }),
        };
      }
      if (Date.now() >= deadline) {
        return { run, status: record?.status ?? "unknown" };
      }
      // Cancellable, for the reason every wait in this repo is: a caller that
      // was asked to stop must not stay here for the rest of the budget.
      await sleep(Math.min(poll, deadline - Date.now()), invokeCtx);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function sleep(ms: number, invokeCtx: InvokeContext | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unlink?.();
      resolve();
    }, ms);
    const unlink = invokeCtx?.cancellation.onCancelled((reason) => {
      clearTimeout(timer);
      reject(
        new InvokeError("ERR_INVOKE_CANCELLED", `Waiting for a run's result was cancelled`, {
          reason,
        }),
      );
    });
  });
}

export function register(): void {}

export async function create(
  resource: ResultManifest,
  ctx: ResourceContext,
): Promise<ResultController> {
  return new ResultController(resource, ctx);
}
