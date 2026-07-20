import {
  parseLevelName,
  SEVERITY,
  type LevelName,
  type LogAttributes,
  type Logger,
  type ResourceRef,
} from "@telorun/sdk";
import { BOOTSTRAP_SINK_ID, createBootstrapWriter } from "./bootstrap-writer.js";
import { ConsoleSink } from "./console-sink.js";
import { compileRedactionPolicy, EMPTY_REDACTION_POLICY } from "./redact-attributes.js";
import type { DropCause, LogSinkInstance } from "./log-sink.js";
import { createLoggingHost, type LoggingHost } from "./logging-host.js";
import { LoggingPipeline, type ScopeConfig, type TraceContextProvider } from "./logging-pipeline.js";
import type { SamplingConfig } from "./sampler.js";

/**
 * The kernel's ownership of the logging pipeline — `kernel/specs/logging.md`
 * §12.
 *
 * Sequencing is the whole job here. An internal console writer covers process
 * start through manifest validation, because declared sinks cannot instantiate
 * before the block that declares them has been validated. Once the manifest
 * resolves, the declared configuration takes over: eager sinks attach, buffered
 * records replay, and the bootstrap writer steps aside.
 */

/** The raw `logging:` block as authored, after CEL evaluation. */
export interface LoggingManifestBlock {
  level?: string;
  attributes?: LogAttributes;
  redact?: { paths?: string[]; censor?: string; remove?: boolean };
  sampling?: { first?: number; thereafter?: number; tick?: string; sampleErrors?: boolean };
  sinks?: unknown[];
}

const DEFAULT_SAMPLING_TICK_MS = 1000;

/** The module-context tree as far as logging is concerned — just enough to walk
 *  children and read each one's resolved scope config, declared structurally so
 *  this file stays independent of the concrete `ModuleContext`. */
export interface LoggingContextNode {
  readonly children?: readonly LoggingContextNode[];
  getLoggingConfig?(): ScopeConfig | undefined;
}

/** How many sinks the root Application declared. Zero means the runtime behaves
 *  exactly as if a single `Telo.ConsoleSink` were declared (§12.1), which is why
 *  the bootstrap writer is replaced by a threshold-aware one rather than left as
 *  the fixed-`info` writer. */
function declaredSinkCount(manifests: readonly { kind?: string }[]): number {
  const root = manifests.find((m) => m.kind === "Telo.Application") as
    | { logging?: { sinks?: unknown[] } }
    | undefined;
  return root?.logging?.sinks?.length ?? 0;
}

export class KernelLogging {
  readonly pipeline: LoggingPipeline;
  readonly host: LoggingHost;

  #rootScope: ScopeConfig;
  #bootstrap: LogSinkInstance | undefined;
  #sealed = false;
  /** Kept so the zero-config console sink can be rebuilt at the resolved
   *  threshold once the manifest is known (see {@link sealBootstrap}). */
  readonly #streams: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };

