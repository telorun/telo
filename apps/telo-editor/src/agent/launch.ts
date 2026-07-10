/**
 * Launch a per-session authoring-agent instance on the active runner. Each
 * launch is its OWN isolated container (private workspace, DB, journal) — the
 * per-instance isolation that makes the agent multi-user. The agent is an
 * operator-predefined app: the editor requests it by name and the runner
 * resolves the image and injects the operator's credentials server-side —
 * the editor never holds a secret nor picks an image.
 */

/** Well-known app name in the runner's predefined-app catalog. */
export const AGENT_APP_NAME = "authoring-agent";

const AGENT_PORT = 8080;

/** Header carrying the accepted terms version (mirrors runner-core's
 *  `ACCEPTED_TERMS_HEADER`; local constant so editor code doesn't import the
 *  Node-only package). */
const ACCEPTED_TERMS_HEADER = "x-telo-accepted-terms";

export interface LaunchedAgent {
  /** Base URL of this session's agent instance. */
  agentUrl: string;
  sessionId: string;
  /** The runner's DELETE URL for this session — used by the pagehide handler
   *  to fire a keepalive teardown when the page is closing. */
  deleteUrl: string;
  /** Tear the session's container down on the runner. */
  stop(): Promise<void>;
}

interface RunnerEndpoint {
  host: string;
  port: number;
  protocol: string;
  url?: string;
}

