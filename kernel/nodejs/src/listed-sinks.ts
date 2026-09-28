import { RuntimeError } from "@telorun/sdk";

/**
 * The sinks the root Application attaches — `logging.sinks` and `tracing.sinks`
 * (`kernel/specs/logging.md` §12.1, `kernel/specs/tracing.md` §1).
 *
 * The kernel attaches exactly the instances a list names, and nothing attaches
 * itself: a sink declared anywhere else is inert. An entry is a sink reference
 * (`{ kind, name, alias? }` once the loader has resolved `!ref` and extracted an
 * inline declaration) or `{ sink, when }`, whose `when` is evaluated at load and
 * validated as a boolean before any sink is created.
 */

export type SinkList = "logging" | "tracing";

export interface ListedSink {
  list: SinkList;
  /** `logging.sinks[1]` — how a diagnostic names the entry. */
  entry: string;
  name: string;
  /** Set for a `!ref <Alias>.<name>` entry: an instance an import exports. */
  alias?: string;
  attach: boolean;
}

export function readListedSinks(list: SinkList, block: unknown): ListedSink[] {
  const sinks = (block as { sinks?: unknown } | undefined)?.sinks;
  if (!Array.isArray(sinks)) return [];
  return sinks.map((raw, index) => {
    const entry = `${list}.sinks[${index}]`;
    const gated =
      raw && typeof raw === "object" && "sink" in (raw as Record<string, unknown>)
        ? (raw as { sink: unknown; when?: unknown })
        : undefined;
    const ref = (gated ? gated.sink : raw) as { name?: unknown; alias?: unknown } | undefined;
    if (!ref || typeof ref.name !== "string") {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        `${entry} does not name a sink: write \`!ref <name>\`, an inline sink declaration, or \`{ sink, when }\`.`,
      );
    }
    return {
      list,
      entry,
      name: ref.name,
      ...(typeof ref.alias === "string" ? { alias: ref.alias } : {}),
      attach: gated?.when !== false,
    };
  });
}

/** The members a sink instance exposes to the runtime that writes to it. */
const SINK_CONTRACT = ["sinkId", "write", "flush", "flushSync", "close"] as const;

export interface AttachableSink {
  sinkId: string;
  write(record: unknown): void;
  flush(): Promise<void>;
  flushSync(): void;
  close(): Promise<void>;
}

/** Refuse a listed instance that does not expose the sink contract. */
export function assertSinkContract(instance: unknown, listed: ListedSink): AttachableSink {
  const record = instance as Record<string, unknown> | null;
  const missing = SINK_CONTRACT.filter((member) =>
    member === "sinkId"
      ? typeof record?.sinkId !== "string"
      : typeof record?.[member] !== "function",
  );
  if (missing.length > 0) {
    throw new RuntimeError(
      "ERR_SINK_CONTRACT_MISSING",
      `${listed.entry} lists '${listed.alias ? `${listed.alias}.` : ""}${listed.name}', whose instance ` +
        `does not expose the sink contract (missing ${missing.join(", ")}). A ${listed.list} sink must ` +
        `be a kind with capability Telo.Sink whose instance is the sink itself.`,
    );
  }
  return instance as AttachableSink;
}
