import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  parseDurationMs,
  RuntimeError,
  type EffectChain,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { createServer, type Server } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";

interface RedirectListenerManifest {
  metadata?: { name?: string };
  port?: number;
  path?: string;
  responseBody?: string;
}

/** What a browser redirect carried. */
export interface RedirectResult {
  code: string | null;
  state: string;
  error: string | null;
  iss: string | null;
}

/** How long a callback nobody is waiting for is held before being dropped. Bounds
 *  what a long-lived pinned-port listener can accumulate; the waiting side has its
 *  own timeout, so nothing legitimate is retained longer than this. */
const HELD_RESULT_TTL_MS = 300_000;

/** Hard cap on unclaimed callbacks, evicting oldest-first. A sign-in flow has one
 *  in flight at a time; this only bounds what an unsolicited caller can retain. */
const MAX_HELD_RESULTS = 32;

export class RedirectListenerResource implements ResourceInstance {
  private server?: Server;
  private readonly path: string;
  private readonly responseBody: string;
  /** Callbacks that arrived before anyone asked for them. */
  private readonly received = new Map<string, RedirectResult>();
  private readonly waiters = new Map<string, (result: RedirectResult) => void>();

  constructor(
    private readonly manifest: RedirectListenerManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.path = manifest.path ?? "/callback";
    this.responseBody =
      manifest.responseBody ?? "<p>Sign-in complete. You can close this tab.</p>";
  }

  private describe(): string {
    return `OAuthClient.RedirectListener "${this.manifest.metadata?.name ?? ""}"`;
  }

  /** Binding is an observable side effect, so it belongs in `run()` — and the
   *  socket it opens is what `run()` returns, since closing it is the only thing
   *  that undoes this. The same split `Http.Server` uses. */
  run(): EffectChain<unknown> {
    return this.ctx.effect("redirect socket", async () => {
      await this.bind();
      return { result: undefined, inverse: () => this.close() };
    });
  }

  /** Close the socket. The inverse of {@link bind}; a listener that never bound
   *  closes to nothing. */
  private async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async bind(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
      // Only the configured path is a callback. Treating every request as one
      // means a browser's /favicon.ico is recorded as a sign-in and answered with
      // the success page.
      if (url.pathname !== this.path) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const result: RedirectResult = {
        code: url.searchParams.get("code"),
        state,
        error: url.searchParams.get("error"),
        iss: url.searchParams.get("iss"),
      };
      const waiter = this.waiters.get(state);
      if (waiter) {
        this.waiters.delete(state);
        waiter(result);
      } else {
        // The awaiting step may not have reached its turn yet; hold the result so
        // a callback that arrives first is not lost. Bounded twice over — by age
        // and by count — because the key is whatever `state` the caller sent and
        // each entry holds an authorization code: anything that can reach the
        // socket could otherwise grow this without limit.
        this.received.set(state, result);
        setTimeout(() => this.received.delete(state), HELD_RESULT_TTL_MS).unref();
        while (this.received.size > MAX_HELD_RESULTS) {
          // Insertion-ordered, so the first key is the oldest.
          const oldest = this.received.keys().next();
          if (oldest.done) break;
          this.received.delete(oldest.value);
        }
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(this.responseBody);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onListenError = (err: Error) => reject(err);
      server.once("error", onListenError);
      server.listen(this.manifest.port ?? 0, LOOPBACK_HOST, () => {
        // Hand the socket over to a real handler. Leaving the bind-time `reject`
        // attached would send every later error to an already-settled promise,
        // which discards it silently.
        server.off("error", onListenError);
        server.on("error", (err) =>
          this.ctx.log.error(`${this.describe()}: socket error while waiting for the redirect`, {
            error: err.message,
          }),
        );
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new RuntimeError(
        "ERR_OAUTH_LISTENER_ADDRESS",
        `${this.describe()}: the socket bound to no resolvable address.`,
      );
    }

    // Reported the moment it is known — the bound port is what the consent URL
    // has to carry, and it did not exist until now.
    await this.ctx.setStatus({
      port: address.port,
      redirectUri: `http://${LOOPBACK_HOST}:${address.port}${this.path}`,
    });
  }

  awaitCallback(
    state: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RedirectResult> {
    const already = this.received.get(state);
    if (already) {
      this.received.delete(state);
      return Promise.resolve(already);
    }
    return new Promise<RedirectResult>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(state);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () =>
        settle(() => reject(new InvokeError(ERR_INVOKE_CANCELLED, "Waiting for the redirect was cancelled")));
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new RuntimeError(
                "ERR_OAUTH_REDIRECT_TIMEOUT",
                `${this.describe()}: no redirect arrived within the timeout. ` +
                  `The user may not have finished signing in.`,
              ),
            ),
          ),
        timeoutMs,
      );
      this.waiters.set(state, (result) => settle(() => resolve(result)));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function isRedirectListener(value: unknown): value is RedirectListenerResource {
  return value instanceof RedirectListenerResource;
}

interface RedirectAwaitManifest {
  metadata?: { name?: string };
  listener: unknown;
  timeout?: string;
}

export class RedirectAwaitResource implements ResourceInstance {
  private readonly timeoutMs: number;
  private listener?: RedirectListenerResource;

  constructor(
    private readonly manifest: RedirectAwaitManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.timeoutMs = parseDurationMs(manifest.timeout, 300_000);
  }

  /**
   * Resolved on first use, never in the constructor. A scoped resource is
   * CREATED before its scoped siblings are initialized, so a constructor-time
   * lookup races the scope's own init order: the sibling is not in the scope's
   * instances yet, and resolution falls through to the enclosing module — binding
   * a same-named outer resource that is never started. By invoke time the scope
   * is fully initialized and the name resolves to what it actually denotes.
   */
  private target(): RedirectListenerResource {
    return (this.listener ??= this.ctx.resolveRef(
      this.manifest.listener,
      isRedirectListener,
      () => `OAuthClient.RedirectAwait "${this.manifest.metadata?.name ?? ""}": 'listener'`,
      "OAuthClient.RedirectListener",
    ));
  }

  async invoke(
    inputs: { state: string },
    invokeCtx?: InvokeContext,
  ): Promise<RedirectResult> {
    return this.target().awaitCallback(
      inputs.state,
      this.timeoutMs,
      invokeCtx?.cancellation.signal,
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const redirectListener = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: RedirectListenerManifest, ctx: ResourceContext) {
    return new RedirectListenerResource(resource, ctx);
  },
};

export const redirectAwait = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: RedirectAwaitManifest, ctx: ResourceContext) {
    return new RedirectAwaitResource(resource, ctx);
  },
};