export async function launchAgentSession(
  runnerBaseUrl: string,
  acceptedTermsVersion?: string | null,
): Promise<LaunchedAgent> {
  const base = runnerBaseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Agent sessions ride the same terms enforcement as runs (428 without it).
  if (acceptedTermsVersion) headers[ACCEPTED_TERMS_HEADER] = acceptedTermsVersion;
  const res = await fetch(`${base}/v1/apps/${encodeURIComponent(AGENT_APP_NAME)}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      env: {},
      ports: [{ port: AGENT_PORT, protocol: "tcp" }],
    }),
  });
  if (res.status === 428) {
    throw new Error(
      "Accept the usage terms before using the agent: run any application once to review and accept them, then try again.",
    );
  }
  if (res.status === 404) {
    throw new Error("The authoring agent is not available.");
  }
  if (!res.ok) {
    throw new Error(`Failed to start the authoring agent (${res.status}).`);
  }
  const { sessionId, streamUrl } = (await res.json()) as { sessionId: string; streamUrl: string };
  // Tap the container's PTY output (the /io byte channel — separate from the
  // SSE event stream) so a boot crash's stdout/stderr is captured and attached
  // to a launch failure instead of a bare "exit code 1".
  const output = new OutputTail();
  const tap = openIoTap(base, sessionId, output);
  try {
    const agentUrl = await resolveAgentUrl(base, streamUrl, output, () =>
      Promise.race([tap.settled, delay(1500)]),
    );
    const deleteUrl = `${base}/v1/sessions/${encodeURIComponent(sessionId)}`;
    return {
      agentUrl,
      sessionId,
      deleteUrl,
      async stop() {
        try {
          await fetch(deleteUrl, { method: "DELETE" });
        } catch (err) {
          // No caller can act on this, but a failed delete means a leaked
          // container on the runner — keep it visible.
          console.error(`Failed to delete agent session '${sessionId}' on the runner`, err);
        }
      },
    };
  } finally {
    tap.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface IoTap {
  close(): void;
  /** Resolves when the socket closes — on a terminal session the runner replays
   *  the buffered PTY bytes and closes, so awaiting this flushes a crash's output
   *  before we compose the failure message. */
  settled: Promise<void>;
}

/** Consume the session's `/io` WebSocket (binary `[seq:4 BE][payload]` frames)
 *  from the start of the transcript, decoding each payload into `output`. A
 *  rejected upgrade (origin/terminal) just leaves the tap empty — best effort. */
function openIoTap(base: string, sessionId: string, output: OutputTail): IoTap {
  let resolveSettled = (): void => {};
  const settled = new Promise<void>((r) => (resolveSettled = r));
  let socket: WebSocket | null = null;
  try {
    const wsBase = base.replace(/^http/, "ws");
    socket = new WebSocket(`${wsBase}/v1/sessions/${encodeURIComponent(sessionId)}/io?lastSeq=0`);
    socket.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    socket.addEventListener("message", (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 4) return; // string = control frame
      output.push(decoder.decode(new Uint8Array(e.data, 4), { stream: true }));
    });
    socket.addEventListener("close", () => resolveSettled());
    socket.addEventListener("error", () => resolveSettled());
  } catch {
    resolveSettled();
  }
  return {
    close() {
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolveSettled();
    },
    settled,
  };
}

/**
 * Consume the session's event stream and resolve the agent's base URL once it is
 * actually reachable — not merely when the container reports `running` (which
 * fires the instant the container starts, before the app inside binds its port).
 * The container's own stdout/stderr, a terminal `exited`/`failed`, and the
 * per-port reachability transitions all ride this stream; we surface them so a
 * boot crash becomes a readable error here instead of a downstream 502.
 *
 * Readiness = `running` seen AND the agent port reported `reachable`. For a
 * runner that doesn't emit reachability at all, we fall back to accepting the
 * `running` endpoint after a short grace, preserving the old behaviour.
 */
function resolveAgentUrl(
  runnerBase: string,
  streamUrl: string,
  output: OutputTail,
  flush: () => Promise<void>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${runnerBase}${streamUrl}`);
    let endpoint: RunnerEndpoint | undefined;
    let running = false;
    let sawReachability = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      void failWithOutput(
        running ? "Agent started but never became reachable in time." : "Agent did not become ready in time.",
      );
    }, 90000);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      source.close();
      fn();
    };
    const succeed = () => done(() => resolve(endpointUrl(runnerBase, endpoint)));
    const fail = (err: Error) => done(() => reject(err));
    // Give the /io tap a moment to flush the container's buffered output, then
    // append it so the failure carries the boot crash, not just a code.
    const failWithOutput = async (message: string) => {
      if (settled) return;
      await flush();
      fail(new Error(`${message}${output.suffix()}`));
    };

    source.addEventListener("reachability", (e) => {
      const evt = parseEvent<{ port?: number; state?: string }>(e);
      if (!evt) return;
      // Only the agent's own port counts — a multi-port app could report an
      // unrelated port reachable, which must not mark the agent ready. Before
      // `running` arrives `endpoint` is unset, so fall back to AGENT_PORT.
      const targetPort = endpoint?.port ?? AGENT_PORT;
      if (evt.port !== targetPort) return;
      sawReachability = true;
      if (running && evt.state === "reachable") succeed();
    });

    // Runner SSE frames carry the RunEvent shape: `{ type, status: { kind,
    // endpoints } }` — read `.status`, not the top-level object.
    source.addEventListener("status", (e) => {
      const evt = parseEvent<{ status?: { kind?: string; code?: number; message?: string; endpoints?: RunnerEndpoint[] } }>(e);
      const status = evt?.status;
      if (!status || typeof status.kind !== "string") return;
      if (status.kind === "running") {
        running = true;
        endpoint = (status.endpoints ?? []).find((x) => x.port === AGENT_PORT) ?? status.endpoints?.[0];
        // Fall back to the running endpoint only if the runner never reports
        // reachability; if it does, wait for `reachable` (or the crash/exit).
        graceTimer = setTimeout(() => {
          if (!sawReachability) succeed();
        }, 6000);
      } else if (status.kind === "failed" || status.kind === "exited" || status.kind === "stopped") {
        const detail =
          status.kind === "exited"
            ? `exit code ${status.code ?? "?"}`
            : status.kind === "failed" && status.message
              ? status.message
              : status.kind;
        void failWithOutput(`Agent failed to start (${detail}).`);
      }
    });

    // EventSource auto-reconnects on a dropped connection; the timeout bounds it.
  });
}

function parseEvent<T>(e: Event): T | undefined {
  try {
    return JSON.parse((e as MessageEvent).data) as T;
  } catch {
    return undefined;
  }
}

function endpointUrl(runnerBase: string, ep: RunnerEndpoint | undefined): string {
  if (ep?.url) return ep.url;
  const runner = new URL(runnerBase);
  const host = ep?.host && ep.host.length > 0 ? ep.host : runner.hostname;
  return `${runner.protocol}//${host}:${ep?.port ?? AGENT_PORT}`;
}

/** A bounded, ANSI-stripped tail of the container's output, appended to launch
 *  errors so a boot crash is legible instead of a bare 502. */
class OutputTail {
  private buf = "";
  private static readonly MAX = 4000;
  // eslint-disable-next-line no-control-regex
  private static readonly ANSI = /\x1b\[[0-9;]*m/g;

  push(chunk: string): void {
    if (!chunk) return;
    this.buf = (this.buf + chunk.replace(OutputTail.ANSI, "")).slice(-OutputTail.MAX);
  }

  suffix(): string {
    const text = this.buf.trim();
    return text ? `\n\nContainer output:\n${text}` : "";
  }
}
