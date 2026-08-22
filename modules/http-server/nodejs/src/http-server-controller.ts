import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import {
  CatchEntry,
  dispatchCatches,
  dispatchReturns,
  ReturnEntry,
} from "@telorun/http-dispatch";
import {
  isInvokeError,
  SEVERITY,
  severityForLevel,
  type Invocable,
  type KindRef,
  type LevelName,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
} from "@telorun/sdk";
import addFormats from "ajv-formats";
import Fastify, {
  FastifyInstance,
  LogController,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { fastifyReplySink } from "./fastify-reply-sink.js";
import { createFastifyTeloLogger, LISTEN_SUPERSEDED } from "./fastify-telo-logger.js";
import { publishSpecServerUrlPolicy } from "./openapi-spec-servers.js";

/** A mounted Telo.Mount instance (Http.Api, Mcp.HttpEndpoint, …). The kernel injects the
 *  live instance into a mount's `mount` slot (x-telo-ref `Telo.Mount`) — cross-module refs
 *  resolve to an imported library's exported mount — and every mountable exposes register(). */
interface Mountable {
  register(app: FastifyInstance, prefix: string): void | Promise<void>;
}

type CorsOptions = {
  origin?: string | boolean | string[];
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  cacheControl?: number | string;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
  preflight?: boolean;
  strictPreflight?: boolean;
  hideOptionsRoute?: boolean;
};

type HttpMount = {
  path?: string;
  // x-telo-ref `Telo.Mount`: Phase 5 replaces this slot with the live mounted
  // instance (Http.Api, Mcp.HttpEndpoint, …), local or imported.
  mount?: Mountable;
  logging?: { level?: LevelName };
  /** Expanded at startup (`x-telo-eval: compile`); `false` leaves the mount out. */
  when?: boolean;
};

type HttpServerResource = RuntimeResource & {
  host?: string;
  port?: number;
  baseUrl?: string;
  trustForwardedHeaders?: boolean;
  trustProxy?: boolean | number;
  cors?: CorsOptions;
  contentTypeParsers?: Array<{ contentType: string; parser?: Invocable; stream?: boolean }>;
  openapi?: {
    info: {
      title: string;
      version: string;
    };
  };
  mounts?: HttpMount[];
  notFoundHandler?: {
    invoke: KindRef<Invocable>;
    inputs?: Record<string, unknown>;
    returns?: ReturnEntry[];
    catches?: CatchEntry[];
  };
};

type ResolvedHandler = {
  kind: string;
  name: string;
  inputs: Record<string, any>;
  returns?: ReturnEntry[];
  catches?: CatchEntry[];
};

class HttpServer implements ResourceInstance {
  /** Fastify's `close()` is the inverse of everything registered on the
   *  instance, so two effects name it; running it twice is a no-op. */
  private closed = false;
  private readonly app: FastifyInstance;
  private readonly host: string;
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly trustForwardedHeaders: boolean;
  private readonly resource: HttpServerResource;
  private readonly ctx: ResourceContext;
  private readonly resolvedNotFoundHandler: ResolvedHandler | null;

  constructor(
    resource: HttpServerResource,
    ctx: ResourceContext,
    resolvedNotFoundHandler: ResolvedHandler | null = null,
  ) {
    this.resource = resource;
    this.ctx = ctx;
    this.host = resource.host || "0.0.0.0";
    this.port = Number(resource.port || 0);
    this.baseUrl = resource.baseUrl ?? `http://${this.host}:${this.port}`;
    this.trustForwardedHeaders = resource.trustForwardedHeaders === true;
    this.resolvedNotFoundHandler = resolvedNotFoundHandler;

    if (!this.port) {
      throw new Error("Http.Server port is required");
    }
    // `trustProxy` is the single Fastify knob behind both the forwarded
    // protocol/host (request.protocol/host) and the canonical client address
    // (request.ip). An explicit `trustProxy` (boolean / hop-count) wins; absent
    // it, the legacy `trustForwardedHeaders` boolean still applies.
    //
    // The hop count is expressed as the predicate it means — trust the rightmost
    // N entries of X-Forwarded-For — rather than handed to Fastify as a number:
    // Fastify 5.12 stopped honouring the numeric form and now trusts NOTHING for
    // it, which would turn this kind's documented hop-count option into a silent
    // no-op. The spoofing hazard that motivated their change is the one the
    // schema already states: only enable this behind a trusted proxy.
    const configuredTrust = resource.trustProxy ?? this.trustForwardedHeaders;
    const trustProxy: FastifyServerOptions["trustProxy"] =
      typeof configuredTrust === "number"
        ? (address, hop) => hop < configuredTrust
        : configuredTrust;
    // §13.3: replacement, not bridging — Fastify's Pino instance is swapped for
    // a Telo-backed adapter, so its records are Telo records at the source and
    // inherit the root `logging:` block's level, encoding, redaction, and sinks.
    //
    // The adapter is injected UNCONDITIONALLY. It used to be gated on `info`
    // being enabled, because that was what avoided building a per-request record
    // at a raised threshold — but disabled request logging now removes that cost
    // outright, so the gate's only remaining effect was to hand Fastify its null
    // logger at `level: warn` and silently drop every diagnostic it owns: the
    // error handler's own failures, reply-send failures, aborted-request hooks.
    // Those are exactly the records `warn` is supposed to KEEP. The adapter's
    // `emit` short-circuits on `log.enabled`, so a quiet server pays one
    // predicate per suppressed record and keeps its errors.
    //
    // A custom logger *instance* must be passed via Fastify 5's `loggerInstance`
    // option; passing it to `logger:` throws FST_ERR_LOG_INVALID_LOGGER_CONFIG.
    this.app = Fastify({
      loggerInstance: createFastifyTeloLogger(this.ctx.log),
      // Fastify's own per-request lines are off: this kind emits its own from
      // `onRequest` / `onResponse` instead (see `installRequestLogging`), so the
      // access record's shape is this KIND's contract rather than Pino's prose —
      // which is what lets a Rust or Go implementation emit the same thing.
      // The top-level `disableRequestLogging` option is deprecated (FSTDEP023);
      // the log controller carries the same switch.
      logController: new LogController({ disableRequestLogging: true }),
      trustProxy,
      ajv: { customOptions: { useDefaults: true }, plugins: [addFormats.default as any] },
    });
  }

  /**
   * Registering plugins and routes: nothing observable, and nothing repeatable —
   * a route registers exactly once.
   *
   * Written as if it runs once, because it does. A failed `init()` recovers
   * through this effect and the instance is discarded, so the next pass builds a
   * fresh Fastify rather than re-entering one that already has half its routes —
   * which is what the mount-by-mount resumability bookkeeping used to buy, and
   * what Fastify's duplicate-route error used to punish.
   *
   * ONE effect, not one per plugin and mount: Fastify has no unregister, so
   * `close()` is the only real inverse of anything attached to the instance.
   * Registering a per-mount inverse that undid nothing would be decoration.
   */
  init() {
    return this.ctx.effect("fastify plugins and routes", async () => {
      await this.setupPlugins();
      this.setupRoutes();
      return { result: undefined, inverse: () => this.closeApp() };
    });
  }

  /** Idempotent: two effects name `close()` as their inverse (the routes, and
   *  the open socket), and both may unwind in one teardown. */
  private async closeApp(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.app.close();
  }

  /**
   * The access log, emitted by this kind rather than by Fastify.
   *
   * The contract is `event_name` plus OTel attributes — never the message text,
   * which is prose and differs per framework. That is what makes the record
   * readable across runtimes: an axum or net/http implementation registers the
   * equivalent middleware and emits the same `http.server.request`.
   *
   * One `info` record per request, on completion — the convention every access
   * log follows (nginx, Caddy, tower-http). The received-side record is `debug`
   * because it carries no outcome; its one real use is a request that HANGS and
   * never completes, which otherwise leaves no trace at all.
   */
  /**
   * Per-mount access-log floors, longest prefix first so the match is the first
   * hit. Built once at init rather than per request — the mount set is fixed.
   *
   * A mount's `logging.level` exists because the import-scoped threshold (§12.2)
   * governs a whole module instance: one `Http.Server` is one resource in one
   * scope, so it cannot quieten `/health` while leaving `/api` alone. This can.
   */
  private mountLogFloors(): ReadonlyArray<{ prefix: string; floor: number }> {
    return this.activeMounts()
      .flatMap((mount) => {
        const level = mount.logging?.level;
        if (!level) return [];
        return [{ prefix: mount.path || "", floor: severityForLevel(level) }];
      })
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /**
   * The mounts this server attaches, `when:`-gated ones dropped.
   *
   * `when` is a startup decision, not a per-request one: it resolves with the
   * rest of the server's configuration, so an excluded mount registers no routes
   * at all rather than answering 404 — which is what makes leaving the API
   * reference out of a production deployment mean something. The referenced
   * resource is still created and initialized: it is an ordinary ref slot, filled
   * before this server ever runs.
   */
  private activeMounts(): ReadonlyArray<HttpMount> {
    return (this.resource.mounts ?? []).filter((mount) => mount.when !== false);
  }

  private installRequestLogging() {
    const log = this.ctx.log;
    const floors = this.mountLogFloors();
    /**
     * `http.route` is the matched TEMPLATE (`/todos/:id`), never the concrete
     * path: low-cardinality, which is what an access log is aggregated on.
     *
     * When nothing matched — every 404 — there IS no template, and the key is
     * omitted rather than filled with the concrete URL. Falling back would let
     * an unauthenticated caller write arbitrary strings into the `info`-level
     * attribute a dashboard groups on: one 404 scan, unbounded cardinality.
     * Omission is also what OTel requires when there is no match.
     *
     * `routeOptions` is a getter that rebuilds an options object on every access,
     * so it is read once per hook and passed around as the resolved value.
     */
    const routeAttribute = (route: string | undefined): { "http.route"?: string } =>
      route === undefined ? {} : { "http.route": route };

    /** The floor this request must clear: its mount's, or none. Matched on the
     *  concrete URL, since that is what a mount prefix attaches to. */
    const floorFor = (request: FastifyRequest): number => {
      for (const { prefix, floor } of floors) {
        if (prefix === "" || request.url === prefix || request.url.startsWith(`${prefix}/`)) {
          return floor;
        }
      }
      return 0;
    };

    /** A 5xx is not the same class of event as a 200, and both were `info`.
     *  Deriving severity from the status is also what makes a quietened mount
     *  safe: `level: warn` on a health check still surfaces it returning 500,
     *  rather than going blind on the path that matters most.
     *
     *  4xx stays `info` deliberately — a 404 or a 401 is ordinary traffic, and
     *  promoting it would make a scanner walking random URLs read as an incident. */
    const severityForStatus = (status: number): number =>
      status >= 500 ? SEVERITY.error : SEVERITY.info;

    this.app.addHook("onRequest", async (request) => {
      if (!log.enabled(SEVERITY.debug) || SEVERITY.debug < floorFor(request)) return;
      log.debug(
        "Request received",
        {
          "http.request.method": request.method,
          ...routeAttribute(request.routeOptions?.url),
          "url.path": request.url,
          "httpserver.request_id": String(request.id),
        },
        { eventName: "http.server.request.started" },
      );
    });

    this.app.addHook("onResponse", async (request, reply) => {
      const severity = severityForStatus(reply.statusCode);
      if (!log.enabled(severity) || severity < floorFor(request)) return;
      log.log(
        severity,
        "Request completed",
        {
          "http.request.method": request.method,
          ...routeAttribute(request.routeOptions?.url),
          "http.response.status_code": reply.statusCode,
          // OTel's name in OTel's unit: seconds, as a double. Fastify measures in
          // milliseconds at full `hrtime` precision, so this is rounded to
          // microseconds — finer than anything an access log needs, and without
          // it the division prints seventeen digits of float noise.
          "http.server.request.duration": Math.round(reply.elapsedTime * 1000) / 1e6,
          "httpserver.request_id": String(request.id),
        },
        { eventName: "http.server.request" },
      );
    });
  }

  /**
   * Accept a multipart body out of the box.
   *
   * Fastify ships parsers for JSON and urlencoded and nothing else, so a route
   * receiving a file upload answered 415 before any handler ran — a failure that
   * names a media type the author DID send and points at no fix. Every server
   * taking an upload had to discover `contentTypeParsers` first.
   *
   * Registered as RAW BYTES rather than a string, because that is what a
   * multipart body is: decoding it as text corrupts every binary part, and the
   * parts are the point. The handler receives the undrained request stream, which
   * `Multipart.Decoder` consumes.
   *
   * Registered UNCONDITIONALLY, as a regex. Fastify keys a duplicate on the exact
   * string (or the regex's `toString()`) and consults its string parsers before
   * its regex ones, so a declared `multipart/form-data` neither collides with this
   * nor is shadowed by it — it simply wins for its own type. Skipping the default
   * whenever any multipart parser was declared would instead disable it for the
   * SIBLING subtypes the author did not customize, so declaring a parser for
   * `form-data` would silently restore the 415 for `related` and `mixed`.
   */
  private installDefaultMultipartParser(): void {
    this.app.addContentTypeParser(/^multipart\//, (_req, payload, done) => {
      done(null, payload);
    });
  }

  private async setupPlugins() {
    this.installRequestLogging();
    this.installDefaultMultipartParser();
    for (const { contentType, parser, stream } of this.resource.contentTypeParsers ?? []) {
      if (stream) {
        // Raw passthrough: omit `parseAs` so Fastify hands the handler the
        // undrained request stream. The matching route wraps `request.body`
        // in a `Stream<Uint8Array>`. No buffering, no AJV — see http-api-controller.
        this.app.addContentTypeParser(contentType, (_req, payload, done) => {
          done(null, payload);
        });
      } else if (parser) {
        this.app.addContentTypeParser(
          contentType,
          { parseAs: "string" },
          async (_req, body, done) => {
            try {
              // The bound entry point forwards every argument, so the root
              // context rides in as the InvokeContext — §7's obligation for an
              // inbound registrant. (This path still calls the instance
              // directly rather than going through `invokeResolved`, so it is
              // untraced; that predates zones and is tracked separately.)
              done(null, await parser.invoke({ body }, this.ctx.rootContext()));
            } catch (err) {
              done(err as Error, undefined);
            }
          },
        );
      } else {
        this.app.addContentTypeParser(contentType, { parseAs: "string" }, (_req, body, done) => {
          done(null, body);
        });
      }
    }

    if (this.resource.cors) {
      // Only forward the fields the manifest actually set. Spreading `undefined`
      // for an unset option overrides @fastify/cors's own defaults with
      // `undefined` — notably `preflight: undefined` disables the preflight 204
      // reply (its `OPTIONS *` handler then `callNotFound()`s → 404), which a
      // browser reports as "preflight … does not have HTTP ok status".
      const cfg = this.resource.cors;
      const corsOptions: Record<string, unknown> = {};
      for (const key of [
        "origin",
        "methods",
        "allowedHeaders",
        "exposedHeaders",
        "credentials",
        "maxAge",
        "cacheControl",
        "preflightContinue",
        "optionsSuccessStatus",
        "preflight",
        "strictPreflight",
        "hideOptionsRoute",
      ] as const) {
        if (cfg[key] !== undefined) corsOptions[key] = cfg[key];
      }
      await this.app.register(cors, corsOptions);
    }

    // Register custom error handler for validation errors
    this.app.setErrorHandler((error, request, reply) => {
      const mappedError = convertFastifyValidationError(error);
      if (mappedError) {
        reply.code(400);
        return reply.send(mappedError);
      }
      // Let Fastify handle other errors normally
      throw error;
    });
    if (this.resource.openapi) {
      // Each route is documented at its full `mount-prefix + path` (see
      // http-api-controller), so the server is a single origin, not one entry per
      // mount. Server URL precedence: an explicit `baseUrl` is an absolute, fixed
      // override; otherwise the URL is relative (`/`) so the doc is correct behind
      // any proxy/ingress/origin — the client resolves it against wherever the
      // reference was loaded.
      //
      // This registers the document and nothing that serves it: rendering it is
      // Http.Reference's, mounted where the author wants it. Collection has to
      // stay here because @fastify/swagger reads a route's schema through an
      // `onRoute` hook in its own encapsulation context, so it must be at the
      // root scope before any mount registers its routes.
      const servers = [{ url: this.resource.baseUrl ?? "/" }];
      await this.app.register(swagger, {
        openapi: {
          openapi: "3.0.0",
          info: this.resource.openapi.info,
          servers,
        },
      });
      // `trustForwardedHeaders` (and no fixed baseUrl) upgrades the relative
      // default to absolute URLs built per-request from the now-trusted
      // X-Forwarded-* headers. The rewrite itself belongs to whichever mount
      // serves the document, which is the only side that knows its path.
      publishSpecServerUrlPolicy(
        this.app,
        this.trustForwardedHeaders && !this.resource.baseUrl,
      );
    }
  }

  private setupRoutes(): void {
    // const routesByName = new Map<string, HttpRouteResource>();
    const mounts = this.activeMounts();
    for (const skipped of (this.resource.mounts ?? []).filter((mount) => mount.when === false)) {
      // Said out loud: a route set that is absent because a condition excluded
      // it is indistinguishable at request time from one that failed to
      // register.
      this.ctx.log.debug(
        "Mount excluded by its `when` condition",
        { "http.route": skipped.path || "/" },
        { eventName: "http.server.mount.excluded" },
      );
    }
    // const resolveSchema = createSchemaResolver(this.ctx);
    for (let index = 0; index < mounts.length; index++) {
      const mount = mounts[index];
      const prefix = mount.path || "";
      // `mount.mount` is the live Telo.Mount instance injected by the kernel at Phase 5
      // (x-telo-ref `Telo.Mount`) — a same-module or imported-library mount, uniformly.
      const api = mount.mount;
      if (!api || typeof api.register !== "function") {
        // Thrown, not recorded: Phase-5 injection runs again before the next
        // init pass, so a mount that is merely not created YET resolves then.
        throw new Error(
          `Failed to mount at "${prefix}": mount target did not resolve to a Telo.Mount instance`,
        );
      }
      api.register(this.app, prefix);
    }

    if (this.resolvedNotFoundHandler) {
      const handler = this.resolvedNotFoundHandler;
      this.app.setNotFoundHandler(async (request, reply) => {
        const normalizedHeaders: Record<string, any> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          normalizedHeaders[key.toLowerCase()] = value;
        }
        const requestContext = {
          request: {
            method: request.method,
            path: request.url,
            params: request.params || {},
            query: request.query || {},
            headers: normalizedHeaders,
            body: request.body,
          },
        };
        const acceptHeader = (
          (request.headers as Record<string, string | string[] | undefined>)["accept"] as
            | string
            | undefined
        )?.toString();

        const sink = fastifyReplySink(reply);

        // Expand the `inputs:` sibling template against the request context,
        // then pass the merged shape (spread for convenience + `inputs:` field
        // for handlers that read it explicitly) to the dispatch target. Same
        // contract Api.routes[*] uses. When no `inputs:` is declared, the
        // request context itself is forwarded so existing manifests that read
        // `request.*` directly continue to work.
        const resolvedInputs: Record<string, any> =
          handler.inputs && Object.keys(handler.inputs).length > 0
            ? ((this.ctx.moduleContext.expandWith(handler.inputs, requestContext) as any) ?? {})
            : requestContext;
        const invokeInput: Record<string, any> = {
          ...resolvedInputs,
          inputs: resolvedInputs,
        };

        let result: any;
        try {
          // rootContext: an inbound registrant dispatches with a context that
          // inherits nothing ambient (kernel/specs/execution-zones.md §7).
          result = await this.ctx.invoke(handler.kind, handler.name, invokeInput, {
            ctx: this.ctx.rootContext(),
          });
        } catch (err) {
          if (!isInvokeError(err)) throw err;
          return dispatchCatches(
            handler.catches,
            { code: err.code, message: err.message, data: err.data },
            requestContext,
            acceptHeader,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            sink,
          );
        }

        if (handler.returns) {
          return dispatchReturns(
            handler.returns,
            result,
            requestContext,
            acceptHeader,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            sink,
          );
        }
        const status = result?.status ?? 200;
        reply.code(status);
        if (result?.headers) {
          Object.entries(result.headers).forEach(([key, value]) =>
            reply.header(key, value as string),
          );
        }
        return reply.send(result?.body ?? result);
      });
    }
  }

  /**
   * Two effects, and no error handling of its own.
   *
   * The hold is one, the open socket is the other. A `listen()` that throws — a bound port — unwinds the run frame,
   * so the hold is released and the routes are torn down without this method
   * knowing anything about recovery; the same unwind is what stops the server at
   * teardown, which is why there is no `teardown()` left to keep in step.
   */
  run() {
    return this.ctx
      .effect("kernel hold", async () => ({
        result: undefined,
        inverse: this.ctx.acquireHold(`http server ${this.resource.metadata.name}`),
      }))
      .effect("listening socket", async () => {
        await this.app.listen({
        host: this.host,
        port: this.port,
        // Fastify announces "Server listening at http://…" through the injected
        // logger, interpolating the address into prose — unparseable, and exactly
        // what §4.1 routes into attributes. Replacing the text with a constant
        // this module owns lets the adapter drop it without pattern-matching
        // Fastify's wording, which is the thing this kind's own contract forbids.
        listenTextResolver: () => LISTEN_SUPERSEDED,
      });
      this.ctx.log.info(
        "Listening",
        {
          "server.address": this.host,
          "server.port": this.port,
          // The SOCKET's scheme, which this kind only ever opens as plain HTTP —
          // there is no TLS field on `Http.Server`. `baseUrl` is the ADVERTISED
          // url and is routinely `https://` behind a terminator, so deriving from
          // it would claim TLS for a plaintext socket on the most common
          // production deployment there is.
          "url.scheme": "http",
        },
        { eventName: "http.server.started" },
      );
      await this.ctx.emitEvent(`${this.resource.metadata.name}.Listening`, {
        port: this.port,
        host: this.host,
        baseUrl: this.baseUrl,
        mounts: this.resource.mounts,
        openapi: this.resource.openapi,
      });
      return {
        result: undefined,
        // Paired with the record above, which is what the `listening` flag used
        // to approximate: a server that never listened has no such effect, so it
        // cannot report a close a consumer would fail to match with a start.
        inverse: async () => {
          await this.closeApp();
          this.ctx.log.info(
            "Stopped listening",
            { "server.address": this.host, "server.port": this.port },
            { eventName: "http.server.stopped" },
          );
        },
      };
    });
  }
}

