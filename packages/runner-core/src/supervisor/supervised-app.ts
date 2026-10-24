import type { AppRun } from "../backend.js";
import type { AppState, ByteStreamTag } from "../contract.js";
import { SupervisorClient, SupervisorTerminated, type SupervisorTermination } from "./supervisor-client.js";
import type { SupervisorHello } from "./supervisor-protocol.js";

export interface SupervisedAppAddress {
  host: string;
  port: number;
  token: string;
  /** How messages name what the supervisor runs in, e.g. `container 'app-web'`. */
  label: string;
}

export interface SupervisedAppEvents {
  onAppState(state: AppState): void;
  onOutput(chunk: Buffer, stream: ByteStreamTag): void;
  /** The connection ended for good. */
  onTerminated(termination: SupervisorTermination): void;
}

/**
 * One app slot driven through its session supervisor, in `/v1` terms: `started`
 * is `running`, `exited` / `failed` is `ready` with the run's ending, and frames
 * the supervisor's ring lost are told on the app's output.
 *
 * State is reported only from `report()` on, so a workload says `running` before
 * any app says `ready`; whatever the supervisor said before that (an adopted
 * live run included) is read from the client when reporting starts.
 */
export class SupervisedApp {
  private readonly client: SupervisorClient;
  private readonly label: string;
  private reporting = false;
  private lastStream: ByteStreamTag = "tty";

  constructor(address: SupervisedAppAddress, private readonly events: SupervisedAppEvents) {
    this.label = address.label;
    this.client = new SupervisorClient({
      host: address.host,
      port: address.port,
      token: address.token,
      listener: {
        onConnected: () => {},
        onStarted: (runId) => {
          if (this.reporting) this.events.onAppState({ state: "running", runId });
        },
        onExited: (ending) => {
          if (this.reporting) this.events.onAppState({ state: "ready", ended: ending });
        },
        onFailed: (runId, reason) => {
          if (this.reporting) this.events.onAppState({ state: "ready", ended: { runId, reason } });
        },
        onRefused: () => {},
        onOutput: (chunk, stream) => {
          this.lastStream = stream;
          this.events.onOutput(chunk, stream);
        },
        onGap: (expected, received) => {
          this.events.onOutput(
            Buffer.from(`\r\n[runner] ${received - expected} output frame(s) were lost before the runner read them\r\n`),
            this.lastStream === "tty" ? "tty" : "stderr",
          );
        },
        // The client reconnects and is replayed from its last seq.
        onDisconnected: () => {},
        onTerminated: (termination) => this.events.onTerminated(termination),
      },
    });
  }

  /** The supervisor's first `hello`, or why there was none within `timeoutMs`
   *  (`SupervisorTerminated` for a connection ended for good). */
  async connect(timeoutMs: number): Promise<SupervisorHello> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the session supervisor of ${this.label} did not answer within ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([this.client.connect(), timeout]);
    } catch (err) {
      await this.client.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Report the app's state as it stands, and every change from now on. */
  report(): void {
    this.reporting = true;
    const live = this.client.liveRunId;
    this.events.onAppState(live !== undefined ? { state: "running", runId: live } : { state: "ready" });
  }

  get liveRunId(): string | undefined {
    return this.client.liveRunId;
  }

  run(run: AppRun): Promise<void> {
    return this.client.run(run);
  }

  stop(runId: string, graceMs: number): Promise<void> {
    return this.client.stop(runId, graceMs);
  }

  writeStdin(runId: string, bytes: Uint8Array): void {
    this.client.writeStdin(runId, bytes);
  }

  resize(runId: string, cols: number, rows: number): void {
    this.client.resize(runId, cols, rows);
  }

  /** Drop the connection; a live run keeps running. */
  close(): Promise<void> {
    return this.client.close();
  }
}

/** A supervisor of another protocol generation: the workload predates this
 *  runner build (or follows it), and the backend recreates it. */
export function isGenerationMismatch(err: unknown): boolean {
  return err instanceof SupervisorTerminated && err.termination.kind === "generation_mismatch";
}