  constructor(options: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    /** The process's real stderr — §8.4's fallback diagnostic stream. Kept
     *  distinct from the kernel's injectable `stderr` so a captured stream can
     *  never swallow the report that the capture itself failed. */
    fallbackStream?: { write(chunk: string): unknown };
  }) {
    this.#streams = { env: options.env, stdout: options.stdout, stderr: options.stderr };
    this.pipeline = new LoggingPipeline({
      fallbackStream: options.fallbackStream ?? {
        write: (chunk: string) => process.stderr.write(chunk),
      },
    });

    // §12.3: a fixed default of `info` until the manifest resolves. This phase
    // is the only one not manifest-governed, and it is deliberately not
    // configurable by any other means.
    this.#rootScope = {
      threshold: SEVERITY.info,
      redaction: EMPTY_REDACTION_POLICY,
    };

    this.#bootstrap = createBootstrapWriter(options);
    this.pipeline.attach(this.#bootstrap);

    this.host = createLoggingHost(
      this.pipeline,
      () => this.#rootScope.threshold,
      (sinkId: string, cause: DropCause, count?: number) => this.recordDrop(sinkId, cause, count),
    );
  }

  get rootScope(): ScopeConfig {
    return this.#rootScope;
  }

  setTraceContextProvider(provider: TraceContextProvider | undefined): void {
    this.pipeline.setTraceContextProvider(provider);
  }

  recordDrop(sinkId: string, cause: DropCause, count = 1): void {
    // Routed through the pipeline so the recovery warning §10.4 requires is
    // emitted as an ordinary record and reaches every sink.
    this.pipeline.recordDrop(sinkId, cause, count);
  }

  /**
   * Adopt the manifest's declared configuration. Called as soon as the
   * `logging:` block has been validated — after that point the bootstrap default
   * is no longer in force.
   */
  applyRootConfig(block: LoggingManifestBlock | undefined, secretValues?: ReadonlySet<string>): void {
    this.#rootScope = buildScopeConfig(block, {
      threshold: SEVERITY.info,
      redaction: EMPTY_REDACTION_POLICY,
      secretValues,
    });
  }

  /**
   * Detach the bootstrap writer and stop holding records for replay. Called once
   * every declared sink has attached: the buffer exists to cover the pre-attach
   * window, and a consumer connecting later (the debug wire) wants the live
   * stream rather than the whole process history.
   *
   * When the manifest declares no sinks at all, the runtime behaves exactly as
   * if a single `Telo.ConsoleSink` were declared — "pretty logs on stderr in a
   * terminal, JSON when piped", with no imports.
   *
   * That equivalence is why the bootstrap writer is *replaced* here rather than
   * promoted in place. The bootstrap writer is pinned at `info` (§12.3), but a
   * declared `Telo.ConsoleSink` with no explicit `level:` takes the resolved
   * scope threshold — so promoting the fixed-`info` writer would silently ignore
   * a root `logging.level`, in both directions (a `debug` never lowers the gate,
   * a `warn` never raises it). The fresh sink is built at the resolved threshold,
   * so `logging: { level: debug }` with no `sinks:` behaves as documented.
   */
  sealBootstrap(manifests: readonly { kind?: string }[]): void {
    if (this.#sealed) return;
    this.#sealed = true;

    if (this.#bootstrap) {
      this.pipeline.detach(this.#bootstrap);
      this.#bootstrap = undefined;
    }
    // Drop the replay buffer *before* attaching the zero-config sink, so the
    // records the bootstrap writer already wrote live are not replayed into it.
    this.pipeline.sealBootstrap();

    if (declaredSinkCount(manifests) === 0) {
      this.pipeline.attach(
        new ConsoleSink({
          sinkId: BOOTSTRAP_SINK_ID,
          level: this.#rootScope.threshold,
          destination: "stderr",
          encoding: "auto",
          color: "auto",
          env: this.#streams.env,
          stdout: this.#streams.stdout,
          stderr: this.#streams.stderr,
        }),
      );
    }
  }

  /** A logger scoped to a module context, stamped with a resource identity. */
  createLogger(scope: ScopeConfig | undefined, resource?: ResourceRef): Logger {
    return this.pipeline.createLogger(scope ?? this.#rootScope, resource);
  }

  /**
   * Every module context's resolved logging configuration, keyed by its dotted
   * import-alias path (`Api.Domain.Db`); the root is keyed `""`.
   *
   * This closes §12.2's loop between reading and configuring: the `scope` on a
   * log line is exactly the path you write in the manifest to change that
   * instance's level, and this answers "what level did that path actually
   * resolve to" without re-deriving the cascade by hand. The tree walk is
   * logging logic, so it lives here rather than on the orchestrator.
   */
  scopesFrom(rootContext: LoggingContextNode | undefined): Map<string, ScopeConfig> {
    const scopes = new Map<string, ScopeConfig>();
    scopes.set("", this.#rootScope);
    const visit = (context: LoggingContextNode): void => {
      for (const child of context.children ?? []) {
        const config = child.getLoggingConfig?.();
        if (config?.scope) scopes.set(config.scope, config);
        visit(child);
      }
    };
    if (rootContext) visit(rootContext);
    return scopes;
  }

  /** The kernel's own logger — used for diagnostics the kernel emits about
   *  itself, which §13.1 requires to go through this pipeline rather than to
   *  `process.stderr` or `console.*`. */
  kernelLogger(): Logger {
    return this.pipeline.createLogger(this.#rootScope, undefined);
  }

  async shutdown(): Promise<void> {
    await this.pipeline.close();
  }
}

/**
 * Merge a `logging:` block over an inherited configuration. Config cascades and
 * may be narrowed at each hop, which is what makes a dependency you do not own
 * diagnosable — raising `Api`'s level lifts everything beneath it without
 * editing `Api`'s manifest (§12.2).
 */
export function buildScopeConfig(
  block: LoggingManifestBlock | undefined,
  inherited: ScopeConfig,
): ScopeConfig {
  if (!block) return inherited;

  const level = block.level ? parseLevelName(block.level as LevelName) : undefined;

  return {
    threshold: level ?? inherited.threshold,
    redaction: block.redact
      ? compileRedactionPolicy({
          paths: block.redact.paths,
          censor: block.redact.censor,
          remove: block.redact.remove,
        })
      : inherited.redaction,
    sampling: block.sampling ? toSamplingConfig(block.sampling) : inherited.sampling,
    secretValues: inherited.secretValues,
    scope: inherited.scope,
    module: inherited.module,
    attributes: block.attributes ?? inherited.attributes,
  };
}

function toSamplingConfig(sampling: NonNullable<LoggingManifestBlock["sampling"]>): SamplingConfig {
  return {
    first: sampling.first ?? 0,
    thereafter: sampling.thereafter ?? 0,
    tickMs: sampling.tick ? parseTickMs(sampling.tick) : DEFAULT_SAMPLING_TICK_MS,
    sampleErrors: sampling.sampleErrors ?? false,
  };
}

function parseTickMs(tick: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(tick);
  if (!match) return DEFAULT_SAMPLING_TICK_MS;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  return Number(match[1]) * unit;
}