export async function create(
  resource: HttpServerResource,
  ctx: ResourceContext,
): Promise<ResourceInstance | null> {
  let resolvedNotFoundHandler: ResolvedHandler | null = null;
  if (resource.notFoundHandler) {
    const invoke = resource.notFoundHandler.invoke as unknown;
    let kind = "";
    let name = "";
    if (typeof invoke === "object" && invoke !== null) {
      const resolved = ctx.ensureKindRef(invoke);
      kind = resolved.kind;
      name = resolved.name;
    } else if (typeof invoke === "string") {
      // String form (schema oneOf: string | object) — resource name only.
      name = invoke;
    }
    resolvedNotFoundHandler = {
      kind,
      name,
      inputs: resource.notFoundHandler.inputs ?? {},
      returns: resource.notFoundHandler.returns,
      catches: resource.notFoundHandler.catches,
    };
  }
  return new HttpServer(resource, ctx, resolvedNotFoundHandler);
}

/**
 * Converts Fastify validation errors to standardized Telo format
 * Returns null if the error is not a validation error
 */
function convertFastifyValidationError(error: any): Record<string, any> | null {
  // Check if this is a Fastify validation error
  if (!error || typeof error !== "object" || error.code !== "FST_ERR_VALIDATION") {
    return null;
  }

  const message = error.message || "";
  const details = [];

  // Parse Fastify validation error message to extract location and field
  // Format examples:
  // "querystring must have required property 'name'"
  // "body must be object"
  // "params.userId must be string"

  let location = "body"; // default
  let fieldPath = "";
  let validationMessage = "Validation failed";

  // Try to extract location from message
  if (message.includes("querystring")) {
    location = "query";
  } else if (message.includes("params")) {
    location = "params";
  } else if (message.includes("headers")) {
    location = "headers";
  } else if (message.includes("body")) {
    location = "body";
  }

  // Extract field name from "must have required property 'fieldName'" pattern
  const requiredMatch = message.match(/must have required property '([^']+)'/);
  if (requiredMatch) {
    fieldPath = requiredMatch[1];
    validationMessage = `is a required property`;
  } else {
    // Extract field from "fieldName must be" pattern
    const fieldMatch = message.match(/^(?:querystring|body|params|headers)\.?(\w+)\s/);
    if (fieldMatch) {
      fieldPath = fieldMatch[1];
    }
    validationMessage = message
      .replace(/^(?:querystring|body|params|headers)\.?\w*\s/, "")
      .replace(" must ", " ");
  }

  if (fieldPath || message) {
    details.push({
      location,
      path: fieldPath,
      message: validationMessage,
    });
  }

  return {
    error: "ValidationError",
    message: "Request validation failed",
    status: 400,
    details,
  };
}
